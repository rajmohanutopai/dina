/**
 * REAL_LIFE_FIXES §6.1 — a D2D item's trust is Core's stamp, kept at
 * resolve whatever Brain sends; a D2D item without one stays quarantined.
 */

import { receiveAndStage } from '../../src/d2d/receive';
import { createPersona, openPersona, resetPersonaState } from '../../src/persona/service';
import { setStagingRepository } from '../../src/staging/repository';
import { claim, ingest, resetStagingState, resolve } from '../../src/staging/service';
import { clearVaults, getItem as getVaultItem } from '../../src/vault/crud';

beforeEach(() => {
  resetStagingState();
  setStagingRepository(null);
  resetPersonaState();
  createPersona('general', 'default');
  openPersona('general', true);
  clearVaults(['general']);
});

afterEach(() => resetPersonaState());

it("a contact's message is stored searchable even if Brain says quarantine", () => {
  const r = receiveAndStage('social.update', 'did:plc:friend', 'contact_ring1', '{"text":"moved to Leeds"}', 'm-1', true);
  claim(10);
  resolve(r.stagingId!, 'general', true, {
    type: 'relationship_note',
    summary: 'moved to Leeds',
    sender_trust: 'unknown',
    source_type: 'unknown',
    retrieval_policy: 'quarantine',
  });
  const v = getVaultItem('general', `stg-${r.stagingId}`);
  expect(v?.retrieval_policy).toBe('normal');
  expect(v?.source_type).toBe('contact');
  expect(v?.sender_trust).toBe('contact_ring1');
});

it('a D2D item without Core\'s stamp stays quarantined, whatever Brain says', () => {
  const { id } = ingest({ source: 'd2d', source_id: 'm-2', data: { type: 'note', summary: 'hello' } });
  claim(10);
  resolve(id, 'general', true, { type: 'note', summary: 'hello', retrieval_policy: 'normal', sender_trust: 'contact_ring1' });
  // Quarantined rows are excluded from normal reads.
  expect(getVaultItem('general', `stg-${id}`)?.retrieval_policy ?? 'quarantine').toBe('quarantine');
});
