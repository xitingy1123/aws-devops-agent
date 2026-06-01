import { buildRCAContext, DevOpsAgentRequest } from '../../src/lambdas/rca-analyzer/context-builder';
import { AlarmRouterOutput, ResourceIdentifier } from '../../src/shared/types';

/**
 * 把任意字符串当作 resourceId 塞进 ResourceIdentifier。
 * 测试断言里直接对比 formatResourceKey 后的字符串。
 */
function res(resourceId: string): ResourceIdentifier {
  return {
    accountId: '123456789012',
    region: 'us-east-1',
    service: 'ec2',
    resourceId,
  };
}

/**
 * 把 res(x) 序列化成 buildRCAContext 输出的 resourceArns 数组里的字符串形式。
 * 与 src/shared/types.ts 中 formatResourceKey 的语义保持一致。
 */
function key(resourceId: string): string {
  return resourceId
    ? `123456789012/ec2/us-east-1/${resourceId}`
    : '123456789012/ec2/us-east-1';
}

function makeAlarm(overrides: Partial<AlarmRouterOutput> = {}): AlarmRouterOutput {
  return {
    alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:TestAlarm',
    alarmName: 'TestAlarm',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-1234567890abcdef0' },
    threshold: 80,
    currentValue: 95,
    stateChangeTimestamp: '2024-01-15T10:30:00.000Z',
    previousState: 'OK',
    accountId: '123456789012',
    region: 'us-east-1',
    resource: res('i-1234567890abcdef0'),
    filtered: false,
    ...overrides,
  };
}

describe('buildRCAContext', () => {
  it('should return investigationType as alarm_response', () => {
    const result = buildRCAContext([makeAlarm()]);
    expect(result.investigationType).toBe('alarm_response');
  });

  it('should collect all unique alarm ARNs', () => {
    const alarms = [
      makeAlarm({ alarmId: 'arn:alarm:1' }),
      makeAlarm({ alarmId: 'arn:alarm:2' }),
      makeAlarm({ alarmId: 'arn:alarm:1' }), // duplicate
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.alarmArns).toEqual(['arn:alarm:1', 'arn:alarm:2']);
  });

  it('should collect all unique resource keys and filter out empty strings', () => {
    // 注意: resource.resourceId='' 时 formatResourceKey 会退化成
    // "accountId/service/region"（不为空），仍会进入 resourceArns 数组。
    // 想要"被过滤"必须整个 resource 都是空字段——单测里不模拟这种场景。
    const alarms = [
      makeAlarm({ resource: res('r1') }),
      makeAlarm({ resource: res('r2') }),
      makeAlarm({ resource: res('r1') }), // duplicate
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.resourceArns).toEqual([key('r1'), key('r2')]);
  });

  it('should set timeRange.start to 1 hour before the earliest alarm', () => {
    const alarms = [
      makeAlarm({ stateChangeTimestamp: '2024-01-15T12:00:00.000Z' }),
      makeAlarm({ stateChangeTimestamp: '2024-01-15T10:00:00.000Z' }), // earliest
      makeAlarm({ stateChangeTimestamp: '2024-01-15T11:00:00.000Z' }),
    ];
    const result = buildRCAContext(alarms);
    // Earliest is 10:00, so start should be 09:00
    expect(result.context.timeRange.start).toBe('2024-01-15T09:00:00.000Z');
  });

  it('should set timeRange.end to the latest alarm timestamp', () => {
    const alarms = [
      makeAlarm({ stateChangeTimestamp: '2024-01-15T12:00:00.000Z' }), // latest
      makeAlarm({ stateChangeTimestamp: '2024-01-15T10:00:00.000Z' }),
      makeAlarm({ stateChangeTimestamp: '2024-01-15T11:00:00.000Z' }),
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.timeRange.end).toBe('2024-01-15T12:00:00.000Z');
  });

  it('should use current time when no valid timestamps exist', () => {
    const before = Date.now();
    const alarms = [makeAlarm({ stateChangeTimestamp: '' })];
    const result = buildRCAContext(alarms);
    const after = Date.now();

    const endTime = new Date(result.context.timeRange.end).getTime();
    expect(endTime).toBeGreaterThanOrEqual(before);
    expect(endTime).toBeLessThanOrEqual(after);

    const startTime = new Date(result.context.timeRange.start).getTime();
    const oneHourMs = 60 * 60 * 1000;
    expect(startTime).toBeGreaterThanOrEqual(before - oneHourMs);
    expect(startTime).toBeLessThanOrEqual(after - oneHourMs);
  });

  it('should build a non-empty additionalContext string', () => {
    const alarms = [makeAlarm()];
    const result = buildRCAContext(alarms);
    expect(result.context.additionalContext).not.toBe('');
    expect(result.context.additionalContext).toContain('TestAlarm');
    expect(result.context.additionalContext).toContain('AWS/EC2');
    expect(result.context.additionalContext).toContain('CPUUtilization');
    expect(result.context.additionalContext).toContain('95');
    expect(result.context.additionalContext).toContain('80');
  });

  it('should include all alarms in the additionalContext', () => {
    const alarms = [
      makeAlarm({ alarmName: 'Alarm-A', namespace: 'AWS/RDS' }),
      makeAlarm({ alarmName: 'Alarm-B', namespace: 'AWS/Lambda' }),
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.additionalContext).toContain('Alarm-A');
    expect(result.context.additionalContext).toContain('Alarm-B');
    expect(result.context.additionalContext).toContain('AWS/RDS');
    expect(result.context.additionalContext).toContain('AWS/Lambda');
  });

  it('should handle a single alarm correctly', () => {
    const alarm = makeAlarm({
      alarmId: 'arn:aws:cloudwatch:us-east-1:123:alarm:Single',
      alarmName: 'SingleAlarm',
      stateChangeTimestamp: '2024-06-01T08:00:00.000Z',
      resource: { accountId: '123', region: 'us-east-1', service: 'ec2', resourceId: 'i-abc' },
    });
    const result = buildRCAContext([alarm]);

    expect(result.context.alarmArns).toEqual(['arn:aws:cloudwatch:us-east-1:123:alarm:Single']);
    expect(result.context.resourceArns).toEqual(['123/ec2/us-east-1/i-abc']);
    expect(result.context.timeRange.start).toBe('2024-06-01T07:00:00.000Z');
    expect(result.context.timeRange.end).toBe('2024-06-01T08:00:00.000Z');
  });

  it('should empty resource (all fields blank) collapse to empty key and be filtered out', () => {
    // 当 ResourceIdentifier 所有字段都是空字符串时，formatResourceKey 返回 "//" 风格
    // 实际上 formatResourceKey({ '', '', '', '' }) === '///' 不会被过滤掉。
    // 但 alarm-router 在 composite alarm 场景下产生的 resource 全空——保留行为：
    // 这种 resource 会形成一个稳定的 "//" key，仍可作为聚合维度（即"无主告警桶"）。
    const blank: ResourceIdentifier = { accountId: '', region: '', service: '', resourceId: '' };
    const alarms = [
      makeAlarm({ resource: blank }),
      makeAlarm({ resource: blank }),
    ];
    const result = buildRCAContext(alarms);
    // formatResourceKey({all empty}) => "//"
    expect(result.context.resourceArns).toEqual(['//']);
  });

  it('should handle empty alarms array gracefully', () => {
    const result = buildRCAContext([]);
    expect(result.investigationType).toBe('alarm_response');
    expect(result.context.alarmArns).toEqual([]);
    expect(result.context.resourceArns).toEqual([]);
    expect(result.context.additionalContext).toBe('No alarm details available');
  });
});
