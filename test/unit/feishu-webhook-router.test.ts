import { routeWebhooks } from '../../src/lambdas/feishu-notifier/webhook-router';
import { WebhookConfig } from '../../src/shared/types';

describe('routeWebhooks', () => {
  describe('namespace equals matching', () => {
    it('should match webhook when namespace equals the pattern exactly', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'EC2 Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/EC2', match: 'equals' }],
        },
        {
          url: 'https://hook.feishu.cn/webhook2',
          name: 'RDS Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/RDS', match: 'equals' }],
        },
      ];

      const result = routeWebhooks('AWS/EC2', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook1']);
    });

    it('should not match when namespace does not equal the pattern', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'EC2 Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/EC2', match: 'equals' }],
        },
      ];

      // No match → broadcast to all
      const result = routeWebhooks('AWS/Lambda', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook1']);
    });
  });

  describe('namespace contains matching', () => {
    it('should match webhook when namespace contains the pattern', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'AWS Team',
          routingRules: [{ field: 'namespace', pattern: 'EC2', match: 'contains' }],
        },
      ];

      const result = routeWebhooks('AWS/EC2', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook1']);
    });

    it('should not match when namespace does not contain the pattern', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'AWS Team',
          routingRules: [{ field: 'namespace', pattern: 'RDS', match: 'contains' }],
        },
      ];

      // No match → broadcast
      const result = routeWebhooks('AWS/EC2', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook1']);
    });
  });

  describe('regex matching', () => {
    it('should match namespace with regex pattern', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'AWS Team',
          routingRules: [{ field: 'namespace', pattern: '^AWS/.*', match: 'regex' }],
        },
      ];

      const result = routeWebhooks('AWS/EC2', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook1']);
    });

    it('should treat invalid regex as non-matching', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'Team',
          routingRules: [{ field: 'namespace', pattern: '[invalid(regex', match: 'regex' }],
        },
      ];

      // Invalid regex → non-matching → broadcast
      const result = routeWebhooks('AWS/EC2', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook1']);
    });
  });

  describe('broadcast when no rules match', () => {
    it('should broadcast to all webhooks when no routing rules match', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'EC2 Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/EC2', match: 'equals' }],
        },
        {
          url: 'https://hook.feishu.cn/webhook2',
          name: 'RDS Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/RDS', match: 'equals' }],
        },
      ];

      const result = routeWebhooks('AWS/Lambda', {}, configs);
      expect(result).toEqual([
        'https://hook.feishu.cn/webhook1',
        'https://hook.feishu.cn/webhook2',
      ]);
    });

    it('should return only matching webhooks when at least one matches', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'EC2 Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/EC2', match: 'equals' }],
        },
        {
          url: 'https://hook.feishu.cn/webhook2',
          name: 'RDS Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/RDS', match: 'equals' }],
        },
        {
          url: 'https://hook.feishu.cn/webhook3',
          name: 'Lambda Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/Lambda', match: 'equals' }],
        },
      ];

      const result = routeWebhooks('AWS/EC2', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook1']);
    });
  });

  describe('empty configs', () => {
    it('should return empty array when webhookConfigs is empty', () => {
      const result = routeWebhooks('AWS/EC2', {}, []);
      expect(result).toEqual([]);
    });
  });

  describe('webhook with no routing rules (catch-all)', () => {
    it('should always match a webhook with empty routing rules', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'Catch-All Team',
          routingRules: [],
        },
      ];

      const result = routeWebhooks('AWS/EC2', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook1']);
    });

    it('should include catch-all webhook alongside specifically matched webhooks', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'EC2 Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/EC2', match: 'equals' }],
        },
        {
          url: 'https://hook.feishu.cn/webhook2',
          name: 'Catch-All',
          routingRules: [],
        },
      ];

      const result = routeWebhooks('AWS/EC2', {}, configs);
      expect(result).toEqual([
        'https://hook.feishu.cn/webhook1',
        'https://hook.feishu.cn/webhook2',
      ]);
    });

    it('catch-all webhook prevents broadcast behavior', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'EC2 Team',
          routingRules: [{ field: 'namespace', pattern: 'AWS/EC2', match: 'equals' }],
        },
        {
          url: 'https://hook.feishu.cn/webhook2',
          name: 'Catch-All',
          routingRules: [],
        },
      ];

      // Even though webhook1 doesn't match Lambda, webhook2 (catch-all) does
      // So we get only the matching ones (webhook2), not broadcast
      const result = routeWebhooks('AWS/Lambda', {}, configs);
      expect(result).toEqual(['https://hook.feishu.cn/webhook2']);
    });
  });

  describe('multiple routing rules on a single webhook (OR logic)', () => {
    it('should match if any routing rule matches', () => {
      const configs: WebhookConfig[] = [
        {
          url: 'https://hook.feishu.cn/webhook1',
          name: 'Infra Team',
          routingRules: [
            { field: 'namespace', pattern: 'AWS/EC2', match: 'equals' },
            { field: 'namespace', pattern: 'AWS/RDS', match: 'equals' },
          ],
        },
      ];

      const result1 = routeWebhooks('AWS/EC2', {}, configs);
      expect(result1).toEqual(['https://hook.feishu.cn/webhook1']);

      const result2 = routeWebhooks('AWS/RDS', {}, configs);
      expect(result2).toEqual(['https://hook.feishu.cn/webhook1']);
    });
  });
});
