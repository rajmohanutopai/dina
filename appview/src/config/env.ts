import { z } from 'zod'

// MED-01 fix: Resolve NODE_ENV through Zod first so the default 'production'
// is applied before we use it for conditional validation. This prevents the
// race where process.env.NODE_ENV is unset (isProduction=false) but Zod
// defaults it to 'production'.
const resolvedNodeEnv = z.enum(['development', 'test', 'production'])
  .default('production')
  .parse(process.env.NODE_ENV)

const isProduction = resolvedNodeEnv === 'production'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),

  // In production, DATABASE_URL is required (no default with weak creds)
  DATABASE_URL: isProduction
    ? z.string().url()
    : z.string().default('postgresql://dina:dina@localhost:5432/dina_trust'),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(20),

  // In production, JETSTREAM_URL is required
  JETSTREAM_URL: isProduction
    ? z.string()
    : z.string().default('ws://jetstream:6008'),

  NEXT_PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  PORT: z.coerce.number().default(3000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  RATE_LIMIT_RPM: z.coerce.number().default(60),
})

export type Env = z.infer<typeof envSchema>

export const env: Env = envSchema.parse(process.env)

// Runtime validation for production safety
if (isProduction) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production')
  }
  if (!process.env.JETSTREAM_URL) {
    throw new Error('JETSTREAM_URL is required in production')
  }
}

// Warn when dev defaults are in use
if (!process.env.DATABASE_URL) {
  console.warn('WARNING: Using default DATABASE_URL — not suitable for production')
}
