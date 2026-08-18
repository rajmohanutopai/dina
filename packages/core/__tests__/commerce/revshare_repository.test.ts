/**
 * §5 — the revshare document store, BOTH backends against one body:
 * the SQLite arm (migration v40) previously ran only in production,
 * so a column drift or index miss surfaced on a live node first.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryRevshareDocumentRepository,
  SQLiteRevshareDocumentRepository,
  type RevshareDocumentRepository,
  type RevshareDocumentRow,
} from '../../src/commerce/revshare_ledger';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

interface Backend {
  name: string;
  make: () => { repo: RevshareDocumentRepository; close: () => void };
}

const backends: Backend[] = [
  {
    name: 'sqlite',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-revshare-repo-'));
      const adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteRevshareDocumentRepository(adapter),
        close: () => {
          adapter.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'memory',
    make: () => ({ repo: new InMemoryRevshareDocumentRepository(), close: () => undefined }),
  },
];

function row(overrides: Partial<RevshareDocumentRow>): RevshareDocumentRow {
  return {
    recordDigest: 'a'.repeat(64),
    kind: 'agreement_proposal',
    counterpartyDid: 'did:plc:vendor000000000000000000',
    proposalDigest: '',
    answersDigest: '',
    direction: 'outbound',
    recordJson: '{"stub":true}',
    evidenceJson: '{}',
    createdAt: 1_800_000_000_000,
    ...overrides,
  };
}

describe.each(backends)('revshare document store ($name)', ({ make }) => {
  let repo: RevshareDocumentRepository;
  let close: () => void;

  beforeEach(() => {
    ({ repo, close } = make());
  });
  afterEach(() => close());

  it('round-trips a row; first writer wins on the digest', () => {
    const first = row({});
    expect(repo.put(first)).toBe(true);
    expect(repo.put(row({ recordJson: '{"stub":"other"}' }))).toBe(false);
    expect(repo.get(first.recordDigest)).toEqual(first);
    expect(repo.get('f'.repeat(64))).toBeNull();
  });

  it('listByProposal and answersTo select by kind, listByCounterparty by party', () => {
    const proposal = row({ recordDigest: 'b'.repeat(64) });
    const note = row({
      recordDigest: 'c'.repeat(64),
      kind: 'settlement_note',
      proposalDigest: proposal.recordDigest,
      direction: 'inbound',
    });
    const ack = row({
      recordDigest: 'd'.repeat(64),
      kind: 'settlement_ack',
      proposalDigest: proposal.recordDigest,
      answersDigest: note.recordDigest,
    });
    for (const entry of [proposal, note, ack]) expect(repo.put(entry)).toBe(true);

    expect(repo.listByProposal(proposal.recordDigest, 'settlement_note').map((r) => r.recordDigest)).toEqual([note.recordDigest]);
    expect(repo.listByProposal(proposal.recordDigest, 'settlement_ack').map((r) => r.recordDigest)).toEqual([ack.recordDigest]);
    expect(repo.answersTo(note.recordDigest, 'settlement_ack').map((r) => r.recordDigest)).toEqual([ack.recordDigest]);
    expect(repo.answersTo(note.recordDigest, 'settlement_note')).toEqual([]);
    expect(
      repo.listByCounterparty('did:plc:vendor000000000000000000', 'agreement_proposal').map((r) => r.recordDigest),
    ).toEqual([proposal.recordDigest]);
    expect(repo.listByCounterparty('did:plc:nobody0000000000000000000', 'agreement_proposal')).toEqual([]);
  });
});
