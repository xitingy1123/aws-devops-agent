/**
 * Tests for the webhook-trigger-mode RCAAnalyzer Lambda handler.
 *
 * The handler's job has changed:
 *   - Old: synchronously call DevOps Agent and return a full RCAReport.
 *   - New: trigger the DevOps Agent webhook, write a pending record, and let
 *     SFN waitForTaskToken hold the workflow until InvestigationEventHandler
 *     wakes it up via SendTaskSuccess.
 *
 * Failure modes here:
 *   - Webhook trigger fails fast → handler must SendTaskFailure to SFN so the
 *     workflow proceeds to its partial-notification branch.
 *   - Unexpected exception → handler must NOT throw (SFN already has retry on
 *     LambdaInvoke service exceptions; rethrowing would be redundant) and must
 *     SendTaskFailure.
 */

import { AlarmRouterOutput } from '../../src/shared/types';

// AWS clients
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutMetricDataCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      Parameter: {
        Value: JSON.stringify({
          version: '1.0.0',
          alarmSelectionMode: 'all',
          selectedAlarmNames: [],
          alarmFilters: [],
          feishuWebhooks: [],
          rcaTimeout: 300,
          retryPolicy: { maxRetries: 3, initialDelay: 5, backoffMultiplier: 2 },
          groupingWindow: 120,
          retentionDays: 90,
        }),
      },
    }),
  })),
  GetParameterCommand: jest.fn(),
}));

const mockSfnSend = jest.fn();
jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({ send: mockSfnSend })),
  SendTaskFailureCommand: jest.fn().mockImplementation((input) => ({
    __type: 'SendTaskFailureCommand',
    input,
  })),
}));

// Mock the agent-client (webhook trigger)
jest.mock('../../src/lambdas/rca-analyzer/agent-client', () => ({
  triggerDevOpsAgentInvestigation: jest.fn(),
}));

// Mock the pending-store (DDB write)
jest.mock('../../src/lambdas/rca-analyzer/pending-store', () => ({
  writePendingInvestigation: jest.fn().mockResolvedValue(undefined),
}));

import { handler } from '../../src/lambdas/rca-analyzer/index';
import { triggerDevOpsAgentInvestigation } from '../../src/lambdas/rca-analyzer/agent-client';
import { writePendingInvestigation } from '../../src/lambdas/rca-analyzer/pending-store';

const mockTrigger = triggerDevOpsAgentInvestigation as jest.MockedFunction<
  typeof triggerDevOpsAgentInvestigation
>;
const mockWritePending = writePendingInvestigation as jest.MockedFunction<
  typeof writePendingInvestigation
>;

function createTestAlarm(overrides?: Partial<AlarmRouterOutput>): AlarmRouterOutput {
  return {
    alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:TestAlarm',
    alarmName: 'TestAlarm',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-1234567890abcdef0' },
    threshold: 80,
    currentValue: 95,
    stateChangeTimestamp: '2024-01-15T10:00:00Z',
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
  };
}

describe('RCAAnalyzer handler (webhook trigger mode)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSfnSend.mockReset().mockResolvedValue({});
  });

  it('returns webhook_triggered ack when webhook responds 200', async () => {
    mockTrigger.mockResolvedValue({
      success: true,
      incidentId: 'cw-alarm-g1-12345',
      triggeredAt: '2024-01-01T00:00:00.000Z',
      statusCode: 200,
    });

    const result = await handler({
      groupId: 'g1',
      alarms: [createTestAlarm()],
      taskToken: 'tok-abc',
    });

    expect(result.ack).toBe('webhook_triggered');
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockWritePending).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: 'cw-alarm-g1-12345',
        triggeredAt: '2024-01-01T00:00:00.000Z',
        taskToken: 'tok-abc',
        groupId: 'g1',
      })
    );
    // SFN should NOT be poked when trigger succeeds — SFN stays in waitForTaskToken.
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it('throws if invoked without a taskToken (defensive)', async () => {
    await expect(
      handler({ groupId: 'g1', alarms: [createTestAlarm()], taskToken: '' as any })
    ).rejects.toThrow(/taskToken/);
  });

  it('SendTaskFailures and returns webhook_failed_failure_sent when trigger fails', async () => {
    mockTrigger.mockResolvedValue({
      success: false,
      error: 'HTTP 503',
    });

    const result = await handler({
      groupId: 'g1',
      alarms: [createTestAlarm()],
      taskToken: 'tok-xyz',
    });

    expect(result.ack).toBe('webhook_failed_failure_sent');
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    const sentCmd = mockSfnSend.mock.calls[0][0];
    expect(sentCmd.input.taskToken).toBe('tok-xyz');
    expect(sentCmd.input.error).toBe('WebhookTriggerFailed');
    expect(sentCmd.input.cause).toContain('HTTP 503');
    expect(mockWritePending).not.toHaveBeenCalled();
  });

  it('does not throw on unexpected error; SendTaskFailure with RCAAnalyzerError code', async () => {
    mockTrigger.mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await handler({
      groupId: 'g1',
      alarms: [createTestAlarm()],
      taskToken: 'tok-z',
    });

    expect(result.ack).toBe('webhook_failed_failure_sent');
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    const sentCmd = mockSfnSend.mock.calls[0][0];
    expect(sentCmd.input.error).toBe('RCAAnalyzerError');
    expect(sentCmd.input.cause).toContain('boom');
  });

  it('passes retry/timeout options sourced from SSM config to the trigger', async () => {
    mockTrigger.mockResolvedValue({
      success: true,
      incidentId: 'cw-alarm-g1-1',
      triggeredAt: new Date().toISOString(),
      statusCode: 200,
    });

    await handler({
      groupId: 'g1',
      alarms: [createTestAlarm()],
      taskToken: 'tok',
    });

    expect(mockTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ investigationType: 'alarm_response' }),
      'g1',
      expect.objectContaining({
        maxRetries: 3,
        initialDelayMs: 5000,
        backoffMultiplier: 2,
      })
    );
  });

  it('handles multiple alarms in a single group', async () => {
    mockTrigger.mockResolvedValue({
      success: true,
      incidentId: 'cw-alarm-g1-1',
      triggeredAt: new Date().toISOString(),
      statusCode: 200,
    });

    const alarms = [
      createTestAlarm({ alarmName: 'Alarm1' }),
      createTestAlarm({ alarmName: 'Alarm2', metricName: 'NetworkIn' }),
    ];

    const result = await handler({ groupId: 'g1', alarms, taskToken: 'tok' });

    expect(result.ack).toBe('webhook_triggered');
    expect(mockWritePending).toHaveBeenCalledWith(
      expect.objectContaining({ alarms })
    );
  });
});
