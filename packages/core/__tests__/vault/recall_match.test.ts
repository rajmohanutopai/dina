/** REAL_LIFE_FIXES_2 §9.2 — recall matches word forms both ways; exact lookups do not. */

import { recallFTSMatch, queryVault, storeItem } from '../../src/vault/crud';
import { InMemoryVaultRepository, setVaultRepository } from '../../src/vault/repository';
import { createPersona, openPersona, resetPersonaState } from '../../src/persona/service';

describe('recallFTSMatch', () => {
  it('turns words into prefix terms with one ending stripped', () => {
    expect(recallFTSMatch('receipts')).toBe('"receipt"*');
    expect(recallFTSMatch('booking')).toBe('"book"*');
    expect(recallFTSMatch("Kavi's week")).toBe('"Kavi"* OR "week"*');
  });

  it('keeps two-letter words and numbers exact, drops single letters', () => {
    expect(recallFTSMatch('is 42 a go')).toBe('"is" OR "42" OR "go"');
    expect(recallFTSMatch('BP')).toBe('"BP"');
    expect(recallFTSMatch('')).toBe('');
  });
});

describe('queries', () => {
  beforeEach(() => {
    resetPersonaState();
    createPersona('general', 'default');
    openPersona('general');
    setVaultRepository('general', new InMemoryVaultRepository());
    storeItem('general', { type: 'note', summary: 'Rent receipt for April', body: 'Rent receipt for April' });
    storeItem('general', { type: 'note', summary: 'Annabel likes jazz', body: 'Annabel likes jazz' });
  });

  it('a recall search for "receipts" finds the stored "receipt"', () => {
    expect(queryVault('general', { mode: 'fts5', text: 'rent receipts', limit: 10, wordForms: true })).toHaveLength(1);
  });
});
