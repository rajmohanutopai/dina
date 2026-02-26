import { z } from 'zod'

const isProduction = process.env.NODE_ENV === 'production'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // In production, DATABASE_URL is required (no default with weak creds)
  DATABASE_URL: isProduction
    ? z.string().url()
    : z.string().default('postgresql://dina:dina@localhost:5432/dina_reputation'),
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
