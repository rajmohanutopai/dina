/**
 * The directory's PeerLens evidence in the owner's review of a remote agent
 * (design §6.1, §8.4). It is the agent's only when the directory's verified
 * card for the DID the live card names lists the same endpoint; otherwise
 * the owner hears it is someone else's. Display only, read on demand.
 */

import { DINA_A2A_EXTENSION_URI } from '@dina/a2a';

import {
  dinaNodeDidOfCard,
  installA2ADirectoryEvidence,
  remoteAgentEvidence,
  type DirectoryCardEvidence,
} from '../../src/a2a';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const ENDPOINT = 'https://bus.example/a2a/v1';

const cardJson = (extensions: unknown[] | undefined) =>
  JSON.stringify({ name: 'Bus', capabilities: extensions === undefined ? {} : { extensions } });
const dinaCard = (did: unknown = DID) => cardJson([{ uri: DINA_A2A_EXTENSION_URI, params: { did } }]);

const listed = (over: Partial<DirectoryCardEvidence> = {}): DirectoryCardEvidence => ({
  endpoint: ENDPOINT,
  trustScore: 0.8,
  recommendation: 'proceed',
  indexedAt: '2026-10-01T00:00:00.000Z',
  stale: false,
  ...over,
});

afterEach(() => installA2ADirectoryEvidence(null));

describe('the node DID a card names', () => {
  it.each([
    ['the Dina extension’s DID', dinaCard(), DID],
    ['no extensions', cardJson(undefined), null],
    ['another extension only', cardJson([{ uri: 'https://other.example/ext', params: { did: DID } }]), null],
    ['a malformed DID', dinaCard('did:plc:short'), null],
    ['a DID that is not a string', dinaCard(7), null],
    ['not JSON', '{', null],
  ])('%s → %p', (_name, json, did) => expect(dinaNodeDidOfCard(json)).toBe(did));
});

describe('the evidence', () => {
  it('a card that names no Dina node has none, and the directory is not asked', async () => {
    const asked: string[] = [];
    installA2ADirectoryEvidence(async (did) => (asked.push(did), listed()));
    expect(await remoteAgentEvidence({ card_json: cardJson(undefined), endpoint: ENDPOINT })).toEqual({ status: 'not_dina' });
    expect(asked).toEqual([]);
  });

  it('no directory on this host, or one that fails, is unavailable', async () => {
    expect(await remoteAgentEvidence({ card_json: dinaCard(), endpoint: ENDPOINT })).toEqual({ status: 'unavailable' });
    installA2ADirectoryEvidence(async () => {
      throw new Error('AppView responded 503');
    });
    expect(await remoteAgentEvidence({ card_json: dinaCard(), endpoint: ENDPOINT })).toEqual({ status: 'unavailable' });
  });

  it('a DID the directory does not list is said so', async () => {
    installA2ADirectoryEvidence(async () => null);
    expect(await remoteAgentEvidence({ card_json: dinaCard(), endpoint: ENDPOINT })).toEqual({ status: 'not_listed', did: DID });
  });

  it('the directory’s card for that DID names another endpoint: not this agent’s evidence, and none of its trust shown', async () => {
    installA2ADirectoryEvidence(async () => listed({ endpoint: 'https://trusted.example/a2a/v1' }));
    expect(await remoteAgentEvidence({ card_json: dinaCard(), endpoint: ENDPOINT })).toEqual({ status: 'other_endpoint', did: DID });
  });

  it('the same endpoint (as a URL, default port and all): the DID’s trust, as the directory states it', async () => {
    const asked: string[] = [];
    installA2ADirectoryEvidence(async (did) => (asked.push(did), listed({ endpoint: 'https://bus.example:443/a2a/v1', stale: true })));
    expect(await remoteAgentEvidence({ card_json: dinaCard(), endpoint: ENDPOINT })).toEqual({
      status: 'listed',
      did: DID,
      trust_score: 0.8,
      recommendation: 'proceed',
      indexed_at: '2026-10-01T00:00:00.000Z',
      stale: true,
    });
    expect(asked).toEqual([DID]);
  });
});
