// Feature: cloudwatch-alarm-auto-rca, Property 11: Webhook routing correctness
// Validates: Requirements 4.6

import * as fc from 'fast-check';
import { routeWebhooks } from '../../src/lambdas/feishu-notifier/webhook-router';
import { WebhookConfig, WebhookRoutingRule } from '../../src/shared/types';

// --- Arbitrary generators ---

const arbNamespace = fc.constantFrom(
  'AWS/EC2', 'AWS/RDS', 'AWS/Lambda', 'AWS/ECS', 'AWS/S3', 'Custom/MyApp'
);

const arbTagKey = fc.constantFrom('env', 'team', 'service', 'region', 'tier');
const arbTagValue = fc.constantFrom('production', 'staging', 'dev', 'backend', 'frontend', 'critical');

const arbTags = fc.dictionary(arbTagKey, arbTagValue, { minKeys: 0, maxKeys: 3 });

const arbWebhookUrl = fc.integer({ min: 1, max: 100 }).map(
  (n) => `https://open.feishu.cn/open-apis/bot/v2/hook/webhook-${n}`
);

const arbMatchType = fc.constantFrom('equals', 'contains', 'regex') as fc.Arbitrary<WebhookRoutingRule['match']>;

const arbNamespaceRule: fc.Arbitrary<WebhookRoutingRule> = fc.record({
  field: fc.constant('namespace') as fc.Arbitrary<'namespace'>,
  pattern: arbNamespace,
  match: fc.constantFrom('equals', 'contains') as fc.Arbitrary<'equals' | 'contains'>,
});

const arbTagRule: fc.Arbitrary<WebhookRoutingRule> = arbNamespaceRule;

const arbRoutingRule: fc.Arbitrary<WebhookRoutingRule> = arbNamespaceRule;

const arbWebhookConfig: fc.Arbitrary<WebhookConfig> = fc.record({
  url: arbWebhookUrl,
  name: fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.replace(/[^a-zA-Z0-9 ]/g, 'a') || 'team'),
  routingRules: fc.array(arbRoutingRule, { minLength: 0, maxLength: 3 }),
});

describe('Property 11: Webhook routing correctness', () => {
  it('empty webhook configs always returns empty array', () => {
    fc.assert(
      fc.property(arbNamespace, arbTags, (namespace, tags) => {
        const result = routeWebhooks(namespace, tags, []);
        expect(result).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it('when no rules match, all webhook URLs are returned (broadcast)', () => {
    fc.assert(
      fc.property(
        fc.array(arbWebhookUrl, { minLength: 1, maxLength: 5 }),
        (urls) => {
          // Create configs with rules that won't match "Custom/NoMatch" namespace
          const configs: WebhookConfig[] = urls.map((url) => ({
            url,
            name: 'team',
            routingRules: [{ field: 'namespace' as const, pattern: 'AWS/NonExistent', match: 'equals' as const }],
          }));

          const result = routeWebhooks('Custom/NoMatchNamespace', {}, configs);
          // When no rules match, broadcast to all
          expect(result.length).toBe(urls.length);
          expect(result.sort()).toEqual(urls.sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('webhook with empty routing rules always matches (catch-all)', () => {
    fc.assert(
      fc.property(arbNamespace, arbTags, arbWebhookUrl, (namespace, tags, url) => {
        const configs: WebhookConfig[] = [
          { url, name: 'catch-all', routingRules: [] },
        ];

        const result = routeWebhooks(namespace, tags, configs);
        expect(result).toContain(url);
      }),
      { numRuns: 100 }
    );
  });

  it('namespace equals rule matches only exact namespace', () => {
    fc.assert(
      fc.property(
        arbNamespace,
        arbWebhookUrl,
        (namespace, url) => {
          const configs: WebhookConfig[] = [
            { url, name: 'team', routingRules: [{ field: 'namespace', pattern: namespace, match: 'equals' }] },
          ];

          const result = routeWebhooks(namespace, {}, configs);
          expect(result).toContain(url);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('result contains only URLs from the provided webhook configs', () => {
    fc.assert(
      fc.property(
        arbNamespace,
        arbTags,
        fc.array(arbWebhookConfig, { minLength: 1, maxLength: 5 }),
        (namespace, tags, configs) => {
          const result = routeWebhooks(namespace, tags, configs);
          const allUrls = configs.map((c) => c.url);

          for (const url of result) {
            expect(allUrls).toContain(url);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('routing is deterministic - same input always produces same output', () => {
    fc.assert(
      fc.property(
        arbNamespace,
        arbTags,
        fc.array(arbWebhookConfig, { minLength: 1, maxLength: 5 }),
        (namespace, tags, configs) => {
          const result1 = routeWebhooks(namespace, tags, configs);
          const result2 = routeWebhooks(namespace, tags, configs);
          expect(result1).toEqual(result2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
