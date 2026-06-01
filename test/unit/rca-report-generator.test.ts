import {
  generateRCAReport,
  generateFullReport,
  generatePartialReport,
  generateTimeoutReport,
  AgentResponse,
} from '../../src/lambdas/rca-analyzer/report-generator';
import { AlarmRouterOutput } from '../../src/shared/types';

const mockAlarms: AlarmRouterOutput[] = [
  {
    alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU',
    alarmName: 'HighCPU',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-1234567890abcdef0' },
    threshold: 80,
    currentValue: 95,
    stateChangeTimestamp: '2024-01-15T10:00:00.000Z',
    previousState: 'OK',
    accountId: '123456789012',
    region: 'us-east-1',
    resource: { accountId: '123456789012', region: 'us-east-1', service: 'ec2', resourceId: 'i-1234567890abcdef0' },
    filtered: false,
  },
  {
    alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighMemory',
    alarmName: 'HighMemory',
    namespace: 'AWS/EC2',
    metricName: 'MemoryUtilization',
    dimensions: { InstanceId: 'i-1234567890abcdef0' },
    threshold: 90,
    currentValue: 92,
    stateChangeTimestamp: '2024-01-15T10:01:00.000Z',
    previousState: 'OK',
    accountId: '123456789012',
    region: 'us-east-1',
    resource: { accountId: '123456789012', region: 'us-east-1', service: 'ec2', resourceId: 'i-1234567890abcdef0' },
    filtered: false,
  },
];

const groupId = 'group-123';

describe('report-generator', () => {
  describe('generateRCAReport', () => {
    it('should generate a full report when agent response is successful', () => {
      const agentResponse: AgentResponse = {
        success: true,
        data: {
          timeline: [
            { timestamp: '2024-01-15T10:00:00Z', action: 'Checked metrics', finding: 'CPU spike detected' },
          ],
          dataSourcesConsulted: ['CloudWatch Metrics', 'CloudTrail'],
          hypothesesExplored: ['Deployment change', 'Traffic spike'],
          rootCause: {
            summary: 'Auto-scaling group reached max capacity',
            category: 'resource_limit',
            details: 'The ASG hit its max instance count during a traffic spike',
            confidence: 'high',
            affectedResources: ['arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:my-asg'],
          },
          remediation: {
            immediateMitigation: 'Increase ASG max capacity',
            longTermFix: 'Implement predictive scaling',
            steps: ['Increase max capacity to 10', 'Enable predictive scaling'],
            rollbackPlan: 'Revert max capacity to 5',
          },
        },
      };

      const report = generateRCAReport(agentResponse, mockAlarms, groupId);

      expect(report.status).toBe('completed');
      expect(report.groupId).toBe(groupId);
      expect(report.reportId).toBeDefined();
      expect(report.generatedAt).toBeDefined();
      expect(report.alarmSummary.alarmCount).toBe(2);
      expect(report.alarmSummary.alarms).toHaveLength(2);
      expect(report.alarmSummary.firstAlarmTime).toBe('2024-01-15T10:00:00.000Z');
      expect(report.alarmSummary.lastAlarmTime).toBe('2024-01-15T10:01:00.000Z');
      expect(report.investigation.timeline).toHaveLength(1);
      expect(report.investigation.dataSourcesConsulted).toEqual(['CloudWatch Metrics', 'CloudTrail']);
      expect(report.rootCause.summary).toBe('Auto-scaling group reached max capacity');
      expect(report.rootCause.category).toBe('resource_limit');
      expect(report.rootCause.confidence).toBe('high');
      expect(report.remediation.immediateMitigation).toBe('Increase ASG max capacity');
      expect(report.remediation.steps).toHaveLength(2);
      expect(report.remediation.rollbackPlan).toBe('Revert max capacity to 5');
    });

    it('should generate a timeout report when agent timed out', () => {
      const agentResponse: AgentResponse = {
        success: false,
        timedOut: true,
        error: 'DevOps Agent call timed out after 300000ms',
      };

      const report = generateRCAReport(agentResponse, mockAlarms, groupId);

      expect(report.status).toBe('timeout');
      expect(report.groupId).toBe(groupId);
      expect(report.alarmSummary.alarmCount).toBe(2);
      expect(report.rootCause.summary).toBe('Root cause analysis timed out');
      expect(report.rootCause.category).toBe('unknown');
      expect(report.rootCause.confidence).toBe('low');
      expect(report.remediation.immediateMitigation).toBe('Manual investigation required');
    });

    it('should generate a partial report when agent failed', () => {
      const agentResponse: AgentResponse = {
        success: false,
        error: 'DevOps Agent call failed after 3 retries. Last error: HTTP 503',
      };

      const report = generateRCAReport(agentResponse, mockAlarms, groupId);

      expect(report.status).toBe('partial');
      expect(report.groupId).toBe(groupId);
      expect(report.alarmSummary.alarmCount).toBe(2);
      expect(report.rootCause.summary).toBe('Root cause analysis incomplete due to agent failure');
      expect(report.rootCause.category).toBe('unknown');
      expect(report.rootCause.confidence).toBe('low');
      expect(report.investigation.timeline).toHaveLength(1);
      expect(report.investigation.timeline[0].finding).toContain('HTTP 503');
    });
  });

  describe('generateFullReport', () => {
    it('should handle missing data fields gracefully', () => {
      const agentResponse: AgentResponse = {
        success: true,
        data: {},
      };

      const report = generateFullReport(agentResponse, mockAlarms, groupId);

      expect(report.status).toBe('completed');
      expect(report.investigation.timeline).toEqual([]);
      expect(report.investigation.dataSourcesConsulted).toEqual([]);
      expect(report.investigation.hypothesesExplored).toEqual([]);
      expect(report.rootCause.category).toBe('unknown');
      expect(report.rootCause.confidence).toBe('medium');
      expect(report.rootCause.affectedResources).toContain(
        '123456789012/ec2/us-east-1/i-1234567890abcdef0'
      );
    });

    it('should handle undefined data in agent response', () => {
      const agentResponse: AgentResponse = {
        success: true,
      };

      const report = generateFullReport(agentResponse, mockAlarms, groupId);

      expect(report.status).toBe('completed');
      expect(report.investigation.timeline).toEqual([]);
      expect(report.rootCause.category).toBe('unknown');
    });

    it('should validate category values and default to unknown for invalid ones', () => {
      const agentResponse: AgentResponse = {
        success: true,
        data: {
          rootCause: {
            category: 'invalid_category',
            confidence: 'high',
          },
        },
      };

      const report = generateFullReport(agentResponse, mockAlarms, groupId);

      expect(report.rootCause.category).toBe('unknown');
    });

    it('should validate confidence values and default to medium for invalid ones', () => {
      const agentResponse: AgentResponse = {
        success: true,
        data: {
          rootCause: {
            category: 'system_change',
            confidence: 'very_high',
          },
        },
      };

      const report = generateFullReport(agentResponse, mockAlarms, groupId);

      expect(report.rootCause.confidence).toBe('medium');
    });
  });

  describe('generatePartialReport', () => {
    it('should include affected resources from alarms', () => {
      const agentResponse: AgentResponse = {
        success: false,
        error: 'Service unavailable',
      };

      const report = generatePartialReport(agentResponse, mockAlarms, groupId);

      expect(report.rootCause.affectedResources).toContain(
        '123456789012/ec2/us-east-1/i-1234567890abcdef0'
      );
    });

    it('should filter out empty resource keys', () => {
      // resource 全空字段时 formatResourceKey 输出 "//", 不为空字符串,因此
      // 这条 alarm 的 resource key 仍会进入 affectedResources。要测真正的
      // "空 resource 被过滤", 用 service/resourceId 全为空的 ResourceIdentifier。
      const blank = { accountId: '', region: '', service: '', resourceId: '' };
      const alarmsWithEmpty: AlarmRouterOutput[] = [
        { ...mockAlarms[0], resource: blank },
        mockAlarms[1],
      ];

      const agentResponse: AgentResponse = {
        success: false,
        error: 'Failed',
      };

      const report = generatePartialReport(agentResponse, alarmsWithEmpty, groupId);

      expect(report.rootCause.affectedResources).not.toContain('');
      expect(report.rootCause.affectedResources).toContain(
        '123456789012/ec2/us-east-1/i-1234567890abcdef0'
      );
    });
  });

  describe('generateTimeoutReport', () => {
    it('should include timeout error details', () => {
      const agentResponse: AgentResponse = {
        success: false,
        timedOut: true,
        error: 'DevOps Agent call timed out after 300000ms',
      };

      const report = generateTimeoutReport(agentResponse, mockAlarms, groupId);

      expect(report.status).toBe('timeout');
      expect(report.investigation.timeline[0].finding).toContain('timed out');
      expect(report.rootCause.details).toContain('300000ms');
    });
  });

  describe('alarm summary', () => {
    it('should handle alarms with empty timestamps', () => {
      const alarmsNoTimestamp: AlarmRouterOutput[] = [
        { ...mockAlarms[0], stateChangeTimestamp: '' },
      ];

      const agentResponse: AgentResponse = { success: true, data: {} };
      const report = generateFullReport(agentResponse, alarmsNoTimestamp, groupId);

      // Should use current time when no valid timestamps
      expect(report.alarmSummary.firstAlarmTime).toBeDefined();
      expect(report.alarmSummary.lastAlarmTime).toBeDefined();
    });

    it('should correctly identify first and last alarm times', () => {
      const agentResponse: AgentResponse = { success: true, data: {} };
      const report = generateFullReport(agentResponse, mockAlarms, groupId);

      expect(report.alarmSummary.firstAlarmTime).toBe('2024-01-15T10:00:00.000Z');
      expect(report.alarmSummary.lastAlarmTime).toBe('2024-01-15T10:01:00.000Z');
    });

    it('should generate unique report IDs', () => {
      const agentResponse: AgentResponse = { success: true, data: {} };
      const report1 = generateFullReport(agentResponse, mockAlarms, groupId);
      const report2 = generateFullReport(agentResponse, mockAlarms, groupId);

      expect(report1.reportId).not.toBe(report2.reportId);
    });
  });
});
