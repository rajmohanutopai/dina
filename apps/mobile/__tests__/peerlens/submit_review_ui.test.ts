/**
 * `submitReviewFromUI` — the binding that resolves the booted node + global repo
 * and calls `submitReviewPublish`. Pins the credential bridge (round-4 P2a):
 * when the dev/E2E test-inject path is active, a sentinel publisher is passed so
 * the credential gate doesn't reject an inject-only build (no real PDS account).
 * `submitReviewPublish` is mocked so we assert exactly what it's handed.
 */

jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: jest.fn(),
}));
jest.mock('../../src/peerlens/appview_runtime', () => ({
  __esModule: true,
  isTestPublishConfigured: jest.fn(),
  injectAttestation: jest.fn(),
}));
jest.mock('../../src/peerlens/submit_review_publish', () => ({
  __esModule: true,
  submitReviewPublish: jest.fn(async () => ({ kind: 'published', uri: 'at://x', cid: 'c' })),
}));

import { InMemoryReviewPublishRepository, setReviewPublishRepository } from '@dina/core';

import { getBootedNode } from '../../src/hooks/useNodeBootstrap';
import { isTestPublishConfigured } from '../../src/peerlens/appview_runtime';
import { submitReviewPublish } from '../../src/peerlens/submit_review_publish';
import { submitReviewFromUI } from '../../src/peerlens/submit_review_ui';

import type { AttestationDraftBody } from '../../src/peerlens/review_draft_body';

const mockNode = getBootedNode as jest.MockedFunction<typeof getBootedNode>;
const mockInjectConfigured = isTestPublishConfigured as jest.MockedFunction<typeof isTestPublishConfigured>;
const mockSubmit = submitReviewPublish as jest.MockedFunction<typeof submitReviewPublish>;

const DRAFT: AttestationDraftBody = {
  sentiment: 'positive',
  headline: 'Solid',
  body: 'Good.',
  confidence: 'high',
  subjectTitle: 'Chair',
};

function callUI(): Promise<unknown> {
  return submitReviewFromUI({ rkey: 'rk', record: { text: 'x' }, draft: DRAFT });
}

beforeEach(() => {
  setReviewPublishRepository(new InMemoryReviewPublishRepository());
});
afterEach(() => {
  setReviewPublishRepository(null);
  jest.clearAllMocks();
});

it('inject active + NO real publisher → passes a sentinel publisher + the inject publishToPDS', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockNode.mockReturnValue({ did: 'did:plc:owner', pdsPublisher: undefined } as any);
  mockInjectConfigured.mockReturnValue(true);

  await callUI();

  const arg = mockSubmit.mock.calls[0][0];
  expect(arg.publisher).not.toBeUndefined(); // sentinel — credential gate passes
  expect(arg.publishToPDS).toBeDefined(); // the inject path is wired in
});

it('inject OFF + NO real publisher → publisher undefined (real no_credentials path) + no inject', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockNode.mockReturnValue({ did: 'did:plc:owner', pdsPublisher: undefined } as any);
  mockInjectConfigured.mockReturnValue(false);

  await callUI();

  const arg = mockSubmit.mock.calls[0][0];
  expect(arg.publisher).toBeUndefined();
  expect(arg.publishToPDS).toBeUndefined();
});

it('a real publisher is passed straight through (no sentinel)', async () => {
  const realPublisher = { publish: () => undefined };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockNode.mockReturnValue({ did: 'did:plc:owner', pdsPublisher: realPublisher } as any);
  mockInjectConfigured.mockReturnValue(false);

  await callUI();

  expect(mockSubmit.mock.calls[0][0].publisher).toBe(realPublisher);
});

it('returns an error without calling submitReviewPublish when the node is not ready', async () => {
  mockNode.mockReturnValue(null);
  mockInjectConfigured.mockReturnValue(false);

  const out = (await callUI()) as { kind: string };

  expect(out.kind).toBe('error');
  expect(mockSubmit).not.toHaveBeenCalled();
});
