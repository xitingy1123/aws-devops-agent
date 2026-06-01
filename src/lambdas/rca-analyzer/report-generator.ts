import * as crypto from 'crypto';
import { AlarmRouterOutput, RCAReport, formatResourceKey } from '../../shared/types';

/**
 * Legacy-shaped agent response used by `generateFullReport` / `generatePartialReport`
 * / `generateTimeoutReport`.
 *
 * The webhook-mode rca-analyzer no longer produces this directly — it triggers an
 * investigation and lets `investigation-event-handler` build the RCAReport from
 * the EventBridge event + journal records. But `generatePartialReport` /
 * `generateTimeoutReport` are still used as defensive fallbacks (e.g., when the
 * webhook trigger itself fails fast and we want to render a degraded card),
 * and the unit/property tests cover this mapping logic.
 */
export interface AgentResponse {
  success: boolean;
  data?: any;
  error?: string;
  timedOut?: boolean;
}

/**
 * Builds the alarm summary section from the input alarms.
 */
function buildAlarmSummary(alarms: AlarmRouterOutput[]): RCAReport['alarmSummary'] {
  const timestamps = alarms
    .map((a) => a.stateChangeTimestamp)
    .filter((ts) => ts !== '')
    .map((ts) => new Date(ts).getTime())
    .filter((t) => !isNaN(t));

  const firstAlarmTime =
    timestamps.length > 0
      ? new Date(Math.min(...timestamps)).toISOString()
      : new Date().toISOString();

  const lastAlarmTime =
    timestamps.length > 0
      ? new Date(Math.max(...timestamps)).toISOString()
      : new Date().toISOString();

  return {
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
  };
}

/**
 * Generates a full RCA report from a successful DevOps Agent response.
 *
 * @param agentResponse - The successful response from the DevOps Agent
 * @param alarms - The alarm data that triggered the analysis
 * @param groupId - The alarm group identifier
 * @returns A complete RCAReport with status "completed"
 */
export function generateFullReport(
  agentResponse: AgentResponse,
  alarms: AlarmRouterOutput[],
  groupId: string
): RCAReport {
  const data = agentResponse.data || {};

  const investigation: RCAReport['investigation'] = {
    timeline: Array.isArray(data.timeline)
      ? data.timeline.map((entry: any) => ({
          timestamp: entry.timestamp || new Date().toISOString(),
          action: entry.action || '',
          finding: entry.finding || '',
        }))
      : [],
    dataSourcesConsulted: Array.isArray(data.dataSourcesConsulted)
      ? data.dataSourcesConsulted
      : [],
    hypothesesExplored: Array.isArray(data.hypothesesExplored)
      ? data.hypothesesExplored
      : [],
  };

  const rootCause: RCAReport['rootCause'] = {
    summary: data.rootCause?.summary || 'Root cause identified by DevOps Agent',
    category: validateCategory(data.rootCause?.category) || 'unknown',
    details: data.rootCause?.details || '',
    confidence: validateConfidence(data.rootCause?.confidence) || 'medium',
    affectedResources: Array.isArray(data.rootCause?.affectedResources)
      ? data.rootCause.affectedResources
      : alarms.map((a) => formatResourceKey(a.resource)).filter((s) => s !== ''),
  };

  const remediation: RCAReport['remediation'] = {
    immediateMitigation: data.remediation?.immediateMitigation || '',
    longTermFix: data.remediation?.longTermFix || '',
    steps: Array.isArray(data.remediation?.steps) ? data.remediation.steps : [],
    rollbackPlan: data.remediation?.rollbackPlan,
  };

  return {
    reportId: crypto.randomUUID(),
    groupId,
    generatedAt: new Date().toISOString(),
    status: 'completed',
    alarmSummary: buildAlarmSummary(alarms),
    investigation,
    rootCause,
    remediation,
    impact: typeof data.impact === 'string' ? data.impact : undefined,
    keyFindings: Array.isArray(data.keyFindings) ? data.keyFindings : undefined,
    hypothesesDetailed: Array.isArray(data.hypothesesDetailed) ? data.hypothesesDetailed : undefined,
    rootCauses: Array.isArray(data.rootCauses) ? data.rootCauses : undefined,
    mitigationPlan: Array.isArray(data.mitigationPlan) ? data.mitigationPlan : undefined,
    executionId: typeof data.executionId === 'string' ? data.executionId : undefined,
    taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
    incidentId: typeof data.incidentId === 'string' ? data.incidentId : undefined,
    reportPhase:
      data.reportPhase === 'investigation' || data.reportPhase === 'mitigation'
        ? data.reportPhase
        : undefined,
    agentRawText: typeof data.agentRawText === 'string' ? data.agentRawText : undefined,
  };
}

/**
 * Generates a partial RCA report when the DevOps Agent failed after all retries.
 *
 * @param agentResponse - The failed response from the DevOps Agent
 * @param alarms - The alarm data that triggered the analysis
 * @param groupId - The alarm group identifier
 * @returns A partial RCAReport with status "partial"
 */
export function generatePartialReport(
  agentResponse: AgentResponse,
  alarms: AlarmRouterOutput[],
  groupId: string
): RCAReport {
  return {
    reportId: crypto.randomUUID(),
    groupId,
    generatedAt: new Date().toISOString(),
    status: 'partial',
    alarmSummary: buildAlarmSummary(alarms),
    investigation: {
      timeline: [
        {
          timestamp: new Date().toISOString(),
          action: 'DevOps Agent invocation',
          finding: `Analysis incomplete: ${agentResponse.error || 'Agent failed after retries'}`,
        },
      ],
      dataSourcesConsulted: [],
      hypothesesExplored: [],
    },
    rootCause: {
      summary: 'Root cause analysis incomplete due to agent failure',
      category: 'unknown',
      details: agentResponse.error || 'DevOps Agent was unavailable or returned an error after all retries',
      confidence: 'low',
      affectedResources: alarms.map((a) => formatResourceKey(a.resource)).filter((s) => s !== ''),
    },
    remediation: {
      immediateMitigation: 'Manual investigation required',
      longTermFix: '',
      steps: ['Review CloudWatch metrics for affected resources', 'Check CloudTrail for recent changes', 'Retry RCA analysis when DevOps Agent is available'],
    },
  };
}

/**
 * Generates a timeout RCA report when the DevOps Agent timed out.
 *
 * @param agentResponse - The timed-out response from the DevOps Agent
 * @param alarms - The alarm data that triggered the analysis
 * @param groupId - The alarm group identifier
 * @returns A timeout RCAReport with status "timeout"
 */
export function generateTimeoutReport(
  agentResponse: AgentResponse,
  alarms: AlarmRouterOutput[],
  groupId: string
): RCAReport {
  return {
    reportId: crypto.randomUUID(),
    groupId,
    generatedAt: new Date().toISOString(),
    status: 'timeout',
    alarmSummary: buildAlarmSummary(alarms),
    investigation: {
      timeline: [
        {
          timestamp: new Date().toISOString(),
          action: 'DevOps Agent invocation',
          finding: `Analysis timed out: ${agentResponse.error || 'Agent exceeded timeout limit'}`,
        },
      ],
      dataSourcesConsulted: [],
      hypothesesExplored: [],
    },
    rootCause: {
      summary: 'Root cause analysis timed out',
      category: 'unknown',
      details: agentResponse.error || 'DevOps Agent did not respond within the configured timeout',
      confidence: 'low',
      affectedResources: alarms.map((a) => formatResourceKey(a.resource)).filter((s) => s !== ''),
    },
    remediation: {
      immediateMitigation: 'Manual investigation required',
      longTermFix: '',
      steps: ['Review CloudWatch metrics for affected resources', 'Check CloudTrail for recent changes', 'Retry RCA analysis with extended timeout'],
    },
  };
}

/**
 * Main entry point: generates an RCA report based on the agent response status.
 *
 * - If the agent response is successful, generates a full report.
 * - If the agent timed out, generates a timeout report.
 * - If the agent failed (non-timeout), generates a partial report.
 *
 * @param agentResponse - The response from the DevOps Agent
 * @param alarms - The alarm data that triggered the analysis
 * @param groupId - The alarm group identifier
 * @returns An RCAReport with appropriate status
 */
export function generateRCAReport(
  agentResponse: AgentResponse,
  alarms: AlarmRouterOutput[],
  groupId: string
): RCAReport {
  if (agentResponse.success) {
    return generateFullReport(agentResponse, alarms, groupId);
  }

  if (agentResponse.timedOut) {
    return generateTimeoutReport(agentResponse, alarms, groupId);
  }

  return generatePartialReport(agentResponse, alarms, groupId);
}

/**
 * Validates that a category string is one of the allowed values.
 */
function validateCategory(
  category: string | undefined
): RCAReport['rootCause']['category'] | undefined {
  const validCategories: RCAReport['rootCause']['category'][] = [
    'system_change',
    'input_anomaly',
    'resource_limit',
    'component_failure',
    'dependency_issue',
    'unknown',
  ];
  if (category && validCategories.includes(category as any)) {
    return category as RCAReport['rootCause']['category'];
  }
  return undefined;
}

/**
 * Validates that a confidence string is one of the allowed values.
 */
function validateConfidence(
  confidence: string | undefined
): RCAReport['rootCause']['confidence'] | undefined {
  const validConfidences: RCAReport['rootCause']['confidence'][] = ['high', 'medium', 'low'];
  if (confidence && validConfidences.includes(confidence as any)) {
    return confidence as RCAReport['rootCause']['confidence'];
  }
  return undefined;
}
