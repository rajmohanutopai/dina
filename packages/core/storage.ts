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
export {
  SQLitePersonaRepository,
  setPersonaRepository,
  getPersonaRepository,
} from './src/persona/repository';
export type { PersonaRepository, StoredPersona } from './src/persona/repository';
export { hydratePersonas } from './src/persona/service';
export {
  SQLiteServiceOfferRepository,
  setServiceOfferRepository,
  getServiceOfferRepository,
} from './src/contacts/service_offers_repository';
export type {
  ServiceOffer,
  ServiceOfferRepository,
} from './src/contacts/service_offers_repository';
export {
  SQLiteServiceDecisionRepository,
  setServiceDecisionRepository,
  getServiceDecisionRepository,
} from './src/contacts/service_decisions_repository';
export type {
  ServiceDecision,
  ServiceDecisionInput,
  ServiceDecisionOutcome,
  ServiceDecisionRepository,
} from './src/contacts/service_decisions_repository';
export {
  SQLiteServiceGrantRepository,
  setServiceGrantRepository,
  getServiceGrantRepository,
} from './src/service/service_grant_repository';
export type {
  ServiceGrant,
  ServiceGrantRepository,
} from './src/service/service_grant_repository';
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
export { hydrateStagingFromRepository, resetStagingState } from './src/staging/service';
export {
  SQLiteQuarantineRepository,
  setQuarantineRepository,
  hydrateQuarantineFromRepository,
  resetQuarantineState,
} from './src/d2d/quarantine';
export type { QuarantineRepository } from './src/d2d/quarantine';
export {
  SQLiteVaultRepository,
  resetVaultRepositories,
  setVaultRepository,
} from './src/vault/repository';
export type { VaultRepository } from './src/vault/repository';
export {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from './src/plugins/registry';
export type { PluginInstallRepository } from './src/plugins/registry';
export {
  SQLitePluginGrantRepository,
  setPluginGrantRepository,
} from './src/plugins/grants';
export type { PluginGrantRepository } from './src/plugins/grants';
export {
  SQLitePluginDecisionRepository,
  setPluginDecisionRepository,
} from './src/plugins/decisions';
export type { PluginDecisionRepository } from './src/plugins/decisions';
