// Feature: cloudwatch-alarm-auto-rca, Property 7: RCA context assembly completeness
// Validates: Requirements 3.2

import * as fc from 'fast-check';
import { buildRCAContext } from '../../src/lambdas/rca-analyzer/context-builder';
import { AlarmRouterOutput, ResourceIdentifier, formatResourceKey } from '../../src/shared/types';

// --- Arbitrary generators ---

const arbAlarmId = fc.string({ minLength: 10, maxLength: 80 }).map(
  (s) => `arn:aws:cloudwatch:us-east-1:123456789012:alarm:${s.replace(/[^a-zA-Z0-9-_]/g, 'x')}`
);

const arbResource: fc.Arbitrary<ResourceIdentifier> = fc.constantFrom<ResourceIdentifier>(
  { accountId: '123456789012', region: 'us-east-1', service: 'ec2', resourceId: 'i-abc123' },
  { accountId: '123456789012', region: 'us-east-1', service: 'rds', resourceId: 'prod-db' },
  { accountId: '123456789012', region: 'us-east-1', service: 'lambda', resourceId: 'my-func' },
  { accountId: '123456789012', region: 'us-east-1', service: 'ecs', resourceId: 'my-cluster/my-service' }
);

const arbTimestamp = fc.integer({ min: 1700000000000, max: 1710000000000 }).map(
  (ts) => new Date(ts).toISOString()
);

const arbNamespace = fc.constantFrom('AWS/EC2', 'AWS/RDS', 'AWS/Lambda', 'AWS/ECS', 'AWS/SQS');

const arbMetricName = fc.constantFrom(
  'CPUUtilization', 'FreeableMemory', 'Duration', 'Errors', 'Invocations'
);

const arbAlarm: fc.Arbitrary<AlarmRouterOutput> = fc.record({
  alarmId: arbAlarmId,
  alarmName: fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/[^a-zA-Z0-9-_]/g, 'a')),
  namespace: arbNamespace,
  metricName: arbMetricName,
  dimensions: fc.constant({}),
  threshold: fc.double({ min: 0, max: 1000, noNaN: true }),
  currentValue: fc.double({ min: 0, max: 2000, noNaN: true }),
  stateChangeTimestamp: arbTimestamp,
  previousState: fc.constant('OK'),
  accountId: fc.constant('123456789012'),
  region: fc.constant('us-east-1'),
  resource: arbResource,
  filtered: fc.constant(false),
});

const arbAlarms = fc.array(arbAlarm, { minLength: 1, maxLength: 10 });

describe('Property 7: RCA context assembly completeness', () => {
  it('assembled request always contains all alarm ARNs', () => {
    fc.assert(
      fc.property(arbAlarms, (alarms) => {
        const result = buildRCAContext(alarms);

        // All unique alarm ARNs must be present
        const expectedAlarmArns = [...new Set(alarms.map((a) => a.alarmId))];
        expect(result.context.alarmArns).toEqual(expect.arrayContaining(expectedAlarmArns));
        expect(result.context.alarmArns.length).toBe(expectedAlarmArns.length);
      }),
      { numRuns: 100 }
    );
  });

  it('assembled request always contains all resource keys', () => {
    fc.assert(
      fc.property(arbAlarms, (alarms) => {
        const result = buildRCAContext(alarms);

        // All unique non-empty resource keys must be present
        const expectedResourceKeys = [
          ...new Set(
            alarms
              .map((a) => formatResourceKey(a.resource))
              .filter((s) => s !== '')
          ),
        ];
        expect(result.context.resourceArns).toEqual(expect.arrayContaining(expectedResourceKeys));
        expect(result.context.resourceArns.length).toBe(expectedResourceKeys.length);
      }),
      { numRuns: 100 }
    );
  });

  it('time range start is at least 1 hour before the earliest alarm', () => {
    fc.assert(
      fc.property(arbAlarms, (alarms) => {
        const result = buildRCAContext(alarms);

        const timestamps = alarms
          .map((a) => new Date(a.stateChangeTimestamp).getTime())
          .filter((t) => !isNaN(t));

        if (timestamps.length > 0) {
          const earliestAlarm = Math.min(...timestamps);
          const timeRangeStart = new Date(result.context.timeRange.start).getTime();
          const oneHourMs = 60 * 60 * 1000;

          // Start should be at least 1 hour before earliest alarm
          expect(timeRangeStart).toBeLessThanOrEqual(earliestAlarm - oneHourMs + 1); // +1 for floating point
        }
      }),
      { numRuns: 100 }
    );
  });

  it('time range end covers the latest alarm timestamp', () => {
    fc.assert(
      fc.property(arbAlarms, (alarms) => {
        const result = buildRCAContext(alarms);

        const timestamps = alarms
          .map((a) => new Date(a.stateChangeTimestamp).getTime())
          .filter((t) => !isNaN(t));

        if (timestamps.length > 0) {
          const latestAlarm = Math.max(...timestamps);
          const timeRangeEnd = new Date(result.context.timeRange.end).getTime();

          // End should be at or after the latest alarm
          expect(timeRangeEnd).toBeGreaterThanOrEqual(latestAlarm);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('additional context is always a non-empty string', () => {
    fc.assert(
      fc.property(arbAlarms, (alarms) => {
        const result = buildRCAContext(alarms);

        expect(typeof result.context.additionalContext).toBe('string');
        expect(result.context.additionalContext.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('investigation type is always alarm_response', () => {
    fc.assert(
      fc.property(arbAlarms, (alarms) => {
        const result = buildRCAContext(alarms);
        expect(result.investigationType).toBe('alarm_response');
      }),
      { numRuns: 100 }
    );
  });

  it('all required fields are present in the assembled request', () => {
    fc.assert(
      fc.property(arbAlarms, (alarms) => {
        const result = buildRCAContext(alarms);

        // Verify structure completeness
        expect(result).toHaveProperty('investigationType');
        expect(result).toHaveProperty('context');
        expect(result.context).toHaveProperty('alarmArns');
        expect(result.context).toHaveProperty('resourceArns');
        expect(result.context).toHaveProperty('timeRange');
        expect(result.context.timeRange).toHaveProperty('start');
        expect(result.context.timeRange).toHaveProperty('end');
        expect(result.context).toHaveProperty('additionalContext');

        // Arrays should not be empty (since we always have at least 1 alarm)
        expect(result.context.alarmArns.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });
});
