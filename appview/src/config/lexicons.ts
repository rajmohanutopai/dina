import { CATALOG_POINTER_NSID, CATALOG_SNAPSHOT_NSID } from '@dina/commerce-protocol'

/**
 * All trust record collection NSIDs.
 *
 * THIS LIST IS THE JETSTREAM SUBSCRIPTION. `wantedCollections` is built from
 * it, so a name that is here and nowhere else still gets a firehose; a name
 * that is elsewhere and not here is never delivered at all. The catalog
 * entries therefore come from `@dina/commerce-protocol` rather than being
 * spelled a third time — the publisher and the handler map already agree
 * through those constants, and a subscription list that disagreed with both
 * would fail silently, which is how the original defect stayed invisible.
 */
export const TRUST_COLLECTIONS = [
  'com.dinakernel.peerlens.attestation',
  'com.dinakernel.peerlens.vouch',
  'com.dinakernel.peerlens.endorsement',
  'com.dinakernel.peerlens.flag',
  'com.dinakernel.peerlens.reply',
  'com.dinakernel.peerlens.reaction',
  'com.dinakernel.peerlens.reportRecord',
  'com.dinakernel.peerlens.revocation',
  'com.dinakernel.peerlens.delegation',
  'com.dinakernel.peerlens.collection',
  'com.dinakernel.peerlens.media',
  'com.dinakernel.peerlens.subject',
  'com.dinakernel.peerlens.amendment',
  'com.dinakernel.peerlens.verification',
  'com.dinakernel.peerlens.reviewRequest',
  'com.dinakernel.peerlens.comparison',
  'com.dinakernel.peerlens.subjectClaim',
  'com.dinakernel.peerlens.trustPolicy',
  'com.dinakernel.peerlens.notificationPrefs',
  'com.dinakernel.service.profile',
  CATALOG_POINTER_NSID,
  CATALOG_SNAPSHOT_NSID,
  'com.dinakernel.commerce.relationshipClaim',
] as const

export type TrustCollection = typeof TRUST_COLLECTIONS[number]

/** Map from short record type name to full collection NSID */
export const COLLECTION_NSID_MAP: Record<string, TrustCollection> = {
  attestation: 'com.dinakernel.peerlens.attestation',
  vouch: 'com.dinakernel.peerlens.vouch',
  endorsement: 'com.dinakernel.peerlens.endorsement',
  flag: 'com.dinakernel.peerlens.flag',
  reply: 'com.dinakernel.peerlens.reply',
  reaction: 'com.dinakernel.peerlens.reaction',
  reportRecord: 'com.dinakernel.peerlens.reportRecord',
  revocation: 'com.dinakernel.peerlens.revocation',
  delegation: 'com.dinakernel.peerlens.delegation',
  collection: 'com.dinakernel.peerlens.collection',
  media: 'com.dinakernel.peerlens.media',
  subject: 'com.dinakernel.peerlens.subject',
  amendment: 'com.dinakernel.peerlens.amendment',
  verification: 'com.dinakernel.peerlens.verification',
  reviewRequest: 'com.dinakernel.peerlens.reviewRequest',
  comparison: 'com.dinakernel.peerlens.comparison',
  subjectClaim: 'com.dinakernel.peerlens.subjectClaim',
  trustPolicy: 'com.dinakernel.peerlens.trustPolicy',
  notificationPrefs: 'com.dinakernel.peerlens.notificationPrefs',
  serviceProfile: 'com.dinakernel.service.profile',
  commerceCatalog: CATALOG_POINTER_NSID,
  commerceCatalogSnapshot: CATALOG_SNAPSHOT_NSID,
  commerceRelationshipClaim: 'com.dinakernel.commerce.relationshipClaim',
}
