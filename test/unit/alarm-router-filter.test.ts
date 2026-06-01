import { shouldProcessAlarm, applyFilterRules } from '../../src/lambdas/alarm-router/filter';
import { AlarmRouterOutput, SystemConfig, AlarmFilterRule } from '../../src/shared/types';

function makeAlarm(overrides: Partial<AlarmRouterOutput> = {}): AlarmRouterOutput {
  return {
    alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:test-alarm',
    alarmName: 'HighCPUAlarm',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-1234567890abcdef0' },
    threshold: 80,
    currentValue: 95,
    stateChangeTimestamp: '2024-01-01T00:00:00.000Z',
    previousState: 'OK',
    accountId: '123456789012',
    region: 'us-east-1',
    resource: {
      accountId: '123456789012',
      region: 'us-east-1',
      service: 'ec2',
      resourceId: 'i-1234567890abcdef0',
    },
    filtered: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    version: '1.0',
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

describe('shouldProcessAlarm', () => {
  describe('alarm selection mode', () => {
    it('should pass all alarms when mode is "all"', () => {
      const alarm = makeAlarm();
      const config = makeConfig({ alarmSelectionMode: 'all' });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(true);
    });

    it('should pass alarm when mode is "custom" and alarm name is in selected list', () => {
      const alarm = makeAlarm({ alarmName: 'HighCPUAlarm' });
      const config = makeConfig({
        alarmSelectionMode: 'custom',
        selectedAlarmNames: ['HighCPUAlarm', 'LowMemoryAlarm'],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(true);
    });

    it('should reject alarm when mode is "custom" and alarm name is not in selected list', () => {
      const alarm = makeAlarm({ alarmName: 'UnknownAlarm' });
      const config = makeConfig({
        alarmSelectionMode: 'custom',
        selectedAlarmNames: ['HighCPUAlarm', 'LowMemoryAlarm'],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('not_in_selected_alarms');
    });

    it('should apply selection mode before filter rules', () => {
      const alarm = makeAlarm({ alarmName: 'NotSelected', namespace: 'AWS/EC2' });
      const config = makeConfig({
        alarmSelectionMode: 'custom',
        selectedAlarmNames: ['HighCPUAlarm'],
        alarmFilters: [{ type: 'namespace', value: 'AWS/EC2', action: 'include' }],
      });
      // Even though the namespace filter would include it, selection mode rejects it first
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('not_in_selected_alarms');
    });
  });

  describe('filter rules - namespace', () => {
    it('should include alarm matching namespace include rule', () => {
      const alarm = makeAlarm({ namespace: 'AWS/EC2' });
      const config = makeConfig({
        alarmFilters: [{ type: 'namespace', value: 'AWS/EC2', action: 'include' }],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(true);
    });

    it('should reject alarm not matching any namespace include rule', () => {
      const alarm = makeAlarm({ namespace: 'AWS/RDS' });
      const config = makeConfig({
        alarmFilters: [{ type: 'namespace', value: 'AWS/EC2', action: 'include' }],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('no_include_rule_matched');
    });

    it('should exclude alarm matching namespace exclude rule', () => {
      const alarm = makeAlarm({ namespace: 'AWS/EC2' });
      const config = makeConfig({
        alarmFilters: [{ type: 'namespace', value: 'AWS/EC2', action: 'exclude' }],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('excluded_by_namespace:AWS/EC2');
    });
  });

  describe('filter rules - name_pattern', () => {
    it('should include alarm matching name pattern', () => {
      const alarm = makeAlarm({ alarmName: 'prod-HighCPU-us-east-1' });
      const config = makeConfig({
        alarmFilters: [{ type: 'name_pattern', value: '^prod-.*', action: 'include' }],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(true);
    });

    it('should reject alarm not matching name pattern', () => {
      const alarm = makeAlarm({ alarmName: 'dev-HighCPU' });
      const config = makeConfig({
        alarmFilters: [{ type: 'name_pattern', value: '^prod-.*', action: 'include' }],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(false);
    });

    it('should handle invalid regex gracefully (no match)', () => {
      const alarm = makeAlarm({ alarmName: 'test' });
      const config = makeConfig({
        alarmFilters: [{ type: 'name_pattern', value: '[invalid', action: 'exclude' }],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(true);
    });
  });

  describe('exclude takes precedence over include', () => {
    it('should exclude even when include rule also matches', () => {
      const alarm = makeAlarm({ namespace: 'AWS/EC2', alarmName: 'test-alarm' });
      const config = makeConfig({
        alarmFilters: [
          { type: 'namespace', value: 'AWS/EC2', action: 'include' },
          { type: 'name_pattern', value: '^test-.*', action: 'exclude' },
        ],
      });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('excluded_by_');
    });
  });

  describe('no filter rules', () => {
    it('should pass all alarms when no filter rules are configured', () => {
      const alarm = makeAlarm();
      const config = makeConfig({ alarmFilters: [] });
      const result = shouldProcessAlarm(alarm, config);
      expect(result.pass).toBe(true);
    });
  });
});

describe('applyFilterRules', () => {
  it('should pass when filters array is empty', () => {
    const alarm = makeAlarm();
    const result = applyFilterRules(alarm, []);
    expect(result.pass).toBe(true);
  });

  it('should pass when only exclude rules exist and none match', () => {
    const alarm = makeAlarm({ namespace: 'AWS/EC2' });
    const filters: AlarmFilterRule[] = [
      { type: 'namespace', value: 'AWS/RDS', action: 'exclude' },
    ];
    const result = applyFilterRules(alarm, filters);
    expect(result.pass).toBe(true);
  });

  it('should handle multiple include rules (OR logic)', () => {
    const alarm = makeAlarm({ namespace: 'AWS/RDS' });
    const filters: AlarmFilterRule[] = [
      { type: 'namespace', value: 'AWS/EC2', action: 'include' },
      { type: 'namespace', value: 'AWS/RDS', action: 'include' },
    ];
    const result = applyFilterRules(alarm, filters);
    expect(result.pass).toBe(true);
  });
});
