export { SQLiteAuditRepository, setAuditRepository } from './src/audit/repository';
export type { AuditRepository } from './src/audit/repository';
export {
  SQLiteChatMessageRepository,
  setChatMessageRepository,
} from './src/chat/repository';
export type { ChatMessageRepository, StoredChatMessage } from './src/chat/repository';
export {
  SQLiteContactRepository,
  setContactRepository,
} from './src/contacts/repository';
export type { ContactRepository } from './src/contacts/repository';
export { SQLiteDeviceRepository, setDeviceRepository } from './src/devices/repository';
export type { DeviceRepository } from './src/devices/repository';
export { SQLiteKVRepository } from './src/kv/repository';
export type { KVRepository } from './src/kv/repository';
export { setKVRepository } from './src/kv/store';
export type { KVEntry } from './src/kv/store';
export {
  SQLiteTopicRepository,
  resetTopicRepositories,
  setTopicRepository,
} from './src/memory/repository';
export type { TopicRepository } from './src/memory/repository';
export { setMemoryService } from './src/memory/service';
export {
  SQLitePeopleRepository,
  setPeopleRepository,
} from './src/people/repository';
export type { PeopleRepository } from './src/people/repository';
export {
  SQLiteReminderRepository,
  setReminderRepository,
} from './src/reminders/repository';
export type { ReminderRepository } from './src/reminders/repository';
export { hydrateRemindersFromRepo } from './src/reminders/service';
export {
  bootstrapPersistence,
  openPersonaVault,
  shutdownPersistence,
} from './src/storage/bootstrap';
export { InMemoryDatabaseAdapter } from './src/storage/db_adapter';
export type { DatabaseAdapter, DBRow } from './src/storage/db_adapter';
export {
  getDBProvider,
  getIdentityDB,
  getPersonaDB,
  resetDBProvider,
  setDBProvider,
} from './src/storage/db_provider';
export type { DBProvider } from './src/storage/db_provider';
export {
  SQLiteStagingRepository,
  setStagingRepository,
} from './src/staging/repository';
export type { StagingRepository } from './src/staging/repository';
export { hydrateStagingFromRepository } from './src/staging/service';
export {
  SQLiteVaultRepository,
  resetVaultRepositories,
  setVaultRepository,
} from './src/vault/repository';
export type { VaultRepository } from './src/vault/repository';
