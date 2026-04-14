/** All trust record collection NSIDs */
export const TRUST_COLLECTIONS = [
  'com.dina.trust.attestation',
  'com.dina.trust.vouch',
  'com.dina.trust.endorsement',
  'com.dina.trust.flag',
  'com.dina.trust.reply',
  'com.dina.trust.reaction',
  'com.dina.trust.reportRecord',
  'com.dina.trust.revocation',
  'com.dina.trust.delegation',
  'com.dina.trust.collection',
  'com.dina.trust.media',
  'com.dina.trust.subject',
  'com.dina.trust.amendment',
  'com.dina.trust.verification',
  'com.dina.trust.reviewRequest',
  'com.dina.trust.comparison',
  'com.dina.trust.subjectClaim',
  'com.dina.trust.trustPolicy',
  'com.dina.trust.notificationPrefs',
  'com.dina.service.profile',
] as const

export type TrustCollection = typeof TRUST_COLLECTIONS[number]

/** Map from short record type name to full collection NSID */
export const COLLECTION_NSID_MAP: Record<string, TrustCollection> = {
  attestation: 'com.dina.trust.attestation',
  vouch: 'com.dina.trust.vouch',
  endorsement: 'com.dina.trust.endorsement',
  flag: 'com.dina.trust.flag',
  reply: 'com.dina.trust.reply',
  reaction: 'com.dina.trust.reaction',
  reportRecord: 'com.dina.trust.reportRecord',
  revocation: 'com.dina.trust.revocation',
  delegation: 'com.dina.trust.delegation',
  collection: 'com.dina.trust.collection',
  media: 'com.dina.trust.media',
  subject: 'com.dina.trust.subject',
  amendment: 'com.dina.trust.amendment',
  verification: 'com.dina.trust.verification',
  reviewRequest: 'com.dina.trust.reviewRequest',
  comparison: 'com.dina.trust.comparison',
  subjectClaim: 'com.dina.trust.subjectClaim',
  trustPolicy: 'com.dina.trust.trustPolicy',
  notificationPrefs: 'com.dina.trust.notificationPrefs',
  serviceProfile: 'com.dina.service.profile',
}
