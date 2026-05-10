/** All trust record collection NSIDs */
export const TRUST_COLLECTIONS = [
  'com.dina.peerlens.attestation',
  'com.dina.peerlens.vouch',
  'com.dina.peerlens.endorsement',
  'com.dina.peerlens.flag',
  'com.dina.peerlens.reply',
  'com.dina.peerlens.reaction',
  'com.dina.peerlens.reportRecord',
  'com.dina.peerlens.revocation',
  'com.dina.peerlens.delegation',
  'com.dina.peerlens.collection',
  'com.dina.peerlens.media',
  'com.dina.peerlens.subject',
  'com.dina.peerlens.amendment',
  'com.dina.peerlens.verification',
  'com.dina.peerlens.reviewRequest',
  'com.dina.peerlens.comparison',
  'com.dina.peerlens.subjectClaim',
  'com.dina.peerlens.trustPolicy',
  'com.dina.peerlens.notificationPrefs',
  'com.dina.service.profile',
] as const

export type TrustCollection = typeof TRUST_COLLECTIONS[number]

/** Map from short record type name to full collection NSID */
export const COLLECTION_NSID_MAP: Record<string, TrustCollection> = {
  attestation: 'com.dina.peerlens.attestation',
  vouch: 'com.dina.peerlens.vouch',
  endorsement: 'com.dina.peerlens.endorsement',
  flag: 'com.dina.peerlens.flag',
  reply: 'com.dina.peerlens.reply',
  reaction: 'com.dina.peerlens.reaction',
  reportRecord: 'com.dina.peerlens.reportRecord',
  revocation: 'com.dina.peerlens.revocation',
  delegation: 'com.dina.peerlens.delegation',
  collection: 'com.dina.peerlens.collection',
  media: 'com.dina.peerlens.media',
  subject: 'com.dina.peerlens.subject',
  amendment: 'com.dina.peerlens.amendment',
  verification: 'com.dina.peerlens.verification',
  reviewRequest: 'com.dina.peerlens.reviewRequest',
  comparison: 'com.dina.peerlens.comparison',
  subjectClaim: 'com.dina.peerlens.subjectClaim',
  trustPolicy: 'com.dina.peerlens.trustPolicy',
  notificationPrefs: 'com.dina.peerlens.notificationPrefs',
  serviceProfile: 'com.dina.service.profile',
}
