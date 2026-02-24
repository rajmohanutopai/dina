/** Jetstream commit event for a create/update operation */
export interface JetstreamCommitCreate {
  did: string
  time_us: number
  kind: 'commit'
  commit: {
    rev: string
    operation: 'create' | 'update'
    collection: string
    rkey: string
    record: Record<string, unknown>
    cid: string
  }
}

/** Jetstream commit event for a delete operation */
export interface JetstreamCommitDelete {
  did: string
  time_us: number
  kind: 'commit'
  commit: {
    rev: string
    operation: 'delete'
    collection: string
    rkey: string
  }
}

/** Jetstream identity event (handle change, DID tombstone) */
export interface JetstreamIdentityEvent {
  did: string
  time_us: number
  kind: 'identity'
  identity: {
    did: string
    handle: string
    seq: number
    time: string
  }
}

/** Jetstream account event (status changes) */
export interface JetstreamAccountEvent {
  did: string
  time_us: number
  kind: 'account'
  account: {
    active: boolean
    did: string
    seq: number
    time: string
    status?: 'takendown' | 'suspended' | 'deleted' | 'deactivated'
  }
}

export type JetstreamEvent =
  | JetstreamCommitCreate
  | JetstreamCommitDelete
  | JetstreamIdentityEvent
  | JetstreamAccountEvent
