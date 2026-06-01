import { ConfigManager, DEFAULT_CONFIG, validateConfig } from '../../src/shared/config-manager';
import { SystemConfig } from '../../src/shared/types';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Mock SSM Client
const mockSend = jest.fn();
const mockSsmClient = { send: mockSend } as unknown as SSMClient;

function createValidConfig(overrides?: Partial<SystemConfig>): SystemConfig {
  return {
    version: '2.0.0',
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
    ...overrides,
  };
}

describe('ConfigManager', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();
    configManager = new ConfigManager({
      ssmClient: mockSsmClient,
      cacheTtlMs: 5 * 60 * 1000,
    });
  });

  describe('getConfig()', () => {
    it('should return default config when no config has been loaded', async () => {
      mockSend.mockRejectedValueOnce(new Error('SSM unavailable'));
      const config = await configManager.getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should fetch config from SSM on first call', async () => {
      const validConfig = createValidConfig({ version: '3.0.0' });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });

      const config = await configManager.getConfig();
      expect(config.version).toBe('3.0.0');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should use cached config within TTL', async () => {
      const validConfig = createValidConfig({ version: '3.0.0' });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });

      // First call fetches from SSM
      await configManager.getConfig();
      // Second call should use cache
      const config = await configManager.getConfig();

      expect(config.version).toBe('3.0.0');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should refresh config after TTL expires', async () => {
      // Use a very short TTL for testing
      const shortTtlManager = new ConfigManager({
        ssmClient: mockSsmClient,
        cacheTtlMs: 1, // 1ms TTL
      });

      const config1 = createValidConfig({ version: '1.0.0' });
      const config2 = createValidConfig({ version: '2.0.0' });

      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(config1) },
      });

      await shortTtlManager.getConfig();

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 5));

      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(config2) },
      });

      const config = await shortTtlManager.getConfig();
      expect(config.version).toBe('2.0.0');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshConfig()', () => {
    it('should update cached config with valid SSM response', async () => {
      const validConfig = createValidConfig({ rcaTimeout: 600 });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });

      await configManager.refreshConfig();
      // Force getConfig to not re-fetch by checking cache is fresh
      const config = await configManager.getConfig();
      expect(config.rcaTimeout).toBe(600);
    });

    it('should retain previous config when SSM is unavailable', async () => {
      // First load a valid config
      const validConfig = createValidConfig({ version: '5.0.0' });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });
      await configManager.refreshConfig();

      // Now SSM fails
      mockSend.mockRejectedValueOnce(new Error('Network error'));
      await configManager.refreshConfig();

      const config = await configManager.getConfig();
      expect(config.version).toBe('5.0.0');
    });

    it('should retain previous config when SSM returns empty value', async () => {
      const validConfig = createValidConfig({ version: '5.0.0' });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });
      await configManager.refreshConfig();

      mockSend.mockResolvedValueOnce({
        Parameter: { Value: '' },
      });
      await configManager.refreshConfig();

      const config = await configManager.getConfig();
      expect(config.version).toBe('5.0.0');
    });

    it('should retain previous config when SSM returns invalid JSON', async () => {
      const validConfig = createValidConfig({ version: '5.0.0' });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });
      await configManager.refreshConfig();

      mockSend.mockResolvedValueOnce({
        Parameter: { Value: 'not valid json {{{' },
      });
      await configManager.refreshConfig();

      const config = await configManager.getConfig();
      expect(config.version).toBe('5.0.0');
    });

    it('should retain previous config when new config fails validation', async () => {
      const validConfig = createValidConfig({ version: '5.0.0' });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });
      await configManager.refreshConfig();

      // Invalid config: negative rcaTimeout
      const invalidConfig = { ...createValidConfig(), rcaTimeout: -1 };
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(invalidConfig) },
      });
      await configManager.refreshConfig();

      const config = await configManager.getConfig();
      expect(config.version).toBe('5.0.0');
      expect(config.rcaTimeout).toBe(300);
    });
  });

  describe('isConfigStale()', () => {
    it('should return true when no config has been fetched', () => {
      expect(configManager.isConfigStale()).toBe(true);
    });

    it('should return false immediately after a successful fetch', async () => {
      const validConfig = createValidConfig();
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });
      await configManager.refreshConfig();
      expect(configManager.isConfigStale()).toBe(false);
    });

    it('should return true after TTL expires', async () => {
      const shortTtlManager = new ConfigManager({
        ssmClient: mockSsmClient,
        cacheTtlMs: 1,
      });

      const validConfig = createValidConfig();
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(validConfig) },
      });
      await shortTtlManager.refreshConfig();

      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(shortTtlManager.isConfigStale()).toBe(true);
    });
  });

  describe('config version change detection', () => {
    it('should detect and apply config version changes on refresh', async () => {
      const configV1 = createValidConfig({ version: '1.0.0' });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(configV1) },
      });
      await configManager.refreshConfig();
      const firstConfig = await configManager.getConfig();
      expect(firstConfig.version).toBe('1.0.0');

      // Simulate TTL expiry by creating a new manager with 1ms TTL
      const shortTtlManager = new ConfigManager({
        ssmClient: mockSsmClient,
        cacheTtlMs: 1,
      });

      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(configV1) },
      });
      await shortTtlManager.getConfig();

      await new Promise((resolve) => setTimeout(resolve, 5));

      const configV2 = createValidConfig({ version: '2.0.0', rcaTimeout: 600 });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(configV2) },
      });

      const updatedConfig = await shortTtlManager.getConfig();
      expect(updatedConfig.version).toBe('2.0.0');
      expect(updatedConfig.rcaTimeout).toBe(600);
    });

    it('should not update config if new version fails validation', async () => {
      const configV1 = createValidConfig({ version: '1.0.0' });
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(configV1) },
      });
      await configManager.refreshConfig();

      // Attempt to load v2 with invalid data
      const invalidV2 = { ...createValidConfig({ version: '2.0.0' }), rcaTimeout: -1 };
      mockSend.mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify(invalidV2) },
      });
      await configManager.refreshConfig();

      const config = await configManager.getConfig();
      expect(config.version).toBe('1.0.0');
    });
  });

  describe('validateConfig()', () => {
    it('should return no errors for a valid config', () => {
      const config = createValidConfig();
      expect(validateConfig(config)).toEqual([]);
    });

    it('should reject null config', () => {
      const errors = validateConfig(null);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should reject config with invalid alarmSelectionMode', () => {
      const config = createValidConfig();
      (config as any).alarmSelectionMode = 'invalid';
      const errors = validateConfig(config);
      expect(errors).toContain('alarmSelectionMode must be "all" or "custom"');
    });

    it('should reject custom mode with empty selectedAlarmNames', () => {
      const config = createValidConfig({
        alarmSelectionMode: 'custom',
        selectedAlarmNames: [],
      });
      const errors = validateConfig(config);
      expect(errors).toContain(
        'selectedAlarmNames must be a non-empty array when alarmSelectionMode is "custom"'
      );
    });

    it('should accept custom mode with non-empty selectedAlarmNames', () => {
      const config = createValidConfig({
        alarmSelectionMode: 'custom',
        selectedAlarmNames: ['my-alarm'],
      });
      const errors = validateConfig(config);
      expect(errors).toEqual([]);
    });

    it('should reject negative rcaTimeout', () => {
      const config = createValidConfig({ rcaTimeout: -10 });
      const errors = validateConfig(config);
      expect(errors).toContain('rcaTimeout must be a positive number');
    });

    it('should reject zero groupingWindow', () => {
      const config = createValidConfig({ groupingWindow: 0 });
      const errors = validateConfig(config);
      expect(errors).toContain('groupingWindow must be a positive number');
    });

    it('should reject negative retentionDays', () => {
      const config = createValidConfig({ retentionDays: -5 });
      const errors = validateConfig(config);
      expect(errors).toContain('retentionDays must be a positive number');
    });

    it('should reject missing retryPolicy', () => {
      const config = createValidConfig();
      (config as any).retryPolicy = null;
      const errors = validateConfig(config);
      expect(errors).toContain('retryPolicy must be a non-null object');
    });

    it('should reject retryPolicy with negative maxRetries', () => {
      const config = createValidConfig({
        retryPolicy: { maxRetries: -1, initialDelay: 5, backoffMultiplier: 2 },
      });
      const errors = validateConfig(config);
      expect(errors).toContain('retryPolicy.maxRetries must be a non-negative number');
    });

    it('should reject retryPolicy with zero initialDelay', () => {
      const config = createValidConfig({
        retryPolicy: { maxRetries: 3, initialDelay: 0, backoffMultiplier: 2 },
      });
      const errors = validateConfig(config);
      expect(errors).toContain('retryPolicy.initialDelay must be a positive number');
    });

    it('should reject config with missing version', () => {
      const config = createValidConfig();
      (config as any).version = '';
      const errors = validateConfig(config);
      expect(errors).toContain('version must be a non-empty string');
    });
  });
});
