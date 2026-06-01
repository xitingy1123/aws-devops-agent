import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';
import { ConfigManager } from '../../shared/config-manager';
import {
  AlarmGrouperInput,
  AlarmGrouperOutput,
  AlarmGroup,
  AlarmRouterOutput,
  formatResourceKey,
} from '../../shared/types';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const configManager = new ConfigManager();

const TABLE_NAME = process.env.ALARM_GROUP_TABLE_NAME ?? '';

/**
 * Queries DynamoDB for an active alarm group (status="collecting") for the given
 * resourceKey where the current time falls within the group's collection window.
 *
 * 注意：DDB partition key 字段名仍叫 `resourceArn`（保留 schema 兼容），
 * 但 value 已经从真正的 ARN 切换为 formatResourceKey() 的输出
 * (`accountId/service/region/resourceId`)。
 */
async function findActiveGroup(
  resourceKey: string,
  now: Date
): Promise<AlarmGroup | undefined> {
  const nowISO = now.toISOString();

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'resourceArn = :arn',
      FilterExpression:
        '#status = :collecting AND windowEnd > :now',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':arn': resourceKey,
        ':collecting': 'collecting',
        ':now': nowISO,
      },
    })
  );

  if (result.Items && result.Items.length > 0) {
    return result.Items[0] as unknown as AlarmGroup;
  }
  return undefined;
}

/**
 * Adds an alarm to an existing group in DynamoDB by appending it to the alarms list.
 */
async function addAlarmToGroup(
  group: AlarmGroup,
  alarm: AlarmRouterOutput
): Promise<AlarmGroup> {
  const updatedAlarms = [...group.alarms, alarm];

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        resourceArn: group.resourceArn,
        groupId: group.groupId,
      },
      UpdateExpression: 'SET alarms = :alarms',
      ExpressionAttributeValues: {
        ':alarms': updatedAlarms,
      },
    })
  );

  return { ...group, alarms: updatedAlarms };
}

/**
 * Creates a new alarm group in DynamoDB.
 */
async function createNewGroup(
  alarm: AlarmRouterOutput,
  groupingWindowSeconds: number,
  now: Date
): Promise<AlarmGroup> {
  const groupId = crypto.randomUUID();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + groupingWindowSeconds * 1000).toISOString();
  // TTL: window end + 1 hour buffer for cleanup
  const ttl = Math.floor(now.getTime() / 1000) + groupingWindowSeconds + 3600;

  const group: AlarmGroup = {
    resourceArn: formatResourceKey(alarm.resource),
    groupId,
    alarms: [alarm],
    windowStart,
    windowEnd,
    status: 'collecting',
    ttl,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: group,
    })
  );

  return group;
}

/**
 * AlarmGrouper Lambda handler.
 *
 * Groups alarms by resource within a configurable time window (default 2 minutes).
 * - If an active group exists for the same resource, adds the alarm to that group.
 * - If no active group exists, creates a new group.
 * - On DynamoDB failure, creates a single-alarm group and proceeds (degraded mode).
 */
export const handler = async (event: AlarmGrouperInput): Promise<AlarmGrouperOutput> => {
  const { alarm } = event;
  const now = new Date();

  // Get grouping window from configuration
  let groupingWindowSeconds = 120; // default 2 minutes
  try {
    const config = await configManager.getConfig();
    groupingWindowSeconds = config.groupingWindow;
  } catch (error) {
    console.warn('[AlarmGrouper] Failed to load config, using default groupingWindow', error);
  }

  const resourceKey = formatResourceKey(alarm.resource);

  try {
    // Check for an active group for this resource
    const activeGroup = await findActiveGroup(resourceKey, now);

    if (activeGroup) {
      // Add alarm to existing group
      const updatedGroup = await addAlarmToGroup(activeGroup, alarm);
      console.log(
        `[AlarmGrouper] Added alarm ${alarm.alarmName} to existing group ${activeGroup.groupId}`
      );

      return {
        groupId: updatedGroup.groupId,
        alarms: updatedGroup.alarms,
        isNewGroup: false,
        shouldWait: true,
        waitUntil: activeGroup.windowEnd,
      };
    }

    // No active group — create a new one
    const newGroup = await createNewGroup(alarm, groupingWindowSeconds, now);
    console.log(
      `[AlarmGrouper] Created new group ${newGroup.groupId} for resource ${resourceKey}`
    );

    return {
      groupId: newGroup.groupId,
      alarms: newGroup.alarms,
      isNewGroup: true,
      shouldWait: false,
    };
  } catch (error) {
    // Degraded mode: DynamoDB failure — skip grouping, create a single-alarm group
    console.error(
      '[AlarmGrouper] DynamoDB operation failed, proceeding in degraded mode',
      error
    );

    const fallbackGroupId = crypto.randomUUID();
    return {
      groupId: fallbackGroupId,
      alarms: [alarm],
      isNewGroup: true,
      shouldWait: false,
    };
  }
};
