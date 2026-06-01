import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SystemConfig } from './types';

/**
 * Default system configuration used as fallback when SSM is unavailable
 * or no valid configuration has been loaded yet.
 */
export const DEFAULT_CONFIG: SystemConfig = {
  version: '1.0.0',
  alarmSelectionMode: 'all',
  selectedAlarmNames: [],
  alarmFilters: [],
  feishuWebhooks: [],
  rcaTimeout: 300,
  retryPolicy: {
    maxRetries: 3,
    initialDelay: 5,
    backoffMultiplier: 2,
  },
  groupingWindow: 120,
  retentionDays: 90,
};

/** Cache TTL in milliseconds (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** SSM parameter path for the system configuration. */
const SSM_PARAMETER_PATH = '/cloudwatch-alarm-auto-rca/config';

/**
 * Validates a SystemConfig object. Returns an array of validation error messages.
 * An empty array means the config is valid.
 */
export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    errors.push('Configuration must be a non-null object');
    return errors;
  }

  const cfg = config as Record<string, unknown>;

  // Required string field: version
  if (typeof cfg.version !== 'string' || cfg.version.trim() === '') {
    errors.push('version must be a non-empty string');
  }

  // alarmSelectionMode must be "all" or "custom"
  if (cfg.alarmSelectionMode !== 'all' && cfg.alarmSelectionMode !== 'custom') {
    errors.push('alarmSelectionMode must be "all" or "custom"');
  }

  // When alarmSelectionMode is "custom", selectedAlarmNames must be non-empty
  if (cfg.alarmSelectionMode === 'custom') {
    if (!Array.isArray(cfg.selectedAlarmNames) || cfg.selectedAlarmNames.length === 0) {
      errors.push('selectedAlarmNames must be a non-empty array when alarmSelectionMode is "custom"');
    }
  }

  // selectedAlarmNames must be an array
  if (!Array.isArray(cfg.selectedAlarmNames)) {
    errors.push('selectedAlarmNames must be an array');
  }

  // alarmFilters must be an array
  if (!Array.isArray(cfg.alarmFilters)) {
    errors.push('alarmFilters must be an array');
  }

  // feishuWebhooks must be an array
  if (!Array.isArray(cfg.feishuWebhooks)) {
    errors.push('feishuWebhooks must be an array');
  }

  // rcaTimeout must be a positive number
  if (typeof cfg.rcaTimeout !== 'number' || cfg.rcaTimeout <= 0) {
    errors.push('rcaTimeout must be a positive number');
  }

  // groupingWindow must be a positive number
  if (typeof cfg.groupingWindow !== 'number' || cfg.groupingWindow <= 0) {
    errors.push('groupingWindow must be a positive number');
  }

  // retentionDays must be a positive number
  if (typeof cfg.retentionDays !== 'number' || cfg.retentionDays <= 0) {
    errors.push('retentionDays must be a positive number');
  }

  // retryPolicy validation
  if (!cfg.retryPolicy || typeof cfg.retryPolicy !== 'object') {
    errors.push('retryPolicy must be a non-null object');
  } else {
    const rp = cfg.retryPolicy as Record<string, unknown>;
    if (typeof rp.maxRetries !== 'number' || rp.maxRetries < 0) {
      errors.push('retryPolicy.maxRetries must be a non-negative number');
    }
    if (typeof rp.initialDelay !== 'number' || rp.initialDelay <= 0) {
      errors.push('retryPolicy.initialDelay must be a positive number');
    }
    if (typeof rp.backoffMultiplier !== 'number' || rp.backoffMultiplier <= 0) {
      errors.push('retryPolicy.backoffMultiplier must be a positive number');
    }
  }

  return errors;
}

/**
 * ConfigManager reads configuration from SSM Parameter Store,
 * provides in-memory caching with a 5-minute TTL, and validates
 * configuration before accepting it.
 */
export class ConfigManager {
  private ssmClient: SSMClient;
  private parameterPath: string;
  private cachedConfig: SystemConfig;
  private lastFetchTime: number;
  private cacheTtlMs: number;

  constructor(options?: {
    ssmClient?: SSMClient;
    parameterPath?: string;
    cacheTtlMs?: number;
  }) {
    this.ssmClient = options?.ssmClient ?? new SSMClient({});
    this.parameterPath = options?.parameterPath ?? SSM_PARAMETER_PATH;
    this.cacheTtlMs = options?.cacheTtlMs ?? CACHE_TTL_MS;
    this.cachedConfig = DEFAULT_CONFIG;
    this.lastFetchTime = 0;
  }

  /**
   * Returns the current configuration. If the cache is stale,
   * attempts to refresh from SSM. On failure, returns the last
   * valid cached configuration.
   */
  async getConfig(): Promise<SystemConfig> {
    if (this.isConfigStale()) {
      await this.refreshConfig();
    }
    return this.cachedConfig;
  }

  /**
   * Forces a refresh of the configuration from SSM Parameter Store.
   * If the fetch fails or the fetched config is invalid, the previous
   * valid configuration is retained and a warning is logged.
   */
  async refreshConfig(): Promise<void> {
    try {
      const command = new GetParameterCommand({
        Name: this.parameterPath,
        WithDecryption: true,
      });

      const response = await this.ssmClient.send(command);
      const paramValue = response.Parameter?.Value;

      if (!paramValue) {
        console.warn(
          '[ConfigManager] SSM parameter value is empty, retaining previous configuration'
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(paramValue);
      } catch (parseError) {
        console.warn(
          '[ConfigManager] Failed to parse SSM parameter as JSON, retaining previous configuration',
          parseError
        );
        return;
      }

      const validationErrors = validateConfig(parsed);
      if (validationErrors.length > 0) {
        console.warn(
          '[ConfigManager] Configuration validation failed, retaining previous configuration. Errors:',
          validationErrors
        );
        return;
      }

      // Config is valid — update cache
      this.cachedConfig = parsed as SystemConfig;
      this.lastFetchTime = Date.now();
    } catch (error) {
      console.warn(
        '[ConfigManager] Failed to fetch configuration from SSM, retaining previous configuration',
        error
      );
      // Keep the existing cached config (or defaults if never loaded)
    }
  }

  /**
   * Returns true if the cached configuration is stale (older than the TTL).
   */
  isConfigStale(): boolean {
    if (this.lastFetchTime === 0) {
      return true;
    }
    return Date.now() - this.lastFetchTime >= this.cacheTtlMs;
  }
}
