// Feature: cloudwatch-alarm-auto-rca, Property 4: Alarm selection mode correctness
// Validates: Requirements 1.6, 1.7, 1.8

import * as fc from 'fast-check';
import { shouldProcessAlarm } from '../../src/lambdas/alarm-router/filter';
import { AlarmRouterOutput, SystemConfig, AlarmFilterRule } from '../../src/shared/types';

/**
 * Arbitrary generator for alarm names.
 */
const arbAlarmName = fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9\-_]+$/.test(s));

/**
 * Arbitrary generator for alarm output.
 */
const arbAlarm: fc.Arbitrary<AlarmRouterOutput> = arbAlarmName.map((name: string) => ({
  alarmId: `arn:aws:cloudwatch:us-east-1:123456789012:alarm:${name}`,
  alarmName: name,
  namespace: 'AWS/EC2',
  metricName: 'CPUUtilization',
  dimensions: { InstanceId: 'i-1234567890abcdef0' },
  threshold: 80,
  currentValue: 95,
  stateChangeTimestamp: '2024-01-01T00:00:00Z',
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
}));

/**
 * Arbitrary generator for a list of selected alarm names.
 */
const arbSelectedAlarmNames: fc.Arbitrary<string[]> = fc.array(arbAlarmName, { minLength: 1, maxLength: 10 });

/**
 * Base config without selection mode specifics.
 */
function makeBaseConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
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

describe('Property 4: Alarm selection mode correctness', () => {
  it('should pass all alarms when mode is "all" regardless of alarm name', () => {
    fc.assert(
      fc.property(arbAlarm, (alarm) => {
        const config = makeBaseConfig({ alarmSelectionMode: 'all' });
        const result = shouldProcessAlarm(alarm, config);
        // In "all" mode with no filter rules, all alarms pass
        expect(result.pass).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should pass alarm in "custom" mode if and only if alarmName is in selectedAlarmNames', () => {
    fc.assert(
      fc.property(arbAlarm, arbSelectedAlarmNames, (alarm, selectedNames) => {
        const config = makeBaseConfig({
          alarmSelectionMode: 'custom',
          selectedAlarmNames: selectedNames,
        });

        const result = shouldProcessAlarm(alarm, config);

        if (selectedNames.includes(alarm.alarmName)) {
          // Alarm is in the list, should pass selection check
          expect(result.pass).toBe(true);
        } else {
          // Alarm is not in the list, should be rejected
          expect(result.pass).toBe(false);
          expect(result.reason).toBe('not_in_selected_alarms');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('should always pass alarm in "custom" mode when alarm name is explicitly in the list', () => {
    fc.assert(
      fc.property(arbAlarm, arbSelectedAlarmNames, (alarm, otherNames) => {
        // Ensure the alarm name is in the selected list
        const selectedNames = [...otherNames, alarm.alarmName];
        const config = makeBaseConfig({
          alarmSelectionMode: 'custom',
          selectedAlarmNames: selectedNames,
        });

        const result = shouldProcessAlarm(alarm, config);
        expect(result.pass).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should apply selection mode before filter rules (custom mode rejects even if filter would include)', () => {
    fc.assert(
      fc.property(arbAlarm, arbSelectedAlarmNames, (alarm, selectedNames) => {
        // Ensure alarm is NOT in the selected list
        const filteredNames = selectedNames.filter(n => n !== alarm.alarmName);
        if (filteredNames.length === 0) {
          filteredNames.push('some-other-alarm-name-xyz');
        }

        const config = makeBaseConfig({
          alarmSelectionMode: 'custom',
          selectedAlarmNames: filteredNames,
          // Include filter that would match the alarm's namespace
          alarmFilters: [
            { type: 'namespace', value: alarm.namespace, action: 'include' },
          ],
        });

        const result = shouldProcessAlarm(alarm, config);

        // Selection mode should reject before filter rules are applied
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('not_in_selected_alarms');
      }),
      { numRuns: 100 }
    );
  });

  it('should apply filter rules after selection mode passes in "all" mode', () => {
    fc.assert(
      fc.property(arbAlarm, (alarm) => {
        // In "all" mode, selection passes, then filter rules apply
        const config = makeBaseConfig({
          alarmSelectionMode: 'all',
          alarmFilters: [
            { type: 'namespace', value: 'NonExistentNamespace', action: 'include' },
          ],
        });

        const result = shouldProcessAlarm(alarm, config);

        // Selection passes (all mode), but filter rejects (no include match)
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('no_include_rule_matched');
      }),
      { numRuns: 100 }
    );
  });

  it('should apply filter rules after selection mode passes in "custom" mode', () => {
    fc.assert(
      fc.property(arbAlarm, (alarm) => {
        // In "custom" mode with alarm in list, filter rules still apply
        const config = makeBaseConfig({
          alarmSelectionMode: 'custom',
          selectedAlarmNames: [alarm.alarmName],
          alarmFilters: [
            { type: 'namespace', value: 'NonExistentNamespace', action: 'include' },
          ],
        });

        const result = shouldProcessAlarm(alarm, config);

        // Selection passes (alarm in list), but filter rejects
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('no_include_rule_matched');
      }),
      { numRuns: 100 }
    );
  });
});
