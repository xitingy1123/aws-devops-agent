import { AlarmRouterInput, AlarmRouterOutput, ResourceIdentifier } from '../../shared/types';

/**
 * Parse a CloudWatch Alarm State Change event into a structured AlarmRouterOutput.
 *
 * Supports:
 * - Single metric alarms
 * - Metric math expression alarms
 * - Anomaly detection alarms
 * - Composite alarms (no metric info)
 *
 * Returns filtered: true with filterReason for malformed events.
 */
export function parseAlarmEvent(event: AlarmRouterInput): AlarmRouterOutput {
  try {
    return extractAlarmFields(event);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown parsing error';
    return buildFilteredOutput(event, reason);
  }
}

function extractAlarmFields(event: AlarmRouterInput): AlarmRouterOutput {
  const detail = event.detail;

  if (!detail || !detail.alarmName) {
    throw new Error('Missing required field: detail.alarmName');
  }

  if (!detail.state || !detail.state.timestamp) {
    throw new Error('Missing required field: detail.state.timestamp');
  }

  const alarmName = detail.alarmName;
  const stateChangeTimestamp = detail.state.timestamp;
  const previousState = detail.previousState?.value ?? 'UNKNOWN';
  const accountId = event.account ?? '';
  const region = event.region ?? '';
  const alarmId = event.resources?.[0] ?? '';

  // Extract metric info (namespace, metricName, dimensions)
  const metricInfo = extractMetricInfo(detail);

  // Extract threshold and current value from reasonData
  const { threshold, currentValue } = extractThresholdAndValue(detail);

  const resource = extractResourceIdentifier(
    metricInfo.namespace,
    metricInfo.dimensions,
    accountId,
    region,
  );

  return {
    alarmId,
    alarmName,
    namespace: metricInfo.namespace,
    metricName: metricInfo.metricName,
    dimensions: metricInfo.dimensions,
    threshold,
    currentValue,
    stateChangeTimestamp,
    previousState,
    accountId,
    region,
    resource,
    filtered: false,
  };
}

interface MetricInfo {
  namespace: string;
  metricName: string;
  dimensions: Record<string, string>;
}

/**
 * Extract metric information from the alarm configuration.
 * Handles single metric, metric math, anomaly detection, and composite alarms.
 */
function extractMetricInfo(detail: AlarmRouterInput['detail']): MetricInfo {
  const metrics = detail.configuration?.metrics;

  // Composite alarms have no metrics array
  if (!metrics || metrics.length === 0) {
    return { namespace: '', metricName: '', dimensions: {} };
  }

  // Find the first metric with a metricStat (covers single metric and metric math)
  const metricWithStat = metrics.find((m) => m.metricStat != null);

  if (metricWithStat?.metricStat) {
    const metric = metricWithStat.metricStat.metric;
    return {
      namespace: metric.namespace ?? '',
      metricName: metric.name ?? '',
      dimensions: metric.dimensions ?? {},
    };
  }

  // All metrics are expressions (anomaly detection band or pure math)
  // Try to find any metric that has returnData: true and a metricStat
  const returnDataMetric = metrics.find((m) => m.returnData && m.metricStat != null);
  if (returnDataMetric?.metricStat) {
    const metric = returnDataMetric.metricStat.metric;
    return {
      namespace: metric.namespace ?? '',
      metricName: metric.name ?? '',
      dimensions: metric.dimensions ?? {},
    };
  }

  // No metricStat found at all (pure expression-based or anomaly detection without direct metric)
  return { namespace: '', metricName: '', dimensions: {} };
}

/**
 * Extract threshold and current value from the state reasonData JSON string.
 */
function extractThresholdAndValue(detail: AlarmRouterInput['detail']): {
  threshold: number;
  currentValue: number;
} {
  const reasonData = detail.state?.reasonData;

  if (!reasonData) {
    return { threshold: 0, currentValue: 0 };
  }

  try {
    const parsed = JSON.parse(reasonData);

    // Standard metric alarm reasonData format
    const threshold = typeof parsed.threshold === 'number' ? parsed.threshold : 0;

    // currentValue can be in different fields depending on alarm type
    let currentValue = 0;
    if (typeof parsed.recentDatapoints === 'object' && Array.isArray(parsed.recentDatapoints)) {
      // Use the most recent datapoint
      const datapoints = parsed.recentDatapoints.filter(
        (dp: unknown) => typeof dp === 'number'
      );
      if (datapoints.length > 0) {
        currentValue = datapoints[datapoints.length - 1];
      }
    } else if (typeof parsed.queryResultValue === 'number') {
      currentValue = parsed.queryResultValue;
    } else if (typeof parsed.evaluatedDatapoints === 'object' && Array.isArray(parsed.evaluatedDatapoints)) {
      // Anomaly detection or newer format
      const evaluated = parsed.evaluatedDatapoints;
      if (evaluated.length > 0 && typeof evaluated[0].value === 'number') {
        currentValue = evaluated[0].value;
      }
    }

    return { threshold, currentValue };
  } catch {
    // Invalid JSON in reasonData
    return { threshold: 0, currentValue: 0 };
  }
}

/**
 * Build a generic ResourceIdentifier from alarm metric info.
 *
 * 不再尝试拼成 ARN ——CloudWatch 告警事件本身不带 ARN，且每个服务 ARN
 * 格式都不同，硬要支持就要列 200+ 服务。这里用 (accountId, region,
 * service, resourceId) 四元组通用表达：
 *
 *   service:    从 namespace 推断
 *               - "AWS/EC2"   → "ec2"
 *               - "AWS/Lambda" → "lambda"
 *               - "AWS/ApplicationELB" → "applicationelb"
 *               - 自定义 namespace 原样保留（如 "MyApp/Backend"）
 *
 *   resourceId: 取 dimensions 第一个值
 *               - InstanceId / FunctionName / TableName / BucketName / ...
 *                 这些都是单维度告警，第一个值就是主资源 ID
 *               - ECS 等少数多维度场景把所有值用 "/" 拼起来
 *                 （如 ClusterName=prod, ServiceName=api → "prod/api"）
 *               - 没维度（composite alarm）则为空字符串
 *
 * 这种表达对所有 AWS 服务都适用——任何服务的告警都至少有 namespace 和
 * 维度，缺一个最坏退化到空 resourceId（DDB partition 仍能正常工作）。
 */
function extractResourceIdentifier(
  namespace: string,
  dimensions: Record<string, string>,
  accountId: string,
  region: string,
): ResourceIdentifier {
  return {
    accountId,
    region,
    service: serviceFromNamespace(namespace),
    resourceId: resourceIdFromDimensions(dimensions),
  };
}

/**
 * Convert CloudWatch metric namespace to a short service slug.
 * "AWS/EC2" → "ec2"; "AWS/ApplicationELB" → "applicationelb"; custom kept as-is.
 */
function serviceFromNamespace(namespace: string): string {
  if (!namespace) return '';
  if (namespace.startsWith('AWS/')) {
    return namespace.slice(4).toLowerCase();
  }
  return namespace; // 自定义 namespace 原样返回（保留用户的命名约定）
}

/**
 * Pick the most meaningful resource identifier from the dimensions.
 * 99% of CloudWatch alarms have 1-2 dimensions where the first value is the
 * primary resource. Multi-dim cases (ECS) are joined with `/`.
 */
function resourceIdFromDimensions(dimensions: Record<string, string>): string {
  if (!dimensions) return '';
  const values = Object.values(dimensions).filter(Boolean);
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  // 多维度：所有值用 / 拼起来。比如 ECS 的 (ClusterName, ServiceName) → "prod/api"
  return values.join('/');
}

/**
 * Build a filtered output with safe defaults for all fields.
 */
function buildFilteredOutput(event: AlarmRouterInput, filterReason: string): AlarmRouterOutput {
  const accountId = event?.account ?? '';
  const region = event?.region ?? '';
  return {
    alarmId: event?.resources?.[0] ?? '',
    alarmName: event?.detail?.alarmName ?? '',
    namespace: '',
    metricName: '',
    dimensions: {},
    threshold: 0,
    currentValue: 0,
    stateChangeTimestamp: event?.detail?.state?.timestamp ?? event?.time ?? '',
    previousState: event?.detail?.previousState?.value ?? 'UNKNOWN',
    accountId,
    region,
    resource: { accountId, region, service: '', resourceId: '' },
    filtered: true,
    filterReason,
  };
}
