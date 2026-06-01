/**
 * Integration test: DynamoDB read/write operations.
 *
 * Wires the shared DynamoDB client module to an in-memory fake DynamoDB
 * implementation and exercises the full read/write lifecycle for:
 *   - WorkflowExecution table  (create → update status → read)
 *   - AlarmGroup table         (create → query active group → append alarms)
 *   - DeadLetter table         (write failed notifications)
 *
 * Validates the wiring across:
 *   - calculateTTL math
 *   - QueryCommand filter expression for active alarm groups
 *   - UpdateCommand list_append for state transitions
 *   - PutCommand item shape
 *
 * Validates: Requirements 2.1, 2.5, 2.6, 6.4
 */

import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  setDocClient,
  calculateTTL,
  createWorkflowExecution,
  updateWorkflowStatus,
  getWorkflowExecution,
  createAlarmGroup,
  addAlarmToGroup,
  findActiveAlarmGroup,
  writeDeadLetterNotification,
  DeadLetterNotification,
} from '../../src/shared/dynamodb-client';
import { WorkflowExecution, AlarmGroup, AlarmRouterOutput } from '../../src/shared/types';

// -----------------------------------------------------------------------------
// In-memory DynamoDB fake
//
// Implements only the subset of operations used by the dynamodb-client module:
//   PutCommand     — write/replace by composite key
//   GetCommand     — read by composite key
//   UpdateCommand  — apply UpdateExpression with limited list_append support
//   QueryCommand   — scan partition by KeyCondition + minimal FilterExpression
// -----------------------------------------------------------------------------

interface FakeTable {
  // key: stable JSON of the composite key
  items: Map<string, any>;
  partitionKey: string;
  sortKey?: string;
}

const tables: Record<string, FakeTable> = {
  'test-workflow-table': {
    items: new Map(),
    partitionKey: 'executionId',
    sortKey: 'createdAt',
  },
  'test-alarm-group-table': {
    items: new Map(),
    partitionKey: 'resourceArn',
    sortKey: 'groupId',
  },
  'test-dead-letter-table': {
    items: new Map(),
    partitionKey: 'notificationId',
  },
};

function keyOf(table: FakeTable, item: any): string {
  return JSON.stringify({
    pk: item[table.partitionKey],
    sk: table.sortKey ? item[table.sortKey] : undefined,
  });
}

const fakeDocClient: any = {
  async send(command: any): Promise<any> {
    if (command instanceof PutCommand) {
      const t = tables[command.input.TableName!];
      if (!t) throw new Error(`Unknown table: ${command.input.TableName}`);
      t.items.set(keyOf(t, command.input.Item), command.input.Item);
      return {};
    }

    if (command instanceof GetCommand) {
      const t = tables[command.input.TableName!];
      if (!t) throw new Error(`Unknown table: ${command.input.TableName}`);
      const item = t.items.get(keyOf(t, command.input.Key));
      return { Item: item };
    }

    if (command instanceof UpdateCommand) {
      const t = tables[command.input.TableName!];
      if (!t) throw new Error(`Unknown table: ${command.input.TableName}`);
      const k = keyOf(t, command.input.Key);
      let item = t.items.get(k);
      if (!item) {
        // DynamoDB treats updates on missing items as inserts; mirror that.
        item = { ...command.input.Key };
      }
      // Apply the limited UpdateExpression grammar used by dynamodb-client.ts.
      const expr = command.input.UpdateExpression!;
      const eav = command.input.ExpressionAttributeValues!;
      const ean = command.input.ExpressionAttributeNames ?? {};

      // 1) "SET #status = :newStatus, stateTransitions = list_append(if_not_exists(stateTransitions, :emptyList), :transition)"
      // 2) "SET alarms = list_append(if_not_exists(alarms, :emptyList), :newAlarm)"
      // 3) "SET alarms = :alarms"
      const setBody = expr.replace(/^\s*SET\s+/i, '');
      const assignments = setBody.split(/,\s+(?=[a-zA-Z#])/);

      for (const assignment of assignments) {
        const m = assignment.match(/^(#?\w+)\s*=\s*(.+)$/);
        if (!m) throw new Error(`Unsupported assignment: ${assignment}`);
        const lhs = ean[m[1]] ?? m[1];
        const rhs = m[2].trim();

        if (rhs.startsWith(':')) {
          item[lhs] = eav[rhs];
        } else if (rhs.startsWith('list_append(if_not_exists(')) {
          const listAppendMatch = rhs.match(
            /^list_append\(if_not_exists\((\w+),\s*(:\w+)\),\s*(:\w+)\)$/
          );
          if (!listAppendMatch) throw new Error(`Unsupported list_append: ${rhs}`);
          const fieldName = listAppendMatch[1];
          const emptyToken = listAppendMatch[2];
          const newToken = listAppendMatch[3];
          const existing = item[fieldName] ?? eav[emptyToken];
          item[fieldName] = [...existing, ...eav[newToken]];
        } else {
          throw new Error(`Unsupported RHS: ${rhs}`);
        }
      }

      t.items.set(k, item);
      return {};
    }

    if (command instanceof QueryCommand) {
      const t = tables[command.input.TableName!];
      if (!t) throw new Error(`Unknown table: ${command.input.TableName}`);

      // KeyConditionExpression: "resourceArn = :arn"
      const eav = command.input.ExpressionAttributeValues!;
      const ean = command.input.ExpressionAttributeNames ?? {};
      const arnValue = eav[':arn'];

      let items = Array.from(t.items.values()).filter(
        (it) => it[t.partitionKey] === arnValue
      );

      // FilterExpression: "#status = :collecting AND windowEnd > :now"
      const filter = command.input.FilterExpression;
      if (filter) {
        const collectingValue = eav[':collecting'];
        const nowValue = eav[':now'];
        items = items.filter((it) => {
          const status = it[ean['#status'] ?? 'status'];
          return status === collectingValue && it.windowEnd > nowValue;
        });
      }

      return { Items: items };
    }

    throw new Error(`Unsupported command: ${command.constructor.name}`);
  },
};

// -----------------------------------------------------------------------------
// Test setup
// -----------------------------------------------------------------------------

beforeAll(() => {
  setDocClient(fakeDocClient);
  process.env.WORKFLOW_EXECUTION_TABLE_NAME = 'test-workflow-table';
  process.env.ALARM_GROUP_TABLE_NAME = 'test-alarm-group-table';
  process.env.DEAD_LETTER_TABLE_NAME = 'test-dead-letter-table';
});

beforeEach(() => {
  for (const t of Object.values(tables)) t.items.clear();
});

afterAll(() => {
  delete process.env.WORKFLOW_EXECUTION_TABLE_NAME;
  delete process.env.ALARM_GROUP_TABLE_NAME;
  delete process.env.DEAD_LETTER_TABLE_NAME;
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeAlarm(overrides?: Partial<AlarmRouterOutput>): AlarmRouterOutput {
  return {
    alarmId: 'alarm-1',
    alarmName: 'HighCPU',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-abc' },
    threshold: 80,
    currentValue: 95,
    stateChangeTimestamp: '2024-01-01T00:01:00.000Z',
    previousState: 'OK',
    accountId: '123',
    region: 'us-east-1',
    resource: { accountId: '123', region: 'us-east-1', service: 'ec2', resourceId: 'i-abc' },
    filtered: false,
    ...overrides,
  };
}

/**
 * 测试里把任意字符串当作 resource 标识塞进去（既可以是真 ARN,也可以是
 * formatResourceKey 输出的 "account/service/region/id"——二者作为 partition
 * key 字符串都能正常工作,DDB 不会区分）。
 */
function withResourceId(resourceId: string): Partial<AlarmRouterOutput> {
  return {
    resource: { accountId: '123', region: 'us-east-1', service: 'ec2', resourceId },
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Integration: DynamoDB workflow execution lifecycle', () => {
  it('creates, updates status, and retrieves a workflow execution end-to-end', async () => {
    const createdAtUnix = 1_700_000_000;
    const createdAt = new Date(createdAtUnix * 1000).toISOString();
    const ttl = calculateTTL(createdAtUnix, 90);

    const exec: WorkflowExecution = {
      executionId: 'exec-1',
      createdAt,
      status: 'pending',
      groupId: 'group-1',
      alarmArns: ['arn:aws:cloudwatch:us-east-1:123:alarm:t1'],
      resourceArns: ['arn:aws:ec2:us-east-1:123:instance/i-abc'],
      startedAt: createdAt,
      stateTransitions: [],
      ttl,
    };

    await createWorkflowExecution(exec);
    await updateWorkflowStatus('exec-1', createdAt, 'analyzing', 'agent invoked');
    await updateWorkflowStatus('exec-1', createdAt, 'completed');

    const stored = await getWorkflowExecution('exec-1', createdAt);

    expect(stored).toBeDefined();
    expect(stored!.executionId).toBe('exec-1');
    expect(stored!.status).toBe('completed');
    expect(stored!.ttl).toBe(createdAtUnix + 90 * 86400);
    expect(stored!.stateTransitions).toHaveLength(2);
    expect(stored!.stateTransitions[0].to).toBe('analyzing');
    expect(stored!.stateTransitions[0].reason).toBe('agent invoked');
    expect(stored!.stateTransitions[1].to).toBe('completed');
  });

  it('returns undefined when reading a non-existent workflow execution', async () => {
    const result = await getWorkflowExecution('missing', '2024-01-01T00:00:00.000Z');
    expect(result).toBeUndefined();
  });
});

describe('Integration: DynamoDB alarm group operations', () => {
  it('creates an active group and finds it via findActiveAlarmGroup within the window', async () => {
    const resourceArn = 'arn:aws:ec2:us-east-1:123:instance/i-abc';
    const group: AlarmGroup = {
      resourceArn,
      groupId: 'group-1',
      alarms: [makeAlarm()],
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2024-01-01T00:02:00.000Z',
      status: 'collecting',
      ttl: 1700000000,
    };

    await createAlarmGroup(group);

    const within = await findActiveAlarmGroup(resourceArn, new Date('2024-01-01T00:01:00.000Z'));
    expect(within).toBeDefined();
    expect(within!.groupId).toBe('group-1');
  });

  it('does not return groups whose window has already ended', async () => {
    const resourceArn = 'arn:aws:ec2:us-east-1:123:instance/i-expired';
    await createAlarmGroup({
      resourceArn,
      groupId: 'group-expired',
      alarms: [makeAlarm(withResourceId(resourceArn))],
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2024-01-01T00:02:00.000Z',
      status: 'collecting',
      ttl: 1700000000,
    });

    const after = await findActiveAlarmGroup(resourceArn, new Date('2024-01-01T00:05:00.000Z'));
    expect(after).toBeUndefined();
  });

  it('does not return groups in a non-collecting status', async () => {
    const resourceArn = 'arn:aws:ec2:us-east-1:123:instance/i-done';
    await createAlarmGroup({
      resourceArn,
      groupId: 'group-done',
      alarms: [makeAlarm(withResourceId(resourceArn))],
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2024-01-01T00:10:00.000Z',
      status: 'done',
      ttl: 1700000000,
    });

    const result = await findActiveAlarmGroup(resourceArn, new Date('2024-01-01T00:01:00.000Z'));
    expect(result).toBeUndefined();
  });

  it('appends alarms to an existing group via list_append semantics', async () => {
    const resourceArn = 'arn:aws:ec2:us-east-1:123:instance/i-append';
    const initialAlarm = makeAlarm({ ...withResourceId(resourceArn), alarmId: 'a1', alarmName: 'A1' });
    await createAlarmGroup({
      resourceArn,
      groupId: 'group-append',
      alarms: [initialAlarm],
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2024-01-01T00:02:00.000Z',
      status: 'collecting',
      ttl: 1700000000,
    });

    await addAlarmToGroup(
      resourceArn,
      'group-append',
      makeAlarm({ ...withResourceId(resourceArn), alarmId: 'a2', alarmName: 'A2' })
    );
    await addAlarmToGroup(
      resourceArn,
      'group-append',
      makeAlarm({ ...withResourceId(resourceArn), alarmId: 'a3', alarmName: 'A3' })
    );

    const result = await findActiveAlarmGroup(
      resourceArn,
      new Date('2024-01-01T00:01:00.000Z')
    );
    expect(result).toBeDefined();
    expect(result!.alarms).toHaveLength(3);
    expect(result!.alarms.map((a) => a.alarmId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('isolates groups by resourceArn (different resources are never returned together)', async () => {
    const arnA = 'arn:aws:ec2:us-east-1:123:instance/i-a';
    const arnB = 'arn:aws:ec2:us-east-1:123:instance/i-b';

    await createAlarmGroup({
      resourceArn: arnA,
      groupId: 'group-a',
      alarms: [makeAlarm(withResourceId(arnA))],
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2024-01-01T00:02:00.000Z',
      status: 'collecting',
      ttl: 1700000000,
    });
    await createAlarmGroup({
      resourceArn: arnB,
      groupId: 'group-b',
      alarms: [makeAlarm(withResourceId(arnB))],
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2024-01-01T00:02:00.000Z',
      status: 'collecting',
      ttl: 1700000000,
    });

    const onlyA = await findActiveAlarmGroup(arnA, new Date('2024-01-01T00:01:00.000Z'));
    const onlyB = await findActiveAlarmGroup(arnB, new Date('2024-01-01T00:01:00.000Z'));

    expect(onlyA!.groupId).toBe('group-a');
    expect(onlyB!.groupId).toBe('group-b');
  });
});

describe('Integration: Dead letter notification table', () => {
  it('persists failed notifications', async () => {
    const notification: DeadLetterNotification = {
      notificationId: 'notif-1',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
      message: { msg_type: 'interactive', card: {} },
      failedAt: '2024-01-01T00:00:00.000Z',
      error: 'Connection timeout',
    };

    await writeDeadLetterNotification(notification);

    const t = tables['test-dead-letter-table'];
    expect(t.items.size).toBe(1);
    const stored = Array.from(t.items.values())[0];
    expect(stored).toEqual(notification);
  });
});

describe('Integration: TTL math used by the storage layer', () => {
  it('produces a TTL value strictly greater than the creation timestamp', () => {
    const t = calculateTTL(1_700_000_000, 90);
    expect(t).toBeGreaterThan(1_700_000_000);
    // Exactly equal to 90 days in seconds.
    expect(t - 1_700_000_000).toBe(90 * 86400);
  });
});
