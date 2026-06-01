/**
 * Integration test: SSM Parameter Store configuration reading.
 *
 * Exercises the full ConfigManager fetch / cache / validate / fallback
 * lifecycle wired through a fake SSM client, and verifies that runtime
 * behavior of dependent components changes in lockstep with SSM updates.
 *
 * Specifically:
 *   - A fresh ConfigManager fetches from the configured SSM path.
 *   - After a successful fetch the cache is honored within TTL.
 *   - Invalid SSM payloads (bad JSON, validation errors) cause the manager
 *     to retain the previous valid configuration.
 *   - The AlarmRouter Lambda picks up SSM-driven config (custom selection
 *     mode + filter rules) at runtime.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.6
 */

import { ConfigManager, DEFAULT_CONFIG } from '../../src/shared/config-manager';
import { SystemConfig, AlarmRouterInput } from '../../src/shared/types';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// -----------------------------------------------------------------------------
// Fake SSM client
// -----------------------------------------------------------------------------

class FakeSsm {
  private store = new Map<string, string>();
  public callLog: string[] = [];

  setParameter(name: string, value: string): void {
    this.store.set(name, value);
  }

  /** Drop-in replacement for SSMClient. */
  asClient(): SSMClient {
    const self = this;
    return {
      async send(command: any) {
        if (!(command instanceof GetParameterCommand)) {
          throw new Error(`Unsupported command in fake SSM: ${command.constructor.name}`);
        }
        const name = command.input.Name!;
        self.callLog.push(name);
        const value = self.store.get(name);
        if (value === undefined) {
          throw new Error(`ParameterNotFound: ${name}`);
        }
        return { Parameter: { Name: name, Value: value, Type: 'String' } } as any;
      },
    } as unknown as SSMClient;
  }
}

function validConfig(overrides?: Partial<SystemConfig>): SystemConfig {
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

const PARAMETER_PATH = '/cloudwatch-alarm-auto-rca/config';

// -----------------------------------------------------------------------------
// ConfigManager-only tests
// -----------------------------------------------------------------------------

describe('Integration: ConfigManager + SSM Parameter Store', () => {
  let ssm: FakeSsm;

  beforeEach(() => {
    ssm = new FakeSsm();
  });

  it('reads configuration from the configured SSM path', async () => {
    ssm.setParameter(PARAMETER_PATH, JSON.stringify(validConfig({ rcaTimeout: 600 })));

    const cm = new ConfigManager({ ssmClient: ssm.asClient(), parameterPath: PARAMETER_PATH });
    const cfg = await cm.getConfig();

    expect(cfg.rcaTimeout).toBe(600);
    expect(ssm.callLog).toEqual([PARAMETER_PATH]);
  });

  it('honors the in-memory cache within the TTL window', async () => {
    ssm.setParameter(PARAMETER_PATH, JSON.stringify(validConfig({ rcaTimeout: 100 })));

    const cm = new ConfigManager({
      ssmClient: ssm.asClient(),
      parameterPath: PARAMETER_PATH,
      cacheTtlMs: 5 * 60 * 1000,
    });

    await cm.getConfig();
    await cm.getConfig();
    await cm.getConfig();

    expect(ssm.callLog).toHaveLength(1);
  });

  it('refreshes after the TTL expires and applies the new configuration', async () => {
    const cm = new ConfigManager({
      ssmClient: ssm.asClient(),
      parameterPath: PARAMETER_PATH,
      cacheTtlMs: 1,
    });

    ssm.setParameter(PARAMETER_PATH, JSON.stringify(validConfig({ version: '1.0.0' })));
    const first = await cm.getConfig();
    expect(first.version).toBe('1.0.0');

    await new Promise((r) => setTimeout(r, 5));

    ssm.setParameter(PARAMETER_PATH, JSON.stringify(validConfig({ version: '2.0.0' })));
    const second = await cm.getConfig();

    expect(second.version).toBe('2.0.0');
    expect(ssm.callLog.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to the default configuration when SSM is unreachable on first load', async () => {
    // FakeSsm has no parameter set → throws ParameterNotFound.
    const cm = new ConfigManager({ ssmClient: ssm.asClient(), parameterPath: PARAMETER_PATH });

    const cfg = await cm.getConfig();
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('retains the previous valid configuration when SSM returns invalid JSON', async () => {
    const cm = new ConfigManager({
      ssmClient: ssm.asClient(),
      parameterPath: PARAMETER_PATH,
      cacheTtlMs: 1,
    });

    ssm.setParameter(PARAMETER_PATH, JSON.stringify(validConfig({ version: '1.0.0' })));
    await cm.getConfig();

    await new Promise((r) => setTimeout(r, 5));
    ssm.setParameter(PARAMETER_PATH, '{not valid json');

    const cfg = await cm.getConfig();
    expect(cfg.version).toBe('1.0.0');
  });

  it('retains the previous valid configuration when SSM returns a config that fails validation', async () => {
    const cm = new ConfigManager({
      ssmClient: ssm.asClient(),
      parameterPath: PARAMETER_PATH,
      cacheTtlMs: 1,
    });

    ssm.setParameter(PARAMETER_PATH, JSON.stringify(validConfig({ version: '1.0.0' })));
    await cm.getConfig();

    await new Promise((r) => setTimeout(r, 5));
    // Negative rcaTimeout fails validation.
    ssm.setParameter(
      PARAMETER_PATH,
      JSON.stringify({ ...validConfig({ version: '2.0.0' }), rcaTimeout: -1 })
    );

    const cfg = await cm.getConfig();
    expect(cfg.version).toBe('1.0.0');
    expect(cfg.rcaTimeout).toBe(300);
  });

  it('preserves the configuration through serialize/parse round-trip via SSM', async () => {
    const original = validConfig({
      alarmSelectionMode: 'custom',
      selectedAlarmNames: ['HighCPU', 'LowDisk'],
      alarmFilters: [{ type: 'namespace', value: 'AWS/EC2', action: 'include' }],
      feishuWebhooks: [
        { url: 'https://x', name: 'team-a', routingRules: [] },
      ],
    });
    ssm.setParameter(PARAMETER_PATH, JSON.stringify(original));

    const cm = new ConfigManager({ ssmClient: ssm.asClient(), parameterPath: PARAMETER_PATH });
    const loaded = await cm.getConfig();

    expect(loaded).toEqual(original);
  });
});

// -----------------------------------------------------------------------------
// AlarmRouter end-to-end with SSM-driven configuration
// -----------------------------------------------------------------------------

const mockSsmSend = jest.fn();
const mockCloudWatchSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockCloudWatchSend })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-ssm', () => {
  const original = jest.requireActual('@aws-sdk/client-ssm');
  return {
    ...original,
    SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  };
});

function buildAlarmEvent(name: string, namespace = 'AWS/EC2'): AlarmRouterInput {
  return {
    version: '0',
    id: 'evt-1',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-15T10:30:00Z',
    region: 'us-east-1',
    resources: [`arn:aws:cloudwatch:us-east-1:123456789012:alarm:${name}`],
    detail: {
      alarmName: name,
      state: { value: 'ALARM', reason: 'Threshold Crossed', timestamp: '2024-01-15T10:30:00Z' },
      previousState: { value: 'OK', reason: 'OK', timestamp: '2024-01-15T10:25:00Z' },
      configuration: {
        metrics: [
          {
            id: 'm1',
            metricStat: {
              metric: { namespace, name: 'CPUUtilization', dimensions: { InstanceId: 'i-abc' } },
              period: 300,
              stat: 'Average',
            },
            returnData: true,
          },
        ],
      },
    },
  };
}

async function loadAlarmRouterHandlerWithConfig(cfg: SystemConfig) {
  jest.resetModules();
  // Re-apply the mocks against the freshly-reset module registry.
  jest.doMock('@aws-sdk/client-cloudwatch', () => ({
    CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockCloudWatchSend })),
    PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
  }));
  jest.doMock('@aws-sdk/client-ssm', () => {
    const original = jest.requireActual('@aws-sdk/client-ssm');
    return {
      ...original,
      SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
    };
  });

  mockSsmSend.mockResolvedValue({ Parameter: { Value: JSON.stringify(cfg) } });

  const mod = await import('../../src/lambdas/alarm-router/index');
  return mod.handler;
}

describe('Integration: AlarmRouter reads SSM config at runtime', () => {
  beforeEach(() => {
    mockSsmSend.mockReset();
    mockCloudWatchSend.mockClear();
  });

  it('routes through "all" mode when SSM publishes alarmSelectionMode=all', async () => {
    const handler = await loadAlarmRouterHandlerWithConfig(
      validConfig({ alarmSelectionMode: 'all' })
    );
    const result = await handler(buildAlarmEvent('SomeAlarm'));
    expect(result.filtered).toBe(false);
  });

  it('rejects alarms not in selectedAlarmNames when SSM publishes custom mode', async () => {
    const handler = await loadAlarmRouterHandlerWithConfig(
      validConfig({
        alarmSelectionMode: 'custom',
        selectedAlarmNames: ['AllowedAlarm'],
      })
    );
    const result = await handler(buildAlarmEvent('SomeOtherAlarm'));
    expect(result.filtered).toBe(true);
    expect(result.filterReason).toBe('not_in_selected_alarms');
  });

  it('applies SSM-published include filter rules to the namespace', async () => {
    const handler = await loadAlarmRouterHandlerWithConfig(
      validConfig({
        alarmSelectionMode: 'all',
        alarmFilters: [{ type: 'namespace', value: 'AWS/RDS', action: 'include' }],
      })
    );

    // EC2 alarm — does not match the AWS/RDS-only include rule.
    const ec2 = await handler(buildAlarmEvent('EC2Alarm', 'AWS/EC2'));
    expect(ec2.filtered).toBe(true);
    expect(ec2.filterReason).toBe('no_include_rule_matched');

    // Reload with a fresh module so ConfigManager doesn't reuse cached EC2 result.
    const handler2 = await loadAlarmRouterHandlerWithConfig(
      validConfig({
        alarmSelectionMode: 'all',
        alarmFilters: [{ type: 'namespace', value: 'AWS/RDS', action: 'include' }],
      })
    );
    const rds = await handler2(buildAlarmEvent('RDSAlarm', 'AWS/RDS'));
    expect(rds.filtered).toBe(false);
  });

  it('falls back to default configuration when SSM is unavailable at first load', async () => {
    jest.resetModules();
    jest.doMock('@aws-sdk/client-cloudwatch', () => ({
      CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockCloudWatchSend })),
      PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
    }));
    jest.doMock('@aws-sdk/client-ssm', () => {
      const original = jest.requireActual('@aws-sdk/client-ssm');
      return {
        ...original,
        SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
      };
    });
    mockSsmSend.mockRejectedValue(new Error('SSM unavailable'));

    const mod = await import('../../src/lambdas/alarm-router/index');
    const result = await mod.handler(buildAlarmEvent('AnyAlarm'));

    // DEFAULT_CONFIG has alarmSelectionMode=all and no filters → alarm passes.
    expect(result.filtered).toBe(false);
  });
});
