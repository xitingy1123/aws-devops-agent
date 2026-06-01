// Feature: cloudwatch-alarm-auto-rca, Property 13: Invalid configuration fallback
// Validates: Requirements 5.3, 5.6

import * as fc from 'fast-check';
import { ConfigManager, DEFAULT_CONFIG, validateConfig } from '../../src/shared/config-manager';
import { SystemConfig } from '../../src/shared/types';
import { SSMClient } from '@aws-sdk/client-ssm';

// Mock SSM Client
const mockSend = jest.fn();
const mockSsmClient = { send: mockSend } as unknown as SSMClient;

function createValidConfig(overrides?: Partial<SystemConfig>): SystemConfig {
  return {
    version: '2.0.0',
    alarmSelectionMode: 'all',
    selectedAlarmNames: [],
    alarmFilters: [],
    feishuWebhooks: [],
    rcaTimeout: 300,
    retryPolicy: {
      maxRetries: 3,
      initialDelay: 5,
      backoffMultiplier: 2,
    },
    groupingWindow: 120,
    retentionDays: 90,
    ...overrides,
  };
}

/**
 * Arbitrary generator for invalid configurations.
 * Generates objects that should fail validation.
 */
const arbInvalidConfig: fc.Arbitrary<unknown> = fc.oneof(
  // Null/undefined
  fc.constant(null),
  fc.constant(undefined),

  // Non-object types
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant([]),

  // Missing version
  fc.constant({ ...createValidConfig(), version: '' }),

  // Invalid alarmSelectionMode
  fc.constant({ ...createValidConfig(), alarmSelectionMode: 'invalid' }),

  // Custom mode with empty selectedAlarmNames
  fc.constant({
    ...createValidConfig(),
    alarmSelectionMode: 'custom',
    selectedAlarmNames: [],
  }),

  // Negative rcaTimeout
  fc.integer({ min: -1000, max: 0 }).map((n) => ({
    ...createValidConfig(),
    rcaTimeout: n,
  })),

  // Zero or negative groupingWindow
  fc.integer({ min: -1000, max: 0 }).map((n) => ({
    ...createValidConfig(),
    groupingWindow: n,
  })),

  // Negative retentionDays
  fc.integer({ min: -1000, max: 0 }).map((n) => ({
    ...createValidConfig(),
    retentionDays: n,
  })),

  // Missing retryPolicy
  fc.constant({ ...createValidConfig(), retryPolicy: null }),

  // Invalid retryPolicy fields
  fc.integer({ min: -100, max: -1 }).map((n) => ({
    ...createValidConfig(),
    retryPolicy: { maxRetries: n, initialDelay: 5, backoffMultiplier: 2 },
  })),

  fc.integer({ min: -100, max: 0 }).map((n) => ({
    ...createValidConfig(),
    retryPolicy: { maxRetries: 3, initialDelay: n, backoffMultiplier: 2 },
  })),

  // Non-array selectedAlarmNames
  fc.constant({ ...createValidConfig(), selectedAlarmNames: 'not-an-array' }),

  // Non-array alarmFilters
  fc.constant({ ...createValidConfig(), alarmFilters: 'not-an-array' }),

  // Non-array feishuWebhooks
  fc.constant({ ...createValidConfig(), feishuWebhooks: 'not-an-array' })
);

describe('Property 13: Invalid configuration fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject all invalid configurations via validateConfig', () => {
    fc.assert(
      fc.property(arbInvalidConfig, (invalidConfig: unknown) => {
        const errors = validateConfig(invalidConfig);
        // Invalid configs must produce at least one error
        expect(errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('should retain previous valid config when SSM returns invalid config', () => {
    fc.assert(
      fc.asyncProperty(arbInvalidConfig, async (invalidConfig: unknown) => {
        const configManager = new ConfigManager({
          ssmClient: mockSsmClient,
          cacheTtlMs: 5 * 60 * 1000,
        });

        // First load a valid config
        const validConfig = createValidConfig({ version: '5.0.0' });
        mockSend.mockResolvedValueOnce({
          Parameter: { Value: JSON.stringify(validConfig) },
        });
        await configManager.refreshConfig();

        // Now try to load an invalid config
        const serialized = typeof invalidConfig === 'string'
          ? invalidConfig
          : JSON.stringify(invalidConfig);
        mockSend.mockResolvedValueOnce({
          Parameter: { Value: serialized },
        });
        await configManager.refreshConfig();

        // Should still have the previous valid config
        const config = await configManager.getConfig();
        expect(config.version).toBe('5.0.0');
      }),
      { numRuns: 100 }
    );
  });

  it('should fall back to DEFAULT_CONFIG when no valid config has ever been loaded and invalid config is provided', () => {
    fc.assert(
      fc.asyncProperty(arbInvalidConfig, async (invalidConfig: unknown) => {
        const configManager = new ConfigManager({
          ssmClient: mockSsmClient,
          cacheTtlMs: 5 * 60 * 1000,
        });

        // Try to load an invalid config as the first config
        const serialized = typeof invalidConfig === 'string'
          ? invalidConfig
          : JSON.stringify(invalidConfig);
        mockSend.mockResolvedValueOnce({
          Parameter: { Value: serialized },
        });
        await configManager.refreshConfig();

        // Should fall back to DEFAULT_CONFIG
        const config = await configManager.getConfig();
        expect(config).toEqual(DEFAULT_CONFIG);
      }),
      { numRuns: 100 }
    );
  });
});
