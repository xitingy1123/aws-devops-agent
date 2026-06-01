// Feature: cloudwatch-alarm-auto-rca, Property 2: Malformed event graceful handling
// Validates: Requirements 1.3

import * as fc from 'fast-check';
import { parseAlarmEvent } from '../../src/lambdas/alarm-router/parser';
import { AlarmRouterInput } from '../../src/shared/types';

/**
 * Arbitrary generator for malformed CloudWatch alarm events.
 * These are events that are missing required fields that the parser checks:
 * - Missing or falsy detail
 * - Missing or falsy detail.alarmName
 * - Missing or falsy detail.state or detail.state.timestamp
 */
const arbMalformedEvent: fc.Arbitrary<any> = fc.oneof(
  // Completely empty object
  fc.constant({}),

  // Null detail
  fc.constant({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: null,
  }),

  // Undefined detail
  fc.constant({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: undefined,
  }),

  // Empty detail object (missing alarmName)
  fc.constant({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {},
  }),

  // Missing alarmName (falsy values: null, undefined, empty string, 0, false)
  fc.constantFrom(null, undefined, '', 0, false).map(val => ({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      alarmName: val,
      state: { value: 'ALARM', reason: 'test', timestamp: '2024-01-01T00:00:00Z' },
      previousState: { value: 'OK', reason: 'test', timestamp: '2024-01-01T00:00:00Z' },
      configuration: {},
    },
  })),

  // Missing state (null or undefined)
  fc.constantFrom(null, undefined).map(val => ({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      alarmName: 'test-alarm',
      state: val,
      previousState: { value: 'OK', reason: 'test', timestamp: '2024-01-01T00:00:00Z' },
      configuration: {},
    },
  })),

  // Missing state.timestamp (falsy values)
  fc.constantFrom(null, undefined, '', 0, false).map(val => ({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      alarmName: 'test-alarm',
      state: { value: 'ALARM', reason: 'test', timestamp: val },
      previousState: { value: 'OK', reason: 'test', timestamp: '2024-01-01T00:00:00Z' },
      configuration: {},
    },
  })),

  // detail is a non-object type that will cause property access to fail
  fc.constantFrom(0, false, '').map(val => ({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: val,
  })),

  // Missing resources array
  fc.constant({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: undefined,
    detail: null,
  }),

  // State is an empty object (no timestamp)
  fc.constant({
    version: '0',
    id: 'test',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      alarmName: 'test-alarm',
      state: {},
      previousState: { value: 'OK', reason: 'test', timestamp: '2024-01-01T00:00:00Z' },
      configuration: {},
    },
  })
);

describe('Property 2: Malformed event graceful handling', () => {
  it('should return filtered: true for any malformed event without throwing', () => {
    fc.assert(
      fc.property(arbMalformedEvent, (event: any) => {
        // Should not throw
        let result: any;
        expect(() => {
          result = parseAlarmEvent(event as AlarmRouterInput);
        }).not.toThrow();

        // Should return filtered: true
        expect(result.filtered).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should return a non-empty filterReason for any malformed event', () => {
    fc.assert(
      fc.property(arbMalformedEvent, (event: any) => {
        const result = parseAlarmEvent(event as AlarmRouterInput);
        expect(result.filtered).toBe(true);
        expect(result.filterReason).toBeTruthy();
        expect(typeof result.filterReason).toBe('string');
        expect(result.filterReason!.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('should always return a result with expected field types for malformed events', () => {
    fc.assert(
      fc.property(arbMalformedEvent, (event: any) => {
        const result = parseAlarmEvent(event as AlarmRouterInput);

        // Verify the output has the expected structure
        expect(result).toBeDefined();
        expect(result.filtered).toBe(true);
        expect(typeof result.filterReason).toBe('string');
        expect(typeof result.threshold).toBe('number');
        expect(typeof result.currentValue).toBe('number');
        expect(typeof result.accountId).toBe('string');
        expect(typeof result.region).toBe('string');
        expect(typeof result.resource).toBe('object');
        expect(typeof result.resource.accountId).toBe('string');
        expect(typeof result.resource.region).toBe('string');
        expect(typeof result.resource.service).toBe('string');
        expect(typeof result.resource.resourceId).toBe('string');
      }),
      { numRuns: 100 }
    );
  });
});
