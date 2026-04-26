/**
 * Vault agentic tools — unit tests for `vault_search`,
 * `list_personas`, `browse_vault`, `get_full_content`.
 */

import {
  createVaultSearchTool,
  createListPersonasTool,
  createBrowseVaultTool,
  createGetFullContentTool,
} from '../../src/reasoning/vault_tool';
import {
  setAccessiblePersonas,
  resetReasoningProvider,
} from '../../src/vault_context/assembly';
import { clearVaults, storeItem } from '../../../core/src/vault/crud';
import {
  createPersona,
  resetPersonaState,
} from '../../../core/src/persona/service';

describe('createVaultSearchTool', () => {
  beforeEach(() => {
    clearVaults();
    resetReasoningProvider();
    setAccessiblePersonas(['general', 'health']);
  });

  it('returns rows matching the query in an accessible persona', async () => {
    storeItem('general', {
      type: 'user_memory',
      summary: "Emma's birthday is March 15",
      body: "Emma's birthday is March 15",
    });
    const tool = createVaultSearchTool();

    const raw = await tool.execute({ query: 'emma birthday' });
    const result = raw as {
      persona: string;
      query: string;
      accessible: boolean;
      results: Array<{ id: string; content_l0: string; score: number; persona: string }>;
    };

    // Default (no persona arg) is fan-out across all unlocked personas.
    expect(result.persona).toBe('all');
    expect(result.accessible).toBe(true);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // Per-row persona still names the source vault.
    expect(result.results[0]!.persona).toBe('general');
    // content_l0 falls back to summary when content_l0 is empty
    expect(result.results[0]!.content_l0).toMatch(/Emma/i);
  });

  it('scopes to the requested persona — omits cross-persona hits', async () => {
    storeItem('general', {
      type: 'user_memory',
      summary: 'generic personal fact',
      body: 'generic personal fact about ferrets',
    });
    storeItem('health', {
      type: 'medical_note',
      summary: 'allergy shot due',
      body: 'seasonal allergy booster',
    });
    const tool = createVaultSearchTool();

    const healthOnly = (await tool.execute({
      query: 'allergy',
      persona: 'health',
    })) as { results: Array<{ id: string }> };
    expect(healthOnly.results.length).toBeGreaterThanOrEqual(1);

    // Query that's only in `general` — scoping to `health` returns 0.
    const scoped = (await tool.execute({
      query: 'ferrets',
      persona: 'health',
    })) as { results: Array<{ id: string }> };
    expect(scoped.results.length).toBe(0);
  });

  it('returns empty + accessible=false when persona is locked', async () => {
    storeItem('financial', {
      type: 'note',
      summary: 'statement',
      body: 'account balance',
    });
    // `financial` is NOT in accessiblePersonas → tool must return [] and
    // signal accessible:false so the LLM can tell the user "that's
    // locked, unlock it first" instead of pretending there's nothing.
    const tool = createVaultSearchTool();
    const result = (await tool.execute({
      query: 'balance',
      persona: 'financial',
    })) as { accessible: boolean; results: unknown[] };
    expect(result.accessible).toBe(false);
    expect(result.results.length).toBe(0);
  });

  it('rejects an empty query (prevents wildcard dumps)', async () => {
    const tool = createVaultSearchTool();
    await expect(tool.execute({ query: '' })).rejects.toThrow(/required/);
  });

  it('respects the configured maxResults ceiling', async () => {
    for (let i = 0; i < 15; i++) {
      storeItem('general', {
        type: 'user_memory',
        summary: `emma memory ${i}`,
        body: `emma memory ${i}`,
      });
    }
    const tool = createVaultSearchTool({ maxResults: 3 });
    const result = (await tool.execute({ query: 'emma', limit: 10 })) as {
      results: unknown[];
    };
    // LLM asked for 10, but tool ceiling is 3 — ceiling wins.
    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it('fans out across every unlocked persona when persona arg is omitted', async () => {
    // Drain may have routed items to 'general' even when the user's
    // question phrases them as a 'health' or 'financial' topic. The
    // default search must NOT under-scope to a single persona.
    storeItem('general', {
      type: 'user_memory',
      summary: 'hypertension reading 145/92',
      body: 'hypertension reading 145/92',
    });
    storeItem('health', {
      type: 'medical_note',
      summary: 'doctor visit notes',
      body: 'doctor visit notes about hypertension',
    });
    const tool = createVaultSearchTool();
    const result = (await tool.execute({ query: 'hypertension' })) as {
      persona: string;
      personas_searched: string[];
      accessible: boolean;
      results: Array<{ id: string; persona: string }>;
    };

    expect(result.persona).toBe('all');
    expect(result.personas_searched.sort()).toEqual(['general', 'health']);
    expect(result.accessible).toBe(true);
    // Both vaults contributed — the LLM gets both rows back even though
    // it didn't name a persona.
    const personasFound = new Set(result.results.map((r) => r.persona));
    expect(personasFound.has('general')).toBe(true);
    expect(personasFound.has('health')).toBe(true);
  });

  it('respects an explicit persona arg — single-persona scoping still works', async () => {
    storeItem('general', {
      type: 'user_memory',
      summary: 'hypertension reading 145/92',
      body: 'hypertension reading 145/92',
    });
    storeItem('health', {
      type: 'medical_note',
      summary: 'doctor visit notes',
      body: 'doctor visit notes about hypertension',
    });
    const tool = createVaultSearchTool();
    const result = (await tool.execute({
      query: 'hypertension',
      persona: 'health',
    })) as {
      persona: string;
      personas_searched: string[];
      results: Array<{ persona: string }>;
    };
    expect(result.persona).toBe('health');
    expect(result.personas_searched).toEqual(['health']);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // Only health rows — caller asked for narrow scope, they get it.
    expect(result.results.every((r) => r.persona === 'health')).toBe(true);
  });

  it('returns accessible:false when fan-out has no unlocked personas', async () => {
    setAccessiblePersonas([]);
    const tool = createVaultSearchTool();
    const result = (await tool.execute({ query: 'anything' })) as {
      persona: string;
      personas_searched: string[];
      accessible: boolean;
      results: unknown[];
    };
    expect(result.persona).toBe('all');
    expect(result.personas_searched).toEqual([]);
    expect(result.accessible).toBe(false);
    expect(result.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// list_personas — persona enumeration + preview
// ---------------------------------------------------------------------------

describe('createListPersonasTool', () => {
  beforeEach(() => {
    clearVaults();
    resetReasoningProvider();
    resetPersonaState();
    createPersona('general', 'default');
    createPersona('health', 'sensitive');
    createPersona('financial', 'sensitive');
    setAccessiblePersonas(['general', 'health']); // financial intentionally locked
  });

  it('returns every registered persona with a preview block', async () => {
    storeItem('general', {
      type: 'user_memory',
      summary: "Emma's birthday is March 15",
      body: '...',
    });
    storeItem('general', {
      type: 'note',
      summary: 'prefer cold brew coffee',
      body: '...',
    });
    storeItem('health', {
      type: 'medical_note',
      summary: 'allergy shot due',
      body: '...',
    });

    const tool = createListPersonasTool();
    const raw = await tool.execute({});
    const result = raw as {
      personas: Array<{
        name: string;
        item_count?: number;
        types?: string[];
        recent_summaries?: string[];
        status?: string;
      }>;
    };

    expect(result.personas.length).toBe(3);
    const byName = new Map(result.personas.map((p) => [p.name, p]));
    expect(byName.get('general')!.item_count).toBe(2);
    expect(byName.get('general')!.types).toEqual(
      expect.arrayContaining(['user_memory', 'note']),
    );
    expect(byName.get('general')!.recent_summaries?.[0]).toMatch(/Emma|cold brew/);
    expect(byName.get('health')!.item_count).toBe(1);
  });

  it('flags locked personas with status:locked instead of silently omitting them', async () => {
    const tool = createListPersonasTool();
    const raw = await tool.execute({});
    const result = raw as {
      personas: Array<{ name: string; status?: string; item_count?: number }>;
    };
    const locked = result.personas.find((p) => p.name === 'financial');
    expect(locked?.status).toBe('locked');
    expect(locked?.item_count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// browse_vault — recent items without a search term
// ---------------------------------------------------------------------------

describe('createBrowseVaultTool', () => {
  beforeEach(() => {
    clearVaults();
    resetReasoningProvider();
    resetPersonaState();
    createPersona('general', 'default');
    setAccessiblePersonas(['general']);
  });

  it('returns recent items with summary + body + provenance fields', async () => {
    storeItem('general', {
      type: 'user_memory',
      summary: 'pizza is at joes',
      body: 'user told us about pizza',
      sender: 'owner',
      sender_trust: 'self',
    });
    const tool = createBrowseVaultTool();
    const result = (await tool.execute({ persona: 'general' })) as {
      persona: string;
      items: Array<Record<string, string>>;
    };
    expect(result.persona).toBe('general');
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.summary).toBe('pizza is at joes');
    expect(result.items[0]!.sender_trust).toBe('self');
  });

  it('returns a locked note instead of content for inaccessible personas', async () => {
    createPersona('health', 'sensitive');
    storeItem('health', { type: 'medical_note', summary: 'secret', body: 'secret' });
    // health NOT in accessiblePersonas
    const tool = createBrowseVaultTool();
    const result = (await tool.execute({ persona: 'health' })) as {
      items: unknown[];
      note?: string;
    };
    expect(result.items).toEqual([]);
    expect(result.note).toMatch(/locked/);
  });

  it('throws when persona arg is missing (schema violation)', async () => {
    const tool = createBrowseVaultTool();
    await expect(tool.execute({})).rejects.toThrow(/persona is required/);
  });
});

// ---------------------------------------------------------------------------
// get_full_content — fetch by id
// ---------------------------------------------------------------------------

describe('createGetFullContentTool', () => {
  beforeEach(() => {
    clearVaults();
    resetReasoningProvider();
    resetPersonaState();
    createPersona('general', 'default');
    setAccessiblePersonas(['general']);
  });

  it('returns the full body by id (longer than the search-tool cap)', async () => {
    const longBody = 'a'.repeat(3000);
    const id = storeItem('general', {
      type: 'note',
      summary: 'long note',
      body: longBody,
    });
    const tool = createGetFullContentTool();
    const result = (await tool.execute({ persona: 'general', item_id: id })) as {
      id: string;
      body?: string;
    };
    expect(result.id).toBe(id);
    expect(result.body).toBe(longBody);
  });

  it('returns an error envelope when the item is missing', async () => {
    const tool = createGetFullContentTool();
    const result = (await tool.execute({ persona: 'general', item_id: 'nope' })) as {
      error?: string;
    };
    expect(result.error).toMatch(/not found/);
  });

  it('refuses inaccessible personas', async () => {
    createPersona('health', 'sensitive');
    const id = storeItem('health', { type: 'medical_note', summary: 'x', body: 'y' });
    const tool = createGetFullContentTool();
    const result = (await tool.execute({ persona: 'health', item_id: id })) as {
      error?: string;
    };
    expect(result.error).toMatch(/locked/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pattern A — pluggable personaGuard throws ApprovalRequiredError
// ──────────────────────────────────────────────────────────────────────
describe('vault tools — personaGuard (Pattern A approval bail)', () => {
  beforeEach(() => {
    clearVaults();
    resetReasoningProvider();
    resetPersonaState();
    setAccessiblePersonas(['general']);
  });

  it('vault_search throws ApprovalRequiredError when guard returns an approvalId for the named persona', async () => {
    storeItem('financial', {
      type: 'note',
      summary: 'balance',
      body: 'account balance',
    });
    const guardCalls: string[] = [];
    const guard = async (persona: string): Promise<string | null> => {
      guardCalls.push(persona);
      return persona === 'financial' ? 'appr-abc' : null;
    };
    const tool = createVaultSearchTool({ personaGuard: guard });

    await expect(tool.execute({ query: 'balance', persona: 'financial' })).rejects.toMatchObject({
      name: 'ApprovalRequiredError',
      approvalId: 'appr-abc',
      persona: 'financial',
    });
    expect(guardCalls).toEqual(['financial']);
  });

  it('vault_search runs normally when guard returns null (open persona)', async () => {
    storeItem('general', {
      type: 'user_memory',
      summary: 'birthday',
      body: 'cake',
    });
    const guard = async (): Promise<string | null> => null;
    const tool = createVaultSearchTool({ personaGuard: guard });

    const result = (await tool.execute({ query: 'birthday', persona: 'general' })) as {
      accessible: boolean;
      results: unknown[];
    };
    expect(result.accessible).toBe(true);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('vault_search fan-out path does NOT invoke the guard (pre-filtered to accessible personas)', async () => {
    storeItem('general', { type: 'user_memory', summary: 'something', body: 'about cats' });
    const guardCalls: string[] = [];
    const guard = async (persona: string): Promise<string | null> => {
      guardCalls.push(persona);
      return null;
    };
    const tool = createVaultSearchTool({ personaGuard: guard });

    // Omitting `persona` arg → fan-out across already-accessible personas only.
    await tool.execute({ query: 'cats' });
    expect(guardCalls).toEqual([]);
  });

  it('browse_vault throws ApprovalRequiredError for sensitive persona', async () => {
    const guardCalls: string[] = [];
    const guard = async (persona: string): Promise<string | null> => {
      guardCalls.push(persona);
      return 'appr-browse-1';
    };
    const tool = createBrowseVaultTool({ personaGuard: guard });

    await expect(tool.execute({ persona: 'health' })).rejects.toMatchObject({
      name: 'ApprovalRequiredError',
      approvalId: 'appr-browse-1',
      persona: 'health',
    });
    expect(guardCalls).toEqual(['health']);
  });

  it('browse_vault runs normally when guard returns null', async () => {
    storeItem('general', { type: 'note', summary: 'rec', body: 'b' });
    const tool = createBrowseVaultTool({
      personaGuard: async () => null,
    });
    const result = (await tool.execute({ persona: 'general' })) as {
      items: unknown[];
    };
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });

  it('get_full_content throws ApprovalRequiredError for sensitive persona', async () => {
    const guard = async (): Promise<string | null> => 'appr-full-1';
    const tool = createGetFullContentTool({ personaGuard: guard });

    await expect(tool.execute({ persona: 'health', item_id: 'doesntmatter' })).rejects.toMatchObject({
      name: 'ApprovalRequiredError',
      approvalId: 'appr-full-1',
      persona: 'health',
    });
  });

  it('get_full_content runs normally when guard returns null', async () => {
    const id = storeItem('general', { type: 'note', summary: 'x', body: 'y' });
    const tool = createGetFullContentTool({
      personaGuard: async () => null,
    });
    const result = (await tool.execute({ persona: 'general', item_id: id })) as {
      id?: string;
      error?: string;
    };
    expect(result.error).toBeUndefined();
    expect(result.id).toBe(id);
  });

  it('synchronous guards are supported (returning string directly)', async () => {
    // The signature accepts both Promise<string|null> and the bare value
    // so callers can write minimal guards in tests / simple cases.
    const tool = createBrowseVaultTool({
      personaGuard: (persona: string) => (persona === 'health' ? 'appr-sync' : null),
    });

    await expect(tool.execute({ persona: 'health' })).rejects.toMatchObject({
      approvalId: 'appr-sync',
      persona: 'health',
    });
  });

  it('an empty-string approvalId is fail-closed — surfaces as a hard error, NOT silent allow', async () => {
    // A guard that returns '' indicates a misconfiguration (couldn't
    // mint an approval id). Allowing the read in that state would
    // silently bypass the gate; the contract is fail-closed.
    storeItem('general', { type: 'note', summary: 's', body: 'b' });
    const tool = createVaultSearchTool({
      personaGuard: () => '',
    });
    await expect(tool.execute({ query: 'note', persona: 'general' })).rejects.toThrow(
      /empty approvalId.*fail-closed/,
    );
  });

  it('a non-string return from the guard is fail-closed', async () => {
    // Defensive: TS lets you wire a guard that returns something
    // weird (e.g. {}). Refuse rather than silently coerce.
    const tool = createBrowseVaultTool({
      // @ts-expect-error testing runtime fail-closed for non-string return
      personaGuard: () => ({ approvalId: 'oops' }),
    });
    await expect(tool.execute({ persona: 'health' })).rejects.toThrow(/non-string/);
  });

  it('guard rejection (thrown error) propagates — not caught as approval', async () => {
    // If the guard itself crashes (e.g. ApprovalManager unreachable),
    // the tool should surface the error. The ToolRegistry catches it
    // and reports `execution_failed`, not `approval_required`.
    const tool = createBrowseVaultTool({
      personaGuard: async () => {
        throw new Error('approval manager offline');
      },
    });
    await expect(tool.execute({ persona: 'health' })).rejects.toThrow('approval manager offline');
  });

  it('integrates with ToolRegistry — approval_required outcome flows through', async () => {
    // End-to-end through the ToolRegistry: guard throws
    // ApprovalRequiredError → registry returns
    // {success:false, code:'approval_required', approvalId, persona}.
    const { ToolRegistry } = await import('../../src/reasoning/tool_registry');
    const registry = new ToolRegistry();
    registry.register(
      createBrowseVaultTool({
        personaGuard: async () => 'appr-e2e',
      }),
    );

    const outcome = await registry.execute('browse_vault', { persona: 'health' });
    expect(outcome).toEqual({
      success: false,
      code: 'approval_required',
      approvalId: 'appr-e2e',
      persona: 'health',
      error: expect.stringContaining('appr-e2e'),
    });
  });
});
