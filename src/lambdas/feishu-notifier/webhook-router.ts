import { WebhookConfig, WebhookRoutingRule } from '../../shared/types';

/**
 * Check if a single routing rule matches the given alarm namespace.
 */
function matchesRule(
  rule: WebhookRoutingRule,
  alarmNamespace: string
): boolean {
  if (rule.field === 'namespace') {
    return matchPattern(alarmNamespace, rule.pattern, rule.match);
  }
  return false;
}

/**
 * Match a value against a pattern using the specified match type.
 */
function matchPattern(value: string, pattern: string, matchType: 'equals' | 'contains' | 'regex'): boolean {
  switch (matchType) {
    case 'equals':
      return value === pattern;
    case 'contains':
      return value.includes(pattern);
    case 'regex':
      try {
        const regex = new RegExp(pattern);
        return regex.test(value);
      } catch {
        // Invalid regex pattern → treat as non-matching
        return false;
      }
  }
}

/**
 * Determine if a webhook config matches the given alarm based on its routing rules.
 * A webhook with empty routing rules always matches (acts as catch-all).
 * A webhook matches if ANY of its routing rules match the alarm.
 */
function webhookMatches(
  config: WebhookConfig,
  alarmNamespace: string
): boolean {
  // Empty routing rules → always matches (catch-all)
  if (config.routingRules.length === 0) {
    return true;
  }

  // Match if ANY rule matches
  return config.routingRules.some((rule) => matchesRule(rule, alarmNamespace));
}

/**
 * Route webhooks based on alarm namespace.
 *
 * Returns an array of webhook URLs that should receive the notification.
 * - If no webhooks match any routing rules, broadcast to ALL configured webhooks.
 * - If at least one webhook matches, return only the matching webhook URLs.
 * - Empty webhookConfigs → return empty array.
 * - Webhook with empty routingRules → always matches (catch-all).
 *
 * @param alarmNamespace - The namespace of the alarm (e.g., "AWS/EC2")
 * @param _alarmTags - Deprecated, kept for backward signature compatibility (no longer read)
 * @param webhookConfigs - Array of webhook configurations with routing rules
 * @returns Array of webhook URLs to send notifications to
 */
export function routeWebhooks(
  alarmNamespace: string,
  _alarmTags: Record<string, string>,
  webhookConfigs: WebhookConfig[]
): string[] {
  if (webhookConfigs.length === 0) {
    return [];
  }

  const matchedUrls: string[] = [];

  for (const config of webhookConfigs) {
    if (webhookMatches(config, alarmNamespace)) {
      matchedUrls.push(config.url);
    }
  }

  // If no webhooks matched, broadcast to all
  if (matchedUrls.length === 0) {
    return webhookConfigs.map((config) => config.url);
  }

  return matchedUrls;
}
