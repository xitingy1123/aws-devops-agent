// Feature: cloudwatch-alarm-auto-rca, Property 8: RCA Report structure completeness
// Validates: Requirements 3.3

import * as fc from 'fast-check';
import { generateFullReport, AgentResponse } from '../../src/lambdas/rca-analyzer/report-generator';
import { AlarmRouterOutput, ResourceIdentifier } from '../../src/shared/types';

// --- Arbitrary generators ---

const arbAlarmName = fc.string({ minLength: 1, maxLength: 30 }).map(
  (s) => s.replace(/[^a-zA-Z0-9-_]/g, 'a') || 'alarm'
);

const arbNamespace = fc.constantFrom('AWS/EC2', 'AWS/RDS', 'AWS/Lambda', 'AWS/ECS');

const arbMetricName = fc.constantFrom(
  'CPUUtilization', 'FreeableMemory', 'Duration', 'Errors'
);

const arbResource: fc.Arbitrary<ResourceIdentifier> = fc.constantFrom<ResourceIdentifier>(
  { accountId: '123456789012', region: 'us-east-1', service: 'ec2', resourceId: 'i-abc123' },
  { accountId: '123456789012', region: 'us-east-1', service: 'rds', resourceId: 'prod-db' },
  { accountId: '123456789012', region: 'us-east-1', service: 'lambda', resourceId: 'my-func' }
);

// 受影响资源在 affectedResources 数组里依旧是字符串形式的 resource key。
const arbResourceKeyString = fc.constantFrom(
  '123456789012/ec2/us-east-1/i-abc123',
  '123456789012/rds/us-east-1/prod-db',
  '123456789012/lambda/us-east-1/my-func'
);

const arbTimestamp = fc.integer({ min: 1700000000000, max: 1710000000000 }).map(
  (ts) => new Date(ts).toISOString()
);

const arbAlarm: fc.Arbitrary<AlarmRouterOutput> = fc.record({
  alarmId: fc.constant('arn:aws:cloudwatch:us-east-1:123456789012:alarm:test'),
  alarmName: arbAlarmName,
  namespace: arbNamespace,
  metricName: arbMetricName,
  dimensions: fc.constant({}),
  threshold: fc.double({ min: 0, max: 1000, noNaN: true }),
  currentValue: fc.double({ min: 0, max: 2000, noNaN: true }),
  stateChangeTimestamp: arbTimestamp,
  previousState: fc.constant('OK'),
  accountId: fc.constant('123456789012'),
  region: fc.constant('us-east-1'),
  resource: arbResource,
  filtered: fc.constant(false),
});

const arbCategory = fc.constantFrom(
  'system_change', 'input_anomaly', 'resource_limit',
  'component_failure', 'dependency_issue', 'unknown'
);

const arbConfidence = fc.constantFrom('high', 'medium', 'low');

const arbTimelineEntry = fc.record({
  timestamp: arbTimestamp,
  action: fc.string({ minLength: 1, maxLength: 50 }),
  finding: fc.string({ minLength: 1, maxLength: 100 }),
});

const arbAgentResponseData = fc.record({
  timeline: fc.array(arbTimelineEntry, { minLength: 1, maxLength: 5 }),
  dataSourcesConsulted: fc.array(
    fc.constantFrom('CloudWatch Metrics', 'CloudTrail', 'X-Ray', 'Config'),
    { minLength: 1, maxLength: 4 }
  ),
  hypothesesExplored: fc.array(
    fc.string({ minLength: 1, maxLength: 50 }),
    { minLength: 1, maxLength: 3 }
  ),
  rootCause: fc.record({
    summary: fc.string({ minLength: 1, maxLength: 100 }),
    category: arbCategory,
    details: fc.string({ minLength: 1, maxLength: 200 }),
    confidence: arbConfidence,
    affectedResources: fc.array(arbResourceKeyString, { minLength: 1, maxLength: 3 }),
  }),
  remediation: fc.record({
    immediateMitigation: fc.string({ minLength: 1, maxLength: 100 }),
    longTermFix: fc.string({ minLength: 1, maxLength: 100 }),
    steps: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
    rollbackPlan: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  }),
});

const arbAgentResponse: fc.Arbitrary<AgentResponse> = arbAgentResponseData.map((data) => ({
  success: true,
  data,
}));

const arbGroupId = fc.string({ minLength: 5, maxLength: 36 }).map(
  (s) => s.replace(/[^a-zA-Z0-9-]/g, 'x') || 'group-id'
);

describe('Property 8: RCA Report structure completeness', () => {
  it('generated report always has a non-empty reportId', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);

          expect(report.reportId).toBeDefined();
          expect(typeof report.reportId).toBe('string');
          expect(report.reportId.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('alarm summary has correct alarm count matching input', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);

          expect(report.alarmSummary.alarmCount).toBe(alarms.length);
          expect(report.alarmSummary.alarms.length).toBe(alarms.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('investigation timeline has at least one entry', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);

          expect(report.investigation.timeline.length).toBeGreaterThanOrEqual(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('root cause summary is always a non-empty string', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);

          expect(typeof report.rootCause.summary).toBe('string');
          expect(report.rootCause.summary.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('remediation immediateMitigation is always present', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);

          expect(report.remediation).toBeDefined();
          expect(typeof report.remediation.immediateMitigation).toBe('string');
          expect(report.remediation.immediateMitigation.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('report status is always "completed" for successful agent response', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);
          expect(report.status).toBe('completed');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('report groupId matches the input groupId', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);
          expect(report.groupId).toBe(groupId);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('report generatedAt is a valid ISO timestamp', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);

          const parsed = new Date(report.generatedAt).getTime();
          expect(isNaN(parsed)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all required top-level fields are present', () => {
    fc.assert(
      fc.property(
        arbAgentResponse,
        fc.array(arbAlarm, { minLength: 1, maxLength: 5 }),
        arbGroupId,
        (agentResponse, alarms, groupId) => {
          const report = generateFullReport(agentResponse, alarms, groupId);

          expect(report).toHaveProperty('reportId');
          expect(report).toHaveProperty('groupId');
          expect(report).toHaveProperty('generatedAt');
          expect(report).toHaveProperty('status');
          expect(report).toHaveProperty('alarmSummary');
          expect(report).toHaveProperty('investigation');
          expect(report).toHaveProperty('rootCause');
          expect(report).toHaveProperty('remediation');
        }
      ),
      { numRuns: 100 }
    );
  });
});
