/**
 * Vault routes — the subset Brain actually calls.
 *
 *   POST /v1/vault/query       — FTS keyword search
 *   POST /v1/vault/store       — store a single item
 *   GET  /v1/vault/item/:id    — fetch by id
 *
 * batch-store, kv/*, and DELETE variants were speculative ports — no
 * consumer in the mobile MVP, gone.
 */

import type { CoreRouter } from '../router';
import { storeItem, queryVault, getItem } from '../../vault/crud';

export function registerVaultRoutes(router: CoreRouter): void {
  router.post('/v1/vault/query', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const persona = req.query.persona ?? 'general';
    const text = typeof body.text === 'string' ? body.text : '';
    const mode = (body.mode as 'fts5' | 'semantic' | 'hybrid' | undefined) ?? 'fts5';
    const rawLimit = Number(body.limit) || 20;
    const limit = Math.max(1, Math.min(rawLimit, 100));
    try {
      const results = queryVault(persona, { mode, text, limit });
      return { status: 200, body: { items: results, count: results.length } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  router.post('/v1/vault/store', async (req) => {
    const persona = req.query.persona ?? 'general';
    try {
      // The stored item is whatever the caller sent — the Brain client is
      // trusted to supply a well-shaped VaultItem.
      const id = storeItem(persona, req.body as Parameters<typeof storeItem>[1]);
      return { status: 201, body: { id } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  router.get('/v1/vault/item/:id', async (req) => {
    const persona = req.query.persona ?? 'general';
    const item = getItem(persona, req.params.id);
    if (!item) return { status: 404, body: { error: 'Item not found' } };
    return { status: 200, body: item };
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
