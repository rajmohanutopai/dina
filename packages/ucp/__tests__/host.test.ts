/**
 * The profile host's rules (UCP plan §3.5), at the state-machine level: every
 * host scenario the plan names, with real Ed25519-signed envelopes and real
 * profile documents.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  applyPublication,
  catchUpFromLog,
  envelopeDigest,
  publicState,
  readHostLogRecord,
  readLabelState,
  type HostLogRecord,
  type HostOutcome,
  type LabelState,
} from '../src/host';
import { es256PublicJwk } from '../src/jwk';
import { buyerProfileBytes } from '../src/profile';
import {
  documentHash,
  labelFromBytes,
  signPublication,
  type PublicationEnvelope,
  type PublicationFields,
  type PublishedKey,
} from '../src/publication';

const LABEL = labelFromBytes(new Uint8Array(16).fill(0x42));
const DID_A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const DID_B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const INSTANCE_1 = '11111111-1111-4111-8111-111111111111';
const INSTANCE_2 = '22222222-2222-4222-8222-222222222222';
const signer = (seed: number) => (m: Uint8Array) => ed25519.sign(m, new Uint8Array(32).fill(seed));

/** A UCP key per generation, and the profile bytes listing a set of them. */
const jwkFor = (generation: number) =>
  es256PublicJwk(p256.getPublicKey(new Uint8Array(32).fill(generation + 1), false), sha256);
const profileWith = (
  generations: number[],
  webhook = 'https://x.ucp.dinakernel.com/webhooks/orders',
) => buyerProfileBytes({ keys: generations.map(jwkFor), webhookUrl: webhook });
const key = (generation: number, phase: PublishedKey['phase'] = 'active'): PublishedKey => ({
  thumbprint: jwkFor(generation).kid,
  generation,
  phase,
  ...(phase === 'retiring' ? { retire_after: 2_000_000_000_000 } : {}),
  ...(phase === 'staged' ? { not_before: 2_000_000_000_000 } : {}),
});

interface Sent {
  env: PublicationEnvelope;
  bytes?: string;
}

async function envelope(
  op: PublicationEnvelope['op'],
  revision: number,
  over: Partial<PublicationFields> & { profile?: string; keys?: PublishedKey[]; did?: string } = {},
  seed = 7,
): Promise<Sent> {
  const base = {
    did: over.did ?? DID_A,
    label: LABEL,
    epoch: over.epoch ?? 1,
    instance: over.instance ?? INSTANCE_1,
    revision,
    issued_at: over.issued_at ?? 1_759_000_000_000,
  };
  if (op === 'upload') {
    const bytes = over.profile ?? profileWith([0]);
    const env = await signPublication(
      {
        ...base,
        op,
        documents: { '2026-08-25': documentHash(bytes, sha256) },
        keys: over.keys ?? [key(0)],
      },
      signer(seed),
    );
    return { env, bytes };
  }
  if (op === 'retire')
    return { env: await signPublication({ ...base, op, retire: over.retire ?? [] }, signer(seed)) };
  return { env: await signPublication({ ...base, op }, signer(seed)) };
}

function apply(state: LabelState | null, sent: Sent): HostOutcome {
  return applyPublication(state, sent.env, envelopeDigest(sent.env, sha256), sent.bytes, sha256);
}

function applied(outcome: HostOutcome): LabelState {
  if (outcome.kind !== 'applied')
    throw new Error(`expected applied, got ${JSON.stringify(outcome).slice(0, 120)}`);
  return outcome.state;
}

describe('label ownership', () => {
  it('the first valid upload binds the label; nothing else can start it', async () => {
    expect(apply(null, await envelope('pause', 1))).toMatchObject({
      kind: 'refused',
      reason: 'not_bound',
    });
    expect(apply(null, await envelope('upload', 2))).toMatchObject({
      kind: 'refused',
      reason: 'not_bound',
    });
    const s = applied(apply(null, await envelope('upload', 1)));
    expect(s).toMatchObject({ did: DID_A, revision: 1, serving: true });
  });

  it('another DID is refused whatever its revision, including two claims at the same moment', async () => {
    const first = await envelope('upload', 1);
    const second = await envelope('upload', 1, { did: DID_B }, 9);
    const s = applied(apply(null, first));
    // The second claim was made against the same empty state; the host applies them in turn.
    expect(apply(s, second)).toMatchObject({ kind: 'refused', reason: 'label_owned' });
    expect(apply(s, await envelope('upload', 2, { did: DID_B }, 9))).toMatchObject({
      kind: 'refused',
      reason: 'label_owned',
    });
  });
});

describe('revision compare-and-set', () => {
  it('a replay of an applied revision changes nothing; other bytes under it are refused', async () => {
    const one = await envelope('upload', 1);
    const s = applied(apply(null, one));
    expect(apply(s, one)).toEqual({ kind: 'replay', state: s });
    const other = await envelope('upload', 1, {
      profile: profileWith([0], 'https://y.ucp.dinakernel.com/webhooks/orders'),
    });
    expect(apply(s, other)).toMatchObject({ kind: 'refused', reason: 'stale_revision' });
    expect(apply(s, await envelope('upload', 3))).toMatchObject({
      kind: 'refused',
      reason: 'stale_revision',
    });
  });

  it('order is the revision alone: an upload from a clock a day ahead, then a corrected clock and a restore, applies at once', async () => {
    const DAY = 86_400_000;
    const { states, log } = await run([
      await envelope('upload', 1, { issued_at: 1_759_000_000_000 + DAY }),
      await envelope('upload', 2, { issued_at: 1_759_000_000_000 }),
    ]);
    // A host restored from before revision 2 catches up, and the next update (earlier clock still) applies.
    const restored = caughtUp(states[0] as LabelState, log) as LabelState;
    expect(
      apply(restored, await envelope('upload', 3, { issued_at: 1_759_000_000_000 + 1 })).kind,
    ).toBe('applied');
  });

  it('an upload prepared before a pause and delivered after it is refused; the label stays paused', async () => {
    let s = applied(apply(null, await envelope('upload', 1)));
    const prepared = await envelope('upload', 2, {
      profile: profileWith([0], 'https://z.ucp.dinakernel.com/webhooks/orders'),
    });
    s = applied(apply(s, await envelope('pause', 2)));
    expect(apply(s, prepared)).toMatchObject({ kind: 'refused', reason: 'stale_revision' });
    expect(s.serving).toBe(false);
  });

  it('a duplicate pause delivered after a resume has no effect', async () => {
    let s = applied(apply(null, await envelope('upload', 1)));
    const pause = await envelope('pause', 2);
    s = applied(apply(s, pause));
    s = applied(apply(s, await envelope('upload', 3)));
    expect(apply(s, pause)).toMatchObject({ kind: 'replay' });
    expect(s.serving).toBe(true);
  });
});

describe('pause and retire', () => {
  it('pause then resume with the same key serves again; the label stays bound', async () => {
    let s = applied(apply(null, await envelope('upload', 1)));
    s = applied(apply(s, await envelope('pause', 2)));
    expect(s).toMatchObject({ serving: false, did: DID_A, retired: [] });
    s = applied(apply(s, await envelope('upload', 3)));
    expect(s.serving).toBe(true);
  });

  it('retire then an upload listing that key is refused; the thumbprint stays retired', async () => {
    let s = applied(apply(null, await envelope('upload', 1)));
    const out = apply(s, await envelope('retire', 2, { retire: [key(0).thumbprint] }));
    s = applied(out);
    expect(out.kind === 'applied' && out.log.retired_added).toEqual([key(0).thumbprint]);
    expect(s.serving).toBe(false);
    expect(apply(s, await envelope('upload', 3))).toMatchObject({
      kind: 'refused',
      reason: 'retired_key',
    });
  });
});

describe('key generations', () => {
  it('generations 0 and 1, a changed webhook with both listed, then 0 retired by dropping it, then 0 again refused', async () => {
    let s = applied(apply(null, await envelope('upload', 1)));
    s = applied(
      apply(
        s,
        await envelope('upload', 2, {
          profile: profileWith([1, 0], 'https://w.ucp.dinakernel.com/webhooks/orders'),
          keys: [key(1), key(0, 'retiring')],
        }),
      ),
    );
    expect(s.highestGeneration).toBe(1);
    const dropped = apply(
      s,
      await envelope('upload', 3, { profile: profileWith([1]), keys: [key(1)] }),
    );
    expect(dropped.kind === 'applied' && dropped.log.retired_added).toEqual([key(0).thumbprint]);
    s = applied(dropped);
    expect(
      apply(
        s,
        await envelope('upload', 4, {
          profile: profileWith([1, 0]),
          keys: [key(1), key(0, 'retiring')],
        }),
      ),
    ).toMatchObject({ kind: 'refused', reason: 'retired_key' });
  });

  it('a known thumbprint keeps its generation; a new one must exceed every recorded one', async () => {
    const s = applied(
      apply(null, await envelope('upload', 1, { profile: profileWith([3]), keys: [key(3)] })),
    );
    // Generation 3's key relabelled as generation 4.
    expect(
      apply(
        s,
        await envelope('upload', 2, {
          profile: profileWith([3]),
          keys: [{ ...key(3), generation: 4 }],
        }),
      ),
    ).toMatchObject({ kind: 'refused', reason: 'generation' });
    // A new key below the highest.
    expect(
      apply(
        s,
        await envelope('upload', 2, {
          profile: profileWith([3, 2]),
          keys: [key(3), key(2, 'staged')],
        }),
      ),
    ).toMatchObject({ kind: 'refused', reason: 'generation' });
  });

  it('every listed thumbprint must be a key in the document', async () => {
    expect(
      apply(null, await envelope('upload', 1, { profile: profileWith([0]), keys: [key(5)] })),
    ).toMatchObject({
      kind: 'refused',
      reason: 'document_keys',
    });
  });
});

describe('publisher epoch', () => {
  it('two nodes from one seed: only the activated one may publish; the old one changes nothing', async () => {
    let s = applied(apply(null, await envelope('upload', 1)));
    // Node 2 is activated by the owner: a greater epoch, bound to its instance.
    s = applied(apply(s, await envelope('upload', 2, { epoch: 2, instance: INSTANCE_2 })));
    expect(s).toMatchObject({ epoch: 2, instance: INSTANCE_2 });
    // Node 1 uploads after the activation, and after node 2's pause.
    expect(apply(s, await envelope('upload', 3))).toMatchObject({
      kind: 'refused',
      reason: 'stale_epoch',
    });
    s = applied(apply(s, await envelope('pause', 3, { epoch: 2, instance: INSTANCE_2 })));
    expect(apply(s, await envelope('upload', 4))).toMatchObject({
      kind: 'refused',
      reason: 'stale_epoch',
    });
  });

  it('of two activations from one observed state only the winner may change publication afterwards', async () => {
    const s0 = applied(apply(null, await envelope('upload', 1)));
    const a = await envelope('upload', 2, { epoch: 2, instance: INSTANCE_1 });
    const b = await envelope('upload', 2, { epoch: 2, instance: INSTANCE_2 });
    const s1 = applied(apply(s0, a));
    expect(apply(s1, b)).toMatchObject({ kind: 'refused' });
    // The loser retries under the next revision: still the winner's epoch, another instance.
    expect(
      apply(s1, await envelope('upload', 3, { epoch: 2, instance: INSTANCE_2 })),
    ).toMatchObject({
      kind: 'refused',
      reason: 'other_instance',
    });
    // Including after the winner's own pause.
    const s2 = applied(apply(s1, await envelope('pause', 3, { epoch: 2, instance: INSTANCE_1 })));
    expect(
      apply(s2, await envelope('upload', 4, { epoch: 2, instance: INSTANCE_2 })),
    ).toMatchObject({
      kind: 'refused',
      reason: 'other_instance',
    });
  });
});

describe('the public state document', () => {
  it('carries each field and never the DID', async () => {
    let s = applied(apply(null, await envelope('upload', 1)));
    s = applied(apply(s, await envelope('pause', 2)));
    const doc = publicState(s);
    expect(doc).toEqual({
      revision: 2,
      epoch: 1,
      instance: INSTANCE_1,
      highest_generation: 0,
      keys: [{ thumbprint: key(0).thumbprint, generation: 0, phase: 'active' }],
      retired: [],
      serving: false,
    });
    expect(JSON.stringify(doc)).not.toContain('did:');
  });
});

/** Catch up, expecting a readable log. */
function caughtUp(state: LabelState | null, log: readonly HostLogRecord[]): LabelState | null {
  const out = catchUpFromLog(state, log);
  if (!out.ok) throw new Error(`log refused: ${out.reason}`);
  return out.state;
}

/** Apply a sequence, keeping every state and every log record. */
async function run(steps: Sent[]): Promise<{ states: LabelState[]; log: HostLogRecord[] }> {
  const states: LabelState[] = [];
  const log: HostLogRecord[] = [];
  let state: LabelState | null = null;
  for (const sent of steps) {
    const out = apply(state, sent);
    if (out.kind !== 'applied')
      throw new Error(`step refused: ${JSON.stringify(out).slice(0, 80)}`);
    state = out.state;
    states.push(out.state);
    log.push(out.log);
  }
  return { states, log };
}

describe('catching up from the off-host log (a restored host)', () => {
  it('a backup taken before a key change and a retirement comes back with both; serving waits for the node', async () => {
    const { states, log } = await run([
      await envelope('upload', 1),
      // Generation 1 arrives as staged beside the active generation 0.
      await envelope('upload', 2, {
        profile: profileWith([0, 1]),
        keys: [key(0), key(1, 'staged')],
      }),
      await envelope('upload', 3, {
        profile: profileWith([0, 1]),
        keys: [key(1), key(0, 'retiring')],
      }),
      await envelope('retire', 4, { retire: [key(0).thumbprint] }),
    ]);
    const backup = states[0] as LabelState;
    const restored = caughtUp(backup, log) as LabelState;
    expect(restored).toMatchObject({
      revision: 4,
      serving: false,
      documents: {},
      highestGeneration: 1,
    });
    expect(restored.retired).toEqual([key(0).thumbprint]);
    expect(restored.keys[key(1).thumbprint]).toEqual({ generation: 1, phase: 'active' });
    // The node uploads its current key again: accepted (the log carried its registration).
    const back = apply(
      restored,
      await envelope('upload', 5, { profile: profileWith([1]), keys: [key(1)] }),
    );
    expect(back.kind).toBe('applied');
    // The retired key is refused for ever.
    expect(
      apply(
        restored,
        await envelope('upload', 5, {
          profile: profileWith([0, 1]),
          keys: [key(1), key(0, 'retiring')],
        }),
      ),
    ).toMatchObject({ kind: 'refused', reason: 'retired_key' });
  });

  it('a lost registry row comes back bound to its DID: another DID cannot claim it', async () => {
    const { log } = await run([await envelope('upload', 1)]);
    const restored = caughtUp(null, log) as LabelState;
    expect(restored.did).toBe(DID_A);
    expect(apply(restored, await envelope('upload', 2, { did: DID_B }, 9))).toMatchObject({
      kind: 'refused',
      reason: 'label_owned',
    });
    expect(apply(null, await envelope('upload', 1, { did: DID_B }, 9)).kind).toBe('applied');
  });

  it('an up-to-date state is left alone; only newer records count', async () => {
    const { states, log } = await run([await envelope('upload', 1), await envelope('pause', 2)]);
    expect(caughtUp(states[1] as LabelState, log)).toBeNull();
    expect(caughtUp(states[0] as LabelState, log)).toMatchObject({ revision: 2 });
    expect(caughtUp(null, [])).toBeNull();
  });

  it('every log record survives the store as JSON and reads back exactly', async () => {
    const { log } = await run([
      await envelope('upload', 1, {
        profile: profileWith([0, 1]),
        keys: [key(1), key(0, 'retiring')],
      }),
      await envelope('retire', 2, { retire: [key(0).thumbprint] }),
    ]);
    for (const r of log) expect(readHostLogRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it('a record with a wrong or extra member does not read', async () => {
    const { log } = await run([await envelope('upload', 1)]);
    const good = JSON.parse(JSON.stringify(log[0])) as Record<string, unknown>;
    const bad: unknown[] = [
      null,
      [],
      { ...good, extra: 1 },
      { ...good, revision: 0 },
      { ...good, did: 'did:key:z6Mk' },
      { ...good, op: 'delete' },
      { ...good, envelope_digest: 'A'.repeat(64) },
      { ...good, highest_generation: -2 },
      { ...good, retired_added: ['short'] },
      { ...good, keys_set: { [key(0).thumbprint]: { generation: 0, phase: 'gone' } } },
      { ...good, keys_set: { [key(0).thumbprint]: { generation: 0, phase: 'active', extra: 1 } } },
      { ...good, keys_set: { bad: { generation: 0, phase: 'active' } } },
    ];
    for (const b of bad) expect(readHostLogRecord(b)).toBeNull();
    const { label: _drop, ...missing } = good;
    expect(readHostLogRecord(missing)).toBeNull();
    // did:web is a valid publisher too.
    expect(readHostLogRecord({ ...good, did: 'did:web:shop.example' })).not.toBeNull();
  });
});

describe('a stored label state read back', () => {
  it('every state the rules produce survives JSON and reads back exactly', async () => {
    const { states } = await run([
      await envelope('upload', 1, {
        profile: profileWith([0, 1]),
        keys: [key(1), key(0, 'retiring')],
      }),
      await envelope('retire', 2, { retire: [key(0).thumbprint] }),
      await envelope('upload', 3, { profile: profileWith([1]), keys: [key(1)] }),
      await envelope('pause', 4),
    ]);
    for (const s of states) expect(readLabelState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('a damaged state does not read', async () => {
    const { states } = await run([await envelope('upload', 1)]);
    const good = JSON.parse(JSON.stringify(states[0])) as Record<string, unknown>;
    for (const b of [
      { ...good, extra: true },
      { ...good, revision: 0 },
      { ...good, serving: 'yes' },
      { ...good, documents: { '2026-04-08': '{}' } },
      { ...good, applied: { '01': 'a'.repeat(64) } },
      { ...good, applied: { '1': 'short' } },
      { ...good, keys: { [key(0).thumbprint]: { generation: -1, phase: 'active' } } },
      { ...good, retired: [7] },
    ])
      expect(readLabelState(b)).toBeNull();
  });
});

describe('review fixes', () => {
  it('a document carrying a key the envelope leaves out is refused (a retired key cannot slip back in)', async () => {
    let s = applied(
      apply(
        null,
        await envelope('upload', 1, {
          profile: profileWith([0, 1]),
          keys: [key(1), key(0, 'retiring')],
        }),
      ),
    );
    s = applied(apply(s, await envelope('retire', 2, { retire: [key(0).thumbprint] })));
    // The envelope lists only generation 1; the document still holds the retired generation 0.
    expect(
      apply(s, await envelope('upload', 3, { profile: profileWith([0, 1]), keys: [key(1)] })),
    ).toMatchObject({
      kind: 'refused',
      reason: 'document_keys',
    });
    expect(
      apply(s, await envelope('upload', 3, { profile: profileWith([1]), keys: [key(1)] })).kind,
    ).toBe('applied');
  });

  it('after a catch-up, a replayed envelope is a replay, not a new claim', async () => {
    const steps = [await envelope('upload', 1), await envelope('pause', 2)];
    const { states, log } = await run(steps);
    const restored = caughtUp(states[0] as LabelState, log) as LabelState;
    expect(apply(restored, steps[1] as Sent).kind).toBe('replay');
  });

  it('a log that rebinds the label, skips a revision, or moves a counter back is refused', async () => {
    const { states, log } = await run([
      await envelope('upload', 1),
      await envelope('pause', 2),
      await envelope('pause', 3),
    ]);
    const base = states[0] as LabelState;
    const [, two, three] = log as [HostLogRecord, HostLogRecord, HostLogRecord];
    expect(catchUpFromLog(base, [{ ...two, did: DID_B }, three])).toEqual({
      ok: false,
      reason: 'other_did',
    });
    expect(catchUpFromLog(base, [three])).toEqual({ ok: false, reason: 'revision_gap' });
    expect(catchUpFromLog(base, [two, { ...three, epoch: 0 }])).toEqual({
      ok: false,
      reason: 'counter_back',
    });
    expect(catchUpFromLog(base, [two, { ...three, highest_generation: -1 }])).toEqual({
      ok: false,
      reason: 'counter_back',
    });
    // A repeated revision (an append whose database write failed, then retried) is one history.
    expect(catchUpFromLog(base, [two, two, three])).toMatchObject({
      ok: true,
      state: { revision: 3 },
    });
    // With no stored state, the first record must be revision 1.
    expect(catchUpFromLog(null, [two, three])).toEqual({ ok: false, reason: 'revision_gap' });
  });
});
