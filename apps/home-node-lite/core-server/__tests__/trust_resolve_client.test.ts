/**
 * Task 6.11 — trust resolve xRPC client tests.
 */

import {
  createTrustResolveClient,
  type TrustResolveFetchFn,
  type TrustResolveOutcome,
  type XrpcFetchResult,
} from '../src/appview/trust_resolve_client';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

function okBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    did: DID,
    scores: {
      weightedScore: 0.85,
      confidence: 0.9,
      totalAttestations: 10,
      positive: 8,
      negative: 2,
      verifiedAttestationCount: 5,
    },
    didProfile: {
      overallTrustScore: 0.8,
      vouchCount: 3,
      activeFlagCount: 0,
      tombstoneCount: 0,
    },
    flags: [{ flagType: 'spam', severity: 'warning' }],
    graphContext: {
      shortestPath: 2,
      trustedAttestors: ['did:plc:friend', 'did:plc:trusted'],
    },
    authenticity: { predominantAssessment: 'human', confidence: 0.95 },
    context: 'read',
    ...overrides,
  };
}

function stubFetch(body: Record<string, unknown> | null, status = 200): TrustResolveFetchFn {
  return async () => ({ body, status });
}

describe('createTrustResolveClient (task 6.11)', () => {
  describe('construction', () => {
    it('throws without fetchFn', () => {
      expect(() =>
        createTrustResolveClient({
          fetchFn: undefined as unknown as TrustResolveFetchFn,
        }),
      ).toThrow(/fetchFn/);
    });
  });

  describe('happy path', () => {
    it('parses a full response', async () => {
      const resolve = createTrustResolveClient({ fetchFn: stubFetch(okBody()) });
      const out = (await resolve({ did: DID, context: 'read' })) as Extract<
        TrustResolveOutcome,
        { ok: true }
      >;
      expect(out.ok).toBe(true);
      expect(out.response.did).toBe(DID);
      expect(out.response.scores?.weightedScore).toBe(0.85);
      expect(out.response.flags).toHaveLength(1);
      expect(out.response.graphContext?.shortestPath).toBe(2);
      expect(out.response.authenticity?.predominantAssessment).toBe('human');
    });

    it('supports did:web', async () => {
      const webDid = 'did:web:example.com';
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ ...okBody(), did: webDid }),
      });
      const out = await resolve({ did: webDid });
      expect(out.ok).toBe(true);
    });

    it('null scores / graphContext gracefully become null', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          did: DID,
          scores: null,
          graphContext: null,
          flags: [],
          authenticity: null,
          didProfile: null,
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.response.scores).toBeNull();
      expect(out.response.graphContext).toBeNull();
      expect(out.response.authenticity).toBeNull();
      expect(out.response.didProfile).toBeNull();
    });

    it('partial score fields: non-numeric → null', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          ...okBody(),
          scores: {
            weightedScore: 0.5,
            confidence: 'wrong' as unknown as number,
            totalAttestations: 'huh' as unknown as number,
          },
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.response.scores?.weightedScore).toBe(0.5);
      expect(out.response.scores?.confidence).toBeNull();
      expect(out.response.scores?.totalAttestations).toBeNull();
    });

    it('flags with invalid severity are skipped', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          ...okBody(),
          flags: [
            { flagType: 'spam', severity: 'warning' },
            { flagType: 'weird', severity: 'unknown-severity' },
            null,
            { flagType: 'real', severity: 'critical' },
          ],
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.response.flags).toHaveLength(2);
      expect(out.response.flags[0]!.severity).toBe('warning');
      expect(out.response.flags[1]!.flagType).toBe('real');
    });

    it('fires resolved event', async () => {
      type Ev = { kind: 'resolved'; did: string; hasScores: boolean };
      const events: Ev[] = [];
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch(okBody()),
        onEvent: (e) => {
          if (e.kind === 'resolved') events.push(e);
        },
      });
      await resolve({ did: DID });
      expect(events[0]!.did).toBe(DID);
      expect(events[0]!.hasScores).toBe(true);
    });
  });

  describe('rejections', () => {
    it('invalid did → ok:false, no fetch', async () => {
      let calls = 0;
      const resolve = createTrustResolveClient({
        fetchFn: async () => {
          calls++;
          return { body: okBody(), status: 200 };
        },
      });
      const out = await resolve({ did: 'did:bad:x' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_did');
      expect(calls).toBe(0);
    });

    it('404 → not_found', async () => {
      const resolve = createTrustResolveClient({ fetchFn: stubFetch(null, 404) });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('not_found');
    });

    it('null body on 200 → not_found', async () => {
      const resolve = createTrustResolveClient({ fetchFn: stubFetch(null, 200) });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('not_found');
    });

    it('5xx → rejected_by_appview', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ error: 'database down' }, 503),
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rejected_by_appview') {
        expect(out.status).toBe(503);
        expect(out.error).toMatch(/database down/);
      }
    });

    it('fetch throw → network_error', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: async () => {
          throw new Error('ENETDOWN');
        },
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'network_error') {
        expect(out.error).toMatch(/ENETDOWN/);
      }
    });

    it('body did mismatch → malformed_response', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ ...okBody(), did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' }),
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'malformed_response') {
        expect(out.detail).toMatch(/does not match requested/);
      }
    });

    it('missing did in body → malformed_response', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ scores: null }),
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });
  });

  // ── onEvent contract — rejection paths ─────────────────────────────
  // Every outcome (resolved + 5 rejection reasons) emits exactly one
  // event so observability dashboards can count rejections by reason.
  // The happy path's `resolved` event is already covered above. These
  // tests pin every rejection reason — a future refactor that dropped
  // `onEvent?.(...)` from any branch would silently break the
  // dashboards without breaking any existing test.

  describe('onEvent — rejection paths', () => {
    function captureEvents(): {
      events: { kind: string; did: string; reason?: string }[];
      onEvent: (e: { kind: string; did: string; reason?: string }) => void;
    } {
      const events: { kind: string; did: string; reason?: string }[] = [];
      return {
        events,
        onEvent: (e) => events.push(e),
      };
    }

    it('invalid_did emits {kind:"rejected", reason:"invalid_did"}', async () => {
      const { events, onEvent } = captureEvents();
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch(okBody()),
        onEvent: onEvent as Parameters<typeof createTrustResolveClient>[0]['onEvent'],
      });
      await resolve({ did: 'did:bad:x' });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'rejected',
        did: 'did:bad:x',
        reason: 'invalid_did',
      });
    });

    it('not_found (404) emits {kind:"rejected", reason:"not_found"}', async () => {
      const { events, onEvent } = captureEvents();
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch(null, 404),
        onEvent: onEvent as Parameters<typeof createTrustResolveClient>[0]['onEvent'],
      });
      await resolve({ did: DID });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'rejected',
        did: DID,
        reason: 'not_found',
      });
    });

    it('not_found (null body on 200) emits {kind:"rejected", reason:"not_found"}', async () => {
      // Same outcome class as 404 — null body on 200 is the
      // "no data" path. Both rejection events should look identical.
      const { events, onEvent } = captureEvents();
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch(null, 200),
        onEvent: onEvent as Parameters<typeof createTrustResolveClient>[0]['onEvent'],
      });
      await resolve({ did: DID });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('not_found');
    });

    it('malformed_response emits {kind:"rejected", reason:"malformed_response"}', async () => {
      const { events, onEvent } = captureEvents();
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          ...okBody(),
          did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz',
        }),
        onEvent: onEvent as Parameters<typeof createTrustResolveClient>[0]['onEvent'],
      });
      await resolve({ did: DID });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('malformed_response');
    });

    it('network_error (fetcher throw) emits {kind:"rejected", reason:"network_error"}', async () => {
      const { events, onEvent } = captureEvents();
      const resolve = createTrustResolveClient({
        fetchFn: async () => {
          throw new Error('ENETDOWN');
        },
        onEvent: onEvent as Parameters<typeof createTrustResolveClient>[0]['onEvent'],
      });
      await resolve({ did: DID });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('network_error');
    });

    it('rejected_by_appview (5xx) emits {kind:"rejected", reason:"rejected_by_appview"}', async () => {
      const { events, onEvent } = captureEvents();
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ error: 'database down' }, 503),
        onEvent: onEvent as Parameters<typeof createTrustResolveClient>[0]['onEvent'],
      });
      await resolve({ did: DID });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('rejected_by_appview');
    });

    it('exactly ONE event per call (no duplicate emission)', async () => {
      // Defends against a future refactor that emits both a
      // pre-rejection event AND a final outcome event — every call
      // must emit exactly one event regardless of which path runs.
      const { events, onEvent } = captureEvents();
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch(okBody()),
        onEvent: onEvent as Parameters<typeof createTrustResolveClient>[0]['onEvent'],
      });
      await resolve({ did: DID });
      await resolve({ did: 'did:bad:x' });
      await resolve({ did: DID });
      // 3 calls → 3 events. If any branch double-emits, this would fail.
      expect(events).toHaveLength(3);
    });
  });

  // ── HTTP status routing — 4xx range ────────────────────────────────
  // Existing tests cover 404 → not_found and 503 → rejected_by_appview.
  // The classifier rule is `< 200 || >= 300` for non-success, so all
  // 4xx-other-than-404 also land in rejected_by_appview, including
  // 400 (bad request — typically a malformed query), 401 (unauth),
  // 403 (forbidden — token revoked), 422 (validation). Pinning each
  // so a future refactor that special-cased one 4xx code (e.g. 401
  // routed to `network_error` to trigger re-auth flow) would fail
  // here rather than silently changing the rejection-reason taxonomy.

  describe('HTTP status routing — 4xx-non-404', () => {
    it.each([400, 401, 403, 405, 409, 410, 422, 429])(
      'status=%s → rejected_by_appview',
      async (status) => {
        const resolve = createTrustResolveClient({
          fetchFn: stubFetch({ error: 'rejected' }, status),
        });
        const out = await resolve({ did: DID });
        expect(out.ok).toBe(false);
        if (!out.ok) {
          expect(out.reason).toBe('rejected_by_appview');
          if (out.reason === 'rejected_by_appview') {
            expect(out.status).toBe(status);
          }
        }
      },
    );

    it('body without `error` field falls back to "status N" message', async () => {
      // The status-code branch reads body.error as a string; if
      // missing/non-string it falls back to `status N`. Pinning the
      // fallback so a future refactor that changed the field name
      // (e.g. `message` instead of `error`) would surface the change
      // explicitly rather than silently dropping the AppView-side
      // explanation.
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ message: 'database down' }, 502),
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rejected_by_appview') {
        expect(out.error).toBe('status 502');
      }
    });

    it('body where `error` is non-string falls back to "status N" message', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ error: { code: 'X' } }, 500),
      });
      const out = await resolve({ did: DID });
      if (out.ok === false && out.reason === 'rejected_by_appview') {
        expect(out.error).toBe('status 500');
      }
    });
  });

  // ── parseFlags entry-level type guards ────────────────────────────────
  // The existing 'flags with invalid severity are skipped' test pins
  // ONE rejection path. The helper has additional guards that the wire
  // contract relies on but no tests exercise. AppView could plausibly
  // ship malformed flag entries during a schema migration (e.g.
  // `flagType` accidentally serialised as a number, or a transient
  // pre-zod handler that lets `''` through). The contract is "skip
  // and continue, never throw, never poison the outer parse". A future
  // refactor that turned a `continue` into a `throw` would silently
  // brick every resolve call that hits that branch — pin the contract.

  describe('parseFlags — entry-level guards (TN-API-003 wire safety)', () => {
    async function resolveFlags(flags: unknown): Promise<readonly { flagType: string; severity: string }[]> {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ ...okBody(), flags }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      return out.response.flags;
    }

    it('non-array `flags` → empty list (no throw)', async () => {
      // Wire contract: missing-or-malformed flags surface as the empty
      // list, which downstream code treats as "no open flags". Throwing
      // here would kill the whole resolve outcome over a non-essential
      // sub-field.
      expect(await resolveFlags(null)).toEqual([]);
      expect(await resolveFlags(undefined)).toEqual([]);
      expect(await resolveFlags('not-an-array' as unknown)).toEqual([]);
      expect(await resolveFlags({ a: 1 } as unknown)).toEqual([]);
      expect(await resolveFlags(42 as unknown)).toEqual([]);
    });

    it('entry with non-string `flagType` is skipped', async () => {
      const flags = await resolveFlags([
        { flagType: 42, severity: 'warning' }, // number — skip
        { flagType: null, severity: 'critical' }, // null — skip
        { flagType: 'real', severity: 'info' }, // valid — keep
      ]);
      expect(flags).toHaveLength(1);
      expect(flags[0]?.flagType).toBe('real');
    });

    it('entry with empty-string `flagType` is skipped', async () => {
      // An empty flagType is meaningless — admin UI groups by flagType
      // so an empty string would create an unlabelled bucket. The
      // helper rejects it explicitly (`flagType === ''`).
      const flags = await resolveFlags([
        { flagType: '', severity: 'warning' },
        { flagType: 'real', severity: 'critical' },
      ]);
      expect(flags).toHaveLength(1);
      expect(flags[0]?.flagType).toBe('real');
    });

    it('entry with missing severity is skipped (severity must be in VALID_SEVERITIES)', async () => {
      // Severity defaults to undefined when omitted. `VALID_SEVERITIES`
      // is a closed Set — undefined is not a member, so the entry
      // drops cleanly.
      const flags = await resolveFlags([
        { flagType: 'spam' }, // no severity — skip
        { flagType: 'real', severity: 'critical' },
      ]);
      expect(flags).toHaveLength(1);
      expect(flags[0]?.flagType).toBe('real');
    });

    it('null/non-object entries inside the array are skipped', async () => {
      const flags = await resolveFlags([
        null,
        undefined,
        'string-entry',
        42,
        { flagType: 'real', severity: 'serious' },
      ]);
      expect(flags).toHaveLength(1);
      expect(flags[0]?.flagType).toBe('real');
    });

    it('extra fields on a valid entry are stripped (only flagType + severity surface)', async () => {
      // The output shape is `{ flagType, severity }` — defence against
      // AppView accidentally leaking internal fields (e.g. raw
      // operator-comment text, internal IDs) downstream into UI/admin
      // surfaces. The mapper picks fields explicitly rather than
      // spreading the entry, so any addition to the wire surface
      // requires a deliberate code change.
      const flags = await resolveFlags([
        {
          flagType: 'spam',
          severity: 'warning',
          operatorNote: 'private-internal-comment',
          rawScore: 0.42,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ]);
      // `toEqual` is structural-exact — extra fields surface as a diff,
      // so this also verifies operatorNote/rawScore/createdAt did NOT
      // leak through into the parsed output.
      expect(flags).toEqual([{ flagType: 'spam', severity: 'warning' }]);
    });

    it('all four valid severities round-trip (closed enum)', async () => {
      // Pin the closed enum: critical, serious, warning, info. A
      // refactor that added/removed a level would surface as a diff
      // here. Counter-test for the existing 'invalid severity' test —
      // proves the Set has the right members, not just that it rejects
      // outliers.
      const flags = await resolveFlags([
        { flagType: 'a', severity: 'critical' },
        { flagType: 'b', severity: 'serious' },
        { flagType: 'c', severity: 'warning' },
        { flagType: 'd', severity: 'info' },
      ]);
      expect(flags).toHaveLength(4);
      expect(flags.map((f) => f.severity)).toEqual([
        'critical',
        'serious',
        'warning',
        'info',
      ]);
    });
  });

  // ── parseAuthenticity + numeric-shape guards ──────────────────────────
  // `parseAuthenticity` returns `null` (not a partial object) when the
  // assessment field is missing/empty/non-string — the field is the
  // primary discriminator for the TN-AUTH-001 surface, so a partial
  // record with no assessment would mislead consumers. Likewise
  // `integerOrNull` (used for shortestPath, vouchCount, etc.) must
  // reject non-integer numbers — the AppView wire contract pins integers
  // for these fields and a non-integer would confuse counters/badges.

  describe('parseAuthenticity — null-on-missing-assessment', () => {
    async function resolveAuth(authenticity: unknown): Promise<unknown> {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ ...okBody(), authenticity }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      return out.response.authenticity;
    }

    it('non-object authenticity → null (not partial)', async () => {
      expect(await resolveAuth(null)).toBeNull();
      expect(await resolveAuth(undefined)).toBeNull();
      expect(await resolveAuth('human' as unknown)).toBeNull();
      expect(await resolveAuth(42 as unknown)).toBeNull();
      expect(await resolveAuth([] as unknown)).toBeNull();
    });

    it('missing predominantAssessment → null', async () => {
      // The whole authenticity record drops, NOT a partial with
      // assessment='' and confidence kept. Consumers branch on
      // `authenticity === null` to decide whether to render the
      // assessment badge at all.
      expect(await resolveAuth({ confidence: 0.95 })).toBeNull();
    });

    it('empty-string predominantAssessment → null', async () => {
      expect(await resolveAuth({ predominantAssessment: '', confidence: 0.95 })).toBeNull();
    });

    it('non-string predominantAssessment → null', async () => {
      // Wire contract: `predominantAssessment` is a string label
      // (e.g. "human", "ai-generated"). A number/boolean/null leaking
      // through would confuse the UI which renders the label as text.
      expect(await resolveAuth({ predominantAssessment: 42 as unknown, confidence: 0.5 })).toBeNull();
      expect(await resolveAuth({ predominantAssessment: null, confidence: 0.5 })).toBeNull();
      expect(await resolveAuth({ predominantAssessment: true as unknown, confidence: 0.5 })).toBeNull();
    });

    it('valid assessment with non-numeric confidence → confidence becomes null (not record-null)', async () => {
      // Counter-pin: if assessment is valid but confidence is
      // malformed, the record DOES surface (with confidence=null),
      // not null wholesale. The assessment is the discriminator;
      // confidence is auxiliary.
      const auth = (await resolveAuth({
        predominantAssessment: 'human',
        confidence: 'high' as unknown,
      })) as { predominantAssessment: string; confidence: number | null };
      expect(auth).not.toBeNull();
      expect(auth.predominantAssessment).toBe('human');
      expect(auth.confidence).toBeNull();
    });
  });

  describe('integer vs number wire-shape pinning (parseScores + parseGraph + parseDidProfile)', () => {
    // `numberOrNull` accepts any finite number (e.g. weightedScore=0.85);
    // `integerOrNull` rejects non-integers (e.g. shortestPath=2.5).
    // The wire contract uses integer fields for counts and graph
    // distance — a 2.5 in shortestPath would confuse "is this 2 or 3
    // hops away" UI logic.

    it('non-integer in integer field → null (counts + path distance)', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          ...okBody(),
          scores: {
            weightedScore: 0.85,
            confidence: 0.9,
            // All these MUST be integers per the AppView contract:
            totalAttestations: 10.5,
            positive: 8.2,
            negative: 2.7,
            verifiedAttestationCount: 5.5,
          },
          didProfile: {
            overallTrustScore: 0.8,
            vouchCount: 3.5,
            activeFlagCount: 0.1,
            tombstoneCount: 0.9,
          },
          graphContext: {
            shortestPath: 2.5,
            trustedAttestors: ['did:plc:friend'],
          },
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.response.scores?.totalAttestations).toBeNull();
      expect(out.response.scores?.positive).toBeNull();
      expect(out.response.scores?.negative).toBeNull();
      expect(out.response.scores?.verifiedAttestationCount).toBeNull();
      expect(out.response.didProfile?.vouchCount).toBeNull();
      expect(out.response.didProfile?.activeFlagCount).toBeNull();
      expect(out.response.didProfile?.tombstoneCount).toBeNull();
      expect(out.response.graphContext?.shortestPath).toBeNull();
      // Counter-pin: float fields (weightedScore, overallTrustScore)
      // are unaffected — they go through numberOrNull.
      expect(out.response.scores?.weightedScore).toBe(0.85);
      expect(out.response.didProfile?.overallTrustScore).toBe(0.8);
    });

    it.each([
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('non-finite %s in numeric field → null', async (_label, value) => {
      // Both numberOrNull and integerOrNull reject non-finite numbers
      // via Number.isFinite. NaN/Infinity in a count or score would
      // cascade into NaN-tainted UI displays — must be null instead.
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          ...okBody(),
          scores: {
            weightedScore: value,
            confidence: value,
            totalAttestations: value,
            positive: 0,
            negative: 0,
            verifiedAttestationCount: 0,
          },
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.response.scores?.weightedScore).toBeNull();
      expect(out.response.scores?.confidence).toBeNull();
      expect(out.response.scores?.totalAttestations).toBeNull();
    });

    it('zero is a valid integer (boundary — must NOT be confused with null)', async () => {
      // Defence against a future refactor that wrote `if (!v)` instead
      // of `typeof v === 'number'` — that bug would map 0 → null.
      // Counts of 0 are meaningful ("no flags", "no vouches") and
      // must surface distinctly from "field missing".
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          ...okBody(),
          scores: {
            weightedScore: 0,
            confidence: 0,
            totalAttestations: 0,
            positive: 0,
            negative: 0,
            verifiedAttestationCount: 0,
          },
          didProfile: {
            overallTrustScore: 0,
            vouchCount: 0,
            activeFlagCount: 0,
            tombstoneCount: 0,
          },
          graphContext: { shortestPath: 0, trustedAttestors: [] },
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.response.scores?.weightedScore).toBe(0);
      expect(out.response.scores?.totalAttestations).toBe(0);
      expect(out.response.didProfile?.vouchCount).toBe(0);
      expect(out.response.graphContext?.shortestPath).toBe(0);
    });
  });
});
