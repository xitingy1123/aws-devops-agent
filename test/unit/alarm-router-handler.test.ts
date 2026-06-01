import { AlarmRouterInput, SystemConfig } from '../../src/shared/types';

// Mock AWS SDK clients
const mockCloudWatchSend = jest.fn().mockResolvedValue({});
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: mockCloudWatchSend,
  })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: mockSsmSend,
  })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

function createValidConfig(overrides?: Partial<SystemConfig>): SystemConfig {
  return {
    version: '1.0.0',
    alarmSelectionMode: 'all',
    selectedAlarmNames: [],
    alarmFilters: [],
    feishuWebhooks: [],
    rcaTimeout: 300,
    retryPolicy: { maxRetries: 3, initialDelay: 5, backoffMultiplier: 2 },
    groupingWindow: 120,
    retentionDays: 90,
    ...overrides,
  };
}

function buildValidAlarmEvent(overrides?: Partial<AlarmRouterInput>): AlarmRouterInput {
  return {
    version: '0',
    id: 'test-event-id',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-15T10:30:00Z',
    region: 'us-east-1',
    resources: ['arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU'],
    detail: {
      alarmName: 'HighCPU',
      state: {
        value: 'ALARM',
        reason: 'Threshold Crossed',
        reasonData: JSON.stringify({
          threshold: 80,
          recentDatapoints: [75, 82, 90],
        }),
        timestamp: '2024-01-15T10:30:00Z',
      },
      previousState: {
        value: 'OK',
        reason: 'Threshold OK',
        timestamp: '2024-01-15T10:25:00Z',
      },
      configuration: {
        metrics: [
          {
            id: 'm1',
            metricStat: {
              metric: {
                namespace: 'AWS/EC2',
                name: 'CPUUtilization',
                dimensions: { InstanceId: 'i-1234567890abcdef0' },
              },
              period: 300,
              stat: 'Average',
            },
            returnData: true,
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('AlarmRouter Handler', () => {
  let handler: (event: AlarmRouterInput) => Promise<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the module to get a fresh ConfigManager instance each test
    jest.resetModules();

    // Re-apply mocks after module reset
    jest.doMock('@aws-sdk/client-cloudwatch', () => ({
      CloudWatchClient: jest.fn().mockImplementation(() => ({
        send: mockCloudWatchSend,
      })),
      PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
    }));

    jest.doMock('@aws-sdk/client-ssm', () => ({
      SSMClient: jest.fn().mockImplementation(() => ({
        send: mockSsmSend,
      })),
      GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
    }));

    mockCloudWatchSend.mockResolvedValue({});
  });

  async function loadHandler(config: SystemConfig) {
    mockSsmSend.mockResolvedValue({
      Parameter: { Value: JSON.stringify(config) },
    });
    const mod = await import('../../src/lambdas/alarm-router/index');
    handler = mod.handler;
  }

  describe('complete processing flow', () => {
    it('should parse and pass a valid alarm event in "all" mode', async () => {
      await loadHandler(createValidConfig());
      const event = buildValidAlarmEvent();
      const result = await handler(event);

      expect(result.filtered).toBe(false);
      expect(result.alarmName).toBe('HighCPU');
      expect(result.namespace).toBe('AWS/EC2');
      expect(result.metricName).toBe('CPUUtilization');
      expect(result.accountId).toBe('123456789012');
      expect(result.region).toBe('us-east-1');
    });

    it('should filter malformed events and emit metrics', async () => {
      await loadHandler(createValidConfig());
      const event = buildValidAlarmEvent();
      (event as any).detail = undefined;

      const result = await handler(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toBeTruthy();
      expect(mockCloudWatchSend).toHaveBeenCalled();
    });

    it('should emit metrics for accepted alarms', async () => {
      await loadHandler(createValidConfig());
      const event = buildValidAlarmEvent();
      await handler(event);

      expect(mockCloudWatchSend).toHaveBeenCalled();
    });
  });

  describe('all/custom mode switching', () => {
    it('should pass all alarms in "all" mode', async () => {
      await loadHandler(createValidConfig({ alarmSelectionMode: 'all' }));
      const event = buildValidAlarmEvent();
      const result = await handler(event);

      expect(result.filtered).toBe(false);
    });

    it('should reject alarm not in selected list in "custom" mode', async () => {
      await loadHandler(
        createValidConfig({
          alarmSelectionMode: 'custom',
          selectedAlarmNames: ['AllowedAlarm'],
        })
      );

      const event = buildValidAlarmEvent(); // HighCPU is not in the selected list
      const result = await handler(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toBe('not_in_selected_alarms');
    });

    it('should pass alarm in selected list in "custom" mode', async () => {
      await loadHandler(
        createValidConfig({
          alarmSelectionMode: 'custom',
          selectedAlarmNames: ['HighCPU'],
        })
      );

      const event = buildValidAlarmEvent();
      const result = await handler(event);

      expect(result.filtered).toBe(false);
      expect(result.alarmName).toBe('HighCPU');
    });
  });

  describe('filter rule combinations', () => {
    it('should include alarm matching namespace include rule', async () => {
      await loadHandler(
        createValidConfig({
          alarmFilters: [{ type: 'namespace', value: 'AWS/EC2', action: 'include' }],
        })
      );

      const event = buildValidAlarmEvent();
      const result = await handler(event);

      expect(result.filtered).toBe(false);
    });

    it('should exclude alarm matching namespace exclude rule', async () => {
      await loadHandler(
        createValidConfig({
          alarmFilters: [{ type: 'namespace', value: 'AWS/EC2', action: 'exclude' }],
        })
      );

      const event = buildValidAlarmEvent();
      const result = await handler(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toContain('excluded_by_');
    });

    it('should reject alarm not matching any include rule', async () => {
      await loadHandler(
        createValidConfig({
          alarmFilters: [{ type: 'namespace', value: 'AWS/RDS', action: 'include' }],
        })
      );

      const event = buildValidAlarmEvent(); // namespace is AWS/EC2
      const result = await handler(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toBe('no_include_rule_matched');
    });

    it('should give exclude precedence over include', async () => {
      await loadHandler(
        createValidConfig({
          alarmFilters: [
            { type: 'namespace', value: 'AWS/EC2', action: 'include' },
            { type: 'name_pattern', value: '^High.*', action: 'exclude' },
          ],
        })
      );

      const event = buildValidAlarmEvent(); // alarmName: HighCPU, namespace: AWS/EC2
      const result = await handler(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toContain('excluded_by_');
    });

    it('should apply name_pattern filter correctly', async () => {
      await loadHandler(
        createValidConfig({
          alarmFilters: [{ type: 'name_pattern', value: '^prod-.*', action: 'include' }],
        })
      );

      const event = buildValidAlarmEvent(); // alarmName: HighCPU (doesn't match ^prod-.*)
      const result = await handler(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toBe('no_include_rule_matched');
    });

    it('should handle combined custom mode and filter rules', async () => {
      await loadHandler(
        createValidConfig({
          alarmSelectionMode: 'custom',
          selectedAlarmNames: ['HighCPU'],
          alarmFilters: [{ type: 'namespace', value: 'AWS/RDS', action: 'include' }],
        })
      );

      // HighCPU passes selection but namespace is AWS/EC2, not AWS/RDS
      const event = buildValidAlarmEvent();
      const result = await handler(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toBe('no_include_rule_matched');
    });
  });

  describe('SSM unavailability', () => {
    it('should use default config when SSM is unavailable', async () => {
      mockSsmSend.mockRejectedValue(new Error('SSM unavailable'));
      const mod = await import('../../src/lambdas/alarm-router/index');
      handler = mod.handler;

      const event = buildValidAlarmEvent();
      const result = await handler(event);

      // Default config has alarmSelectionMode: 'all' and no filters
      expect(result.filtered).toBe(false);
      expect(result.alarmName).toBe('HighCPU');
    });
  });
});
