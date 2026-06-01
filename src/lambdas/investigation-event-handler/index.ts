/**
 * Investigation Event Handler Lambda.
 *
 * Two-phase handling, both phases driven by EventBridge `aws.aidevops` events.
 *
 * Phase 1 — Root cause:
 *   Trigger: 'Investigation Completed' / 'Investigation Failed' /
 *            'Investigation Timed Out' / 'Investigation Cancelled' /
 *            'Investigation Skipped'
 *   1. Look up the pending DDB record (by time window) → get taskToken,
 *      original alarms, groupId.
 *   2. Pull `investigation_summary_md` from journal → build root-cause RCAReport.
 *   3. SendTaskSuccess(taskToken, payload) → wakes up SFN, which goes on to
 *      invoke FeishuNotifier with the first card.
 *   4. If this is a successful Investigation Completed event, immediately call
 *      `UpdateBacklogTask(taskStatus=PENDING_START)` — this is exactly what the
 *      console "Generate mitigation plan" button does — to advance the same
 *      task into the mitigation phase.
 *   5. Update DDB status to `investigation_completed` (or `*_skipped` on
 *      failure/timeout). Persist taskId so phase 2 can find the same record.
 *
 * Phase 2 — Mitigation plan:
 *   Trigger: 'Mitigation Completed' / 'Mitigation Failed' / 'Mitigation Timed Out'
 *            / 'Mitigation Cancelled'
 *   1. Look up the DDB record by `taskId` (saved in phase 1).
 *   2. Pull `mitigation_summary_md` from journal → build mitigation-only RCAReport.
 *   3. Async-invoke FeishuNotifier (InvocationType=Event, no SFN involved) with
 *      a second card, notificationType `rca_complete`.
 *   4. Update DDB status to `mitigation_completed` / `mitigation_failed`.
 *
 * Reference:
 *   https://docs.aws.amazon.com/devopsagent/latest/userguide/integrating-devops-agent-into-event-driven-applications-using-amazon-eventbridge-devops-agent-events-detail-reference.html
 *   https://docs.aws.amazon.com/devopsagent/latest/userguide/aws-devops-agent-security-devops-agent-iam-permissions.html
 *     (aidevops:UpdateBacklogTask "approve a mitigation plan")
 */

import * as crypto from 'crypto';
import {
  SFNClient,
  SendTaskSuccessCommand,
  SendTaskFailureCommand,
} from '@aws-sdk/client-sfn';
import {
  DevOpsAgentClient,
  ListJournalRecordsCommand,
  GetBacklogTaskCommand,
  UpdateBacklogTaskCommand,
  ListExecutionsCommand,
} from '@aws-sdk/client-devops-agent';
import {
  UpdateCommand,
  ScanCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { getDocClient } from '../../shared/dynamodb-client';
import {
  AlarmRouterOutput,
  RCAAnalyzerOutput,
  RCAReport,
  FeishuNotifierInput,
  formatResourceKey,
} from '../../shared/types';

const METRIC_NAMESPACE = 'CloudWatchAlarmAutoRCA';

const sfnClient = new SFNClient({});
const devopsClient = new DevOpsAgentClient({});
const cloudWatchClient = new CloudWatchClient({});
const lambdaClient = new LambdaClient({});

const AGENT_SPACE_ID = process.env.AGENT_SPACE_ID ?? '';
const FEISHU_NOTIFIER_FN_NAME = process.env.FEISHU_NOTIFIER_FN_NAME ?? '';
const FEISHU_BOT_FN_NAME = process.env.FEISHU_BOT_FN_NAME ?? '';
const CHAT_INVESTIGATION_MAPPING_TABLE_NAME =
  process.env.CHAT_INVESTIGATION_MAPPING_TABLE_NAME ?? '';
const PENDING_LOOKUP_WINDOW_SECONDS = 600; // 10-minute window for phase-1 lookup

// -----------------------------------------------------------------------------
// EventBridge event shape (covers both Investigation* and Mitigation* events)
// -----------------------------------------------------------------------------

export type InvestigationDetailType =
  | 'Investigation Created'
  | 'Investigation In Progress'
  | 'Investigation Completed'
  | 'Investigation Failed'
  | 'Investigation Timed Out'
  | 'Investigation Cancelled'
  | 'Investigation Pending Triage'
  | 'Investigation Linked'
  | 'Investigation Skipped';

export type MitigationDetailType =
  | 'Mitigation In Progress'
  | 'Mitigation Completed'
  | 'Mitigation Failed'
  | 'Mitigation Timed Out'
  | 'Mitigation Cancelled';

export interface InvestigationEvent {
  source: 'aws.aidevops';
  'detail-type': InvestigationDetailType | MitigationDetailType;
  time: string;
  region: string;
  account: string;
  detail: {
    version: string;
    metadata: {
      agent_space_id: string;
      task_id: string;
      execution_id?: string;
    };
    data: {
      task_type: string;
      priority: string;
      status: string;
      created_at: string;
      updated_at: string;
      summary_record_id?: string;
    };
  };
}

const INVESTIGATION_TERMINAL_TYPES: InvestigationDetailType[] = [
  'Investigation Completed',
  'Investigation Failed',
  'Investigation Timed Out',
  'Investigation Cancelled',
  'Investigation Skipped',
];

const MITIGATION_TERMINAL_TYPES: MitigationDetailType[] = [
  'Mitigation Completed',
  'Mitigation Failed',
  'Mitigation Timed Out',
  'Mitigation Cancelled',
];

// -----------------------------------------------------------------------------
// Metrics
// -----------------------------------------------------------------------------

async function emitMetric(name: string, value: number): Promise<void> {
  try {
    await cloudWatchClient.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [{ MetricName: name, Value: value, Unit: 'Count', Timestamp: new Date() }],
      })
    );
  } catch (err) {
    console.warn('[InvestigationEventHandler] emitMetric failed', err);
  }
}

// -----------------------------------------------------------------------------
// DDB lookup helpers
// -----------------------------------------------------------------------------

interface PendingRecord {
  executionId: string; // = incidentId (PK)
  createdAt: string;   // ISO timestamp (SK)
  taskToken: string;
  groupId: string;
  alarms: AlarmRouterOutput[];
  taskId?: string;     // populated after phase 1
}

/**
 * Phase-1 lookup: find the pending record by time window.
 * Used for the first Investigation Completed event when we don't yet know taskId.
 */
async function findPendingByTimeWindow(eventTime: string): Promise<PendingRecord | null> {
  const tableName = process.env.WORKFLOW_EXECUTION_TABLE_NAME;
  if (!tableName) {
    throw new Error('WORKFLOW_EXECUTION_TABLE_NAME is not configured');
  }

  const eventMs = Date.parse(eventTime);
  const lowerBound = new Date(eventMs - PENDING_LOOKUP_WINDOW_SECONDS * 1000).toISOString();
  const upperBound = new Date(eventMs + 60 * 1000).toISOString();

  const result = await getDocClient().send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: '#status = :pending AND createdAt BETWEEN :lo AND :hi',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pending': 'pending',
        ':lo': lowerBound,
        ':hi': upperBound,
      },
    })
  );

  const items = (result.Items ?? []) as Array<Record<string, any>>;
  if (items.length === 0) return null;

  // Pick earliest createdAt — simple FIFO matching.
  items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const chosen = items[0];

  if (!chosen.taskToken) {
    console.warn(
      '[InvestigationEventHandler] Found pending record but no taskToken',
      chosen.executionId
    );
    return null;
  }

  return {
    executionId: chosen.executionId,
    createdAt: chosen.createdAt,
    taskToken: chosen.taskToken,
    groupId: chosen.groupId,
    alarms: Array.isArray(chosen.alarms) ? (chosen.alarms as AlarmRouterOutput[]) : [],
    taskId: chosen.taskId,
  };
}

/**
 * Phase-2 lookup: find the record by taskId.
 * Used for Mitigation* events — phase 1 stamps the taskId onto the record so
 * we can do an exact match instead of a fuzzy time window.
 *
 * Falls back to time-window scan if taskId-based lookup fails (e.g., the
 * record was written before this code was deployed).
 */
async function findRecordByTaskId(
  taskId: string,
  eventTime: string
): Promise<PendingRecord | null> {
  const tableName = process.env.WORKFLOW_EXECUTION_TABLE_NAME;
  if (!tableName) {
    throw new Error('WORKFLOW_EXECUTION_TABLE_NAME is not configured');
  }

  // Scan with FilterExpression on taskId — small table, scan is fine.
  const result = await getDocClient().send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: 'taskId = :tid',
      ExpressionAttributeValues: { ':tid': taskId },
    })
  );

  const items = (result.Items ?? []) as Array<Record<string, any>>;
  if (items.length > 0) {
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); // newest first
    const chosen = items[0];
    return {
      executionId: chosen.executionId,
      createdAt: chosen.createdAt,
      taskToken: chosen.taskToken ?? '',
      groupId: chosen.groupId,
      alarms: Array.isArray(chosen.alarms) ? (chosen.alarms as AlarmRouterOutput[]) : [],
      taskId: chosen.taskId,
    };
  }

  // Fallback: maybe the record was written before this code rolled out and
  // doesn't have taskId stamped. Try a wider time window.
  return findPendingByTimeWindow(eventTime);
}

// -----------------------------------------------------------------------------
// Journal fetch
// -----------------------------------------------------------------------------

async function fetchSummaryMarkdown(
  executionId: string,
  recordType: 'investigation_summary_md' | 'mitigation_summary_md'
): Promise<string> {
  if (!AGENT_SPACE_ID) {
    console.warn('[InvestigationEventHandler] AGENT_SPACE_ID not configured; skip journal fetch');
    return '';
  }

  let nextToken: string | undefined;
  const summaryParts: string[] = [];
  let pageCount = 0;
  const MAX_PAGES = 5;

  do {
    const resp = await devopsClient.send(
      new ListJournalRecordsCommand({
        agentSpaceId: AGENT_SPACE_ID,
        executionId,
        limit: 100,
        nextToken,
        recordType,
      })
    );
    for (const r of resp.records ?? []) {
      if (!r.content) continue;
      let text: string | undefined;
      if (typeof r.content === 'string') text = r.content;
      else if (typeof r.content === 'object' && r.content !== null) {
        const c = r.content as Record<string, unknown>;
        if (typeof c.text === 'string') text = c.text;
        else if (typeof c.markdown === 'string') text = c.markdown as string;
        else if (typeof c.body === 'string') text = c.body as string;
      }
      if (text) summaryParts.push(text);
    }
    nextToken = resp.nextToken;
    pageCount++;
  } while (nextToken && pageCount < MAX_PAGES);

  return summaryParts.join('\n\n');
}

/**
 * 找出 task 下 `agentType=mitigation` 的 execution。
 *
 * 关键发现:
 *   每个 backlog task 在 ListExecutions 下会暴露多个 execution——
 *   一个 `agentType=ops1`（root cause 调查阶段）和一个
 *   `agentType=mitigation`（缓解计划生成阶段）。
 *
 *   EventBridge 的 'Mitigation Completed' 事件里 `metadata.execution_id`
 *   给的是 ops1 那个（"主"execution),而 `mitigation_summary_md` journal
 *   record **只存在于 mitigation execution** 里。直接用事件里的 executionId
 *   去查 journal 永远拿不到内容。
 *
 *   所以这里需要:
 *     1. ListExecutions(taskId)
 *     2. 过滤出 agentType=mitigation 的那条
 *     3. 用它的 executionId 去 ListJournalRecords(mitigation_summary_md)
 */
async function findMitigationExecutionId(taskId: string): Promise<string | undefined> {
  if (!AGENT_SPACE_ID) return undefined;
  try {
    const resp = await devopsClient.send(
      new ListExecutionsCommand({
        agentSpaceId: AGENT_SPACE_ID,
        taskId,
        limit: 50,
      })
    );
    const executions = resp.executions ?? [];
    // Prefer the most recent mitigation execution (descending createdAt).
    const mitigations = executions
      .filter((e) => (e.agentType || '').toLowerCase().includes('mitigation'))
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
    return mitigations[0]?.executionId ?? undefined;
  } catch (err) {
    console.warn('[InvestigationEventHandler] findMitigationExecutionId failed', err);
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// Markdown helpers (shared between phase 1 and phase 2)
// -----------------------------------------------------------------------------

function splitMarkdownSections(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /^##\s+(.+?)\s*$/gm;
  const matches = [...text.matchAll(regex)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const name = m[1].trim().toLowerCase();
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    result[name] = text.substring(start, end).trim();
  }
  return result;
}

function parseBulletList(section: string): string[] {
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+|^\d+[.)]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+|^\d+[.)]\s+/, '').trim())
    .filter((l) => l.length > 0);
}

function parseRootCauses(
  section: string
): Array<{ summary: string; details: string }> {
  const blocks = section.split(/\n\s*\n/);
  const out: Array<{ summary: string; details: string }> = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const first = lines[0];
    const m = first.match(/^\d+[.)]\s*(.+)$/);
    if (m) {
      out.push({ summary: m[1].trim(), details: lines.slice(1).join('\n').trim() });
    }
  }
  return out;
}

function parseMitigationPlan(
  section: string
): Array<{ step: string; command?: string; rollback?: string }> {
  const result: Array<{ step: string; command?: string; rollback?: string }> = [];
  const lines = section.split('\n');
  let current: { step: string; command?: string; rollback?: string } | null = null;
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  for (const line of lines) {
    const stepMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (stepMatch && !inCodeBlock) {
      if (current) result.push(current);
      current = { step: stepMatch[1].trim() };
      continue;
    }
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        if (current) current.command = codeBuffer.join('\n').trim();
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeBuffer = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }
    const rollback = line.match(/^\s*回滚\s*[:：]\s*(.+)$/);
    if (rollback && current) {
      current.rollback = rollback[1].trim();
    }
  }
  if (current) result.push(current);
  return result;
}

// -----------------------------------------------------------------------------
// Phase-1 (root cause) RCAReport builder
// -----------------------------------------------------------------------------

function buildRootCauseReport(args: {
  pending: PendingRecord;
  event: InvestigationEvent;
  markdown: string;
}): RCAReport {
  const { pending, event, markdown } = args;
  const detailType = event['detail-type'] as InvestigationDetailType;

  const sections = splitMarkdownSections(markdown);
  const impact = sections['impact']?.trim() || undefined;
  const keyFindings = parseBulletList(sections['key findings'] ?? '');
  const rootCauses = parseRootCauses(sections['root causes'] ?? '');

  const isCompleted = detailType === 'Investigation Completed';
  const isTimedOut = detailType === 'Investigation Timed Out';
  const status: RCAReport['status'] =
    isCompleted ? 'completed' : isTimedOut ? 'timeout' : 'partial';

  const alarms = pending.alarms;
  const alarmTimestamps = alarms
    .map((a) => Date.parse(a.stateChangeTimestamp))
    .filter((t) => !isNaN(t));
  const firstAlarmTime =
    alarmTimestamps.length > 0
      ? new Date(Math.min(...alarmTimestamps)).toISOString()
      : event.time;
  const lastAlarmTime =
    alarmTimestamps.length > 0
      ? new Date(Math.max(...alarmTimestamps)).toISOString()
      : event.time;

  const primaryRC = rootCauses[0] ?? {
    summary: isCompleted
      ? 'DevOps Agent investigation completed (no parseable root cause)'
      : `Investigation ${detailType.replace('Investigation ', '').toLowerCase()}`,
    details: markdown.length > 0 ? markdown : `Status: ${event.detail.data.status}`,
  };

  return {
    reportId: crypto.randomUUID(),
    groupId: pending.groupId,
    generatedAt: new Date().toISOString(),
    status,
    alarmSummary: {
      alarmCount: alarms.length,
      alarms: alarms.map((a) => ({
        alarmName: a.alarmName,
        namespace: a.namespace,
        metricName: a.metricName,
        currentValue: a.currentValue,
        threshold: a.threshold,
        resource: formatResourceKey(a.resource),
      })),
      firstAlarmTime,
      lastAlarmTime,
    },
    investigation: {
      timeline: keyFindings.map((f) => ({
        timestamp: event.time,
        action: 'Key finding',
        finding: f,
      })),
      dataSourcesConsulted: ['DevOps Agent', 'CloudWatch Metrics', 'CloudTrail'],
      hypothesesExplored: parseBulletList(sections['hypotheses'] ?? ''),
    },
    rootCause: {
      summary: primaryRC.summary,
      category: 'unknown',
      details: primaryRC.details,
      confidence: isCompleted ? 'medium' : 'low',
      affectedResources: alarms.map((a) => formatResourceKey(a.resource)).filter((s) => !!s),
    },
    remediation: {
      // Phase-1 card: don't bother filling remediation here — phase 2 will
      // produce a dedicated mitigation card.
      immediateMitigation: '正在生成缓解计划，请等待第二条卡片…',
      longTermFix: '',
      steps: [],
    },
    impact,
    keyFindings: keyFindings.length > 0 ? keyFindings : undefined,
    rootCauses: rootCauses.length > 0
      ? rootCauses.map((r) => ({ summary: r.summary, details: r.details }))
      : undefined,
    // Phase 1 deliberately leaves mitigationPlan unset — phase 2 owns that.
    executionId: event.detail.metadata.execution_id,
    taskId: event.detail.metadata.task_id,
    incidentId: pending.executionId,
    reportPhase: 'investigation',
    agentRawText: markdown || undefined,
  };
}

// -----------------------------------------------------------------------------
// Phase-2 (mitigation) RCAReport builder
// -----------------------------------------------------------------------------

function buildMitigationReport(args: {
  record: PendingRecord;
  event: InvestigationEvent;
  markdown: string;
}): RCAReport {
  const { record, event, markdown } = args;
  const detailType = event['detail-type'] as MitigationDetailType;

  const sections = splitMarkdownSections(markdown);
  // DevOps Agent mitigation summary 实际章节常见形态:
  //   - 默认: `## Action` (动作描述) + `## Reasoning` (推理)
  //   - 简化形态: 一段散文(没有任何 ## 标题)
  //   - 偶尔: `## Mitigation Plan` / `## Steps` / `## Plan`
  // 这里多容错一些。
  const mitigationPlan = parseMitigationPlan(
    sections['mitigation plan']
      ?? sections['action']
      ?? sections['steps']
      ?? sections['plan']
      ?? ''
  );

  const isCompleted = detailType === 'Mitigation Completed';
  const isTimedOut = detailType === 'Mitigation Timed Out';
  const status: RCAReport['status'] =
    isCompleted ? 'completed' : isTimedOut ? 'timeout' : 'partial';

  const alarms = record.alarms;
  const alarmTimestamps = alarms
    .map((a) => Date.parse(a.stateChangeTimestamp))
    .filter((t) => !isNaN(t));
  const firstAlarmTime =
    alarmTimestamps.length > 0
      ? new Date(Math.min(...alarmTimestamps)).toISOString()
      : event.time;
  const lastAlarmTime =
    alarmTimestamps.length > 0
      ? new Date(Math.max(...alarmTimestamps)).toISOString()
      : event.time;

  return {
    reportId: crypto.randomUUID(),
    groupId: record.groupId,
    generatedAt: new Date().toISOString(),
    status,
    alarmSummary: {
      alarmCount: alarms.length,
      alarms: alarms.map((a) => ({
        alarmName: a.alarmName,
        namespace: a.namespace,
        metricName: a.metricName,
        currentValue: a.currentValue,
        threshold: a.threshold,
        resource: formatResourceKey(a.resource),
      })),
      firstAlarmTime,
      lastAlarmTime,
    },
    investigation: {
      timeline: [],
      dataSourcesConsulted: ['DevOps Agent'],
      hypothesesExplored: [],
    },
    rootCause: {
      summary: isCompleted
        ? '缓解计划已生成（接续上一条根因分析）'
        : `Mitigation ${detailType.replace('Mitigation ', '').toLowerCase()}`,
      category: 'unknown',
      details: '',
      confidence: isCompleted ? 'medium' : 'low',
      affectedResources: alarms.map((a) => formatResourceKey(a.resource)).filter((s) => !!s),
    },
    remediation: {
      immediateMitigation: mitigationPlan[0]?.step ?? '',
      longTermFix: '',
      steps: mitigationPlan.map((m) => m.step).filter(Boolean),
    },
    mitigationPlan: mitigationPlan.length > 0 ? mitigationPlan : undefined,
    executionId: event.detail.metadata.execution_id,
    taskId: event.detail.metadata.task_id,
    incidentId: record.executionId,
    reportPhase: 'mitigation',
    // Always pass the markdown through so the renderer can show it verbatim
    // when no structured plan was parsed.
    agentRawText: markdown || undefined,
  };
}

// -----------------------------------------------------------------------------
// DDB status updates
// -----------------------------------------------------------------------------

type RecordStatus =
  | 'pending'
  | 'investigation_completed'
  | 'mitigation_completed'
  | 'mitigation_failed'
  | 'failed'
  | 'timed_out';

async function updateRecord(
  rec: PendingRecord,
  patch: {
    status: RecordStatus;
    reason: string;
    taskId?: string;
  }
): Promise<void> {
  const tableName = process.env.WORKFLOW_EXECUTION_TABLE_NAME;
  if (!tableName) return;

  const setExpressions = [
    '#status = :s',
    'completedAt = :ct',
    'stateTransitions = list_append(if_not_exists(stateTransitions, :empty), :tr)',
  ];
  const exprValues: Record<string, any> = {
    ':s': patch.status,
    ':ct': new Date().toISOString(),
    ':empty': [],
    ':tr': [
      {
        from: 'pending',
        to: patch.status,
        timestamp: new Date().toISOString(),
        reason: patch.reason,
      },
    ],
  };

  if (patch.taskId) {
    setExpressions.push('taskId = :tid');
    exprValues[':tid'] = patch.taskId;
  }

  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          executionId: rec.executionId,
          createdAt: rec.createdAt,
        },
        UpdateExpression: 'SET ' + setExpressions.join(', '),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: exprValues,
      })
    );
  } catch (err) {
    console.warn('[InvestigationEventHandler] updateRecord failed', err);
  }
}

// -----------------------------------------------------------------------------
// "Generate mitigation plan" trigger (the console button equivalent)
// -----------------------------------------------------------------------------

/**
 * Calls UpdateBacklogTask to advance the same task into the mitigation phase.
 *
 * Discovered by inspecting CloudTrail logs of the console "Generate mitigation
 * plan" button: it issues `UpdateBacklogTask(taskStatus='PENDING_START',
 * currentVersion=<task.version>)`. The SDK type for UpdateBacklogTaskRequest
 * doesn't declare currentVersion, but the wire protocol accepts it.
 */
async function triggerMitigationGeneration(taskId: string): Promise<boolean> {
  if (!AGENT_SPACE_ID) {
    console.warn('[InvestigationEventHandler] AGENT_SPACE_ID not set; cannot trigger mitigation');
    return false;
  }
  try {
    // Read current version (optimistic-lock token).
    const get = await devopsClient.send(
      new GetBacklogTaskCommand({
        agentSpaceId: AGENT_SPACE_ID,
        taskId,
      })
    );
    const version = get.task?.version;
    if (typeof version !== 'number') {
      console.warn('[InvestigationEventHandler] task has no version; skip mitigation trigger', {
        taskId,
      });
      return false;
    }

    // Update with PENDING_START to kick off mitigation generation.
    // Pass currentVersion via untyped option (SDK type omits it).
    const updateInput: any = {
      agentSpaceId: AGENT_SPACE_ID,
      taskId,
      taskStatus: 'PENDING_START',
      currentVersion: version,
      clientToken: crypto.randomUUID(),
    };
    await devopsClient.send(new UpdateBacklogTaskCommand(updateInput));

    console.log(
      JSON.stringify({
        level: 'INFO',
        message: 'Mitigation generation triggered',
        taskId,
        previousVersion: version,
      })
    );
    return true;
  } catch (err) {
    console.error('[InvestigationEventHandler] triggerMitigationGeneration failed', err);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Phase-2 card delivery: async-invoke FeishuNotifier directly (no SFN)
// -----------------------------------------------------------------------------

async function dispatchMitigationCard(rcaReport: RCAReport): Promise<void> {
  if (!FEISHU_NOTIFIER_FN_NAME) {
    console.warn(
      '[InvestigationEventHandler] FEISHU_NOTIFIER_FN_NAME not configured; cannot send mitigation card'
    );
    return;
  }
  const payload: FeishuNotifierInput = {
    rcaReport,
    webhookUrls: [],
    notificationType: 'rca_complete',
  };
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: FEISHU_NOTIFIER_FN_NAME,
      InvocationType: 'Event', // fire-and-forget
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
}

// -----------------------------------------------------------------------------
// Chat-initiated investigation fallback
//
// When the SFN-pending lookup misses (i.e. this investigation didn't come from
// the CloudWatch alarm pipeline), check if it was created by the Feishu chat
// path: feishu-bot snapshots ListBacklogTasks before/after each SendMessage
// and writes a (taskId → chatId) mapping to ChatInvestigationMappingTable.
// If we find a mapping, async-invoke feishu-bot to fetch the journal summary
// and post it back to the originating chat.
// -----------------------------------------------------------------------------

interface ChatMapping {
  taskId: string;
  chatId: string;
  description?: string;
}

async function findChatMappingByTaskId(taskId: string): Promise<ChatMapping | null> {
  if (!CHAT_INVESTIGATION_MAPPING_TABLE_NAME) return null;
  try {
    const resp = await getDocClient().send(
      new GetCommand({
        TableName: CHAT_INVESTIGATION_MAPPING_TABLE_NAME,
        Key: { taskId },
      })
    );
    if (!resp.Item) return null;
    const item = resp.Item as Record<string, any>;
    if (!item.chatId) return null;
    return {
      taskId,
      chatId: String(item.chatId),
      description: item.description ? String(item.description) : undefined,
    };
  } catch (err) {
    console.warn('[InvestigationEventHandler] findChatMappingByTaskId failed', err);
    return null;
  }
}

/**
 * 带重试的 mapping 查询。
 *
 * 时序竞态：Agent 在 chat 流的中间就调用了 CreateBacklogTask，几秒后调查可能
 * 完成 → EventBridge 事件抵达 → handler 查 mapping。但 mapping 是 bot 端在
 * 流结束 *之后* 才写的，所以事件**可能比 mapping 还快**。
 *
 * 这里做指数退避：最多 6 次，总等待 ~ 60 秒，足以覆盖任何"流仍在串字"的场景。
 */
async function findChatMappingWithRetry(taskId: string): Promise<ChatMapping | null> {
  const delaysMs = [0, 3000, 5000, 10000, 15000, 25000];
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) await new Promise((r) => setTimeout(r, delaysMs[i]));
    const mapping = await findChatMappingByTaskId(taskId);
    if (mapping) {
      if (i > 0) {
        console.log(
          `[InvestigationEventHandler] chat mapping found on retry #${i} (waited ${delaysMs
            .slice(0, i + 1)
            .reduce((a, b) => a + b, 0)}ms)`
        );
      }
      return mapping;
    }
  }
  return null;
}

async function dispatchChatPushJob(args: {
  chatId: string;
  taskId: string;
  executionId?: string;
  status?: string;
  description?: string;
  phase?: 'investigation' | 'mitigation';
}): Promise<void> {
  if (!FEISHU_BOT_FN_NAME) {
    console.warn(
      '[InvestigationEventHandler] FEISHU_BOT_FN_NAME not configured; cannot push chat-initiated investigation result'
    );
    return;
  }
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: FEISHU_BOT_FN_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(
        JSON.stringify({
          __asyncJob: 'push_chat_investigation_result',
          ...args,
        })
      ),
    })
  );
  console.log(
    JSON.stringify({
      level: 'INFO',
      message: 'Dispatched chat investigation result push',
      taskId: args.taskId,
      chatId: args.chatId,
    })
  );
}

// -----------------------------------------------------------------------------
// Phase 1 handler
// -----------------------------------------------------------------------------

async function handleInvestigationEvent(event: InvestigationEvent): Promise<void> {
  const detailType = event['detail-type'] as InvestigationDetailType;
  const eventTaskId = event.detail.metadata.task_id;
  const executionIdFromEvent = event.detail.metadata.execution_id;

  if (!INVESTIGATION_TERMINAL_TYPES.includes(detailType)) {
    console.log('[InvestigationEventHandler] Non-terminal investigation event ignored');
    return;
  }

  // Phase-1 always uses the time-window lookup because we don't yet have taskId
  // stamped on the record.
  const pending = await findPendingByTimeWindow(event.time);
  if (!pending) {
    // SFN-pending miss → check chat-initiated path. If the user @-ed the bot
    // in Feishu and the agent autonomously created an INVESTIGATION task, the
    // bot has stored a (taskId → chatId) mapping. We push the journal summary
    // back to that chat directly, bypassing SFN entirely.
    //
    // 用带重试的查询，因为 EventBridge 事件可能比 bot 写映射还快到达。
    const chatMapping = await findChatMappingWithRetry(eventTaskId);
    if (chatMapping) {
      console.log(
        JSON.stringify({
          level: 'INFO',
          message: 'Investigation event matched chat mapping (no SFN pending)',
          taskId: eventTaskId,
          chatId: chatMapping.chatId,
          detailType,
        })
      );
      await emitMetric('InvestigationEventMatchedChat', 1);
      try {
        await dispatchChatPushJob({
          chatId: chatMapping.chatId,
          taskId: eventTaskId,
          executionId: executionIdFromEvent,
          status: event.detail.data.status,
          description: chatMapping.description,
          phase: 'investigation',
        });
      } catch (err) {
        console.error(
          '[InvestigationEventHandler] dispatchChatPushJob failed',
          err
        );
        await emitMetric('ChatPushDispatchFailed', 1);
      }

      // 跟 SFN 路径对齐：调查成功完成后,也自动触发 mitigation plan 生成。
      // 这就是控制台 "Generate mitigation plan" 按钮做的事 —
      // UpdateBacklogTask(taskStatus='PENDING_START', currentVersion=...)。
      // 几分钟后 EventBridge 会发 'Mitigation Completed' 事件,我们的
      // handleMitigationEvent fallback 也会从 chat mapping 推第二条 mitigation 卡片。
      if (detailType === 'Investigation Completed') {
        const ok = await triggerMitigationGeneration(eventTaskId);
        await emitMetric(ok ? 'MitigationTriggered' : 'MitigationTriggerFailed', 1);
        console.log(
          JSON.stringify({
            level: 'INFO',
            message: ok
              ? 'Triggered mitigation generation for chat-initiated investigation'
              : 'Failed to trigger mitigation generation for chat-initiated investigation',
            taskId: eventTaskId,
          })
        );
      }
      return;
    }

    console.warn(
      '[InvestigationEventHandler] No pending record matched investigation event',
      { eventTime: event.time, taskId: eventTaskId }
    );
    await emitMetric('InvestigationEventUnmatched', 1);
    return;
  }

  // Pull root-cause markdown.
  let markdown = '';
  if (executionIdFromEvent) {
    try {
      markdown = await fetchSummaryMarkdown(executionIdFromEvent, 'investigation_summary_md');
    } catch (err) {
      console.warn('[InvestigationEventHandler] fetchSummaryMarkdown(investigation) failed', err);
    }
  }

  const rcaReport = buildRootCauseReport({ pending, event, markdown });

  const sfnPayload: RCAAnalyzerOutput = {
    rcaReport,
    status:
      rcaReport.status === 'completed'
        ? 'completed'
        : rcaReport.status === 'timeout'
        ? 'partial'
        : 'partial',
    duration: 0,
  };

  // Wake up SFN so the first card goes out via the existing FeishuNotifier path.
  try {
    await sfnClient.send(
      new SendTaskSuccessCommand({
        taskToken: pending.taskToken,
        output: JSON.stringify(sfnPayload),
      })
    );
    await emitMetric('InvestigationEventMatched', 1);
    console.log(
      JSON.stringify({
        level: 'INFO',
        message: 'Phase-1 SendTaskSuccess delivered',
        incidentId: pending.executionId,
        sfnStatus: sfnPayload.status,
      })
    );
  } catch (err) {
    console.error(
      '[InvestigationEventHandler] Phase-1 SendTaskSuccess failed; trying SendTaskFailure',
      err
    );
    try {
      await sfnClient.send(
        new SendTaskFailureCommand({
          taskToken: pending.taskToken,
          error: 'EventHandlerFailed',
          cause: err instanceof Error ? err.message : String(err),
        })
      );
    } catch (failErr) {
      console.error('[InvestigationEventHandler] SendTaskFailure also failed', failErr);
    }
    await emitMetric('InvestigationEventDeliveryFailed', 1);
    return;
  }

  // If investigation completed successfully, trigger mitigation generation.
  // Other terminal states (Failed/TimedOut/Cancelled/Skipped) don't have a
  // mitigation phase by definition.
  let nextStatus: RecordStatus = 'investigation_completed';
  if (detailType === 'Investigation Completed') {
    const ok = await triggerMitigationGeneration(eventTaskId);
    await emitMetric(ok ? 'MitigationTriggered' : 'MitigationTriggerFailed', 1);
    if (!ok) {
      nextStatus = 'mitigation_failed'; // we won't get a mitigation event
    }
  } else {
    nextStatus = detailType === 'Investigation Timed Out' ? 'timed_out' : 'failed';
  }

  await updateRecord(pending, {
    status: nextStatus,
    reason: detailType,
    taskId: eventTaskId,
  });
}

// -----------------------------------------------------------------------------
// Phase 2 handler
// -----------------------------------------------------------------------------

async function handleMitigationEvent(event: InvestigationEvent): Promise<void> {
  const detailType = event['detail-type'] as MitigationDetailType;
  const eventTaskId = event.detail.metadata.task_id;

  if (!MITIGATION_TERMINAL_TYPES.includes(detailType)) {
    console.log('[InvestigationEventHandler] Non-terminal mitigation event ignored');
    return;
  }

  const record = await findRecordByTaskId(eventTaskId, event.time);
  if (!record) {
    // SFN-record miss → check if this came from the Feishu chat path. The
    // bot stored a (taskId → chatId) mapping when the agent autonomously
    // created the original investigation; that same taskId now drives the
    // mitigation event.
    const chatMapping = await findChatMappingWithRetry(eventTaskId);
    if (chatMapping) {
      console.log(
        JSON.stringify({
          level: 'INFO',
          message: 'Mitigation event matched chat mapping (no SFN record)',
          taskId: eventTaskId,
          chatId: chatMapping.chatId,
          detailType,
        })
      );
      await emitMetric('MitigationEventMatchedChat', 1);
      try {
        await dispatchChatPushJob({
          chatId: chatMapping.chatId,
          taskId: eventTaskId,
          status: event.detail.data.status,
          description: chatMapping.description,
          phase: 'mitigation',
        });
      } catch (err) {
        console.error(
          '[InvestigationEventHandler] dispatchChatPushJob (mitigation) failed',
          err
        );
        await emitMetric('ChatPushDispatchFailed', 1);
      }
      return;
    }

    console.warn(
      '[InvestigationEventHandler] No record matched mitigation event by taskId',
      { taskId: eventTaskId }
    );
    await emitMetric('MitigationEventUnmatched', 1);
    return;
  }

  // EventBridge 的 metadata.execution_id 在 Mitigation* 事件里给的是
  // ops1 (investigation) execution,不是 mitigation execution。
  // mitigation_summary_md 只存在于 agentType=mitigation 的 execution journal 里,
  // 所以必须先 ListExecutions(taskId) 找出真正的 mitigation execution。
  const mitigationExecutionId = await findMitigationExecutionId(eventTaskId);

  let markdown = '';
  if (mitigationExecutionId) {
    try {
      markdown = await fetchSummaryMarkdown(mitigationExecutionId, 'mitigation_summary_md');
    } catch (err) {
      console.warn(
        '[InvestigationEventHandler] fetchSummaryMarkdown(mitigation) failed',
        err
      );
    }
  } else {
    console.warn(
      '[InvestigationEventHandler] Could not resolve mitigation execution for task',
      { taskId: eventTaskId }
    );
  }

  console.log(
    JSON.stringify({
      level: 'INFO',
      message: 'Phase-2 markdown resolved',
      taskId: eventTaskId,
      mitigationExecutionId,
      markdownLen: markdown.length,
    })
  );

  const rcaReport = buildMitigationReport({ record, event, markdown });
  // 把真正解析到的 mitigation execution id 写到 RCAReport 上,飞书卡片
  // 按钮才能跳到正确的页面（虽然现在统一回 dashboard,留着不浪费）。
  if (mitigationExecutionId) {
    rcaReport.executionId = mitigationExecutionId;
  }

  // Send the second card directly (bypassing SFN — that workflow already finished).
  try {
    await dispatchMitigationCard(rcaReport);
    await emitMetric('MitigationEventMatched', 1);
    await updateRecord(record, {
      status: detailType === 'Mitigation Completed' ? 'mitigation_completed' : 'mitigation_failed',
      reason: detailType,
      taskId: eventTaskId,
    });
    console.log(
      JSON.stringify({
        level: 'INFO',
        message: 'Phase-2 mitigation card dispatched',
        incidentId: record.executionId,
        taskId: eventTaskId,
        markdownLen: markdown.length,
      })
    );
  } catch (err) {
    console.error('[InvestigationEventHandler] Phase-2 dispatch failed', err);
    await emitMetric('MitigationCardDispatchFailed', 1);
  }
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export const handler = async (event: InvestigationEvent): Promise<void> => {
  const detailType = event['detail-type'];

  console.log(
    JSON.stringify({
      level: 'INFO',
      message: 'InvestigationEventHandler received event',
      detailType,
      taskId: event.detail.metadata.task_id,
      executionId: event.detail.metadata.execution_id,
      eventTime: event.time,
    })
  );

  if (typeof detailType === 'string' && detailType.startsWith('Investigation ')) {
    await handleInvestigationEvent(event);
    return;
  }
  if (typeof detailType === 'string' && detailType.startsWith('Mitigation ')) {
    await handleMitigationEvent(event);
    return;
  }
  console.warn('[InvestigationEventHandler] Unknown detail-type, ignored', detailType);
};
