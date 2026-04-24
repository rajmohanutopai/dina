/**
 * Typed chat-response hierarchy — constructors, discriminator shape,
 * and the `ChatResponse.typed` round-trip through `handleChat`.
 *
 * Source: port of `brain/src/domain/response.py`.
 */

import {
  confirmResponse,
  contactListResponse,
  errorResponse,
  plainResponse,
  richResponse,
  sendResponse,
  statusResponse,
  trustScoreResponse,
  type BotResponse,
} from '../../src/chat/response_types';
import {
  handleChat,
  resetAskCommandHandler,
  resetChatDefaults,
  resetServiceCommandHandler,
  resetServiceApproveCommandHandler,
  resetServiceDenyCommandHandler,
} from '../../src/chat/orchestrator';
import { resetThreads } from '../../src/chat/thread';
import { resetStagingState } from '../../../core/src/staging/service';

describe('Typed response constructors', () => {
  it('plainResponse carries kind + text + plain format', () => {
    const r = plainResponse('hello');
    expect(r.kind).toBe('plain');
    expect(r.text).toBe('hello');
    expect(r.format).toBe('plain');
  });

  it('richResponse flags rich format', () => {
    const r = richResponse('hello');
    expect(r.kind).toBe('rich');
    expect(r.format).toBe('rich');
  });

  it('errorResponse is discriminated for UI styling', () => {
    const r = errorResponse('something failed');
    expect(r.kind).toBe('error');
    expect(r.text).toBe('something failed');
  });

  it('confirmResponse carries options the UI can render as buttons', () => {
    const r = confirmResponse('Publish now?', [
      { label: 'Publish', action: 'confirm' },
      { label: 'Cancel', action: 'cancel' },
    ]);
    expect(r.kind).toBe('confirm');
    expect(r.options).toHaveLength(2);
    expect(r.options[0].label).toBe('Publish');
  });

  it('statusResponse defaults text from fields when not supplied', () => {
    const r = statusResponse({ did: 'did:plc:x', status: 'healthy', version: '0.1.0' });
    expect(r.kind).toBe('status');
    expect(r.did).toBe('did:plc:x');
    expect(r.text).toContain('healthy');
    expect(r.text).toContain('0.1.0');
  });

  it('contactListResponse renders a safe text fallback for text-only channels', () => {
    const r = contactListResponse([
      { displayName: 'Alice', did: 'did:plc:alice_long_did_string' },
      { displayName: 'Bob', did: 'did:plc:bob_long_did_string' },
    ]);
    expect(r.kind).toBe('contact_list');
    expect(r.contacts).toHaveLength(2);
    expect(r.text).toContain('Alice');
    expect(r.text).toContain('Bob');
  });

  it('trustScoreResponse carries both the numeric score + natural-language text', () => {
    const r = trustScoreResponse({
      displayName: 'Acme',
      did: 'did:plc:acme',
      score: 0.92,
      totalAttestations: 10,
      positiveAttestations: 9,
      vouchCount: 3,
    });
    expect(r.kind).toBe('trust_score');
    expect(r.score).toBe(0.92);
    expect(r.text).toContain('Acme');
    expect(r.text).toContain('9/10');
    expect(r.text).toContain('3 vouches');
  });

  it('sendResponse acknowledges the D2D send', () => {
    const r = sendResponse({
      contact: 'Sancho',
      messageType: 'text',
      messageText: 'hi!',
    });
    expect(r.kind).toBe('send');
    expect(r.text).toContain('Sancho');
  });
});

describe('handleChat wires typed envelopes through to ChatResponse', () => {
  beforeEach(() => {
    resetThreads();
    resetStagingState();
    resetAskCommandHandler();
    resetChatDefaults();
    resetServiceCommandHandler();
    resetServiceApproveCommandHandler();
    resetServiceDenyCommandHandler();
  });

  it('/help returns a rich envelope', async () => {
    const result = await handleChat('/help');
    expect(result.typed.kind).toBe('rich');
    expect(result.response).toContain('/help');
  });

  it('/remember returns a plain envelope with the same text as response', async () => {
    const result = await handleChat("/remember Emma's birthday is March 15");
    expect(result.typed.kind).toBe('plain');
    expect(result.typed.text).toBe(result.response);
  });

  it('/service_approve <id> with no handler installed returns a plain "not wired" envelope', async () => {
    // Bare `/service_approve` (no id) is parsed as `intent: chat` by
    // `parseServiceApproveCommand` — operators must supply an id.
    // Use a valid id so the intent resolves to `service_approve`, no
    // handler is installed → we get the plain "Coming soon" body.
    const result = await handleChat('/service_approve task-123');
    expect(result.typed.kind).toBe('plain');
    expect(result.response).toMatch(/Coming soon/);
  });

  it('discriminated union — every response has a kind', async () => {
    const result = await handleChat('/help');
    const typed: BotResponse = result.typed;
    // TypeScript would refuse to access `options` on a non-confirm
    // kind; this exercises the narrowing at runtime too.
    switch (typed.kind) {
      case 'rich':
        expect(typed.format).toBe('rich');
        break;
      default:
        throw new Error(`unexpected kind: ${typed.kind}`);
    }
  });
});
