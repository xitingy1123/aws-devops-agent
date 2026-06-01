import { AlarmRouterOutput, AlarmFilterRule, SystemConfig } from '../../shared/types';

/**
 * Determine whether an alarm should be processed based on the system configuration.
 *
 * Priority order:
 * 1. Alarm selection mode check (highest priority)
 * 2. Filter rules (exclude takes precedence over include)
 */
export function shouldProcessAlarm(
  alarm: AlarmRouterOutput,
  config: SystemConfig
): { pass: boolean; reason?: string } {
  // Step 1: Alarm selection mode check (highest priority)
  if (config.alarmSelectionMode === 'custom') {
    if (!config.selectedAlarmNames.includes(alarm.alarmName)) {
      return { pass: false, reason: 'not_in_selected_alarms' };
    }
  }

  // Step 2: Apply filter rules
  return applyFilterRules(alarm, config.alarmFilters);
}

/**
 * Apply filter rules to determine if an alarm should pass.
 *
 * Semantics:
 * - Exclude rules take precedence over include rules.
 * - If any exclude rule matches, the alarm is filtered out.
 * - If no include rules exist, all alarms pass (unless excluded).
 * - If include rules exist, at least one must match for the alarm to pass.
 */
export function applyFilterRules(
  alarm: AlarmRouterOutput,
  filters: AlarmFilterRule[]
): { pass: boolean; reason?: string } {
  if (!filters || filters.length === 0) {
    return { pass: true };
  }

  const excludeRules = filters.filter((f) => f.action === 'exclude');
  const includeRules = filters.filter((f) => f.action === 'include');

  // Check exclude rules first (they take precedence)
  for (const rule of excludeRules) {
    if (matchesRule(alarm, rule)) {
      return { pass: false, reason: `excluded_by_${rule.type}:${rule.value}` };
    }
  }

  // If no include rules exist, all alarms pass
  if (includeRules.length === 0) {
    return { pass: true };
  }

  // If include rules exist, at least one must match
  for (const rule of includeRules) {
    if (matchesRule(alarm, rule)) {
      return { pass: true };
    }
  }

  return { pass: false, reason: 'no_include_rule_matched' };
}

/**
 * Check if an alarm matches a single filter rule.
 */
function matchesRule(alarm: AlarmRouterOutput, rule: AlarmFilterRule): boolean {
  switch (rule.type) {
    case 'namespace':
      return matchNamespace(alarm, rule.value);
    case 'name_pattern':
      return matchNamePattern(alarm, rule.value);
    default:
      return false;
  }
}

/**
 * Match alarm namespace against rule value (exact match).
 */
function matchNamespace(alarm: AlarmRouterOutput, value: string): boolean {
  return alarm.namespace === value;
}

/**
 * Match alarm name against rule value (regex pattern).
 */
function matchNamePattern(alarm: AlarmRouterOutput, pattern: string): boolean {
  try {
    const regex = new RegExp(pattern);
    return regex.test(alarm.alarmName);
  } catch {
    // Invalid regex pattern - treat as no match
    return false;
  }
}
