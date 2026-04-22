/**
 * Sync engine — 2-pass email triage for data ingestion.
 *
 * Pass 1: Gmail category filter
 *   PRIMARY → INGEST, PROMOTIONS/SOCIAL/UPDATES/FORUMS → SKIP
 *
 * Pass 2: Sender/subject heuristics
 *   noreply/notifications → SKIP, OTP/verification → THIN, digest → THIN
 *
 * Fiduciary override: security alert / lab results keywords bypass SKIP.
 *
 * runSyncCycle: orchestrates fetch → triage → count via injectable data source.
 *
 * Source: brain/tests/test_sync.py
 */

export type TriageDecision = 'INGEST' | 'THIN' | 'SKIP';

export interface SyncResult {
  ingested: number;
  skipped: number;
  thinRecords: number;
  errors: number;
}

export interface EmailRecord {
  id: string;
  category: string;
  sender: string;
  subject: string;
  body?: string;
  [key: string]: unknown;
}

export type DataSourceProvider = (
  source: string,
  cursor?: string,
) => Promise<{
  emails: EmailRecord[];
  nextCursor?: string;
}>;

export type IngestHandler = (email: EmailRecord, decision: TriageDecision) => Promise<void>;

/** Categories that should be skipped (low-value Gmail tabs). */
const SKIP_CATEGORIES = new Set(['PROMOTIONS', 'SOCIAL', 'UPDATES', 'FORUMS']);

/** Sender patterns that indicate automated/no-reply emails. */
const SKIP_SENDER_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^notifications?@/i,
  /^alerts?@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
];

/** Subject patterns for OTP/verification codes (thin records only). */
const THIN_SUBJECT_PATTERNS = [
  /verification code/i,
  /verify your/i,
  /one-time/i,
  /otp/i,
  /confirm your/i,
  /reset your password/i,
  /login code/i,
  /weekly digest/i,
  /daily digest/i,
  /\bdigest\b/i,
];

/** Fiduciary keywords that override category SKIP. */
const FIDUCIARY_PATTERN =
  /security alert|unusual login|breach|overdrawn|lab result|diagnosis|emergency|payment due/i;

/** Injectable data source provider. */
let dataSource: DataSourceProvider | null = null;

/** Injectable ingest handler. */
let ingestHandler: IngestHandler | null = null;

/** Register a data source provider (e.g., Gmail connector). */
export function registerDataSource(provider: DataSourceProvider): void {
  dataSource = provider;
}

/** Register an ingest handler (called for each triaged email). */
export function registerIngestHandler(handler: IngestHandler): void {
  ingestHandler = handler;
}

/** Reset all providers (for testing). */
export function resetSyncProviders(): void {
  dataSource = null;
  ingestHandler = null;
}

/**
 * Run a sync cycle: fetch emails from source → triage each → ingest/skip.
 *
 * Orchestrates the full pipeline:
 * 1. Fetch emails from the registered data source
 * 2. Run 2-pass triage on each email
 * 3. Call ingest handler for INGEST/THIN items
 * 4. Return counts
 *
 * When no data source is registered, returns zero counts.
 */
export async function runSyncCycle(source: string, cursor?: string): Promise<SyncResult> {
  if (!dataSource) {
    return { ingested: 0, skipped: 0, thinRecords: 0, errors: 0 };
  }

  const result: SyncResult = { ingested: 0, skipped: 0, thinRecords: 0, errors: 0 };

  const { emails } = await dataSource(source, cursor);

  for (const email of emails) {
    try {
      const decision = triageEmail(email);

      if (decision === 'SKIP') {
        result.skipped++;
        continue;
      }

      // Call handler before counting — if handler throws, count as error
      if (ingestHandler) {
        await ingestHandler(email, decision);
      }

      if (decision === 'THIN') {
        result.thinRecords++;
      } else {
        result.ingested++;
      }
    } catch {
      result.errors++;
    }
  }

  return result;
}

/**
 * Triage a single email: INGEST, THIN, or SKIP.
 * Runs both passes in order, with fiduciary override.
 */
export function triageEmail(metadata: Record<string, unknown>): TriageDecision {
  const category = String(metadata.category ?? '');
  const sender = String(metadata.sender ?? '');
  const subject = String(metadata.subject ?? '');

  // Check fiduciary override first — overrides everything
  if (hasFiduciaryOverride(subject)) return 'INGEST';

  // Pass 1: Category filter
  const catDecision = pass1CategoryFilter(category);
  if (catDecision === 'SKIP') return 'SKIP';

  // Pass 2: Sender/subject heuristics
  return pass2SenderHeuristics(sender, subject);
}

/** Pass 1: Gmail category filter. */
export function pass1CategoryFilter(category: string): TriageDecision {
  if (SKIP_CATEGORIES.has(category)) return 'SKIP';
  return 'INGEST';
}

/** Pass 2: Sender/subject heuristics. */
export function pass2SenderHeuristics(sender: string, subject: string): TriageDecision {
  if (SKIP_SENDER_PATTERNS.some((p) => p.test(sender))) return 'SKIP';
  if (THIN_SUBJECT_PATTERNS.some((p) => p.test(subject))) return 'THIN';
  return 'INGEST';
}

/** Check if fiduciary keywords override a category SKIP. */
export function hasFiduciaryOverride(subject: string): boolean {
  return FIDUCIARY_PATTERN.test(subject);
}
