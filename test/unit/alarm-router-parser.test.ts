import { parseAlarmEvent } from '../../src/lambdas/alarm-router/parser';
import { AlarmRouterInput, formatResourceKey } from '../../src/shared/types';

/**
 * Helper to build a valid single-metric alarm event.
 */
function buildValidAlarmEvent(overrides?: Partial<AlarmRouterInput>): AlarmRouterInput {
  return {
    version: '0',
    id: 'test-event-id',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: '123456789012',
    time: '2024-01-15T10:30:00Z',
    region: 'us-east-1',
    resources: ['arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU'],
    detail: {
      alarmName: 'HighCPU',
      state: {
        value: 'ALARM',
        reason: 'Threshold Crossed',
        reasonData: JSON.stringify({
          threshold: 80,
          recentDatapoints: [75, 82, 90],
        }),
        timestamp: '2024-01-15T10:30:00Z',
      },
      previousState: {
        value: 'OK',
        reason: 'Threshold OK',
        timestamp: '2024-01-15T10:25:00Z',
      },
      configuration: {
        metrics: [
          {
            id: 'm1',
            metricStat: {
              metric: {
                namespace: 'AWS/EC2',
                name: 'CPUUtilization',
                dimensions: { InstanceId: 'i-1234567890abcdef0' },
              },
              period: 300,
              stat: 'Average',
            },
            returnData: true,
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('parseAlarmEvent', () => {
  describe('single metric alarm', () => {
    it('should extract all fields correctly', () => {
      const event = buildValidAlarmEvent();
      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(false);
      expect(result.alarmName).toBe('HighCPU');
      expect(result.namespace).toBe('AWS/EC2');
      expect(result.metricName).toBe('CPUUtilization');
      expect(result.dimensions).toEqual({ InstanceId: 'i-1234567890abcdef0' });
      expect(result.threshold).toBe(80);
      expect(result.currentValue).toBe(90);
      expect(result.stateChangeTimestamp).toBe('2024-01-15T10:30:00Z');
      expect(result.previousState).toBe('OK');
      expect(result.accountId).toBe('123456789012');
      expect(result.region).toBe('us-east-1');
      expect(result.alarmId).toBe('arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU');
    });

    it('should build EC2 resource identifier from InstanceId dimension', () => {
      const event = buildValidAlarmEvent();
      const result = parseAlarmEvent(event);

      expect(result.resource).toEqual({
        accountId: '123456789012',
        region: 'us-east-1',
        service: 'ec2',
        resourceId: 'i-1234567890abcdef0',
      });
      expect(formatResourceKey(result.resource)).toBe(
        '123456789012/ec2/us-east-1/i-1234567890abcdef0'
      );
    });
  });

  describe('metric math expression alarm', () => {
    it('should extract metric info from the first metric with metricStat', () => {
      const event = buildValidAlarmEvent();
      event.detail.configuration.metrics = [
        {
          id: 'e1',
          expression: 'METRICS("m1") / METRICS("m2")',
          returnData: true,
        },
        {
          id: 'm1',
          metricStat: {
            metric: {
              namespace: 'AWS/RDS',
              name: 'ReadIOPS',
              dimensions: { DBInstanceIdentifier: 'my-db' },
            },
            period: 60,
            stat: 'Average',
          },
          returnData: false,
        },
        {
          id: 'm2',
          metricStat: {
            metric: {
              namespace: 'AWS/RDS',
              name: 'WriteIOPS',
              dimensions: { DBInstanceIdentifier: 'my-db' },
            },
            period: 60,
            stat: 'Average',
          },
          returnData: false,
        },
      ];

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(false);
      expect(result.namespace).toBe('AWS/RDS');
      expect(result.metricName).toBe('ReadIOPS');
      expect(result.dimensions).toEqual({ DBInstanceIdentifier: 'my-db' });
      expect(result.resource).toEqual({
        accountId: '123456789012',
        region: 'us-east-1',
        service: 'rds',
        resourceId: 'my-db',
      });
    });
  });

  describe('anomaly detection alarm', () => {
    it('should handle anomaly detection with evaluatedDatapoints', () => {
      const event = buildValidAlarmEvent();
      event.detail.state.reasonData = JSON.stringify({
        threshold: 100,
        evaluatedDatapoints: [{ value: 150, timestamp: '2024-01-15T10:30:00Z' }],
      });

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(false);
      expect(result.threshold).toBe(100);
      expect(result.currentValue).toBe(150);
    });
  });

  describe('composite alarm', () => {
    it('should handle composite alarm with no metrics gracefully', () => {
      const event = buildValidAlarmEvent();
      event.detail.configuration.metrics = undefined;

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(false);
      expect(result.namespace).toBe('');
      expect(result.metricName).toBe('');
      expect(result.dimensions).toEqual({});
      // Composite alarm: no namespace, no dimensions → service & resourceId 都是空
      expect(result.resource.service).toBe('');
      expect(result.resource.resourceId).toBe('');
      // accountId / region 仍来自事件本体
      expect(result.resource.accountId).toBe('123456789012');
      expect(result.resource.region).toBe('us-east-1');
    });

    it('should handle composite alarm with empty metrics array', () => {
      const event = buildValidAlarmEvent();
      event.detail.configuration.metrics = [];

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(false);
      expect(result.namespace).toBe('');
      expect(result.metricName).toBe('');
    });
  });

  describe('malformed events', () => {
    it('should return filtered=true when detail is missing', () => {
      const event = buildValidAlarmEvent();
      (event as any).detail = undefined;

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toBeTruthy();
    });

    it('should return filtered=true when alarmName is missing', () => {
      const event = buildValidAlarmEvent();
      (event as any).detail.alarmName = undefined;

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toContain('alarmName');
    });

    it('should return filtered=true when state.timestamp is missing', () => {
      const event = buildValidAlarmEvent();
      (event as any).detail.state.timestamp = undefined;

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(true);
      expect(result.filterReason).toContain('state.timestamp');
    });

    it('should handle missing reasonData gracefully (not filtered)', () => {
      const event = buildValidAlarmEvent();
      event.detail.state.reasonData = undefined;

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(false);
      expect(result.threshold).toBe(0);
      expect(result.currentValue).toBe(0);
    });

    it('should handle invalid JSON in reasonData gracefully', () => {
      const event = buildValidAlarmEvent();
      event.detail.state.reasonData = 'not valid json {{{';

      const result = parseAlarmEvent(event);

      expect(result.filtered).toBe(false);
      expect(result.threshold).toBe(0);
      expect(result.currentValue).toBe(0);
    });

    it('should not throw on completely malformed input', () => {
      const event = {} as any;

      expect(() => parseAlarmEvent(event)).not.toThrow();
      const result = parseAlarmEvent(event);
      expect(result.filtered).toBe(true);
      expect(result.filterReason).toBeTruthy();
    });
  });

  describe('resource identifier building', () => {
    it('should build RDS resource from DBInstanceIdentifier', () => {
      const event = buildValidAlarmEvent();
      event.detail.configuration.metrics = [
        {
          id: 'm1',
          metricStat: {
            metric: {
              namespace: 'AWS/RDS',
              name: 'CPUUtilization',
              dimensions: { DBInstanceIdentifier: 'prod-db' },
            },
            period: 300,
            stat: 'Average',
          },
          returnData: true,
        },
      ];

      const result = parseAlarmEvent(event);
      expect(result.resource).toEqual({
        accountId: '123456789012',
        region: 'us-east-1',
        service: 'rds',
        resourceId: 'prod-db',
      });
    });

    it('should build Lambda resource from FunctionName', () => {
      const event = buildValidAlarmEvent();
      event.detail.configuration.metrics = [
        {
          id: 'm1',
          metricStat: {
            metric: {
              namespace: 'AWS/Lambda',
              name: 'Errors',
              dimensions: { FunctionName: 'my-function' },
            },
            period: 300,
            stat: 'Sum',
          },
          returnData: true,
        },
      ];

      const result = parseAlarmEvent(event);
      expect(result.resource.service).toBe('lambda');
      expect(result.resource.resourceId).toBe('my-function');
    });

    it('should build SQS resource from QueueName', () => {
      const event = buildValidAlarmEvent();
      event.detail.configuration.metrics = [
        {
          id: 'm1',
          metricStat: {
            metric: {
              namespace: 'AWS/SQS',
              name: 'ApproximateNumberOfMessagesVisible',
              dimensions: { QueueName: 'my-queue' },
            },
            period: 300,
            stat: 'Average',
          },
          returnData: true,
        },
      ];

      const result = parseAlarmEvent(event);
      expect(result.resource.service).toBe('sqs');
      expect(result.resource.resourceId).toBe('my-queue');
    });

    it('should preserve custom namespace verbatim and use first dimension value as resourceId', () => {
      // 自定义 namespace 不再被丢弃,而是原样保留作为 service slug;
      // 第一个维度值作为 resourceId,通用兜底所有 AWS 服务 + 业务自定义 metric。
      const event = buildValidAlarmEvent();
      event.detail.configuration.metrics = [
        {
          id: 'm1',
          metricStat: {
            metric: {
              namespace: 'Custom/MyApp',
              name: 'RequestCount',
              dimensions: { Environment: 'prod' },
            },
            period: 300,
            stat: 'Sum',
          },
          returnData: true,
        },
      ];

      const result = parseAlarmEvent(event);
      expect(result.resource).toEqual({
        accountId: '123456789012',
        region: 'us-east-1',
        service: 'Custom/MyApp',
        resourceId: 'prod',
      });
    });

    it('should join multiple dimension values with / for ECS-style alarms', () => {
      const event = buildValidAlarmEvent();
      event.detail.configuration.metrics = [
        {
          id: 'm1',
          metricStat: {
            metric: {
              namespace: 'AWS/ECS',
              name: 'CPUUtilization',
              dimensions: { ClusterName: 'prod-cluster', ServiceName: 'api-svc' },
            },
            period: 300,
            stat: 'Average',
          },
          returnData: true,
        },
      ];

      const result = parseAlarmEvent(event);
      expect(result.resource.service).toBe('ecs');
      expect(result.resource.resourceId).toBe('prod-cluster/api-svc');
    });
  });
});
