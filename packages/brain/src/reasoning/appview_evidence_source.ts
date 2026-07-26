/**
 * AppView protocol adapter for Core-owned reasoning context projection.
 *
 * This module performs wire-shape translation only. Core remains responsible
 * for authorization, quotas, PII scrubbing, evidence IDs, source labels, and
 * the final model projection.
 */

import { getCapabilityEntry } from '@dina/protocol';

import type { AppViewClient, PeerlensAttestation, ServiceProfile } from '../appview_client/http';
import type { PublicReasoningEvidenceCandidate, PublicReasoningEvidenceSource } from '@dina/core';

type EvidenceAppViewClient = Pick<
  AppViewClient,
  'searchCapabilities' | 'searchServices' | 'searchTrust'
>;

const MAX_REVIEW_QUERY_CHARS = 200;
const MAX_CAPABILITY_INTENT_CHARS = 500;
const MAX_CAPABILITIES_PER_QUERY = 3;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function confidence(value: unknown): number | undefined {
  switch (value) {
    case 'speculative':
      return 0.25;
    case 'moderate':
      return 0.5;
    case 'high':
      return 0.75;
    case 'certain':
      return 1;
    default:
      return undefined;
  }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function reviewText(attestation: PeerlensAttestation): string {
  const row = attestation as Record<string, unknown>;
  const text =
    nonEmptyString(row.text) ??
    nonEmptyString(row.summary) ??
    nonEmptyString(row.body) ??
    nonEmptyString(row.headline);
  const labels = [
    nonEmptyString(row.authorHandle) ?? nonEmptyString(row.authorDid),
    nonEmptyString(row.sentiment),
    nonEmptyString(row.confidence),
    nonEmptyString(row.category),
  ].filter((value): value is string => value !== null);
  const tags = Array.isArray(row.tags)
    ? row.tags.filter((value): value is string => typeof value === 'string').slice(0, 8)
    : [];
  return [
    labels.length === 0 ? '' : `Reviewer / assessment: ${labels.join(' | ')}`,
    text ?? '',
    tags.length === 0 ? '' : `Tags: ${tags.join(', ')}`,
  ]
    .filter((value) => value !== '')
    .join('\n');
}

function reviewId(attestation: PeerlensAttestation): string {
  return (
    nonEmptyString(attestation.uri) ??
    nonEmptyString(attestation.cid) ??
    JSON.stringify({
      authorDid: attestation.authorDid ?? null,
      subjectId: attestation.subjectId ?? null,
      category: attestation.category ?? null,
      createdAt: attestation.recordCreatedAt ?? null,
    })
  );
}

function serviceText(profile: ServiceProfile): string {
  return [
    `Service: ${profile.name}`,
    nonEmptyString(profile.description) ?? '',
    `Capabilities: ${profile.capabilities.join(', ')}`,
    nonEmptyString(profile.handle) === null ? '' : `Provider: ${profile.handle}`,
  ]
    .filter((value) => value !== '')
    .join('\n');
}

function serviceId(profile: ServiceProfile): string {
  return profile.uri ?? `${profile.did}:${profile.name}:${profile.capabilities.join(',')}`;
}

/**
 * Create the one shared AppView evidence adapter used by mobile and Home Node.
 */
export function createAppViewReasoningEvidenceSource(
  client: EvidenceAppViewClient,
): PublicReasoningEvidenceSource {
  return {
    async searchReviews(request) {
      const response = await client.searchTrust({
        q: request.query.slice(0, MAX_REVIEW_QUERY_CHARS),
        sort: 'relevant',
        limit: request.limit,
        viewerDid: request.ownerDid,
      });
      return response.results
        .map((attestation): PublicReasoningEvidenceCandidate | null => {
          if (record(attestation) === null) return null;
          const text = reviewText(attestation);
          if (text === '') return null;
          const reviewConfidence = confidence(attestation.confidence);
          const occurredAtMs = timestamp(attestation.recordCreatedAt);
          return {
            externalId: reviewId(attestation),
            text,
            ...(reviewConfidence === undefined ? {} : { confidence: reviewConfidence }),
            ...(occurredAtMs === undefined ? {} : { occurredAtMs }),
          };
        })
        .filter((candidate): candidate is PublicReasoningEvidenceCandidate => candidate !== null);
    },

    async searchServices(request) {
      const capabilities = (
        await client.searchCapabilities({
          intent: request.query.slice(0, MAX_CAPABILITY_INTENT_CHARS),
        })
      )
        .filter((candidate) => getCapabilityEntry(candidate.canonical)?.intentRoutable === true)
        .slice(0, MAX_CAPABILITIES_PER_QUERY);
      const searches = await Promise.allSettled(
        capabilities.map((candidate) =>
          client.searchServices({
            capability: candidate.canonical,
            limit: request.limit,
          }),
        ),
      );
      const firstRejection = searches.find((result) => result.status === 'rejected');
      if (
        capabilities.length > 0 &&
        searches.every((result) => result.status === 'rejected') &&
        firstRejection?.status === 'rejected'
      ) {
        throw firstRejection.reason;
      }
      return searches
        .filter(
          (result): result is PromiseFulfilledResult<ServiceProfile[]> =>
            result.status === 'fulfilled',
        )
        .map((result) => result.value)
        .flat()
        .map((profile) => ({
          externalId: serviceId(profile),
          text: serviceText(profile),
          ...(typeof profile.distanceKm === 'number' &&
          Number.isFinite(profile.distanceKm) &&
          profile.distanceKm >= 0
            ? { confidence: 1 / (1 + profile.distanceKm) }
            : {}),
        }))
        .slice(0, request.limit);
    },
  };
}
