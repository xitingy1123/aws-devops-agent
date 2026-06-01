/**
 * Integration test: end-to-end flow simulating SFN orchestration.
 *
 * Since RCAAnalyzer is now a fire-and-forget webhook trigger and the actual
 * RCAReport is synthesized by InvestigationEventHandler from EventBridge,
 * this test exercises three independent flows:
 *
 *   1. AlarmRouter parses CloudWatch event → AlarmRouterOutput
 *   2. RCAAnalyzer triggers webhook + writes pending record → ack
 *   3. InvestigationEventHandler simulated handoff to FeishuNotifier:
 *      we manually build an RCAReport (as the event handler would) and feed
 *      it to FeishuNotifier to confirm the card path still works.
 */

// AWS SDK mocks (declared before imports)
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
          feishuWebhooks: [
            {
              url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook',
              name: 'Test Team',
              routingRules: [],
            },
          ],
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

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockReturnValue({
      send: jest.fn().mockResolvedValue({ Items: [] }),
    }),
  },
  PutCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetCommand: jest.fn().mockImplementation((input) => ({ input })),
  UpdateCommand: jest.fn().mockImplementation((input) => ({ input })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  SendTaskFailureCommand: jest.fn().mockImplementation((input) => ({ input })),
  SendTaskSuccessCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('../../src/lambdas/rca-analyzer/agent-client', () => ({
  triggerDevOpsAgentInvestigation: jest.fn().mockResolvedValue({
    success: true,
    incidentId: 'cw-alarm-test-1',
    triggeredAt: '2024-01-15T10:00:00.000Z',
    statusCode: 200,
  }),
}));

jest.mock('../../src/lambdas/rca-analyzer/pending-store', () => ({
  writePendingInvestigation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/lambdas/feishu-notifier/sender', () => ({
  sendToMultipleWebhooks: jest.fn().mockResolvedValue({
    sentTo: ['https://open.feishu.cn/open-apis/bot/v2/hook/test-hook'],
    failedTo: [],
    totalRetryCount: 0,
  }),
  writeToDeadLetter: jest.fn().mockResolvedValue(undefined),
}));

import { handler as alarmRouterHandler } from '../../src/lambdas/alarm-router/index';
import { handler as rcaAnalyzerHandler } from '../../src/lambdas/rca-analyzer/index';
import { handler as feishuNotifierHandler } from '../../src/lambdas/feishu-notifier/index';
import { generateFullReport } from '../../src/lambdas/rca-analyzer/report-generator';
import {
  AlarmRouterInput,
  AlarmRouterOutput,
  FeishuNotifierInput,
} from '../../src/shared/types';

beforeAll(() => {
  process.env.WORKFLOW_EXECUTION_TABLE_NAME = 'test-workflow-table';
  process.env.ALARM_GROUP_TABLE_NAME = 'test-alarm-group-table';
  process.env.DEAD_LETTER_TABLE_NAME = 'test-dead-letter-table';
  process.env.SSM_CONFIG_PATH = '/cloudwatch-alarm-auto-rca/config';
  process.env.AGENT_SPACE_ID = 'test-space';
});

afterAll(() => {
  delete process.env.WORKFLOW_EXECUTION_TABLE_NAME;
  delete process.env.ALARM_GROUP_TABLE_NAME;
  delete process.env.DEAD_LETTER_TABLE_NAME;
  delete process.env.SSM_CONFIG_PATH;
  delete process.env.AGENT_SPACE_ID;
});

function createCloudWatchAlarmEvent(): AlarmRouterInput {
  return {
    version: '0',
    id: 'event-123',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-15T10:00:00Z',
    region: 'us-east-1',
    resources: ['arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPUAlarm'],
    detail: {
      alarmName: 'HighCPUAlarm',
      state: {
        value: 'ALARM',
        reason: '95.0 > 80.0',
        timestamp: '2024-01-15T10:00:00.000+0000',
      },
      previousState: {
        value: 'OK',
        reason: 'Threshold not crossed',
        timestamp: '2024-01-15T09:55:00.000+0000',
      },
      configuration: {
        description: 'Alarm when CPU exceeds 80%',
        metrics: [
          {
            id: 'm1',
            metricStat: {
              metric: {
                namespace: 'AWS/EC2',
                name: 'CPUUtilization',
                dimensions: { InstanceId: 'i-abc123' },
              },
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

describe('Integration: end-to-end flow with webhook-mode RCAAnalyzer', () => {
  describe('AlarmRouter', () => {
    it('parses CloudWatch ALARM events and surfaces required metric metadata', async () => {
      const event = createCloudWatchAlarmEvent();
      const routerResult = await alarmRouterHandler(event);

      expect(routerResult.filtered).toBe(false);
      expect(routerResult.alarmName).toBe('HighCPUAlarm');
      expect(routerResult.namespace).toBe('AWS/EC2');
      expect(routerResult.metricName).toBe('CPUUtilization');
      expect(routerResult.region).toBe('us-east-1');
      expect(routerResult.accountId).toBe('123456789012');
    });
  });

  describe('RCAAnalyzer (webhook trigger)', () => {
    it('returns webhook_triggered ack when the webhook accepts the request', async () => {
      const event = createCloudWatchAlarmEvent();
      const routerResult = await alarmRouterHandler(event);

      const rcaResult = await rcaAnalyzerHandler({
        groupId: 'integration-group',
        alarms: [routerResult],
        taskToken: 'tok-integration',
      });

      // In webhook-trigger mode the Lambda no longer returns the RCA report.
      // SFN waitForTaskToken stays open until InvestigationEventHandler awakens it.
      expect(rcaResult.ack).toBe('webhook_triggered');
    });
  });

  describe('FeishuNotifier (driven by an RCAReport synthesized externally)', () => {
    it('formats and sends the card when fed an RCAReport like the one produced by the event handler', async () => {
      const alarms: AlarmRouterOutput[] = [
        {
          alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPUAlarm',
          alarmName: 'HighCPUAlarm',
          namespace: 'AWS/EC2',
          metricName: 'CPUUtilization',
          dimensions: { InstanceId: 'i-abc123' },
          threshold: 80,
          currentValue: 95,
          stateChangeTimestamp: '2024-01-15T10:00:00.000Z',
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
        },
      ];

      // Synthesize an RCAReport the same shape InvestigationEventHandler produces.
      const rcaReport = generateFullReport(
        {
          success: true,
          data: {
            rootCause: {
              summary: 'Auto-scaling group reached max capacity',
              category: 'resource_limit',
              details: 'ASG hit max during traffic spike',
              confidence: 'high',
              affectedResources: ['arn:aws:ec2:us-east-1:123456789012:instance/i-abc123'],
            },
            remediation: {
              immediateMitigation: 'Increase ASG max capacity',
              longTermFix: 'Predictive scaling',
              steps: ['Increase max capacity to 10'],
            },
            executionId: 'exec-1234',
            taskId: 'task-1234',
            incidentId: 'cw-alarm-integration-group-1',
          },
        },
        alarms,
        'integration-group'
      );

      const notifierInput: FeishuNotifierInput = {
        rcaReport,
        webhookUrls: [],
        notificationType: 'rca_complete',
      };
      const result = await feishuNotifierHandler(notifierInput);

      expect(result.success).toBe(true);
      expect(result.sentTo.length).toBeGreaterThan(0);
      expect(result.failedTo).toEqual([]);
      // executionId from event handler should be on the report so the card link works.
      expect(rcaReport.executionId).toBe('exec-1234');
    });
  });
});
