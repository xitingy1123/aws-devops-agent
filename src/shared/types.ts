// =============================================================================
// Core Interfaces & Types for CloudWatch Alarm Auto RCA
// =============================================================================

// -----------------------------------------------------------------------------
// CloudWatch Alarm Event Types
// -----------------------------------------------------------------------------

/**
 * CloudWatch Alarm State Change event detail structure.
 */
export interface CloudWatchAlarmDetail {
  alarmName: string;
  state: {
    value: string;
    reason: string;
    reasonData?: string;
    timestamp: string;
    actionsSuppressedBy?: string;
  };
  previousState: {
    value: string;
    reason: string;
    reasonData?: string;
    timestamp: string;
  };
  configuration: {
    description?: string;
    metrics?: Array<{
      id: string;
      metricStat?: {
        metric: {
          namespace: string;
          name: string;
          dimensions: Record<string, string>;
        };
        period: number;
        stat: string;
      };
      expression?: string;
      returnData: boolean;
    }>;
  };
}

// -----------------------------------------------------------------------------
// AlarmRouter Interfaces
// -----------------------------------------------------------------------------

/**
 * Input: EventBridge CloudWatch Alarm State Change event.
 */
export interface AlarmRouterInput {
  version: string;
  id: string;
  "detail-type": "CloudWatch Alarm State Change";
  source: "aws.cloudwatch";
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: CloudWatchAlarmDetail;
}

/**
 * Output: Structured alarm information with filtering status.
 */
export interface AlarmRouterOutput {
  alarmId: string;
  alarmName: string;
  namespace: string;
  metricName: string;
  dimensions: Record<string, string>;
  threshold: number;
  currentValue: number;
  stateChangeTimestamp: string;
  previousState: string;
  accountId: string;
  region: string;
  /**
   * 资源标识。不再拼成 ARN——CloudWatch 告警事件本身不带 ARN，
   * 不同 AWS 服务 ARN 格式各异，硬要拼会漏掉很多服务。
   * 用 (accountId, region, service, resourceId) 四元组通用表达，
   * 任何服务都能描述。
   */
  resource: ResourceIdentifier;
  filtered: boolean;
  filterReason?: string;
}

/**
 * 资源标识符。
 * 由 alarm-router 从告警的 namespace + dimensions 中提取：
 *   - service: 从 namespace 推断（如 `AWS/EC2` → `ec2`）。
 *     自定义 namespace 原样保留（如 `MyApp/Backend`）。
 *   - resourceId: 取 dimensions 第一个值（绝大多数告警只有 1-2 个维度，
 *     第一个维度就是主资源标识，比如 InstanceId / FunctionName）。
 *     ECS 等多维度场景拼成 `cluster/service` 形式。
 *     没有 dimension 时为空字符串（如 composite alarm）。
 */
export interface ResourceIdentifier {
  accountId: string;
  region: string;
  service: string;
  resourceId: string;
}

/**
 * 把 ResourceIdentifier 序列化成 DDB partition key / 显示用的字符串：
 *   `accountId/service/region/resourceId`
 * 当 resourceId 为空时退化为 `accountId/service/region`。
 */
export function formatResourceKey(r: ResourceIdentifier): string {
  const base = `${r.accountId}/${r.service}/${r.region}`;
  return r.resourceId ? `${base}/${r.resourceId}` : base;
}

// -----------------------------------------------------------------------------
// AlarmGrouper Interfaces
// -----------------------------------------------------------------------------

/**
 * Input: Alarm to be grouped.
 */
export interface AlarmGrouperInput {
  alarm: AlarmRouterOutput;
}

/**
 * Output: Grouping result with aggregation info.
 */
export interface AlarmGrouperOutput {
  groupId: string;
  alarms: AlarmRouterOutput[];
  isNewGroup: boolean;
  shouldWait: boolean;
  waitUntil?: string;
}

// -----------------------------------------------------------------------------
// RCAAnalyzer Interfaces
// -----------------------------------------------------------------------------

/**
 * Input: Alarm group for RCA analysis.
 */
export interface RCAAnalyzerInput {
  groupId: string;
  alarms: AlarmRouterOutput[];
}

/**
 * Output: RCA analysis result.
 */
export interface RCAAnalyzerOutput {
  rcaReport: RCAReport;
  status: "completed" | "partial" | "failed";
  duration: number;
}

// -----------------------------------------------------------------------------
// RCA Report Model
// -----------------------------------------------------------------------------

/**
 * Full RCA report with alarm summary, investigation, root cause, and remediation.
 */
export interface RCAReport {
  reportId: string;
  groupId: string;
  generatedAt: string;
  status: "completed" | "partial" | "timeout";

  alarmSummary: {
    alarmCount: number;
    alarms: Array<{
      alarmName: string;
      namespace: string;
      metricName: string;
      currentValue: number;
      threshold: number;
      resource: string;
    }>;
    firstAlarmTime: string;
    lastAlarmTime: string;
  };

  investigation: {
    timeline: Array<{
      timestamp: string;
      action: string;
      finding: string;
    }>;
    dataSourcesConsulted: string[];
    hypothesesExplored: string[];
  };

  rootCause: {
    summary: string;
    category:
      | "system_change"
      | "input_anomaly"
      | "resource_limit"
      | "component_failure"
      | "dependency_issue"
      | "unknown";
    details: string;
    confidence: "high" | "medium" | "low";
    affectedResources: string[];
  };

  remediation: {
    immediateMitigation: string;
    longTermFix: string;
    steps: string[];
    rollbackPlan?: string;
  };

  /**
   * 高层业务/用户影响描述（来自 DevOps Agent 调查输出的 Impact 模块）。
   */
  impact?: string;

  /**
   * 调查过程中按时间顺序整理的关键发现（指标变化、日志异常、配置变更等）。
   */
  keyFindings?: string[];

  /**
   * 调查过的假设列表。每条说明假设是否成立及推理过程。
   */
  hypothesesDetailed?: Array<{
    hypothesis: string;
    supported: boolean;
    reasoning: string;
  }>;

  /**
   * 全部识别出的根因。当数组非空时，UI 应使用本字段渲染多根因；
   * 否则回退到 rootCause 单字段。
   */
  rootCauses?: Array<{
    summary: string;
    details: string;
    evidence?: string;
  }>;

  /**
   * 完整的缓解计划（步骤、命令、回滚方案）。
   * 当存在时，UI 应优先使用本字段而非 remediation.steps。
   */
  mitigationPlan?: Array<{
    step: string;
    command?: string;
    rollback?: string;
  }>;

  /**
   * DevOps Agent investigation execution ID（来自 EventBridge 'Investigation Created'
   * 事件中的 detail.metadata.execution_id）。用于在飞书卡片里拼控制台 deep link
   * `https://{agentSpaceId}.aidevops.global.app.aws/home/activity/{executionId}`。
   *
   * 注意：这里的 executionId 是 DevOps Agent investigation task 的 execution_id，
   * 不是 Step Functions execution ID，也不是 CreateChat 返回的 chat session ID。
   */
  executionId?: string;

  /**
   * DevOps Agent investigation task ID（同事件中的 detail.metadata.task_id）。
   * 主要用于 ListJournalRecords / GetBacklogTask 反查。
   */
  taskId?: string;

  /**
   * 触发本次调查时由我们生成的 incidentId（webhook payload 里发出去的）。
   * 用于追踪 / 去重。
   */
  incidentId?: string;

  /**
   * 报告阶段标记。在双卡片流程下：
   *   - 'investigation'（默认）：第一条卡片，内容包含 root cause + investigation timeline
   *   - 'mitigation'：第二条卡片，仅包含 mitigation plan 内容
   *
   * 用于让 card-formatter 准确识别该用哪种渲染模板，不依赖于 mitigationPlan
   * 是否被解析出步骤——因为 DevOps Agent 在"无需操作"等场景下会以散文形式
   * 输出 mitigation,正则解不出步骤,但卡片仍然应该显示成 mitigation 卡片。
   */
  reportPhase?: 'investigation' | 'mitigation';

  /**
   * DevOps Agent 调查的原始 markdown 输出，作为 fallback 信息。
   */
  agentRawText?: string;
}

// -----------------------------------------------------------------------------
// Feishu Text Message (for fallback when card is too long)
// -----------------------------------------------------------------------------

/**
 * Feishu plain text message format. Used when the interactive card exceeds
 * Feishu's per-element (30k chars) or total length limits.
 */
export interface FeishuTextMessage {
  msg_type: "text";
  content: { text: string };
}

/**
 * Union type covering both interactive cards and plain text fallbacks.
 */
export type FeishuMessage = FeishuCardMessage | FeishuTextMessage;

// -----------------------------------------------------------------------------
// FeishuNotifier Interfaces
// -----------------------------------------------------------------------------

/**
 * Input: Notification delivery request.
 */
export interface FeishuNotifierInput {
  rcaReport: RCAReport;
  webhookUrls: string[];
  notificationType: "rca_complete" | "rca_timeout" | "rca_partial";
}

/**
 * Output: Notification delivery result.
 */
export interface FeishuNotifierOutput {
  success: boolean;
  sentTo: string[];
  failedTo: string[];
  retryCount: number;
}

/**
 * Feishu card element type (simplified).
 */
export interface FeishuCardElement {
  tag: string;
  text?: { tag: string; content: string };
  content?: string;
  actions?: Array<{ tag: string; text: { tag: string; content: string }; url?: string }>;
  [key: string]: unknown;
}

/**
 * Feishu interactive card message format.
 */
export interface FeishuCardMessage {
  msg_type: "interactive";
  card: {
    header: {
      title: { tag: "plain_text"; content: string };
      template: "red" | "orange" | "green";
    };
    elements: FeishuCardElement[];
  };
}

// -----------------------------------------------------------------------------
// Data Models (DynamoDB)
// -----------------------------------------------------------------------------

/**
 * Workflow execution record stored in DynamoDB.
 */
export interface WorkflowExecution {
  executionId: string;
  createdAt: string;
  status: "pending" | "analyzing" | "completed" | "failed" | "timed_out" | "notified";
  groupId: string;
  alarmArns: string[];
  /**
   * 受影响资源标识（formatResourceKey 的字符串形式）。
   * 历史字段名沿用 `resourceArns`，避免 DDB 现有数据 schema 大改；
   * 内容已经从真正的 ARN 切换为 `accountId/service/region/resourceId`。
   */
  resourceArns: string[];
  startedAt: string;
  completedAt?: string;
  rcaReportId?: string;
  notificationStatus?: "sent" | "partial" | "failed";
  stateTransitions: Array<{
    from: string;
    to: string;
    timestamp: string;
    reason?: string;
  }>;
  ttl: number;
}

/**
 * Alarm group model stored in DynamoDB.
 */
export interface AlarmGroup {
  /**
   * DDB partition key。值为 formatResourceKey(resource) 的结果，
   * 字段名保留 `resourceArn` 是为了不动 DDB schema 名（partitionKey 的 name
   * 在 CDK 里叫 `resourceArn`）。内容已经是 `accountId/service/region/resourceId`。
   */
  resourceArn: string;
  groupId: string;
  alarms: AlarmRouterOutput[];
  windowStart: string;
  windowEnd: string;
  status: "collecting" | "processing" | "done";
  ttl: number;
}

// -----------------------------------------------------------------------------
// Configuration Models (SSM Parameter Store)
// -----------------------------------------------------------------------------

/**
 * Alarm filter rule definition.
 */
export interface AlarmFilterRule {
  type: "namespace" | "name_pattern";
  value: string;
  action: "include" | "exclude";
}

/**
 * Webhook routing rule.
 */
export interface WebhookRoutingRule {
  field: "namespace";
  pattern: string;
  match: "equals" | "contains" | "regex";
}

/**
 * Webhook configuration with routing rules.
 */
export interface WebhookConfig {
  url: string;
  name: string;
  routingRules: WebhookRoutingRule[];
}

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {
  maxRetries: number;
  initialDelay: number;
  backoffMultiplier: number;
}

/**
 * System configuration stored in SSM Parameter Store.
 */
export interface SystemConfig {
  version: string;
  alarmSelectionMode: "all" | "custom";
  selectedAlarmNames: string[];
  alarmFilters: AlarmFilterRule[];
  feishuWebhooks: WebhookConfig[];
  rcaTimeout: number;
  retryPolicy: RetryPolicy;
  groupingWindow: number;
  retentionDays: number;
}
