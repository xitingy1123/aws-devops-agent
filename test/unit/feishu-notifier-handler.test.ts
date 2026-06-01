import { handler } from '../../src/lambdas/feishu-notifier/index';
import { FeishuNotifierInput, RCAReport } from '../../src/shared/types';

// Mock AWS SDK CloudWatch client
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutMetricDataCommand: jest.fn(),
}));

// Mock SSM client for ConfigManager
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
              url: 'https://open.feishu.cn/open-apis/bot/v2/hook/default',
              name: 'Default',
              routingRules: [],
            },
            {
              url: 'https://open.feishu.cn/open-apis/bot/v2/hook/ec2',
              name: 'EC2 Team',
              routingRules: [{ field: 'namespace', pattern: 'AWS/EC2', match: 'equals' }],
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

// Mock the sender module – the handler uses sendToMultipleWebhooks (per-message batch) and writeToDeadLetter.
jest.mock('../../src/lambdas/feishu-notifier/sender', () => ({
  sendToMultipleWebhooks: jest.fn(),
  sendFeishuMessage: jest.fn(),
  writeToDeadLetter: jest.fn(),
}));

import {
  sendToMultipleWebhooks,
  writeToDeadLetter,
} from '../../src/lambdas/feishu-notifier/sender';

const mockSendToMultipleWebhooks = sendToMultipleWebhooks as jest.MockedFunction<typeof sendToMultipleWebhooks>;
const mockWriteToDeadLetter = writeToDeadLetter as jest.MockedFunction<typeof writeToDeadLetter>;

function createMockReport(overrides?: Partial<RCAReport>): RCAReport {
  return {
    reportId: 'rpt-001',
    groupId: 'grp-001',
    generatedAt: '2024-01-15T10:30:00Z',
    status: 'completed',
    alarmSummary: {
      alarmCount: 1,
      alarms: [
        {
          alarmName: 'HighCPUAlarm',
          namespace: 'AWS/EC2',
          metricName: 'CPUUtilization',
          currentValue: 95,
          threshold: 80,
          resource: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc',
        },
      ],
      firstAlarmTime: '2024-01-15T10:25:00Z',
      lastAlarmTime: '2024-01-15T10:25:00Z',
    },
    investigation: {
      timeline: [{ timestamp: '2024-01-15T10:25:00Z', action: 'Check metrics', finding: 'CPU spike' }],
      dataSourcesConsulted: ['CloudWatch'],
      hypothesesExplored: ['Deployment change'],
    },
    rootCause: {
      summary: 'High CPU due to runaway process',
      category: 'resource_limit',
      details: 'Process consuming 90% CPU',
      confidence: 'high',
      affectedResources: ['arn:aws:ec2:us-east-1:123456789012:instance/i-abc'],
    },
    remediation: {
      immediateMitigation: 'Kill the runaway process',
      longTermFix: 'Add CPU limits',
      steps: ['SSH to instance', 'Kill process'],
    },
    ...overrides,
  };
}

/**
 * Helper that returns a successful BatchSendResult sending to all the provided URLs.
 */
function batchSuccess(urls: string[]) {
  return { sentTo: [...urls], failedTo: [], totalRetryCount: 0 };
}

describe('FeishuNotifier Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendToMultipleWebhooks.mockImplementation(async (urls) => batchSuccess(urls));
  });

  describe('card generation for different notification types', () => {
    it('should generate card for rca_complete notification', async () => {
      const input: FeishuNotifierInput = {
        rcaReport: createMockReport(),
        webhookUrls: ['https://open.feishu.cn/open-apis/bot/v2/hook/test'],
        notificationType: 'rca_complete',
      };

      const result = await handler(input);

      expect(result.success).toBe(true);
      expect(result.sentTo).toEqual(['https://open.feishu.cn/open-apis/bot/v2/hook/test']);
      // Handler should send at least one interactive card with template=red (high confidence)
      expect(mockSendToMultipleWebhooks).toHaveBeenCalledWith(
        ['https://open.feishu.cn/open-apis/bot/v2/hook/test'],
        expect.objectContaining({
          msg_type: 'interactive',
          card: expect.objectContaining({
            header: expect.objectContaining({ template: 'red' }),
          }),
        })
      );
    });

    it('should generate card for rca_timeout notification', async () => {
      const input: FeishuNotifierInput = {
        rcaReport: createMockReport({ status: 'timeout' }),
        webhookUrls: ['https://open.feishu.cn/open-apis/bot/v2/hook/test'],
        notificationType: 'rca_timeout',
      };

      const result = await handler(input);

      expect(result.success).toBe(true);
      expect(mockSendToMultipleWebhooks).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          msg_type: 'interactive',
          card: expect.objectContaining({
            header: expect.objectContaining({ template: 'orange' }),
          }),
        })
      );
    });

    it('should generate card for rca_partial notification', async () => {
      const input: FeishuNotifierInput = {
        rcaReport: createMockReport({ status: 'partial' }),
        webhookUrls: ['https://open.feishu.cn/open-apis/bot/v2/hook/test'],
        notificationType: 'rca_partial',
      };

      const result = await handler(input);

      expect(result.success).toBe(true);
      expect(mockSendToMultipleWebhooks).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          msg_type: 'interactive',
          card: expect.objectContaining({
            header: expect.objectContaining({ template: 'orange' }),
          }),
        })
      );
    });
  });

  describe('routing rule matching', () => {
    it('should use provided webhookUrls when available', async () => {
      const input: FeishuNotifierInput = {
        rcaReport: createMockReport(),
        webhookUrls: ['https://open.feishu.cn/open-apis/bot/v2/hook/custom'],
        notificationType: 'rca_complete',
      };

      const result = await handler(input);

      expect(result.sentTo).toEqual(['https://open.feishu.cn/open-apis/bot/v2/hook/custom']);
      expect(mockSendToMultipleWebhooks).toHaveBeenCalledWith(
        ['https://open.feishu.cn/open-apis/bot/v2/hook/custom'],
        expect.any(Object)
      );
    });

    it('should route based on alarm namespace when webhookUrls is empty', async () => {
      const input: FeishuNotifierInput = {
        rcaReport: createMockReport(),
        webhookUrls: [],
        notificationType: 'rca_complete',
      };

      const result = await handler(input);

      expect(result.success).toBe(true);
      expect(result.sentTo).toEqual(
        expect.arrayContaining([
          'https://open.feishu.cn/open-apis/bot/v2/hook/default',
          'https://open.feishu.cn/open-apis/bot/v2/hook/ec2',
        ])
      );
      // sendToMultipleWebhooks was called with both routed URLs in the same batch
      expect(mockSendToMultipleWebhooks).toHaveBeenCalledWith(
        expect.arrayContaining([
          'https://open.feishu.cn/open-apis/bot/v2/hook/default',
          'https://open.feishu.cn/open-apis/bot/v2/hook/ec2',
        ]),
        expect.any(Object)
      );
    });
  });

  describe('retry and dead letter logic', () => {
    it('should write to dead letter when webhook send fails', async () => {
      mockSendToMultipleWebhooks.mockResolvedValue({
        sentTo: [],
        failedTo: ['https://open.feishu.cn/open-apis/bot/v2/hook/failed'],
        totalRetryCount: 3,
      });
      mockWriteToDeadLetter.mockResolvedValue(undefined);

      const input: FeishuNotifierInput = {
        rcaReport: createMockReport(),
        webhookUrls: ['https://open.feishu.cn/open-apis/bot/v2/hook/failed'],
        notificationType: 'rca_complete',
      };

      const result = await handler(input);

      expect(result.success).toBe(false);
      expect(result.failedTo).toEqual(['https://open.feishu.cn/open-apis/bot/v2/hook/failed']);
      expect(result.retryCount).toBeGreaterThanOrEqual(3);
      expect(mockWriteToDeadLetter).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/failed',
          error: expect.any(String),
        })
      );
    });

    it('should handle dead letter write failure gracefully', async () => {
      mockSendToMultipleWebhooks.mockResolvedValue({
        sentTo: [],
        failedTo: ['https://open.feishu.cn/open-apis/bot/v2/hook/failed'],
        totalRetryCount: 3,
      });
      mockWriteToDeadLetter.mockRejectedValue(new Error('DynamoDB unavailable'));

      const input: FeishuNotifierInput = {
        rcaReport: createMockReport(),
        webhookUrls: ['https://open.feishu.cn/open-apis/bot/v2/hook/failed'],
        notificationType: 'rca_complete',
      };

      const result = await handler(input);

      expect(result.success).toBe(false);
      expect(result.failedTo).toEqual(['https://open.feishu.cn/open-apis/bot/v2/hook/failed']);
    });

    it('should report partial success when some webhooks succeed and some fail', async () => {
      mockSendToMultipleWebhooks.mockResolvedValue({
        sentTo: ['https://open.feishu.cn/open-apis/bot/v2/hook/ok'],
        failedTo: ['https://open.feishu.cn/open-apis/bot/v2/hook/failed'],
        totalRetryCount: 3,
      });
      mockWriteToDeadLetter.mockResolvedValue(undefined);

      const input: FeishuNotifierInput = {
        rcaReport: createMockReport(),
        webhookUrls: [
          'https://open.feishu.cn/open-apis/bot/v2/hook/ok',
          'https://open.feishu.cn/open-apis/bot/v2/hook/failed',
        ],
        notificationType: 'rca_complete',
      };

      const result = await handler(input);

      expect(result.success).toBe(false);
      expect(result.sentTo).toEqual(['https://open.feishu.cn/open-apis/bot/v2/hook/ok']);
      expect(result.failedTo).toEqual(['https://open.feishu.cn/open-apis/bot/v2/hook/failed']);
    });

    it('should return success true when all webhooks succeed', async () => {
      mockSendToMultipleWebhooks.mockImplementation(async (urls) => batchSuccess(urls));

      const input: FeishuNotifierInput = {
        rcaReport: createMockReport(),
        webhookUrls: [
          'https://open.feishu.cn/open-apis/bot/v2/hook/a',
          'https://open.feishu.cn/open-apis/bot/v2/hook/b',
        ],
        notificationType: 'rca_complete',
      };

      const result = await handler(input);

      expect(result.success).toBe(true);
      expect(result.failedTo).toEqual([]);
      expect(mockWriteToDeadLetter).not.toHaveBeenCalled();
    });
  });

  describe('empty target webhook guard', () => {
    it('should return success=false when no webhooks are provided AND SSM config has none', async () => {
      // Mock the ConfigManager to return empty feishuWebhooks
      jest.resetModules();
      jest.doMock('@aws-sdk/client-ssm', () => ({
        SSMClient: jest.fn().mockImplementation(() => ({
          send: jest.fn().mockResolvedValue({
            Parameter: {
              Value: JSON.stringify({
                version: '1.0.0',
                alarmSelectionMode: 'all',
                selectedAlarmNames: [],
                alarmFilters: [],
                feishuWebhooks: [], // ← empty
                rcaTimeout: 600,
                retryPolicy: { maxRetries: 1, initialDelay: 5, backoffMultiplier: 2 },
                groupingWindow: 120,
                retentionDays: 90,
              }),
            },
          }),
        })),
        GetParameterCommand: jest.fn(),
      }));
      jest.doMock('@aws-sdk/client-cloudwatch', () => ({
        CloudWatchClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
        PutMetricDataCommand: jest.fn(),
      }));
      jest.doMock('../../src/lambdas/feishu-notifier/sender', () => ({
        sendToMultipleWebhooks: jest.fn(),
        sendFeishuMessage: jest.fn(),
        writeToDeadLetter: jest.fn(),
      }));

      const { handler: isolatedHandler } = await import('../../src/lambdas/feishu-notifier/index');
      const { sendToMultipleWebhooks: isolatedSend } = await import('../../src/lambdas/feishu-notifier/sender');

      const result = await isolatedHandler({
        rcaReport: createMockReport(),
        webhookUrls: [], // ← empty
        notificationType: 'rca_complete',
      });

      expect(result.success).toBe(false);
      expect(result.sentTo).toEqual([]);
      expect(result.failedTo).toEqual([]);
      // 关键：sender 一次都不该被调用
      expect(isolatedSend).not.toHaveBeenCalled();

      jest.resetModules();
    });
  });
});
