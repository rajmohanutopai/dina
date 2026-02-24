import { pgTable, text, timestamp, bigint } from 'drizzle-orm/pg-core'

export const ingesterCursor = pgTable('ingester_cursor', {
  service: text('service').primaryKey(),
  cursor: bigint('cursor', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})
