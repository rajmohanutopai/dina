/**
 * REAL_LIFE_FIXES §14.4 A — the node's presence writer.
 */

import { SERVICE_PRESENCE_COLLECTION, SERVICE_PROFILE_COLLECTION, validateServicePresenceRecord } from '@dina/protocol';

import { ServicePresenceWriter, type PresenceState } from '../src/service_presence';

const CID = (i: number) => `bafyrei${'a'.repeat(40)}${String.fromCharCode(97 + (i % 26))}`;

class FakeRepo {
  profiles: { rkey: string; cid: string }[] = [];
  presence: { cid: string; value: Record<string, unknown> } | null = null;
  writes = 0;
  private seq = 0;
  async listRecords(collection: string) {
    expect(collection).toBe(SERVICE_PROFILE_COLLECTION);
    return [...this.profiles];
  }
  async getRecord(collection: string) {
    expect(collection).toBe(SERVICE_PRESENCE_COLLECTION);
    return this.presence === null ? null : { cid: this.presence.cid };
  }
  async putRecord(_c: string, _r: string, value: Record<string, unknown>, opts: { swapRecord: string | null }) {
    if ((this.presence?.cid ?? null) !== opts.swapRecord) throw Object.assign(new Error('swap'), { casLost: true });
    this.writes += 1;
    this.presence = { cid: CID(++this.seq), value };
    return { cid: this.presence.cid };
  }
  async deleteRecord(_c: string, _r: string, opts: { swapRecord: string }) {
    if (this.presence?.cid !== opts.swapRecord) throw Object.assign(new Error('swap'), { xrpcError: 'InvalidSwap' });
    this.presence = null;
  }
}

function setup(opts: { inbound?: boolean; state?: PresenceState | null } = {}) {
  const repo = new FakeRepo();
  let state: PresenceState | null = opts.state ?? null;
  let now = 1_000_000;
  let inbound = opts.inbound ?? true;
  const writer = new ServicePresenceWriter({
    repo,
    store: { get: async () => state, set: async (s) => void (state = s) },
    inboundUp: () => inbound,
    randomBytes: (n) => new Uint8Array(n).fill(7),
    nowMs: () => now,
  });
  return {
    repo,
    writer,
    state: () => state,
    advance: (ms: number) => void (now += ms),
    setInbound: (v: boolean) => void (inbound = v),
  };
}

describe('the presence writer', () => {
  it('writes a valid record naming every published listing', async () => {
    const t = setup();
    t.repo.profiles = [{ rkey: 'self', cid: CID(1) }, { rkey: 'dentist', cid: CID(2) }];
    const out = await t.writer.nudge();
    expect(out).toMatchObject({ status: 'written', listings: 2, complete: true });
    expect(validateServicePresenceRecord(t.repo.presence?.value)).toBeNull();
    expect(t.repo.presence?.value.listings).toEqual(t.repo.profiles);
  });

  it('writes nothing while the node cannot receive queries, then writes on the next nudge', async () => {
    const t = setup({ inbound: false });
    t.repo.profiles = [{ rkey: 'self', cid: CID(1) }];
    expect(await t.writer.nudge()).toEqual({ status: 'waiting_inbound' });
    expect(t.repo.writes).toBe(0);
    t.setInbound(true);
    expect((await t.writer.nudge()).status).toBe('written');
  });

  it('a change made while offline is written on reconnect, even when no renewal is due', async () => {
    const t = setup();
    t.repo.profiles = [{ rkey: 'a', cid: CID(1) }];
    await t.writer.nudge();
    t.setInbound(false);
    t.repo.profiles = [{ rkey: 'a', cid: CID(1) }, { rkey: 'b', cid: CID(2) }];
    expect((await t.writer.nudge()).status).toBe('waiting_inbound');
    t.setInbound(true);
    expect((await t.writer.onInboundUp())?.status).toBe('written');
    expect((t.repo.presence?.value.listings as unknown[]).length).toBe(2);
    // With nothing waiting, a reconnect only renews when due.
    expect(await t.writer.onInboundUp()).toBeNull();
  });

  it('renews only when the last success is over 22 hours old', async () => {
    const t = setup();
    t.repo.profiles = [{ rkey: 'self', cid: CID(1) }];
    await t.writer.nudge();
    t.advance(21 * 3_600_000);
    expect(await t.writer.renewIfDue()).toBeNull();
    t.advance(2 * 3_600_000);
    expect((await t.writer.renewIfDue())?.status).toBe('written');
    expect(t.repo.writes).toBe(2);
  });

  it('a nudge during a run makes one more run that sees the latest listings', async () => {
    const t = setup();
    t.repo.profiles = [{ rkey: 'a', cid: CID(1) }];
    const first = t.writer.nudge();
    t.repo.profiles = [{ rkey: 'a', cid: CID(1) }, { rkey: 'b', cid: CID(2) }];
    void t.writer.nudge();
    await first;
    expect((t.repo.presence?.value.listings as unknown[]).length).toBe(2);
  });

  it('recovers when its stored CID is wrong (a crash after the write, or a restore)', async () => {
    const t = setup({ state: { lastOkAt: 0, cid: CID(99) } });
    t.repo.profiles = [{ rkey: 'self', cid: CID(1) }];
    t.repo.presence = { cid: CID(50), value: {} };
    expect((await t.writer.nudge()).status).toBe('written');
  });

  it('with no stored state it reads the record before writing', async () => {
    const t = setup({ state: null });
    t.repo.profiles = [{ rkey: 'self', cid: CID(1) }];
    t.repo.presence = { cid: CID(50), value: {} };
    expect((await t.writer.nudge()).status).toBe('written');
  });

  it('deletes presence when no listing is published', async () => {
    const t = setup();
    t.repo.profiles = [{ rkey: 'self', cid: CID(1) }];
    await t.writer.nudge();
    t.repo.profiles = [];
    expect(await t.writer.nudge()).toEqual({ status: 'deleted' });
    expect(t.repo.presence).toBeNull();
    expect(await t.writer.nudge()).toEqual({ status: 'none' });
  });

  it('over the listing limit it writes an incomplete, empty set', async () => {
    const t = setup();
    t.repo.profiles = Array.from({ length: 101 }, (_, i) => ({ rkey: `l${i}`, cid: CID(i) }));
    expect(await t.writer.nudge()).toMatchObject({ status: 'written', listings: 0, complete: false });
    expect(validateServicePresenceRecord(t.repo.presence?.value)).toBeNull();
  });

  it('a PDS failure is reported, and the next nudge tries again', async () => {
    const t = setup();
    t.repo.profiles = [{ rkey: 'self', cid: CID(1) }];
    const list = t.repo.listRecords.bind(t.repo);
    t.repo.listRecords = async () => {
      throw new Error('pds down');
    };
    expect(await t.writer.nudge()).toEqual({ status: 'failed', error: 'pds down' });
    t.repo.listRecords = list;
    expect((await t.writer.nudge()).status).toBe('written');
  });
});
