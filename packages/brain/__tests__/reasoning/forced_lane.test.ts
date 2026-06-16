/**
 * Shared forced-lane enforcement (docs/COMPOSER_MODES_DESIGN.md 6.5-6.6).
 *
 * Pure-logic coverage for the module both ask paths share
 * (`makeAgenticAskHandler` and the production coordinator `buildAgenticExecuteFn`).
 * The end-to-end wiring is covered in ask_handler.test.ts and
 * ask_coordinator.test.ts; here we pin the gate's ABSENCE-vs-OUTAGE distinction
 * and the peerlens evidence rule that the P2a/b/c review findings turned on.
 */

import {
  NO_REVIEWS_ANSWER,
  NO_SERVICE_ANSWER,
  REVIEWS_LANE_TOOLS,
  REVIEWS_OUTAGE_ANSWER,
  SERVICES_LANE_TOOLS,
  SERVICES_OUTAGE_ANSWER,
  applyForcedLanePrompt,
  classifyPeerlensResult,
  enforceForcedLaneAnswer,
  formatForcedLaneBlock,
  isForcedLane,
  isPeerlensBacked,
  isReviewsLane,
  isServicesLane,
  scopeToolsForLane,
  type LaneToolCallView,
} from '../../src/reasoning/forced_lane';
import { ToolRegistry, type AgentTool } from '../../src/reasoning/tool_registry';

const ok = (name: string, result: unknown): LaneToolCallView => ({
  name,
  outcome: { success: true, result },
});
const fail = (name: string, error: string): LaneToolCallView => ({
  name,
  outcome: { success: false, error },
});

describe('lane predicates', () => {
  it('detect Services / Reviews / neither', () => {
    expect(isServicesLane(['provider_services'])).toBe(true);
    expect(isReviewsLane(['peerlens'])).toBe(true);
    expect(isServicesLane(['peerlens'])).toBe(false);
    expect(isForcedLane(undefined)).toBe(false);
    expect(isForcedLane(['vault'])).toBe(false);
    expect(isForcedLane(['provider_services'])).toBe(true);
  });
});

describe('formatForcedLaneBlock', () => {
  it('Services is imperative + carries the provider routing block', () => {
    const b = formatForcedLaneBlock(['provider_services']);
    expect(b).toMatch(/EXPLICIT MODE: Services/);
    expect(b).toMatch(/Provider-services routing/);
  });
  it('Reviews is the imperative PeerLens block', () => {
    expect(formatForcedLaneBlock(['peerlens'])).toMatch(/EXPLICIT MODE: Reviews/);
  });
  it('an unknown forced source returns empty (no crash)', () => {
    expect(formatForcedLaneBlock(['general_knowledge'])).toBe('');
  });
});

describe('applyForcedLanePrompt', () => {
  it('appends the lane block for a forced source', () => {
    const out = applyForcedLanePrompt('BASE', ['peerlens']);
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toMatch(/EXPLICIT MODE: Reviews/);
  });
  it('is a no-op for plain Ask', () => {
    expect(applyForcedLanePrompt('BASE', undefined)).toBe('BASE');
    expect(applyForcedLanePrompt('BASE', ['vault'])).toBe('BASE');
  });
});

describe('scopeToolsForLane', () => {
  function registryWith(names: string[]): ToolRegistry {
    const reg = new ToolRegistry();
    for (const name of names) {
      const t: AgentTool = {
        name,
        description: `${name} (test)`,
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({}),
      };
      reg.register(t);
    }
    return reg;
  }

  it('Services lane keeps service + enrichment tools, drops off-lane', () => {
    const reg = registryWith([
      'search_provider_services',
      'query_service',
      'vault_search', // enrichment — kept
      'schedule_reminder', // off-lane — dropped
      'search_peerlens', // reviews-only — dropped
    ]);
    const scoped = scopeToolsForLane(reg, ['provider_services']);
    expect(scoped.has('search_provider_services')).toBe(true);
    expect(scoped.has('query_service')).toBe(true);
    expect(scoped.has('vault_search')).toBe(true); // invariant 6.6
    expect(scoped.has('schedule_reminder')).toBe(false);
    expect(scoped.has('search_peerlens')).toBe(false);
  });

  it('Reviews lane keeps search_peerlens + enrichment, drops service tools', () => {
    const reg = registryWith([
      'search_peerlens',
      'vault_search',
      'query_service', // service-only — dropped
      'schedule_reminder', // off-lane — dropped
    ]);
    const scoped = scopeToolsForLane(reg, ['peerlens']);
    expect(scoped.has('search_peerlens')).toBe(true);
    expect(scoped.has('vault_search')).toBe(true);
    expect(scoped.has('query_service')).toBe(false);
    expect(scoped.has('schedule_reminder')).toBe(false);
  });

  it('plain Ask gets the full registry unchanged', () => {
    const reg = registryWith(['vault_search', 'schedule_reminder']);
    expect(scopeToolsForLane(reg, undefined)).toBe(reg);
  });

  it('lane tool lists keep enrichment in BOTH lanes (invariant 6.6)', () => {
    for (const t of ['vault_search', 'browse_vault', 'get_full_content', 'find_person']) {
      expect(SERVICES_LANE_TOOLS).toContain(t);
      expect(REVIEWS_LANE_TOOLS).toContain(t);
    }
  });
});

describe('classifyPeerlensResult (P2a: presence is not evidence)', () => {
  it('subject with attestations > 0 → backed', () => {
    expect(classifyPeerlensResult({ subject: { attestationSummary: { total: 9 } } })).toBe('backed');
  });
  it('search with results → backed', () => {
    expect(classifyPeerlensResult({ search: { results: [{ id: 'a' }] } })).toBe('backed');
  });
  it('subject total 0 → empty (key present but no data)', () => {
    expect(classifyPeerlensResult({ subject: { attestationSummary: { total: 0 } } })).toBe('empty');
  });
  it('search results [] → empty', () => {
    expect(classifyPeerlensResult({ search: { results: [] } })).toBe('empty');
  });
  it('a failure note → outage (P2b)', () => {
    expect(classifyPeerlensResult({ note: 'PeerLens lookup failed' })).toBe('outage');
  });
  it('an explicit failed flag → outage', () => {
    expect(classifyPeerlensResult({ failed: true })).toBe('outage');
  });
  it('null / non-object → empty', () => {
    expect(classifyPeerlensResult(null)).toBe('empty');
    expect(classifyPeerlensResult('nope')).toBe('empty');
  });

  it('isPeerlensBacked is true only for real evidence', () => {
    expect(isPeerlensBacked({ subject: { attestationSummary: { total: 1 } } })).toBe(true);
    expect(isPeerlensBacked({ search: { results: [] } })).toBe(false);
    expect(isPeerlensBacked({ note: 'failed' })).toBe(false);
  });
});

describe('enforceForcedLaneAnswer — Services gate', () => {
  it('keeps the answer when a service query was dispatched', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['provider_services'],
        answer: 'Bus 42 arrives in 6 min.',
        serviceQueryCount: 1,
        toolCalls: [ok('query_service', { task_id: 't1' })],
      }),
    ).toBe('Bus 42 arrives in 6 min.');
  });
  it('no dispatch + clean discovery → no-service (absence)', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['provider_services'],
        answer: 'A kebab is about $8.',
        serviceQueryCount: 0,
        toolCalls: [ok('search_provider_services', [])],
      }),
    ).toBe(NO_SERVICE_ANSWER);
  });
  it('no dispatch + a 400/no-candidate discovery failure → no-service (absence)', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['provider_services'],
        answer: 'A kebab is about $8.',
        serviceQueryCount: 0,
        toolCalls: [fail('search_provider_services', 'AppView responded 400 no_candidate')],
      }),
    ).toBe(NO_SERVICE_ANSWER);
  });
  it('no dispatch + a non-400 discovery failure → OUTAGE (P2c)', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['provider_services'],
        answer: 'A kebab is about $8.',
        serviceQueryCount: 0,
        toolCalls: [fail('search_provider_services', 'AppView responded 503 Service Unavailable')],
      }),
    ).toBe(SERVICES_OUTAGE_ANSWER);
  });
  it('discovery succeeded but the DISPATCH (query_service) failed → OUTAGE not no-service', () => {
    // Found a provider, but couldn't deliver the request: "found one but it
    // failed", not "no service exists". A failed query_service is always an outage.
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['provider_services'],
        answer: 'A kebab is about $8.',
        serviceQueryCount: 0,
        toolCalls: [
          ok('search_provider_services', [{ did: 'did:plc:x' }]),
          fail('query_service', 'relay unreachable'),
        ],
      }),
    ).toBe(SERVICES_OUTAGE_ANSWER);
  });
});

describe('enforceForcedLaneAnswer — Reviews gate', () => {
  it('keeps the answer when search_peerlens is backed', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['peerlens'],
        answer: 'Your network rates it highly.',
        serviceQueryCount: 0,
        toolCalls: [ok('search_peerlens', { subject: { attestationSummary: { total: 5 } } })],
      }),
    ).toBe('Your network rates it highly.');
  });
  it('empty-but-successful search → no-reviews (absence)', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['peerlens'],
        answer: 'It is excellent.',
        serviceQueryCount: 0,
        toolCalls: [ok('search_peerlens', { search: { results: [] } })],
      }),
    ).toBe(NO_REVIEWS_ANSWER);
  });
  it('never called → no-reviews', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['peerlens'],
        answer: 'It is excellent.',
        serviceQueryCount: 0,
        toolCalls: [],
      }),
    ).toBe(NO_REVIEWS_ANSWER);
  });
  it('AppView failure note → OUTAGE (P2b)', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: ['peerlens'],
        answer: 'It is excellent.',
        serviceQueryCount: 0,
        toolCalls: [ok('search_peerlens', { note: 'PeerLens lookup failed', failed: true })],
      }),
    ).toBe(REVIEWS_OUTAGE_ANSWER);
  });
});

describe('enforceForcedLaneAnswer — plain Ask', () => {
  it('never rewrites the answer when no lane is forced', () => {
    expect(
      enforceForcedLaneAnswer({
        forcedSources: undefined,
        answer: 'The sky is blue.',
        serviceQueryCount: 0,
        toolCalls: [],
      }),
    ).toBe('The sky is blue.');
  });
});
