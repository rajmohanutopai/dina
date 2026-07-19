/**
 * Narrow test for WM-CORE-10's "hot shutdown unwires them" invariant.
 *
 * `shutdownAllPersistence` is the teardown called on logout / app
 * background. It must clear the per-persona repo maps AND the
 * module-global MemoryService so the /v1/memory routes 503 until the
 * next boot re-installs them.
 *
 * We don't spin up op-sqlite here — `shutdownAllPersistence` is
 * designed to be safe when `initializePersistence` never ran (its
 * inner `resetDBProvider` handles a null provider).
 */

import { addMessage, getThread } from '../../../brain/src/chat/thread';
import {
  setChatMessageRepository,
  getChatMessageRepository,
  InMemoryChatMessageRepository,
} from '../../../core/src/chat/repository';
import {
  hydrateContactDirectory,
  listContacts,
} from '../../../core/src/contacts/directory';
import {
  type ContactRepository,
  setContactRepository,
  getContactRepository,
} from '../../../core/src/contacts/repository';
import {
  setTopicRepository,
  getTopicRepository,
  InMemoryTopicRepository,
} from '../../../core/src/memory/repository';
import {
  setMemoryService,
  getMemoryService,
  MemoryService,
} from '../../../core/src/memory/service';
import {
  type ServiceConfig,
  setServiceConfig,
  listServiceConfigs,
} from '../../../core/src/service/service_config';
import {
  InMemoryServiceConfigRepository,
  setServiceConfigRepository,
  getServiceConfigRepository,
} from '../../../core/src/service/service_config_repository';
import { setVaultRepository, getVaultRepository } from '../../../core/src/vault/repository';
import { shutdownAllPersistence } from '../../src/storage/init';

describe('shutdownAllPersistence — memory teardown', () => {
  it('drops the module-global MemoryService', async () => {
    setMemoryService(
      new MemoryService({
        resolve: () => null,
        listPersonas: () => [],
        nowSecFn: () => 0,
      }),
    );
    expect(getMemoryService()).not.toBeNull();
    await shutdownAllPersistence();
    expect(getMemoryService()).toBeNull();
  });

  it('clears per-persona topic + vault repo maps', async () => {
    setTopicRepository('health', new InMemoryTopicRepository());
    // Hand a minimal object to the vault map just to confirm it clears.
    setVaultRepository('health', {} as never);
    expect(getTopicRepository('health')).not.toBeNull();
    expect(getVaultRepository('health')).not.toBeNull();
    await shutdownAllPersistence();
    expect(getTopicRepository('health')).toBeNull();
    expect(getVaultRepository('health')).toBeNull();
  });

  it('clears the in-memory chat thread cache + drops the chat repo (cross-identity privacy)', async () => {
    // Privacy regression: the chat UI renders from Brain's in-memory `threads`
    // Map. Teardown MUST reset it, or a NEW identity (erase / sign-out then
    // log in as someone else, same JS process) inherits the PREVIOUS user's
    // conversation — exactly the leak reported in the field.
    setChatMessageRepository(new InMemoryChatMessageRepository());
    addMessage('main', 'user', 'previous identity private message');
    expect(getThread('main').length).toBeGreaterThan(0);
    expect(getChatMessageRepository()).not.toBeNull();

    await shutdownAllPersistence();

    expect(getThread('main')).toEqual([]);
    expect(getChatMessageRepository()).toBeNull();
  });

  it('clears the published service config + drops its repo (cross-identity privacy)', async () => {
    // Field bug: after erasing one Dina and signing in as a NEW user in the
    // same JS process, a service from the OLD identity still showed as "linked
    // to me". The `configs` Map is a module-global cache; teardown must reset
    // it (and null the repo) or the previous identity's published listing
    // survives into the next one.
    const validConfig: ServiceConfig = {
      isDiscoverable: true,
      name: 'Sancho Salon (previous identity)',
      description: 'Chair rental + cuts',
      capabilities: {
        availability_query: {
          mcpServer: 'salon',
          mcpTool: 'check_slots',
          responsePolicy: 'auto',
          schemaHash: 'abc123',
        },
      },
      capabilitySchemas: {
        availability_query: {
          params: { type: 'object' },
          result: { type: 'object' },
          schemaHash: 'abc123',
        },
      },
    };
    setServiceConfigRepository(new InMemoryServiceConfigRepository());
    setServiceConfig(validConfig);
    expect(listServiceConfigs().length).toBeGreaterThan(0);
    expect(getServiceConfigRepository()).not.toBeNull();

    await shutdownAllPersistence();

    expect(listServiceConfigs()).toEqual([]);
    expect(getServiceConfigRepository()).toBeNull();
  });

  it('clears the contact directory + drops the contact repo (cross-identity privacy)', async () => {
    // Same class of leak as chat/service-config: `hydrateContactDirectory`
    // `.set()`s each row into the module-global `contactsByPerson` Map (a
    // MERGE, not a replace), so a previous identity's contacts — and any
    // service they offer — survive an in-app erase + re-onboard unless teardown
    // resets the directory.
    const stubContactRepo = {
      list: () => [
        {
          personId: 'p-prev-identity',
          did: '',
          displayName: 'Sancho (previous identity)',
          aliases: ['sancho'],
          trustLevel: 'verified',
          sharingTier: 'summary',
          relationship: 'unknown',
          dataResponsibility: 'external',
          notes: '',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    } as unknown as ContactRepository;
    setContactRepository(stubContactRepo);
    // People repo is null → hydrate resolves no DIDs (fine; we only need a row
    // in the in-memory directory to prove teardown clears it).
    expect(hydrateContactDirectory()).toBe(1);
    expect(listContacts().length).toBe(1);

    await shutdownAllPersistence();

    expect(listContacts()).toEqual([]);
    expect(getContactRepository()).toBeNull();
  });
});
