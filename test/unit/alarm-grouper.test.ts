import { AlarmGrouperInput, AlarmRouterOutput, AlarmGroup } from '../../src/shared/types';

// Must define mockSend before jest.mock so it's hoisted properly
const mockSend = jest.fn();

// Mock @aws-sdk/client-dynamodb
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

// Mock @aws-sdk/lib-dynamodb
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockImplementation(() => ({
      send: (...args: any[]) => mockSend(...args),
    })),
  },
  QueryCommand: jest.fn().mockImplementation((params) => ({ ...params, _type: 'Query' })),
  PutCommand: jest.fn().mockImplementation((params) => ({ ...params, _type: 'Put' })),
  UpdateCommand: jest.fn().mockImplementation((params) => ({ ...params, _type: 'Update' })),
}));

// Mock @aws-sdk/client-ssm
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockRejectedValue(new Error('SSM unavailable')),
  })),
  GetParameterCommand: jest.fn(),
}));

// Mock crypto
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn().mockReturnValue('test-group-id-1234'),
}));

// Import handler after mocks are set up
import { handler } from '../../src/lambdas/alarm-grouper/index';

describe('AlarmGrouper Lambda handler', () => {
  const baseAlarm: AlarmRouterOutput = {
    alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU',
    alarmName: 'HighCPU',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-abc123' },
    threshold: 80,
    currentValue: 95,
    stateChangeTimestamp: '2024-01-15T10:00:00.000Z',
    previousState: 'OK',
    accountId: '123456789012',
    region: 'us-east-1',
    resource: {
      accountId: '123456789012',
      region: 'us-east-1',
      service: 'ec2',
      resourceId: 'i-abc123',
    },
    filtered: false,
  };

  // resourceKey is what the new alarm-grouper builds via formatResourceKey()
  // and stores as the AlarmGroup.resourceArn field.
  const baseAlarmResourceKey = '123456789012/ec2/us-east-1/i-abc123';

  const baseInput: AlarmGrouperInput = {
    alarm: baseAlarm,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALARM_GROUP_TABLE_NAME = 'test-alarm-group-table';
  });

  afterEach(() => {
    delete process.env.ALARM_GROUP_TABLE_NAME;
  });

  describe('New group creation', () => {
    it('should create a new group when no active group exists for the resource', async () => {
      // Query returns no items (no active group)
      mockSend.mockResolvedValueOnce({ Items: [] });
      // Put succeeds
      mockSend.mockResolvedValueOnce({});

      const result = await handler(baseInput);

      expect(result.groupId).toBe('test-group-id-1234');
      expect(result.alarms).toHaveLength(1);
      expect(result.alarms[0]).toEqual(baseAlarm);
      expect(result.isNewGroup).toBe(true);
      expect(result.shouldWait).toBe(false);
    });

    it('should create a new group when query returns undefined Items', async () => {
      // Query returns no Items field
      mockSend.mockResolvedValueOnce({});
      // Put succeeds
      mockSend.mockResolvedValueOnce({});

      const result = await handler(baseInput);

      expect(result.isNewGroup).toBe(true);
      expect(result.shouldWait).toBe(false);
      expect(result.alarms).toHaveLength(1);
    });
  });

  describe('Join existing group', () => {
    it('should add alarm to existing active group', async () => {
      const existingGroup: AlarmGroup = {
        resourceArn: baseAlarmResourceKey,
        groupId: 'existing-group-id',
        alarms: [
          {
            ...baseAlarm,
            alarmName: 'PreviousAlarm',
            stateChangeTimestamp: '2024-01-15T09:59:00.000Z',
          },
        ],
        windowStart: '2024-01-15T09:59:00.000Z',
        windowEnd: '2024-01-15T10:01:00.000Z',
        status: 'collecting',
        ttl: 1705312860,
      };

      // Query returns existing active group
      mockSend.mockResolvedValueOnce({ Items: [existingGroup] });
      // Update succeeds
      mockSend.mockResolvedValueOnce({});

      const result = await handler(baseInput);

      expect(result.groupId).toBe('existing-group-id');
      expect(result.alarms).toHaveLength(2);
      expect(result.isNewGroup).toBe(false);
      expect(result.shouldWait).toBe(true);
      expect(result.waitUntil).toBe('2024-01-15T10:01:00.000Z');
    });
  });

  describe('Grouping window boundary conditions', () => {
    it('should create new group when existing group window has expired', async () => {
      // Query returns no items because filter expression excludes expired groups
      mockSend.mockResolvedValueOnce({ Items: [] });
      // Put succeeds
      mockSend.mockResolvedValueOnce({});

      const result = await handler(baseInput);

      expect(result.isNewGroup).toBe(true);
      expect(result.shouldWait).toBe(false);
    });
  });

  describe('DynamoDB unavailable - degraded mode', () => {
    it('should return single-alarm group when DynamoDB query fails', async () => {
      // Query throws error
      mockSend.mockRejectedValueOnce(new Error('DynamoDB service unavailable'));

      const result = await handler(baseInput);

      // Should proceed in degraded mode
      expect(result.alarms).toHaveLength(1);
      expect(result.alarms[0]).toEqual(baseAlarm);
      expect(result.isNewGroup).toBe(true);
      expect(result.shouldWait).toBe(false);
      // groupId should still be assigned (fallback UUID)
      expect(result.groupId).toBeDefined();
      expect(result.groupId.length).toBeGreaterThan(0);
    });

    it('should return single-alarm group when DynamoDB put fails after query succeeds', async () => {
      // Query returns no items
      mockSend.mockResolvedValueOnce({ Items: [] });
      // Put throws error
      mockSend.mockRejectedValueOnce(new Error('DynamoDB write failed'));

      const result = await handler(baseInput);

      // Should proceed in degraded mode
      expect(result.alarms).toHaveLength(1);
      expect(result.isNewGroup).toBe(true);
      expect(result.shouldWait).toBe(false);
    });

    it('should return single-alarm group when DynamoDB update fails for existing group', async () => {
      const existingGroup: AlarmGroup = {
        resourceArn: baseAlarmResourceKey,
        groupId: 'existing-group-id',
        alarms: [baseAlarm],
        windowStart: '2024-01-15T09:59:00.000Z',
        windowEnd: '2024-01-15T10:01:00.000Z',
        status: 'collecting',
        ttl: 1705312860,
      };

      // Query returns existing group
      mockSend.mockResolvedValueOnce({ Items: [existingGroup] });
      // Update throws error
      mockSend.mockRejectedValueOnce(new Error('DynamoDB update failed'));

      const result = await handler(baseInput);

      // Should proceed in degraded mode
      expect(result.alarms).toHaveLength(1);
      expect(result.isNewGroup).toBe(true);
      expect(result.shouldWait).toBe(false);
    });
  });
});
