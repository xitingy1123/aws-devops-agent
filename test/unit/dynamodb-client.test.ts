import {
  calculateTTL,
  createWorkflowExecution,
  updateWorkflowStatus,
  getWorkflowExecution,
  createAlarmGroup,
  addAlarmToGroup,
  findActiveAlarmGroup,
  writeDeadLetterNotification,
  setDocClient,
  DeadLetterNotification,
} from '../../src/shared/dynamodb-client';
import { WorkflowExecution, AlarmGroup, AlarmRouterOutput } from '../../src/shared/types';

// Mock DynamoDBDocumentClient
const mockSend = jest.fn();
const mockDocClient = { send: mockSend } as any;

beforeAll(() => {
  setDocClient(mockDocClient);
  process.env.WORKFLOW_EXECUTION_TABLE_NAME = 'test-workflow-table';
  process.env.ALARM_GROUP_TABLE_NAME = 'test-alarm-group-table';
  process.env.DEAD_LETTER_TABLE_NAME = 'test-dead-letter-table';
});

beforeEach(() => {
  mockSend.mockReset();
});

afterAll(() => {
  delete process.env.WORKFLOW_EXECUTION_TABLE_NAME;
  delete process.env.ALARM_GROUP_TABLE_NAME;
  delete process.env.DEAD_LETTER_TABLE_NAME;
});

// -----------------------------------------------------------------------------
// TTL Calculation Tests
// -----------------------------------------------------------------------------

describe('calculateTTL', () => {
  it('should calculate TTL as createdAt + retentionDays * 86400', () => {
    const createdAt = 1700000000; // some Unix timestamp
    const retentionDays = 90;
    const expected = 1700000000 + 90 * 86400;
    expect(calculateTTL(createdAt, retentionDays)).toBe(expected);
  });

  it('should handle 1 day retention', () => {
    const createdAt = 1700000000;
    expect(calculateTTL(createdAt, 1)).toBe(1700000000 + 86400);
  });

  it('should handle 0 retention days', () => {
    const createdAt = 1700000000;
    expect(calculateTTL(createdAt, 0)).toBe(1700000000);
  });
});

// -----------------------------------------------------------------------------
// WorkflowExecution Tests
// -----------------------------------------------------------------------------

describe('createWorkflowExecution', () => {
  it('should put the execution item into DynamoDB', async () => {
    mockSend.mockResolvedValueOnce({});

    const execution: WorkflowExecution = {
      executionId: 'exec-123',
      createdAt: '2024-01-01T00:00:00.000Z',
      status: 'pending',
      groupId: 'group-1',
      alarmArns: ['arn:aws:cloudwatch:us-east-1:123:alarm:test'],
      resourceArns: ['arn:aws:ec2:us-east-1:123:instance/i-abc'],
      startedAt: '2024-01-01T00:00:00.000Z',
      stateTransitions: [],
      ttl: 1700000000 + 90 * 86400,
    };

    await createWorkflowExecution(execution);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.TableName).toBe('test-workflow-table');
    expect(command.input.Item).toEqual(execution);
  });
});

describe('updateWorkflowStatus', () => {
  it('should update status and append state transition', async () => {
    mockSend.mockResolvedValueOnce({});

    await updateWorkflowStatus('exec-123', '2024-01-01T00:00:00.000Z', 'analyzing', 'starting analysis');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.TableName).toBe('test-workflow-table');
    expect(command.input.Key).toEqual({
      executionId: 'exec-123',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    expect(command.input.ExpressionAttributeValues[':newStatus']).toBe('analyzing');
    expect(command.input.ExpressionAttributeValues[':transition'][0].to).toBe('analyzing');
    expect(command.input.ExpressionAttributeValues[':transition'][0].reason).toBe('starting analysis');
  });

  it('should not include reason if not provided', async () => {
    mockSend.mockResolvedValueOnce({});

    await updateWorkflowStatus('exec-123', '2024-01-01T00:00:00.000Z', 'completed');

    const command = mockSend.mock.calls[0][0];
    const transition = command.input.ExpressionAttributeValues[':transition'][0];
    expect(transition.to).toBe('completed');
    expect(transition.reason).toBeUndefined();
  });
});

describe('getWorkflowExecution', () => {
  it('should return the execution item when found', async () => {
    const execution: WorkflowExecution = {
      executionId: 'exec-123',
      createdAt: '2024-01-01T00:00:00.000Z',
      status: 'completed',
      groupId: 'group-1',
      alarmArns: [],
      resourceArns: [],
      startedAt: '2024-01-01T00:00:00.000Z',
      stateTransitions: [],
      ttl: 1700000000,
    };

    mockSend.mockResolvedValueOnce({ Item: execution });

    const result = await getWorkflowExecution('exec-123', '2024-01-01T00:00:00.000Z');
    expect(result).toEqual(execution);
  });

  it('should return undefined when item not found', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const result = await getWorkflowExecution('nonexistent', '2024-01-01T00:00:00.000Z');
    expect(result).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// AlarmGroup Tests
// -----------------------------------------------------------------------------

describe('createAlarmGroup', () => {
  it('should put the alarm group item into DynamoDB', async () => {
    mockSend.mockResolvedValueOnce({});

    const group: AlarmGroup = {
      resourceArn: 'arn:aws:ec2:us-east-1:123:instance/i-abc',
      groupId: 'group-1',
      alarms: [],
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2024-01-01T00:02:00.000Z',
      status: 'collecting',
      ttl: 1700000000,
    };

    await createAlarmGroup(group);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.TableName).toBe('test-alarm-group-table');
    expect(command.input.Item).toEqual(group);
  });
});

describe('addAlarmToGroup', () => {
  it('should append alarm to the group alarms list', async () => {
    mockSend.mockResolvedValueOnce({});

    const alarm: AlarmRouterOutput = {
      alarmId: 'alarm-1',
      alarmName: 'HighCPU',
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensions: { InstanceId: 'i-abc' },
      threshold: 80,
      currentValue: 95,
      stateChangeTimestamp: '2024-01-01T00:01:00.000Z',
      previousState: 'OK',
      accountId: '123456789012',
      region: 'us-east-1',
      resource: { accountId: '123', region: 'us-east-1', service: 'ec2', resourceId: 'i-abc' },
      filtered: false,
    };

    await addAlarmToGroup('arn:aws:ec2:us-east-1:123:instance/i-abc', 'group-1', alarm);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.TableName).toBe('test-alarm-group-table');
    expect(command.input.Key).toEqual({
      resourceArn: 'arn:aws:ec2:us-east-1:123:instance/i-abc',
      groupId: 'group-1',
    });
    expect(command.input.ExpressionAttributeValues[':newAlarm']).toEqual([alarm]);
  });
});

describe('findActiveAlarmGroup', () => {
  it('should return the active group when found', async () => {
    const group: AlarmGroup = {
      resourceArn: 'arn:aws:ec2:us-east-1:123:instance/i-abc',
      groupId: 'group-1',
      alarms: [],
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2024-01-01T00:02:00.000Z',
      status: 'collecting',
      ttl: 1700000000,
    };

    mockSend.mockResolvedValueOnce({ Items: [group] });

    const result = await findActiveAlarmGroup(
      'arn:aws:ec2:us-east-1:123:instance/i-abc',
      new Date('2024-01-01T00:01:00.000Z')
    );

    expect(result).toEqual(group);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.ExpressionAttributeValues[':arn']).toBe('arn:aws:ec2:us-east-1:123:instance/i-abc');
    expect(command.input.ExpressionAttributeValues[':collecting']).toBe('collecting');
  });

  it('should return undefined when no active group found', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await findActiveAlarmGroup(
      'arn:aws:ec2:us-east-1:123:instance/i-abc',
      new Date('2024-01-01T00:05:00.000Z')
    );

    expect(result).toBeUndefined();
  });

  it('should return undefined when Items is undefined', async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await findActiveAlarmGroup(
      'arn:aws:ec2:us-east-1:123:instance/i-abc',
      new Date()
    );

    expect(result).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Dead Letter Tests
// -----------------------------------------------------------------------------

describe('writeDeadLetterNotification', () => {
  it('should write the notification to the dead letter table', async () => {
    mockSend.mockResolvedValueOnce({});

    const notification: DeadLetterNotification = {
      notificationId: 'notif-123',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
      message: { msg_type: 'interactive', card: {} },
      failedAt: '2024-01-01T00:00:00.000Z',
      error: 'Connection timeout',
    };

    await writeDeadLetterNotification(notification);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.TableName).toBe('test-dead-letter-table');
    expect(command.input.Item).toEqual(notification);
  });
});

// -----------------------------------------------------------------------------
// Environment Variable Error Tests
// -----------------------------------------------------------------------------

describe('missing environment variables', () => {
  it('should throw when WORKFLOW_EXECUTION_TABLE_NAME is not set', async () => {
    const original = process.env.WORKFLOW_EXECUTION_TABLE_NAME;
    delete process.env.WORKFLOW_EXECUTION_TABLE_NAME;

    await expect(
      createWorkflowExecution({} as WorkflowExecution)
    ).rejects.toThrow('WORKFLOW_EXECUTION_TABLE_NAME environment variable is not set');

    process.env.WORKFLOW_EXECUTION_TABLE_NAME = original;
  });

  it('should throw when ALARM_GROUP_TABLE_NAME is not set', async () => {
    const original = process.env.ALARM_GROUP_TABLE_NAME;
    delete process.env.ALARM_GROUP_TABLE_NAME;

    await expect(
      createAlarmGroup({} as AlarmGroup)
    ).rejects.toThrow('ALARM_GROUP_TABLE_NAME environment variable is not set');

    process.env.ALARM_GROUP_TABLE_NAME = original;
  });

  it('should throw when DEAD_LETTER_TABLE_NAME is not set', async () => {
    const original = process.env.DEAD_LETTER_TABLE_NAME;
    delete process.env.DEAD_LETTER_TABLE_NAME;

    await expect(
      writeDeadLetterNotification({} as DeadLetterNotification)
    ).rejects.toThrow('DEAD_LETTER_TABLE_NAME environment variable is not set');

    process.env.DEAD_LETTER_TABLE_NAME = original;
  });
});

// -----------------------------------------------------------------------------
// TTL-on-Item Tests
// -----------------------------------------------------------------------------

describe('TTL is persisted on items', () => {
  it('should persist computed TTL on workflow execution items', async () => {
    mockSend.mockResolvedValueOnce({});

    const createdAtUnixSeconds = 1_700_000_000;
    const retentionDays = 90;
    const ttl = calculateTTL(createdAtUnixSeconds, retentionDays);

    const execution: WorkflowExecution = {
      executionId: 'exec-ttl',
      createdAt: '2023-11-14T22:13:20.000Z',
      status: 'pending',
      groupId: 'group-ttl',
      alarmArns: [],
      resourceArns: [],
      startedAt: '2023-11-14T22:13:20.000Z',
      stateTransitions: [],
      ttl,
    };

    await createWorkflowExecution(execution);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.Item.ttl).toBe(createdAtUnixSeconds + retentionDays * 86400);
  });

  it('should persist computed TTL on alarm group items', async () => {
    mockSend.mockResolvedValueOnce({});

    const createdAtUnixSeconds = 1_700_000_000;
    const retentionDays = 7;
    const ttl = calculateTTL(createdAtUnixSeconds, retentionDays);

    const group: AlarmGroup = {
      resourceArn: 'arn:aws:ec2:us-east-1:123:instance/i-ttl',
      groupId: 'group-ttl',
      alarms: [],
      windowStart: '2023-11-14T22:13:20.000Z',
      windowEnd: '2023-11-14T22:15:20.000Z',
      status: 'collecting',
      ttl,
    };

    await createAlarmGroup(group);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.Item.ttl).toBe(createdAtUnixSeconds + retentionDays * 86400);
  });
});

// -----------------------------------------------------------------------------
// Concurrent Write Scenario Tests
// -----------------------------------------------------------------------------

describe('concurrent writes', () => {
  function makeAlarm(id: string, resourceArn: string): AlarmRouterOutput {
    return {
      alarmId: id,
      alarmName: `alarm-${id}`,
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensions: { InstanceId: 'i-abc' },
      threshold: 80,
      currentValue: 95,
      stateChangeTimestamp: '2024-01-01T00:01:00.000Z',
      previousState: 'OK',
      accountId: '123456789012',
      region: 'us-east-1',
      // 测试用：把任意字符串塞到 resourceId,formatResourceKey 行为不影响断言
      resource: { accountId: '123', region: 'us-east-1', service: 'ec2', resourceId: resourceArn },
      filtered: false,
    };
  }

  it('should issue independent PutCommands for parallel createWorkflowExecution calls', async () => {
    mockSend.mockResolvedValue({});

    const executions: WorkflowExecution[] = Array.from({ length: 5 }, (_, i) => ({
      executionId: `exec-${i}`,
      createdAt: `2024-01-01T00:00:0${i}.000Z`,
      status: 'pending',
      groupId: `group-${i}`,
      alarmArns: [],
      resourceArns: [],
      startedAt: `2024-01-01T00:00:0${i}.000Z`,
      stateTransitions: [],
      ttl: 1_700_000_000 + 86400,
    }));

    await Promise.all(executions.map((e) => createWorkflowExecution(e)));

    expect(mockSend).toHaveBeenCalledTimes(executions.length);
    const itemsSent = mockSend.mock.calls.map((c) => c[0].input.Item);
    // Each call must carry its own item (no shared state)
    const ids = itemsSent.map((it) => it.executionId).sort();
    expect(ids).toEqual(['exec-0', 'exec-1', 'exec-2', 'exec-3', 'exec-4']);
  });

  it('should append each alarm independently when addAlarmToGroup is called concurrently for the same group', async () => {
    mockSend.mockResolvedValue({});

    const resourceArn = 'arn:aws:ec2:us-east-1:123:instance/i-concurrent';
    const groupId = 'group-concurrent';
    const alarms = [
      makeAlarm('a1', resourceArn),
      makeAlarm('a2', resourceArn),
      makeAlarm('a3', resourceArn),
    ];

    await Promise.all(alarms.map((a) => addAlarmToGroup(resourceArn, groupId, a)));

    expect(mockSend).toHaveBeenCalledTimes(alarms.length);

    for (const call of mockSend.mock.calls) {
      const command = call[0];
      // Each concurrent update must use list_append with if_not_exists so multiple
      // writers can append safely without overwriting prior alarms.
      expect(command.input.UpdateExpression).toBe(
        'SET alarms = list_append(if_not_exists(alarms, :emptyList), :newAlarm)'
      );
      expect(command.input.Key).toEqual({ resourceArn, groupId });
      // Each call carries exactly one new alarm in :newAlarm.
      expect(command.input.ExpressionAttributeValues[':newAlarm']).toHaveLength(1);
    }

    const sentAlarmIds = mockSend.mock.calls
      .map((c) => c[0].input.ExpressionAttributeValues[':newAlarm'][0].alarmId)
      .sort();
    expect(sentAlarmIds).toEqual(['a1', 'a2', 'a3']);
  });

  it('should append independent transitions for concurrent updateWorkflowStatus calls', async () => {
    mockSend.mockResolvedValue({});

    const executionId = 'exec-concurrent';
    const createdAt = '2024-01-01T00:00:00.000Z';
    const newStatuses: Array<WorkflowExecution['status']> = ['analyzing', 'completed', 'notified'];

    await Promise.all(
      newStatuses.map((s, i) => updateWorkflowStatus(executionId, createdAt, s, `reason-${i}`))
    );

    expect(mockSend).toHaveBeenCalledTimes(newStatuses.length);

    const transitions = mockSend.mock.calls.map(
      (c) => c[0].input.ExpressionAttributeValues[':transition'][0]
    );
    // Every concurrent call must produce its own transition entry; none may share state.
    const tos = transitions.map((t) => t.to).sort();
    expect(tos).toEqual([...newStatuses].sort());

    for (const call of mockSend.mock.calls) {
      const command = call[0];
      // list_append on stateTransitions ensures concurrent appends do not overwrite history.
      expect(command.input.UpdateExpression).toContain(
        'list_append(if_not_exists(stateTransitions, :emptyList), :transition)'
      );
      expect(command.input.ExpressionAttributeValues[':transition']).toHaveLength(1);
    }
  });

  it('should isolate dead-letter writes when invoked in parallel', async () => {
    mockSend.mockResolvedValue({});

    const notifications: DeadLetterNotification[] = Array.from({ length: 4 }, (_, i) => ({
      notificationId: `notif-${i}`,
      webhookUrl: `https://open.feishu.cn/open-apis/bot/v2/hook/${i}`,
      message: { msg_type: 'interactive', card: { id: i } },
      failedAt: `2024-01-01T00:00:0${i}.000Z`,
      error: `error-${i}`,
    }));

    await Promise.all(notifications.map((n) => writeDeadLetterNotification(n)));

    expect(mockSend).toHaveBeenCalledTimes(notifications.length);
    const ids = mockSend.mock.calls.map((c) => c[0].input.Item.notificationId).sort();
    expect(ids).toEqual(['notif-0', 'notif-1', 'notif-2', 'notif-3']);

    for (const call of mockSend.mock.calls) {
      expect(call[0].input.TableName).toBe('test-dead-letter-table');
    }
  });

  it('should propagate per-call errors without affecting sibling calls', async () => {
    // First call rejects, the rest succeed. Each call must be observed independently.
    mockSend
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const resourceArn = 'arn:aws:ec2:us-east-1:123:instance/i-mixed';
    const groupId = 'group-mixed';

    const results = await Promise.allSettled([
      addAlarmToGroup(resourceArn, groupId, makeAlarm('m1', resourceArn)),
      addAlarmToGroup(resourceArn, groupId, makeAlarm('m2', resourceArn)),
      addAlarmToGroup(resourceArn, groupId, makeAlarm('m3', resourceArn)),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');
    expect(mockSend).toHaveBeenCalledTimes(3);
  });
});
