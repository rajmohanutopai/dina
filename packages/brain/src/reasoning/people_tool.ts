/**
 * `find_person` agentic tool — resolve a named individual through the
 * people-graph instead of guessing identity from FTS5 keyword matches
 * over vault items.
 *
 * The people graph holds structured records:
 *   - canonical name + relationship hint ("daughter", "doctor", "colleague")
 *   - one or more surface forms ("Emma", "Em", "Mrs Smith")
 *   - provenance edges back to the vault items that mentioned the person
 *
 * Giving the LLM direct access to that structure (rather than asking it
 * to re-derive identity from raw vault rows) shrinks the prompt + makes
 * cross-domain reasoning cleaner. Once it has the canonical name and
 * relationship, it can pivot to `vault_search` for related facts in
 * other personas (budget context, schedule, preferences) without
 * needing the keyword "Emma" to luckily exist in those rows.
 *
 * Backend routing mirrors `vault_search`: mobile leaves
 * `PeopleReadBackend` unset and the tool calls `getPeopleRepository()`
 * directly; lite's brain-server installs an HTTP-backed implementation
 * at boot.
 */

import { getPeopleRepository } from '@dina/core';

import { getPeopleReadBackend } from '../vault_context/assembly';

import { type AgentTool } from './tool_registry';

import type { Person } from '@dina/core';

export interface FindPersonToolOptions {
  /** Upper bound on matches returned to the LLM. Default 10. */
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 10;

/**
 * Build the `find_person` tool. Always-available — no persona-guard
 * needed because the people graph is metadata, not vault content.
 */
export function createFindPersonTool(options: FindPersonToolOptions = {}): AgentTool {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  return {
    name: 'find_person',
    description:
      "Resolve a named individual in the user's people graph. Returns canonical name, relationship hint ('daughter', 'doctor', 'colleague'), and any known surface forms. Use this whenever the question mentions a person by name — it gives you the structured identity that vault_search can then build on (e.g. once you know 'Emma is daughter', you can search 'budget' in finance to find spending guidance for buying her a gift).",
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            "Surface form to match — either a canonical name ('Emma'), nickname ('Em'), or role phrase ('my daughter'). Matched case-insensitively against every surface in the graph.",
        },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<unknown> {
      const raw = args.name;
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (name === '') {
        return { error: 'name is required' };
      }
      const matches = await resolveMatches(name);
      if (matches.length === 0) {
        return { name, matches: [] };
      }
      const trimmed = matches.slice(0, maxResults).map((p) => ({
        personId: p.personId,
        canonicalName: p.canonicalName,
        relationshipHint: p.relationshipHint,
        status: p.status,
        surfaces: (p.surfaces ?? [])
          .filter((s) => s.status !== 'rejected')
          .map((s) => ({
            surface: s.surface,
            surfaceType: s.surfaceType,
            sourceItemId: s.sourceItemId,
            sourceExcerpt: s.sourceExcerpt,
          })),
      }));
      return {
        name,
        matches: trimmed,
        truncated: matches.length > maxResults,
      };
    },
  };
}

async function resolveMatches(name: string): Promise<Person[]> {
  // Remote path (lite) — out-of-process HTTP via brain-server's CoreClient.
  const remote = getPeopleReadBackend();
  if (remote !== null) {
    return remote.peopleFindByName(name);
  }
  // In-process path (mobile, tests) — talk to the repo directly.
  const repo = getPeopleRepository();
  if (repo === null) {
    return [];
  }
  const needle = name.trim().toLowerCase();
  return repo
    .listPeople()
    .filter((p) =>
      (p.surfaces ?? []).some(
        (s) => s.status !== 'rejected' && s.normalizedSurface === needle,
      ),
    );
}
