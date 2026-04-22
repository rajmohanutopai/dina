/**
 * T2.90 + T2.91 — Platform service: Android Foreground Service + iOS JS Context.
 *
 * Source: ARCHITECTURE.md Tasks 2.90, 2.91
 */

import {
  startService,
  stopService,
  checkServiceHealth,
  getServiceStatus,
  verifyProcessIsolation,
  getDefaultConfig,
  setServiceBridge,
  setHealthChecker,
  resetPlatformService,
  type NativeServiceBridge,
  type ServiceConfig,
} from '../../src/process/platform_service';

function mockBridge(opts?: { failStart?: boolean; running?: boolean }): NativeServiceBridge {
  return {
    startService: async () => {
      if (opts?.failStart) throw new Error('Service start failed');
      return 12345;
    },
    stopService: async () => {},
    isServiceRunning: async () => opts?.running ?? true,
    getServicePID: async () => (opts?.running === false ? null : 12345),
  };
}

const androidConfig: ServiceConfig = getDefaultConfig('android');
const iosConfig: ServiceConfig = getDefaultConfig('ios');

describe('Platform Service (2.90 + 2.91)', () => {
  beforeEach(() => resetPlatformService());

  describe('startService', () => {
    it('starts successfully with bridge', async () => {
      setServiceBridge(mockBridge());

      const status = await startService(androidConfig);

      expect(status.state).toBe('running');
      expect(status.pid).toBe(12345);
      expect(status.platform).toBe('android');
      expect(status.uptime).toBeGreaterThanOrEqual(0);
    });

    it('fails without bridge', async () => {
      const status = await startService(androidConfig);

      expect(status.state).toBe('error');
      expect(status.error).toContain('not configured');
    });

    it('handles native start failure', async () => {
      setServiceBridge(mockBridge({ failStart: true }));

      const status = await startService(androidConfig);

      expect(status.state).toBe('error');
      expect(status.error).toContain('start failed');
      expect(status.pid).toBeNull();
    });

    it('verifies health after start', async () => {
      setServiceBridge(mockBridge());
      setHealthChecker(async () => true);

      const status = await startService(androidConfig);
      expect(status.state).toBe('running');
    });

    it('detects unreachable core after start', async () => {
      setServiceBridge(mockBridge());
      setHealthChecker(async () => false);

      const status = await startService(androidConfig);
      expect(status.state).toBe('error');
      expect(status.error).toContain('not reachable');
    });

    it('is idempotent when already running', async () => {
      setServiceBridge(mockBridge());
      await startService(androidConfig);

      const status = await startService(androidConfig);
      expect(status.state).toBe('running');
    });
  });

  describe('stopService', () => {
    it('stops a running service', async () => {
      setServiceBridge(mockBridge());
      await startService(androidConfig);

      const status = await stopService();
      expect(status.state).toBe('stopped');
      expect(status.pid).toBeNull();
      expect(status.uptime).toBeNull();
    });

    it('is idempotent when already stopped', async () => {
      const status = await stopService();
      expect(status.state).toBe('stopped');
    });
  });

  describe('checkServiceHealth', () => {
    it('returns true when running and healthy', async () => {
      setServiceBridge(mockBridge());
      setHealthChecker(async () => true);
      await startService(androidConfig);

      expect(await checkServiceHealth()).toBe(true);
    });

    it('detects stopped service', async () => {
      setServiceBridge(mockBridge({ running: false }));
      await startService(androidConfig);

      // Bridge says not running
      resetPlatformService();
      setServiceBridge(mockBridge({ running: false }));

      expect(await checkServiceHealth()).toBe(false);
    });

    it('returns running state when no checker', async () => {
      setServiceBridge(mockBridge());
      await startService(androidConfig);

      expect(await checkServiceHealth()).toBe(true);
    });
  });

  describe('getDefaultConfig', () => {
    it('Android config enables notification', () => {
      const cfg = getDefaultConfig('android');
      expect(cfg.platform).toBe('android');
      expect(cfg.showNotification).toBe(true);
      expect(cfg.notificationTitle).toBe('Dina Core');
    });

    it('iOS config disables notification', () => {
      const cfg = getDefaultConfig('ios');
      expect(cfg.platform).toBe('ios');
      expect(cfg.showNotification).toBe(false);
    });

    it('uses default port 8100', () => {
      expect(getDefaultConfig('android').corePort).toBe(8100);
    });

    it('accepts custom port', () => {
      expect(getDefaultConfig('android', 9100).corePort).toBe(9100);
    });
  });

  describe('verifyProcessIsolation', () => {
    it('confirms Android :core process isolation', async () => {
      setServiceBridge(mockBridge());
      await startService(androidConfig);

      const result = verifyProcessIsolation();
      expect(result.isolated).toBe(true);
      expect(result.reason).toContain('V8 isolation');
    });

    it('confirms iOS JSContext isolation', async () => {
      setServiceBridge(mockBridge());
      await startService(iosConfig);

      const result = verifyProcessIsolation();
      expect(result.isolated).toBe(true);
      expect(result.reason).toContain('JSContext');
    });

    it('reports not isolated when unconfigured', () => {
      const result = verifyProcessIsolation();
      expect(result.isolated).toBe(false);
    });
  });

  describe('getServiceStatus', () => {
    it('returns full status object', async () => {
      setServiceBridge(mockBridge());
      await startService(androidConfig);

      const status = getServiceStatus();
      expect(status.state).toBe('running');
      expect(status.platform).toBe('android');
      expect(status.pid).toBe(12345);
      expect(status.coreReachable).toBe(true);
    });

    it('returns unknown platform before config', () => {
      expect(getServiceStatus().platform).toBe('unknown');
    });
  });
});
