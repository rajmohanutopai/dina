/** All reputation record collection NSIDs */
export const REPUTATION_COLLECTIONS = [
  'com.dina.reputation.attestation',
  'com.dina.reputation.vouch',
  'com.dina.reputation.endorsement',
  'com.dina.reputation.flag',
  'com.dina.reputation.reply',
  'com.dina.reputation.reaction',
  'com.dina.reputation.reportRecord',
  'com.dina.reputation.revocation',
  'com.dina.reputation.delegation',
  'com.dina.reputation.collection',
  'com.dina.reputation.media',
  'com.dina.reputation.subject',
  'com.dina.reputation.amendment',
  'com.dina.reputation.verification',
  'com.dina.reputation.reviewRequest',
  'com.dina.reputation.comparison',
  'com.dina.reputation.subjectClaim',
  'com.dina.reputation.trustPolicy',
  'com.dina.reputation.notificationPrefs',
] as const

export type ReputationCollection = typeof REPUTATION_COLLECTIONS[number]

/** Map from short record type name to full collection NSID */
export const COLLECTION_NSID_MAP: Record<string, ReputationCollection> = {
  attestation: 'com.dina.reputation.attestation',
  vouch: 'com.dina.reputation.vouch',
  endorsement: 'com.dina.reputation.endorsement',
  flag: 'com.dina.reputation.flag',
  reply: 'com.dina.reputation.reply',
  reaction: 'com.dina.reputation.reaction',
  reportRecord: 'com.dina.reputation.reportRecord',
  revocation: 'com.dina.reputation.revocation',
  delegation: 'com.dina.reputation.delegation',
  collection: 'com.dina.reputation.collection',
  media: 'com.dina.reputation.media',
  subject: 'com.dina.reputation.subject',
  amendment: 'com.dina.reputation.amendment',
  verification: 'com.dina.reputation.verification',
  reviewRequest: 'com.dina.reputation.reviewRequest',
  comparison: 'com.dina.reputation.comparison',
  subjectClaim: 'com.dina.reputation.subjectClaim',
  trustPolicy: 'com.dina.reputation.trustPolicy',
  notificationPrefs: 'com.dina.reputation.notificationPrefs',
}
