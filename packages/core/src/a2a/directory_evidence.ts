/**
 * PeerLens evidence for the owner's review of a remote agent (design §6.1,
 * §8.4): a Dina agent's live card names its node's DID, and the directory
 * holds a card for that DID that AppView verified against the DID's own
 * keys, with the DID's PeerLens trust. That evidence is this agent's only
 * when the directory's card names the same endpoint the live card does:
 * then the agent at this endpoint is the DID the evidence is about. An agent
 * that names a DID it does not hold gets "not this agent's evidence", never
 * the DID's trust.
 *
 * Display only: evidence informs the owner's review and grants nothing
 * (A2A-I13). Nothing is stored; it is read when the owner looks. The host
 * installs the source (a trusted AppView client); with none installed (the
 * phone, or a node with no AppView) the answer is `unavailable`.
 */

import { DINA_A2A_EXTENSION_URI, isPlainObject, parseStrictJson } from '@dina/a2a';

import type { RemoteAgentRow } from './store';

/** The directory's verified card for a DID, as the host's AppView client reads it. */
export interface DirectoryCardEvidence {
  /** The JSON-RPC endpoint the directory's card names. */
  endpoint: string;
  trustScore: number;
  recommendation: 'proceed' | 'caution' | 'verify' | 'avoid';
  indexedAt: string;
  stale: boolean;
}

/** The directory's card for `did`, or null when it lists none; throws when the directory cannot answer. */
export type DirectoryEvidenceSource = (did: string) => Promise<DirectoryCardEvidence | null>;

let source: DirectoryEvidenceSource | null = null;

export function installA2ADirectoryEvidence(next: DirectoryEvidenceSource | null): void {
  source = next;
}

export type RemoteAgentEvidence =
  /** No directory on this host, or it did not answer. */
  | { status: 'unavailable' }
  /** The card names no Dina node, so the directory has nothing to say about it. */
  | { status: 'not_dina' }
  /** The directory lists no card for the DID the card names. */
  | { status: 'not_listed'; did: string }
  /** The directory's card for that DID names another endpoint: its evidence is not this agent's. */
  | { status: 'other_endpoint'; did: string }
  | {
      status: 'listed';
      did: string;
      trust_score: number;
      recommendation: DirectoryCardEvidence['recommendation'];
      indexed_at: string;
      stale: boolean;
    };

const NODE_DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:%-]{1,253})$/;

/** The node DID a pinned card's Dina extension names, or null. */
export function dinaNodeDidOfCard(cardJson: string): string | null {
  const card = parseStrictJson(cardJson);
  if (!card.ok || !isPlainObject(card.value) || !isPlainObject(card.value.capabilities)) return null;
  const extensions = card.value.capabilities.extensions;
  if (!Array.isArray(extensions)) return null;
  const dina = extensions.find((e) => isPlainObject(e) && e.uri === DINA_A2A_EXTENSION_URI);
  const did = isPlainObject(dina) && isPlainObject(dina.params) ? dina.params.did : undefined;
  return typeof did === 'string' && NODE_DID.test(did) ? did : null;
}

function sameEndpoint(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

export async function remoteAgentEvidence(agent: Pick<RemoteAgentRow, 'card_json' | 'endpoint'>): Promise<RemoteAgentEvidence> {
  const did = dinaNodeDidOfCard(agent.card_json);
  if (did === null) return { status: 'not_dina' };
  if (source === null) return { status: 'unavailable' };
  let listed: DirectoryCardEvidence | null;
  try {
    listed = await source(did);
  } catch {
    return { status: 'unavailable' };
  }
  if (listed === null) return { status: 'not_listed', did };
  if (!sameEndpoint(listed.endpoint, agent.endpoint)) return { status: 'other_endpoint', did };
  return {
    status: 'listed',
    did,
    trust_score: listed.trustScore,
    recommendation: listed.recommendation,
    indexed_at: listed.indexedAt,
    stale: listed.stale,
  };
}
