export {
  MsgTypeCoordinationRequest,
  MsgTypeCoordinationResponse,
  MsgTypePresenceSignal,
  MsgTypeSafetyAlert,
  MsgTypeServiceQuery,
  MsgTypeServiceResponse,
  MsgTypeServiceGrantRequest,
  MsgTypeSocialUpdate,
  MsgTypeTrustVouchRequest,
  MsgTypeTrustVouchResponse,
  alwaysPasses,
  isValidV1Type,
  mapToVaultItemType,
  msgTypeToScenario,
  shouldStore,
  validateMessageBody,
} from './src/d2d/families';
export type { D2DScenario } from './src/d2d/families';
// D2D egress trust gate. The `addContact` here is the
// gate-version (1-arg, registers a sender in the egress trust map);
// it has the same name as `contacts/directory.addContact` (5-arg)
// in `@dina/core` root, so consumers that need the gate version
// import it through this subpath.
export {
  addContact,
  setScenarioDeny,
  setSharingRestrictions,
  blockDestination,
  unblockDestination,
  trustDestination,
  untrustDestination,
  isDestinationBlocked,
  isDestinationTrusted,
  clearGatesState,
} from './src/d2d/gates';

export {
  blockSender,
  deleteQuarantined,
  getQuarantined,
  getQuarantinedSenders,
  listBySender,
  listQuarantined,
  quarantineMessage,
  quarantineSize,
  resetQuarantineState,
  sweepExpired,
  unquarantineSender,
} from './src/d2d/quarantine';
export type { QuarantinedMessage } from './src/d2d/quarantine';
// Re-staging path for accept-from-quarantine: feed a released message
// back into the staging inbox so the drain runs enrichment + reminders.
export { receiveAndStage } from './src/d2d/receive';
export { DIDResolver } from './src/d2d/resolver';
export type { ResolvedDID, ResolverConfig } from './src/d2d/resolver';
export { getD2DSender, setD2DSender } from './src/server/routes/d2d_msg';
export type { D2DSender } from './src/server/routes/d2d_msg';
export type { WSFactory, WSLike } from './src/relay/msgbox_ws';
