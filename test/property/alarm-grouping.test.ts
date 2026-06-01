// Feature: cloudwatch-alarm-auto-rca, Property 6: Alarm grouping by resource and time window
// Validates: Requirements 2.5

import * as fc from 'fast-check';
import { AlarmRouterOutput, formatResourceKey } from '../../src/shared/types';

/**
 * Pure function that determines if two alarms should be grouped together.
 * Two alarms are grouped if and only if:
 * 1. They share the same resourceArn
 * 2. Their timestamps are within the grouping window (in seconds)
 */
/**
 * Groups alarms together if:
 * 1. They share the same resource (compared via formatResourceKey)
 * 2. Their timestamps are within the grouping window (in seconds)
 */
function shouldGroupAlarms(
  alarm1: AlarmRouterOutput,
  alarm2: AlarmRouterOutput,
  groupingWindowSeconds: number
): boolean {
  if (formatResourceKey(alarm1.resource) !== formatResourceKey(alarm2.resource)) {
    return false;
  }

  const t1 = new Date(alarm1.stateChangeTimestamp).getTime();
  const t2 = new Date(alarm2.stateChangeTimestamp).getTime();
  const diffMs = Math.abs(t1 - t2);

  return diffMs <= groupingWindowSeconds * 1000;
}

/**
 * Groups alarms by resource and time window using the pure grouping logic.
 * Returns an array of groups, where each group is an array of alarms.
 */
function groupAlarms(
  alarms: AlarmRouterOutput[],
  groupingWindowSeconds: number
): AlarmRouterOutput[][] {
  if (alarms.length === 0) return [];

  const groups: AlarmRouterOutput[][] = [];

  for (const alarm of alarms) {
    let addedToGroup = false;

    for (const group of groups) {
      // An alarm joins a group if it should be grouped with the first alarm in the group
      // (same resource and within time window of the group's first alarm)
      if (shouldGroupAlarms(group[0], alarm, groupingWindowSeconds)) {
        group.push(alarm);
        addedToGroup = true;
        break;
      }
    }

    if (!addedToGroup) {
      groups.push([alarm]);
    }
  }

  return groups;
}

// --- Arbitrary generators ---

const arbResourceArn = fc.constantFrom(
  'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
  'arn:aws:ec2:us-east-1:123456789012:instance/i-def456',
  'arn:aws:rds:us-east-1:123456789012:db:prod-db',
  'arn:aws:lambda:us-east-1:123456789012:function:my-func'
);

const arbBaseTimestamp = fc.integer({ min: 1700000000000, max: 1710000000000 });

const arbAlarm = (resourceArn: string, timestamp: number): AlarmRouterOutput => ({
  alarmId: `arn:aws:cloudwatch:us-east-1:123456789012:alarm:alarm-${Math.random().toString(36).slice(2, 8)}`,
  alarmName: `alarm-${Math.random().toString(36).slice(2, 8)}`,
  namespace: 'AWS/EC2',
  metricName: 'CPUUtilization',
  dimensions: {},
  threshold: 80,
  currentValue: 95,
  stateChangeTimestamp: new Date(timestamp).toISOString(),
  previousState: 'OK',
  accountId: '123456789012',
  region: 'us-east-1',
  // 测试里 resourceArn 实际是个不透明的资源标识符（property test 比较用）。
  // 把它塞到 resource.resourceId,formatResourceKey 比较行为不变。
  resource: {
    accountId: '123456789012',
    region: 'us-east-1',
    service: 'ec2',
    resourceId: resourceArn,
  },
  filtered: false,
});

const arbGroupingWindow = fc.integer({ min: 30, max: 600 }); // 30s to 10min

describe('Property 6: Alarm grouping by resource and time window', () => {
  it('alarms for different resources are never in the same group', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(arbResourceArn, arbBaseTimestamp).map(([arn, ts]) => arbAlarm(arn, ts)),
          { minLength: 2, maxLength: 20 }
        ),
        arbGroupingWindow,
        (alarms, windowSeconds) => {
          const groups = groupAlarms(alarms, windowSeconds);

          // Every group must contain alarms for only one resource
          for (const group of groups) {
            const resourceKeys = new Set(group.map((a) => formatResourceKey(a.resource)));
            expect(resourceKeys.size).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('alarms with same resource and within time window are grouped together', () => {
    fc.assert(
      fc.property(
        arbResourceArn,
        arbBaseTimestamp,
        arbGroupingWindow,
        fc.integer({ min: 0, max: 100 }), // offset within window (as percentage)
        (resourceArn, baseTs, windowSeconds, offsetPct) => {
          const windowMs = windowSeconds * 1000;
          const offset = Math.floor((offsetPct / 100) * windowMs);

          const alarm1 = arbAlarm(resourceArn, baseTs);
          const alarm2 = arbAlarm(resourceArn, baseTs + offset);

          expect(shouldGroupAlarms(alarm1, alarm2, windowSeconds)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('alarms with same resource but outside time window are NOT grouped together', () => {
    fc.assert(
      fc.property(
        arbResourceArn,
        arbBaseTimestamp,
        arbGroupingWindow,
        fc.integer({ min: 1, max: 100000 }), // extra ms beyond window
        (resourceArn, baseTs, windowSeconds, extraMs) => {
          const windowMs = windowSeconds * 1000;
          // Ensure the offset is strictly beyond the window
          const offset = windowMs + extraMs;

          const alarm1 = arbAlarm(resourceArn, baseTs);
          const alarm2 = arbAlarm(resourceArn, baseTs + offset);

          expect(shouldGroupAlarms(alarm1, alarm2, windowSeconds)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('alarms with different resources are never grouped regardless of time', () => {
    fc.assert(
      fc.property(
        arbBaseTimestamp,
        arbGroupingWindow,
        (baseTs, windowSeconds) => {
          const arn1 = 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123';
          const arn2 = 'arn:aws:ec2:us-east-1:123456789012:instance/i-def456';

          // Same timestamp but different resources
          const alarm1 = arbAlarm(arn1, baseTs);
          const alarm2 = arbAlarm(arn2, baseTs);

          expect(shouldGroupAlarms(alarm1, alarm2, windowSeconds)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all alarms appear in exactly one group (no loss, no duplication)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(arbResourceArn, arbBaseTimestamp).map(([arn, ts]) => arbAlarm(arn, ts)),
          { minLength: 1, maxLength: 20 }
        ),
        arbGroupingWindow,
        (alarms, windowSeconds) => {
          const groups = groupAlarms(alarms, windowSeconds);

          const totalInGroups = groups.reduce((sum, g) => sum + g.length, 0);
          expect(totalInGroups).toBe(alarms.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});
