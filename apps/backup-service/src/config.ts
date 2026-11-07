/**
 * Environment config. Nothing here is a secret: the store holds no key that
 * opens what it keeps.
 */

export interface BackupConfig {
  port: number;
  host: string;
  dbPath: string;
  /** Largest copy accepted, in bytes. */
  maxCopyBytes: number;
  /** Calls per backup id per window. */
  rateLimit: { max: number; windowMs: number };
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): BackupConfig {
  return {
    port: int(env, 'BACKUP_PORT', 8310),
    host: env.BACKUP_LISTEN_HOST || '0.0.0.0',
    dbPath: env.BACKUP_DB_PATH || '/data/backups.sqlite',
    maxCopyBytes: int(env, 'BACKUP_MAX_COPY_BYTES', 64 * 1024 * 1024),
    rateLimit: {
      max: int(env, 'BACKUP_RATE_MAX', 60),
      windowMs: int(env, 'BACKUP_RATE_WINDOW_MS', 10 * 60 * 1000),
    },
  };
}
