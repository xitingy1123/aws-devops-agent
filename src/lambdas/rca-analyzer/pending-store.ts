/**
 * 写一条 "pending investigation" 记录到 WorkflowExecutionTable。
 *
 * 用于在 webhook 触发后挂起 SFN，等 EventBridge 事件回流时反查 taskToken。
 *
 * 我们复用 WorkflowExecutionTable，但用 incidentId 当 partition key
 * （表 schema 已经是 PK=executionId,SK=createdAt——把 incidentId 当作
 * "the SFN-side execution id" 写进去，语义自洽）。
 *
 * 在 InvestigationEventHandler 那一侧：
 *   - "Investigation Created" 事件没有 incidentId，但能拿到执行时间窗口。
 *   - "Investigation Completed" 事件含 task_id / execution_id 和时间戳。
 *   - 通过时间窗口在本表里 Query 出最早的一条 "pending" 记录，
 *     反查到 taskToken / alarms / groupId。
 *
 * 这种基于时间窗口的关联在低并发场景下足够准确。如果需要严格关联，
 * 后续可以让 InvestigationEventHandler 调用 ListJournalRecords 拿
 * incident payload 里的原始 incidentId。
 */

import {
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDocClient } from '../../shared/dynamodb-client';
import { AlarmRouterOutput, formatResourceKey } from '../../shared/types';

export interface PendingInvestigation {
  incidentId: string;
  triggeredAt: string;
  taskToken: string;
  groupId: string;
  alarms: AlarmRouterOutput[];
}

const PENDING_TTL_HOURS = 2;

/**
 * 写入 pending investigation 记录。
 *
 * 表项形态（与 WorkflowExecution 类型部分兼容）：
 *   {
 *     executionId: incidentId,          // PK
 *     createdAt: triggeredAt,           // SK
 *     status: 'pending',
 *     groupId,
 *     alarmArns,
 *     resourceArns,
 *     startedAt: triggeredAt,
 *     stateTransitions: [{ from:'', to:'pending', timestamp }],
 *     ttl,
 *     // 为 InvestigationEventHandler 反查 taskToken 用的额外字段
 *     taskToken,
 *     alarms,                           // 完整 alarm 对象（事件 handler 还要拿来生成 RCAReport）
 *   }
 */
export async function writePendingInvestigation(p: PendingInvestigation): Promise<void> {
  const tableName = process.env.WORKFLOW_EXECUTION_TABLE_NAME;
  if (!tableName) {
    throw new Error('WORKFLOW_EXECUTION_TABLE_NAME environment variable is not configured');
  }

  const ttl = Math.floor(new Date(p.triggeredAt).getTime() / 1000) + PENDING_TTL_HOURS * 3600;
  const alarmArns = p.alarms.map((a) => a.alarmId).filter((s) => !!s);
  const resourceArns = p.alarms.map((a) => formatResourceKey(a.resource)).filter((s) => !!s);

  await getDocClient().send(
    new PutCommand({
      TableName: tableName,
      Item: {
        executionId: p.incidentId,
        createdAt: p.triggeredAt,
        status: 'pending',
        groupId: p.groupId,
        alarmArns,
        resourceArns,
        startedAt: p.triggeredAt,
        stateTransitions: [
          { from: '', to: 'pending', timestamp: p.triggeredAt, reason: 'webhook triggered' },
        ],
        ttl,
        // 关联字段：事件 handler 反查这两个
        taskToken: p.taskToken,
        alarms: p.alarms,
      },
    })
  );
}
