// Feature: cloudwatch-alarm-auto-rca, Property 3: Alarm filter rule correctness
// Validates: Requirements 1.5

import * as fc from 'fast-check';
import { applyFilterRules } from '../../src/lambdas/alarm-router/filter';
import { AlarmRouterOutput, AlarmFilterRule } from '../../src/shared/types';

/**
 * Arbitrary generator for alarm output.
 */
const arbNamespace = fc.constantFrom(
  'AWS/EC2', 'AWS/RDS', 'AWS/Lambda', 'AWS/ECS', 'AWS/SQS', 'AWS/DynamoDB'
);

const arbAlarmName = fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9\-_]+$/.test(s));

const arbDimensionKey = fc.constantFrom(
  'InstanceId', 'FunctionName', 'DBInstanceIdentifier', 'Environment', 'Team'
);

const arbDimensionValue = fc.constantFrom(
  'i-abc123', 'my-function', 'prod-db', 'production', 'staging', 'platform', 'backend'
);

const arbDimensions: fc.Arbitrary<Record<string, string>> = fc.dictionary(
  arbDimensionKey,
  arbDimensionValue,
  { minKeys: 0, maxKeys: 3 }
);

const arbAlarm: fc.Arbitrary<AlarmRouterOutput> = fc.tuple(arbAlarmName, arbNamespace, arbDimensions).map(
  ([alarmName, namespace, dimensions]) => ({
    alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:test',
    alarmName,
    namespace,
    metricName: 'CPUUtilization',
    dimensions,
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
      resourceId: 'i-abc123',
    },
    filtered: false,
  })
);

/**
 * Arbitrary generator for filter rules using values that can match the alarm generators.
 */
const arbFilterAction = fc.constantFrom('include', 'exclude') as fc.Arbitrary<'include' | 'exclude'>;

const arbNamespaceFilter: fc.Arbitrary<AlarmFilterRule> = fc.record({
  type: fc.constant('namespace') as fc.Arbitrary<'namespace'>,
  value: arbNamespace,
  action: arbFilterAction,
});

const arbNamePatternFilter: fc.Arbitrary<AlarmFilterRule> = fc.record({
  type: fc.constant('name_pattern') as fc.Arbitrary<'name_pattern'>,
  value: fc.constantFrom('^a.*', '^b.*', '.*test.*', '.*prod.*', '.*'),
  action: arbFilterAction,
});

const arbFilterRule: fc.Arbitrary<AlarmFilterRule> = fc.oneof(
  arbNamespaceFilter,
  arbNamePatternFilter
);

const arbFilterRules: fc.Arbitrary<AlarmFilterRule[]> = fc.array(arbFilterRule, { minLength: 0, maxLength: 5 });

describe('Property 3: Alarm filter rule correctness', () => {
  it('should produce deterministic results for the same alarm and rules', () => {
    fc.assert(
      fc.property(arbAlarm, arbFilterRules, (alarm, filters) => {
        const result1 = applyFilterRules(alarm, filters);
        const result2 = applyFilterRules(alarm, filters);

        // Same input must produce same output (determinism)
        expect(result1.pass).toBe(result2.pass);
        expect(result1.reason).toBe(result2.reason);
      }),
      { numRuns: 100 }
    );
  });

  it('should always pass when no filter rules exist', () => {
    fc.assert(
      fc.property(arbAlarm, (alarm) => {
        const result = applyFilterRules(alarm, []);
        expect(result.pass).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should give exclude rules precedence over include rules', () => {
    fc.assert(
      fc.property(arbAlarm, arbNamespace, (alarm, ns) => {
        // Set alarm namespace to match
        const testAlarm = { ...alarm, namespace: ns };

        // Create both include and exclude rules for the same namespace
        const filters: AlarmFilterRule[] = [
          { type: 'namespace', value: ns, action: 'include' },
          { type: 'namespace', value: ns, action: 'exclude' },
        ];

        const result = applyFilterRules(testAlarm, filters);

        // Exclude should take precedence
        expect(result.pass).toBe(false);
        expect(result.reason).toContain('excluded_by_');
      }),
      { numRuns: 100 }
    );
  });

  it('should pass when only exclude rules exist and none match', () => {
    fc.assert(
      fc.property(arbAlarm, (alarm) => {
        // Create exclude rules that won't match the alarm
        const nonMatchingNamespace = alarm.namespace === 'AWS/EC2' ? 'AWS/RDS' : 'AWS/EC2';
        const filters: AlarmFilterRule[] = [
          { type: 'namespace', value: nonMatchingNamespace, action: 'exclude' },
        ];

        const result = applyFilterRules(alarm, filters);
        expect(result.pass).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should reject when include rules exist but none match', () => {
    fc.assert(
      fc.property(arbAlarm, (alarm) => {
        // Create include rules that won't match the alarm
        const nonMatchingNamespace = alarm.namespace === 'AWS/EC2' ? 'AWS/RDS' : 'AWS/EC2';
        const filters: AlarmFilterRule[] = [
          { type: 'namespace', value: nonMatchingNamespace, action: 'include' },
        ];

        const result = applyFilterRules(alarm, filters);
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('no_include_rule_matched');
      }),
      { numRuns: 100 }
    );
  });

  it('should pass when at least one include rule matches and no exclude rule matches', () => {
    fc.assert(
      fc.property(arbAlarm, (alarm) => {
        // Create an include rule that matches the alarm's namespace
        const filters: AlarmFilterRule[] = [
          { type: 'namespace', value: alarm.namespace, action: 'include' },
        ];

        const result = applyFilterRules(alarm, filters);
        expect(result.pass).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
