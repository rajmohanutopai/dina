/**
 * T2D.3 — CeramicVault: optional AT Protocol decentralized storage.
 *
 * Disabled by default. When enabled (URL configured), provides
 * publish-to-PDS functionality. In-memory implementation.
 *
 * Source: tests/test_vault.py
 */

/** Minimal CeramicVault — optional decentralized storage. */
class CeramicVault {
  private readonly url?: string;
  private _connected = false;
  private _syncedCount = 0;

  constructor(url?: string) {
    this.url = url;
  }

  get enabled(): boolean {
    return !!this.url;
  }
  get connected(): boolean {
    return this._connected;
  }
  get syncedCount(): number {
    return this._syncedCount;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.enabled) return false;
    this._connected = true;
    return true;
  }

  async publish(content: unknown): Promise<string | null> {
    if (!this.enabled || !this._connected) return null;
    this._syncedCount++;
    return `ceramic://${Date.now()}`;
  }

  disconnect(): void {
    this._connected = false;
  }

  status(): string[] {
    if (!this.enabled) return ['CeramicVault: disabled (no URL)'];
    if (!this._connected)
      return [`CeramicVault: disconnected (${this.url})`, `synced: ${this._syncedCount}`];
    return [`CeramicVault: connected (${this.url})`, `synced: ${this._syncedCount}`];
  }
}

describe('CeramicVault', () => {
  describe('disabled behavior', () => {
    it('disabled when no URL configured', () => {
      expect(new CeramicVault().enabled).toBe(false);
    });

    it('publish returns null when disabled', async () => {
      expect(await new CeramicVault().publish({ test: true })).toBeNull();
    });

    it('synced count is 0 when disabled', () => {
      expect(new CeramicVault().syncedCount).toBe(0);
    });

    it('connected is false when disabled', () => {
      expect(new CeramicVault().connected).toBe(false);
    });

    it('health check returns false when disabled', async () => {
      expect(await new CeramicVault().healthCheck()).toBe(false);
    });
  });

  describe('enabled behavior', () => {
    it('enabled when URL is configured', () => {
      expect(new CeramicVault('http://ceramic:7007').enabled).toBe(true);
    });

    it('health check success sets connected', async () => {
      const vault = new CeramicVault('http://ceramic:7007');
      await vault.healthCheck();
      expect(vault.connected).toBe(true);
    });

    it('disconnect clears connected', async () => {
      const vault = new CeramicVault('http://ceramic:7007');
      await vault.healthCheck();
      vault.disconnect();
      expect(vault.connected).toBe(false);
    });

    it('publish returns stream_id on success', async () => {
      const vault = new CeramicVault('http://ceramic:7007');
      await vault.healthCheck();
      const id = await vault.publish({ verdict: 'BUY' });
      expect(id).toMatch(/^ceramic:\/\//);
    });

    it('publish increments synced count', async () => {
      const vault = new CeramicVault('http://ceramic:7007');
      await vault.healthCheck();
      await vault.publish({ a: 1 });
      await vault.publish({ b: 2 });
      expect(vault.syncedCount).toBe(2);
    });

    it('publish returns null when disconnected', async () => {
      const vault = new CeramicVault('http://ceramic:7007');
      expect(await vault.publish({ x: 1 })).toBeNull();
    });

    it('synced count persists across publishes', async () => {
      const vault = new CeramicVault('http://ceramic:7007');
      await vault.healthCheck();
      await vault.publish({ v1: true });
      await vault.publish({ v2: true });
      expect(vault.syncedCount).toBe(2);
    });
  });

  describe('status', () => {
    it('disabled vault shows appropriate status', () => {
      expect(new CeramicVault().status()).toContain('CeramicVault: disabled (no URL)');
    });

    it('connected vault shows URL and synced count', async () => {
      const vault = new CeramicVault('http://ceramic:7007');
      await vault.healthCheck();
      expect(vault.status()[0]).toContain('connected');
    });

    it('disconnected vault shows disconnected status', () => {
      const vault = new CeramicVault('http://ceramic:7007');
      expect(vault.status()[0]).toContain('disconnected');
    });
  });
});
