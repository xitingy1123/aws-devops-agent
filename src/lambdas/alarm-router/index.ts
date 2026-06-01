import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { AlarmRouterInput, AlarmRouterOutput } from '../../shared/types';
import { ConfigManager } from '../../shared/config-manager';
import { parseAlarmEvent } from './parser';
import { shouldProcessAlarm } from './filter';

const METRIC_NAMESPACE = 'CloudWatchAlarmAutoRCA';

const cloudWatchClient = new CloudWatchClient({});
const configManager = new ConfigManager();

/**
 * Emit CloudWatch custom metrics for observability.
 */
async function emitMetrics(
  alarmsReceived: number,
  alarmsFiltered: number
): Promise<void> {
  try {
    const command = new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: [
        {
          MetricName: 'AlarmsReceived',
          Value: alarmsReceived,
          Unit: 'Count',
          Timestamp: new Date(),
        },
        {
          MetricName: 'AlarmsFiltered',
          Value: alarmsFiltered,
          Unit: 'Count',
          Timestamp: new Date(),
        },
      ],
    });
    await cloudWatchClient.send(command);
  } catch (error) {
    // Log metric emission failure but don't fail the handler
    console.warn('[AlarmRouter] Failed to emit CloudWatch metrics', error);
  }
}

/**
 * AlarmRouter Lambda handler.
 *
 * Receives an EventBridge CloudWatch Alarm State Change event, parses it,
 * applies selection mode and filter rules, emits metrics, and returns
 * structured alarm output.
 */
export const handler = async (event: AlarmRouterInput): Promise<AlarmRouterOutput> => {
  const correlationId = event.id ?? `unknown-${Date.now()}`;

  console.log(JSON.stringify({
    level: 'INFO',
    message: 'AlarmRouter invoked',
    correlationId,
    alarmName: event.detail?.alarmName ?? 'unknown',
    timestamp: new Date().toISOString(),
  }));

  // Step 1: Get configuration
  const config = await configManager.getConfig();

  // Step 2: Parse the alarm event
  const parsedAlarm = parseAlarmEvent(event);

  // Step 3: If parsing resulted in a filtered event, emit metrics and return early
  if (parsedAlarm.filtered) {
    console.log(JSON.stringify({
      level: 'WARN',
      message: 'Alarm event filtered during parsing',
      correlationId,
      filterReason: parsedAlarm.filterReason,
      timestamp: new Date().toISOString(),
    }));

    await emitMetrics(1, 1);
    return parsedAlarm;
  }

  // Step 4: Apply selection mode and filter rules
  const filterResult = shouldProcessAlarm(parsedAlarm, config);

  if (!filterResult.pass) {
    parsedAlarm.filtered = true;
    parsedAlarm.filterReason = filterResult.reason;

    console.log(JSON.stringify({
      level: 'INFO',
      message: 'Alarm filtered by selection/filter rules',
      correlationId,
      alarmName: parsedAlarm.alarmName,
      filterReason: filterResult.reason,
      timestamp: new Date().toISOString(),
    }));

    await emitMetrics(1, 1);
    return parsedAlarm;
  }

  // Step 5: Alarm passed all checks
  console.log(JSON.stringify({
    level: 'INFO',
    message: 'Alarm accepted for processing',
    correlationId,
    alarmName: parsedAlarm.alarmName,
    namespace: parsedAlarm.namespace,
    resource: parsedAlarm.resource,
    timestamp: new Date().toISOString(),
  }));

  await emitMetrics(1, 0);
  return parsedAlarm;
};
