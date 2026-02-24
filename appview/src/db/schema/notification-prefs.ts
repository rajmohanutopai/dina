import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core'

export const notificationPrefs = pgTable('notification_prefs', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull().unique(),
  cid: text('cid').notNull(),
  enableMentions: boolean('enable_mentions').default(true),
  enableReactions: boolean('enable_reactions').default(true),
  enableReplies: boolean('enable_replies').default(true),
  enableFlags: boolean('enable_flags').default(true),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
})
