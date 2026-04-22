/**
 * ProductVerdict model — signed product review with attestation fields.
 *
 * Fields: product, verdict (BUY/WAIT/AVOID), confidence_score (0-100),
 * reasons[], hidden_warnings[].
 * Signature fields: signature_hex, signer_did (optional, null when unsigned).
 * stream_id: optional Ceramic/AT Protocol stream reference.
 *
 * Source: tests/test_models.py
 */

export type VerdictValue = 'BUY' | 'WAIT' | 'AVOID';

const VALID_VERDICTS = new Set<string>(['BUY', 'WAIT', 'AVOID']);

export interface ProductVerdict {
  product: string;
  verdict: VerdictValue;
  confidence_score: number; // 0-100
  reasons: string[];
  hidden_warnings: string[];
  signature_hex?: string | null;
  signer_did?: string | null;
  stream_id?: string | null;
}

/**
 * Create a ProductVerdict with validation and defaults.
 *
 * @param fields - Partial verdict fields. product, verdict, confidence_score are required.
 * @returns Complete ProductVerdict with defaults for optional fields
 * @throws if required fields are missing or invalid
 */
export function createVerdict(fields: Partial<ProductVerdict>): ProductVerdict {
  if (!fields.product) {
    throw new Error('verdict: product is required');
  }
  if (!fields.verdict || !VALID_VERDICTS.has(fields.verdict)) {
    throw new Error(
      `verdict: invalid verdict value "${fields.verdict}" (must be BUY, WAIT, or AVOID)`,
    );
  }
  if (fields.confidence_score === undefined || fields.confidence_score === null) {
    throw new Error('verdict: confidence_score is required');
  }
  if (fields.confidence_score < 0 || fields.confidence_score > 100) {
    throw new Error(`verdict: confidence_score must be 0-100, got ${fields.confidence_score}`);
  }

  return {
    product: fields.product,
    verdict: fields.verdict,
    confidence_score: fields.confidence_score,
    reasons: fields.reasons ?? [],
    hidden_warnings: fields.hidden_warnings ?? [],
    signature_hex: fields.signature_hex ?? null,
    signer_did: fields.signer_did ?? null,
    stream_id: fields.stream_id ?? null,
  };
}

/**
 * Validate a verdict. Returns array of error messages (empty = valid).
 */
export function validateVerdict(verdict: ProductVerdict): string[] {
  const errors: string[] = [];

  if (!verdict.product) {
    errors.push('product is required');
  }
  if (!VALID_VERDICTS.has(verdict.verdict)) {
    errors.push(`verdict must be BUY, WAIT, or AVOID, got "${verdict.verdict}"`);
  }
  if (verdict.confidence_score < 0) {
    errors.push(`confidence_score must be >= 0, got ${verdict.confidence_score}`);
  }
  if (verdict.confidence_score > 100) {
    errors.push(`confidence_score must be <= 100, got ${verdict.confidence_score}`);
  }
  if (!Array.isArray(verdict.reasons)) {
    errors.push('reasons must be an array');
  }
  if (!Array.isArray(verdict.hidden_warnings)) {
    errors.push('hidden_warnings must be an array');
  }

  return errors;
}

/**
 * Serialize verdict to JSON.
 * @param excludeSignature - If true, omit signature_hex and signer_did from output
 */
export function serializeVerdict(verdict: ProductVerdict, excludeSignature?: boolean): string {
  if (excludeSignature) {
    const { signature_hex, signer_did, ...rest } = verdict;
    return JSON.stringify(rest);
  }
  return JSON.stringify(verdict);
}

/**
 * Deserialize verdict from JSON.
 */
export function deserializeVerdict(json: string): ProductVerdict {
  const parsed = JSON.parse(json);
  return {
    product: parsed.product,
    verdict: parsed.verdict,
    confidence_score: parsed.confidence_score,
    reasons: parsed.reasons ?? [],
    hidden_warnings: parsed.hidden_warnings ?? [],
    signature_hex: parsed.signature_hex ?? null,
    signer_did: parsed.signer_did ?? null,
    stream_id: parsed.stream_id ?? null,
  };
}
