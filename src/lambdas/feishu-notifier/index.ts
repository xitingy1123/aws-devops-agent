import { FeishuNotifierInput, FeishuNotifierOutput, FeishuMessage } from '../../shared/types';
import { ConfigManager } from '../../shared/config-manager';
import { formatFeishuMessages } from './card-formatter';
import { routeWebhooks } from './webhook-router';
import { sendToMultipleWebhooks, writeToDeadLetter } from './sender';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';

// -----------------------------------------------------------------------------
// Shared instances (reused across invocations)
// -----------------------------------------------------------------------------

const configManager = new ConfigManager();
const cloudWatchClient = new CloudWatchClient({});

const METRIC_NAMESPACE = 'CloudWatchAlarmAutoRCA';

// -----------------------------------------------------------------------------
// CloudWatch Metrics Helper
// -----------------------------------------------------------------------------

async function emitMetrics(sentCount: number, failedCount: number): Promise<void> {
  const timestamp = new Date();

  try {
    await cloudWatchClient.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: 'NotificationsSent',
            Value: sentCount,
            Unit: 'Count',
            Timestamp: timestamp,
          },
          {
            MetricName: 'NotificationsFailed',
            Value: failedCount,
            Unit: 'Count',
            Timestamp: timestamp,
          },
        ],
      })
    );
  } catch (err) {
    console.error('Failed to emit CloudWatch metrics', err);
  }
}

// -----------------------------------------------------------------------------
// Resource tag lookup (for tag-based webhook routing)
// -----------------------------------------------------------------------------

/**
 * Fetch a resource's AWS tags via the unified Resource Groups Tagging API.
 * Works across all services whose ARN the alarm-router can build (EC2, RDS,
 * Lambda, ELB, SQS, DynamoDB, S3, ECS, SNS). Region is parsed from the ARN.
 * Any failure (empty ARN, untaggable resource, throttling) degrades to {} so
 * routing falls back to namespace rules / catch-all instead of breaking.
 */
async function fetchResourceTags(resourceArn: string): Promise<Record<string, string>> {
  if (!resourceArn) return {};
  const region = resourceArn.split(':')[3] || process.env.AWS_REGION;
  try {
    const client = new ResourceGroupsTaggingAPIClient(region ? { region } : {});
    const res = await client.send(new GetResourcesCommand({ ResourceARNList: [resourceArn] }));
    const tags = res.ResourceTagMappingList?.[0]?.Tags ?? [];
    return Object.fromEntries(tags.map((t) => [t.Key ?? '', t.Value ?? '']));
  } catch (err) {
    console.error(
      JSON.stringify({
        message: 'Failed to fetch resource tags for routing',
        resourceArn,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return {};
  }
}

// -----------------------------------------------------------------------------
// Lambda Handler
// -----------------------------------------------------------------------------

export const handler = async (event: FeishuNotifierInput): Promise<FeishuNotifierOutput> => {
  const { rcaReport, webhookUrls, notificationType } = event;

  console.log(
    JSON.stringify({
      message: 'FeishuNotifier invoked',
      reportId: rcaReport.reportId,
      notificationType,
      providedWebhookCount: webhookUrls.length,
    })
  );

  // Determine target webhook URLs
  let targetWebhookUrls: string[];

  if (webhookUrls.length > 0) {
    // Use provided webhook URLs directly
    targetWebhookUrls = webhookUrls;
  } else {
    // Route based on alarm namespace + resource tags from the report
    const config = await configManager.getConfig();
    const firstAlarm =
      rcaReport.alarmSummary.alarms.length > 0 ? rcaReport.alarmSummary.alarms[0] : undefined;
    const alarmNamespace = firstAlarm?.namespace ?? '';
    const alarmTags = await fetchResourceTags(firstAlarm?.resource ?? '');

    targetWebhookUrls = routeWebhooks(alarmNamespace, alarmTags, config.feishuWebhooks);
  }

  // 把报告渲染成飞书消息序列。短报告 → 1 条卡片；超长报告 → 1 条精简卡片 + 多条文本消息。
  const messages: FeishuMessage[] = formatFeishuMessages(rcaReport, notificationType);

  console.log(
    JSON.stringify({
      message: 'FeishuNotifier sending messages',
      reportId: rcaReport.reportId,
      messageCount: messages.length,
      messageTypes: messages.map((m) => m.msg_type),
      webhookCount: targetWebhookUrls.length,
    })
  );

  // 聚合发送结果。每条消息会发送给所有 webhook；任一 webhook 任一消息失败都视为该 webhook 失败。
  const sentSet = new Set<string>(targetWebhookUrls);
  const failedSet = new Set<string>();
  let totalRetryCount = 0;
  let lastErrorPerUrl = new Map<string, string>();

  for (const message of messages) {
    const result = await sendToMultipleWebhooks(targetWebhookUrls, message);
    totalRetryCount += result.totalRetryCount;
    for (const url of result.failedTo) {
      sentSet.delete(url);
      failedSet.add(url);
      lastErrorPerUrl.set(url, `Failed to deliver ${message.msg_type} message after retries`);
    }
  }

  const sentTo = Array.from(sentSet);
  const failedTo = Array.from(failedSet);

  // Write dead letters for any failed webhooks (use the last failed message context).
  if (failedTo.length > 0 && messages.length > 0) {
    const firstMessage = messages[0]; // dead letter 只保留首条作为参考
    for (const failedUrl of failedTo) {
      try {
        await writeToDeadLetter({
          webhookUrl: failedUrl,
          message: firstMessage,
          error: lastErrorPerUrl.get(failedUrl) ?? 'Failed to send notification after retries',
        });
      } catch (dlErr) {
        console.error(
          JSON.stringify({
            message: 'Failed to write dead letter',
            webhookUrl: failedUrl,
            error: dlErr instanceof Error ? dlErr.message : String(dlErr),
          })
        );
      }
    }
  }

  // Emit CloudWatch custom metrics
  await emitMetrics(sentTo.length, failedTo.length);

  // Structured log with correlation info
  console.log(
    JSON.stringify({
      message: 'FeishuNotifier completed',
      reportId: rcaReport.reportId,
      notificationType,
      sentTo,
      failedTo,
      retryCount: totalRetryCount,
      messageCount: messages.length,
      success: failedTo.length === 0,
    })
  );

  return {
    success: failedTo.length === 0,
    sentTo,
    failedTo,
    retryCount: totalRetryCount,
  };
};
