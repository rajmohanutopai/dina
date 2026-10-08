/**
 * REAL_LIFE_FIXES §2.1 — persona names resolve against the vaults this node
 * actually has. An alias applies only when its target is installed; a name
 * that matches nothing parks the item instead of failing it or creating a
 * vault nobody searches.
 */

import {
  createPersona,
  isUnknownPersona,
  openPersona,
  resetPersonaState,
  resolveInstalledPersonaName,
} from '../../src/persona/service';
import { resetDataScope } from '../../src/scope/data_scope';
import { setStagingRepository } from '../../src/staging/repository';
import {
  UNKNOWN_PERSONA_ERROR,
  claim,
  getItem,
  ingest,
  resetStagingState,
  resolve,
  resolveMultiDetailed,
} from '../../src/staging/service';
import { clearVaults, getItem as getVaultItem } from '../../src/vault/crud';
import { InMemoryWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

function freshItem(sourceId: string): string {
  const { id } = ingest({ source: 'user_remember', source_id: sourceId });
  claim(10);
  return id;
}

describe('persona names resolve to installed vaults (§2.1)', () => {
  beforeEach(() => {
    resetStagingState();
    setStagingRepository(null);
    resetDataScope();
    resetPersonaState();
    clearVaults();
    const workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowRepository(workflowRepo);
    setWorkflowService(new WorkflowService({ repository: workflowRepo }));
  });

  describe('resolveInstalledPersonaName', () => {
    it('keeps an exact installed name', () => {
      createPersona('work', 'standard');
      expect(resolveInstalledPersonaName('Work')).toBe('work');
    });

    it('maps an alias to its installed counterpart in either direction', () => {
      createPersona('work', 'standard');
      // `professional` is the canonical spelling of `work`; only `work` exists.
      expect(resolveInstalledPersonaName('professional')).toBe('work');
    });

    it('never maps an installed name away to another vault', () => {
      createPersona('work', 'standard');
      createPersona('professional', 'standard');
      expect(resolveInstalledPersonaName('work')).toBe('work');
      expect(resolveInstalledPersonaName('professional')).toBe('professional');
    });
  });

  describe('isUnknownPersona', () => {
    it('is false for every name while the registry is empty (old behaviour)', () => {
      expect(isUnknownPersona('anything')).toBe(false);
    });

    it('is true only for names neither installed nor an alias of one', () => {
      createPersona('general', 'default');
      createPersona('work', 'standard');
      expect(isUnknownPersona('general')).toBe(false);
      expect(isUnknownPersona('professional')).toBe(false);
      expect(isUnknownPersona('garden')).toBe(true);
    });
  });

  describe('staging resolve', () => {
    it('parks an item whose only target does not exist, writing no vault row', () => {
      createPersona('general', 'default');
      openPersona('general');
      const id = freshItem('garden-1');

      resolve(id, 'garden', true, { id: 'v1', type: 'note', summary: 'roses in May' });

      const item = getItem(id);
      expect(item?.status).toBe('pending_unlock');
      expect(item?.persona).toBe('garden');
      expect(item?.error).toBe(UNKNOWN_PERSONA_ERROR);
      expect(item?.approval_id).toBeUndefined();
      expect(getVaultItem('general', `stg-${id}`)).toBeNull();
    });

    it('multi-target: parks when every target is unknown and reports them', () => {
      createPersona('general', 'default');
      openPersona('general');
      const id = freshItem('garden-2');

      const result = resolveMultiDetailed(
        id,
        [
          { persona: 'garden', personaOpen: true },
          { persona: 'hobbies', personaOpen: true },
        ],
        { id: 'v2', type: 'note', summary: 'seed catalogue' },
      );

      expect(result.storedPersonas).toEqual([]);
      expect(result.unknownPersonas).toEqual(['garden', 'hobbies']);
      expect(getItem(id)?.status).toBe('pending_unlock');
      expect(getItem(id)?.error).toBe(UNKNOWN_PERSONA_ERROR);
    });

    it('multi-target: stores into the known targets and reports the unknown ones', () => {
      createPersona('general', 'default');
      openPersona('general');
      const id = freshItem('mixed-1');

      const result = resolveMultiDetailed(
        id,
        [
          { persona: 'garden', personaOpen: true },
          { persona: 'general', personaOpen: true },
        ],
        { id: 'v3', type: 'note', summary: 'lawn feed' },
      );

      expect(result.storedPersonas).toEqual(['general']);
      expect(result.unknownPersonas).toEqual(['garden']);
      expect(getItem(id)?.status).toBe('stored');
      expect(getVaultItem('general', `stg-${id}`)).not.toBeNull();
    });
  });
});
