/** REAL_LIFE_FIXES_2 §8.2 — Core keeps a change link only to an item it can find in an open persona. */

import { resolve as resolveStaging, ingest, claim } from '../../src/staging/service';
import { getItem, storeItem } from '../../src/vault/crud';
import { InMemoryVaultRepository, setVaultRepository } from '../../src/vault/repository';
import { createPersona, openPersona, resetPersonaState } from '../../src/persona/service';

beforeEach(() => {
  resetPersonaState();
  createPersona('general', 'default');
  openPersona('general');
  setVaultRepository('general', new InMemoryVaultRepository());
});

let n = 0;
async function storeWith(contradicts: string): Promise<string> {
  n++;
  const { id } = ingest({ source: 'user_remember', source_id: `s-${Math.random()}`, data: { summary: 'x', body: 'x', type: 'user_memory' } } as never) as { id: string };
  claim(10);
  resolveStaging(id, 'general', true, { summary: `Coach is Meena now (${n})`, body: `Coach is Meena now (${n})`, type: 'user_memory', contradicts } as never);
  return `stg-${id}`;
}

it('keeps a link to an existing item', async () => {
  const prior = storeItem('general', { type: 'user_memory', summary: 'Coach is Ravi', body: 'Coach is Ravi' });
  const id = await storeWith(`supersedes:${prior}`);
  expect(getItem('general', id)?.contradicts).toBe(`supersedes:${prior}`);
});

it('drops a link to an id that does not exist or is malformed', async () => {
  expect(getItem('general', await storeWith('supersedes:no-such-item'))?.contradicts).toBe('');
  expect(getItem('general', await storeWith('rewrite everything'))?.contradicts).toBe('');
});
