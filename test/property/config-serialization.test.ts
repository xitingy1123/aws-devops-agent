// Feature: cloudwatch-alarm-auto-rca, Property 12: Configuration serialization round-trip
// Validates: Requirements 5.2

import * as fc from 'fast-check';
import { validateConfig } from '../../src/shared/config-manager';
import { SystemConfig, AlarmFilterRule, WebhookConfig, RetryPolicy } from '../../src/shared/types';

/**
 * Arbitrary generator for a valid RetryPolicy.
 */
const arbRetryPolicy: fc.Arbitrary<RetryPolicy> = fc.record({
  maxRetries: fc.integer({ min: 0, max: 10 }),
  initialDelay: fc.integer({ min: 1, max: 60 }),
  backoffMultiplier: fc.integer({ min: 1, max: 5 }),
});

/**
 * Arbitrary generator for a valid AlarmFilterRule.
 */
const arbAlarmFilterRule: fc.Arbitrary<AlarmFilterRule> = fc.record({
  type: fc.constantFrom('namespace', 'name_pattern') as fc.Arbitrary<'namespace' | 'name_pattern'>,
  value: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
  action: fc.constantFrom('include', 'exclude') as fc.Arbitrary<'include' | 'exclude'>,
});

/**
 * Arbitrary generator for a valid WebhookConfig.
 */
const arbWebhookConfig: fc.Arbitrary<WebhookConfig> = fc.record({
  url: fc.webUrl(),
  name: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
  routingRules: fc.array(
    fc.record({
      field: fc.constant('namespace') as fc.Arbitrary<'namespace'>,
      pattern: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
      match: fc.constantFrom('equals', 'contains', 'regex') as fc.Arbitrary<'equals' | 'contains' | 'regex'>,
    }),
    { minLength: 0, maxLength: 3 }
  ),
});

/**
 * Arbitrary generator for a valid SystemConfig.
 * Ensures custom mode always has non-empty selectedAlarmNames.
 */
const arbValidSystemConfig: fc.Arbitrary<SystemConfig> = fc
  .record({
    version: fc.string({ minLength: 1, maxLength: 10 }).filter(s => s.trim().length > 0),
    alarmSelectionMode: fc.constantFrom('all', 'custom') as fc.Arbitrary<'all' | 'custom'>,
    selectedAlarmNames: fc.array(fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0), { minLength: 0, maxLength: 5 }),
    alarmFilters: fc.array(arbAlarmFilterRule, { minLength: 0, maxLength: 5 }),
    feishuWebhooks: fc.array(arbWebhookConfig, { minLength: 0, maxLength: 3 }),
    rcaTimeout: fc.integer({ min: 1, max: 3600 }),
    retryPolicy: arbRetryPolicy,
    groupingWindow: fc.integer({ min: 1, max: 600 }),
    retentionDays: fc.integer({ min: 1, max: 365 }),
  })
  .map((cfg) => {
    // Ensure custom mode has non-empty selectedAlarmNames
    if (cfg.alarmSelectionMode === 'custom' && cfg.selectedAlarmNames.length === 0) {
      cfg.selectedAlarmNames = ['default-alarm'];
    }
    return cfg;
  });

describe('Property 12: Configuration serialization round-trip', () => {
  it('should preserve all fields after JSON serialization and deserialization', () => {
    fc.assert(
      fc.property(arbValidSystemConfig, (config: SystemConfig) => {
        // Serialize to JSON
        const serialized = JSON.stringify(config);

        // Deserialize back
        const deserialized = JSON.parse(serialized) as SystemConfig;

        // Verify all fields are preserved
        expect(deserialized.version).toEqual(config.version);
        expect(deserialized.alarmSelectionMode).toEqual(config.alarmSelectionMode);
        expect(deserialized.selectedAlarmNames).toEqual(config.selectedAlarmNames);
        expect(deserialized.alarmFilters).toEqual(config.alarmFilters);
        expect(deserialized.feishuWebhooks).toEqual(config.feishuWebhooks);
        expect(deserialized.rcaTimeout).toEqual(config.rcaTimeout);
        expect(deserialized.retryPolicy).toEqual(config.retryPolicy);
        expect(deserialized.groupingWindow).toEqual(config.groupingWindow);
        expect(deserialized.retentionDays).toEqual(config.retentionDays);

        // Full deep equality
        expect(deserialized).toEqual(config);
      }),
      { numRuns: 100 }
    );
  });

  it('should produce a valid config after round-trip (passes validation)', () => {
    fc.assert(
      fc.property(arbValidSystemConfig, (config: SystemConfig) => {
        const serialized = JSON.stringify(config);
        const deserialized = JSON.parse(serialized);

        const errors = validateConfig(deserialized);
        expect(errors).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });
});
