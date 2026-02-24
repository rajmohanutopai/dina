/**
 * Database types — Drizzle $inferSelect / $inferInsert re-exports.
 * These are populated after the schema files are created.
 * For now, provide the type aliases that other files reference.
 */

// Re-export from schema when available
export type { } from 'drizzle-orm'

// Placeholder types for DrizzleDB — resolved by connection.ts
export type DrizzleDB = import('drizzle-orm/node-postgres').NodePgDatabase
export type DrizzleTransaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0]
