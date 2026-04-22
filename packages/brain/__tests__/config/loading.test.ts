/**
 * T2B.13 — Brain configuration loading.
 *
 * Source: brain/tests/test_config.py
 */

import { loadBrainConfig, validateBrainConfig } from '../../src/config/loading';

describe('Brain Configuration', () => {
  describe('loadBrainConfig', () => {
    it('loads with defaults when no env vars', () => {
      const config = loadBrainConfig({});
      expect(config.coreURL).toBe('http://localhost:8100');
      expect(config.listenPort).toBe(8200);
      expect(config.serviceKeyDir).toBe('./service_keys');
      expect(config.logLevel).toBe('info');
      expect(config.llmURL).toBeUndefined();
      expect(config.appviewURL).toBeUndefined();
      expect(config.pdsURL).toBeUndefined();
      expect(config.plcURL).toBe('https://plc.directory');
      expect(config.pdsHandle).toBeUndefined();
      expect(config.pdsAdminPassword).toBeUndefined();
    });

    it('reads DINA_CORE_URL from env', () => {
      const config = loadBrainConfig({ DINA_CORE_URL: 'http://localhost:9100' });
      expect(config.coreURL).toBe('http://localhost:9100');
    });

    it('defaults core URL to http://localhost:8100', () => {
      expect(loadBrainConfig({}).coreURL).toBe('http://localhost:8100');
    });

    it('reads service key dir from env', () => {
      const config = loadBrainConfig({ DINA_SERVICE_KEY_DIR: '/custom/keys' });
      expect(config.serviceKeyDir).toBe('/custom/keys');
    });

    it('defaults listen port to 8200', () => {
      expect(loadBrainConfig({}).listenPort).toBe(8200);
    });

    it('defaults log level to info', () => {
      expect(loadBrainConfig({}).logLevel).toBe('info');
    });

    it('reads LLM URL from env (optional)', () => {
      const config = loadBrainConfig({ DINA_LLM_URL: 'http://localhost:11434' });
      expect(config.llmURL).toBe('http://localhost:11434');
    });

    it('handles missing LLM URL gracefully', () => {
      expect(loadBrainConfig({}).llmURL).toBeUndefined();
    });

    it('reads custom port from env', () => {
      const config = loadBrainConfig({ DINA_BRAIN_PORT: '9200' });
      expect(config.listenPort).toBe(9200);
    });

    it('reads the full test-infra envelope from env', () => {
      const config = loadBrainConfig({
        DINA_APPVIEW_URL: 'https://test-appview.dinakernel.com',
        DINA_PDS_URL: 'https://test-pds.dinakernel.com',
        DINA_PLC_URL: 'https://plc.directory',
        DINA_PDS_HANDLE: 'busdriver.test-pds.dinakernel.com',
        DINA_PDS_ADMIN_PASSWORD: 'hunter2',
      });
      expect(config.appviewURL).toBe('https://test-appview.dinakernel.com');
      expect(config.pdsURL).toBe('https://test-pds.dinakernel.com');
      expect(config.plcURL).toBe('https://plc.directory');
      expect(config.pdsHandle).toBe('busdriver.test-pds.dinakernel.com');
      expect(config.pdsAdminPassword).toBe('hunter2');
    });
  });

  describe('validateBrainConfig', () => {
    const validConfig = {
      coreURL: 'http://localhost:8100',
      listenPort: 8200,
      serviceKeyDir: '/keys',
      logLevel: 'info',
      plcURL: 'https://plc.directory',
    };

    it('accepts valid config', () => {
      expect(validateBrainConfig(validConfig)).toEqual([]);
    });

    it('rejects invalid core URL', () => {
      const errors = validateBrainConfig({ ...validConfig, coreURL: 'not-a-url' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('coreURL');
    });

    it('rejects empty service key dir', () => {
      const errors = validateBrainConfig({ ...validConfig, serviceKeyDir: '' });
      expect(errors.some((e) => e.includes('serviceKeyDir'))).toBe(true);
    });

    it('rejects invalid port', () => {
      const errors = validateBrainConfig({ ...validConfig, listenPort: 0 });
      expect(errors.some((e) => e.includes('listenPort'))).toBe(true);
    });

    it('accepts valid optional test-infra URLs', () => {
      const errors = validateBrainConfig({
        ...validConfig,
        appviewURL: 'https://test-appview.dinakernel.com',
        pdsURL: 'https://test-pds.dinakernel.com',
      });
      expect(errors).toEqual([]);
    });

    it('rejects malformed appviewURL', () => {
      const errors = validateBrainConfig({ ...validConfig, appviewURL: 'bad' });
      expect(errors.some((e) => e.includes('appviewURL'))).toBe(true);
    });

    it('rejects malformed pdsURL', () => {
      const errors = validateBrainConfig({ ...validConfig, pdsURL: 'bad' });
      expect(errors.some((e) => e.includes('pdsURL'))).toBe(true);
    });

    it('rejects empty plcURL', () => {
      const errors = validateBrainConfig({ ...validConfig, plcURL: '' });
      expect(errors.some((e) => e.includes('plcURL'))).toBe(true);
    });
  });
});
