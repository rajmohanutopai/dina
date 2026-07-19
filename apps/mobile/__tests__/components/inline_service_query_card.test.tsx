/**
 * Tests for InlineServiceQueryCard — the chat-thread inline renderer for
 * `service_query` lifecycle messages.
 *
 * Covers the four lifecycle states (pending / resolved / failed / expired)
 * + the CardSpec render path: a brain-supplied `lc.cardSpec` is used
 * verbatim; otherwise the renderer derives one on the fly from `result`
 * via the deterministic mapper; otherwise it falls back to the generic
 * text card. The card is drawn by `SafeCardRenderer` from the fixed
 * vocabulary — there is no per-capability TSX.
 */

import { render, screen } from '@testing-library/react-native';
import React from 'react';

import {
  addLifecycleMessage,
  resetThreads,
  type ChatMessage,
  getThread,
} from '@dina/brain/chat';

import { InlineServiceQueryCard } from '../../src/components/InlineServiceQueryCard';

import type { CardSpec } from '@dina/protocol';

const THREAD = 'test-thread';

function lastMessage(): ChatMessage {
  const thread = getThread(THREAD);
  return thread[thread.length - 1]!;
}

describe('InlineServiceQueryCard', () => {
  beforeEach(() => {
    resetThreads();
  });

  it('renders an eta result via the render-time CardSpec mapper (title + stat + maps link)', () => {
    addLifecycleMessage(THREAD, 'Route 8 — 4 min', {
      kind: 'service_query',
      status: 'resolved',
      taskId: 'task-1',
      queryId: 'q-1',
      capability: 'eta_query',
      serviceName: 'Demo ETA',
      result: {
        eta_minutes: 4,
        route_name: 'Route 8',
        stop_name: 'Main St',
        status: 'on_route',
        map_url: 'https://maps.example.com/x',
      },
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    // title ← route_name; stat value ← eta_minutes; link ← map_url
    expect(screen.getByText('Route 8')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('Open in Maps')).toBeTruthy();
  });

  it('prefers a brain-supplied lc.cardSpec over the render-time mapper (Card-4)', () => {
    const cardSpec: CardSpec = {
      version: 1,
      blocks: [
        { kind: 'title', text: 'Pre-baked Card', icon: 'store' },
        { kind: 'stat', value: '$0.79', caption: 'Organic Bananas' },
      ],
    };
    addLifecycleMessage(THREAD, 'fallback text that must NOT show', {
      kind: 'service_query',
      status: 'resolved',
      taskId: 'task-cs',
      queryId: 'q-cs',
      capability: 'price_check',
      serviceName: 'Corner Market',
      result: { price: 999 }, // would map to a DIFFERENT card if used
      cardSpec,
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    // The persisted spec wins; the render-time mapper is not consulted.
    expect(screen.getByText('Pre-baked Card')).toBeTruthy();
    expect(screen.getByText('$0.79')).toBeTruthy();
    expect(screen.queryByText('999')).toBeFalsy();
    expect(screen.queryByText('fallback text that must NOT show')).toBeFalsy();
  });

  it('shows the staged handoff while pending', () => {
    addLifecycleMessage(THREAD, 'Looking…', {
      kind: 'service_query',
      status: 'pending',
      taskId: 'task-2',
      queryId: 'q-2',
      capability: 'eta_query',
      serviceName: 'Demo ETA',
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText(/Asked the Dina service directory/)).toBeTruthy();
  });

  it('renders an appointment result (title + toned Status, no provider badge)', () => {
    addLifecycleMessage(THREAD, 'Reply from Dr Carl', {
      kind: 'service_query',
      status: 'resolved',
      taskId: 'task-3',
      queryId: 'q-3',
      capability: 'appointment_status',
      serviceName: "Dr Carl's Clinic",
      result: { status: 'confirmed', date: 'June 3' },
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText("Dr Carl's Clinic")).toBeTruthy();
    // Provider status is a toned keyValue, never a Dina trust badge.
    expect(screen.getByText('Confirmed')).toBeTruthy();
  });

  it('renders failed state', () => {
    addLifecycleMessage(THREAD, 'failed', {
      kind: 'service_query',
      status: 'failed',
      taskId: 'task-4',
      queryId: 'q-4',
      capability: 'eta_query',
      serviceName: 'Demo ETA',
      error: 'provider unavailable',
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText(/couldn't reach/)).toBeTruthy();
  });

  it('renders expired state', () => {
    addLifecycleMessage(THREAD, 'expired', {
      kind: 'service_query',
      status: 'expired',
      taskId: 'task-5',
      queryId: 'q-5',
      capability: 'eta_query',
      serviceName: 'Demo ETA',
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText(/No response from/)).toBeTruthy();
  });

  // ── Collapsed failure for CONTACT (relationship) services ───────────────────
  // CONTACT_SERVICES_ARCHITECTURE.md §2/§10: for a relationship service every
  // negative path must look the SAME and reveal NO reason, so the requester
  // can't infer the grantor's decision or their own rank. The flag is
  // `lc.relationship === true` (set by chat_d2d.sendServiceQuery).

  it('collapses a relationship FAILED card to a generic outcome (no reason leaked)', () => {
    addLifecycleMessage(THREAD, 'failed', {
      kind: 'service_query',
      status: 'failed',
      taskId: 'task-rel-failed',
      queryId: 'q-rel-failed',
      capability: 'availability_coordination',
      serviceName: 'Sancho',
      error: 'policy soft-reject', // would leak — must NOT render
      relationship: true,
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByTestId('chat-card-service-failed')).toBeTruthy();
    expect(screen.getByText(/Couldn't set up Sancho/)).toBeTruthy();
    // The reason and the public "couldn't reach" wording are both suppressed.
    expect(screen.queryByText('policy soft-reject')).toBeFalsy();
    expect(screen.queryByText(/couldn't reach/)).toBeFalsy();
  });

  it('collapses a relationship EXPIRED card identically to FAILED (indistinguishable)', () => {
    addLifecycleMessage(THREAD, 'expired', {
      kind: 'service_query',
      status: 'expired',
      taskId: 'task-rel-expired',
      queryId: 'q-rel-expired',
      capability: 'availability_coordination',
      serviceName: 'Sancho',
      relationship: true,
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    // Same generic card as the failed case — a timeout is indistinguishable
    // from a refusal to the requester.
    expect(screen.getByTestId('chat-card-service-failed')).toBeTruthy();
    expect(screen.getByText(/Couldn't set up Sancho/)).toBeTruthy();
    expect(screen.queryByText(/No response from/)).toBeFalsy();
  });

  it('does NOT collapse a PUBLIC service failure — the reason is still shown', () => {
    addLifecycleMessage(THREAD, 'failed', {
      kind: 'service_query',
      status: 'failed',
      taskId: 'task-pub-failed',
      queryId: 'q-pub-failed',
      capability: 'eta_query',
      serviceName: 'Demo ETA',
      error: 'provider unavailable',
      // relationship flag ABSENT → public service, no trust tier to leak.
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText(/couldn't reach/)).toBeTruthy();
    expect(screen.getByText('provider unavailable')).toBeTruthy();
    expect(screen.queryByTestId('chat-card-service-failed')).toBeFalsy();
  });

  it('falls back to the generic text card when there is no result and no cardSpec', () => {
    addLifecycleMessage(THREAD, 'Generic reply text', {
      kind: 'service_query',
      status: 'resolved',
      taskId: 'task-6',
      queryId: 'q-6',
      capability: 'price_check',
      serviceName: 'Shopbot',
      // no result, no cardSpec
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText('Generic reply text')).toBeTruthy();
  });

  it('re-validates lc.cardSpec at the render boundary — a corrupt persisted card falls back', () => {
    // readLifecycle only checks the discriminator then casts, so a corrupt /
    // imported / legacy row reaches the renderer unvalidated. The boundary
    // re-validation (validateCardSpec → null) must reject a bad-version /
    // non-array-blocks card and fall back to the generic text card.
    addLifecycleMessage(THREAD, 'fallback text body', {
      kind: 'service_query',
      status: 'resolved',
      taskId: 'task-corrupt',
      queryId: 'q-corrupt',
      capability: 'price_check',
      serviceName: 'Corner Market',
      // deliberately corrupt: bad version + non-array blocks
      cardSpec: { version: 99, blocks: 'not-an-array' } as unknown as CardSpec,
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText('Corner Market')).toBeTruthy();
    expect(screen.getByText('fallback text body')).toBeTruthy();
    expect(screen.queryByText('not-an-array')).toBeFalsy();
  });

  it('drops a stray provider trust badge from a persisted card at the render boundary', () => {
    // Untrusted re-validation strips a Dina-owned badge even if one was
    // somehow persisted into the lifecycle row.
    addLifecycleMessage(THREAD, 'reply', {
      kind: 'service_query',
      status: 'resolved',
      taskId: 'task-badge',
      queryId: 'q-badge',
      capability: 'price_check',
      serviceName: 'Sketchy Seller',
      cardSpec: {
        version: 1,
        blocks: [
          { kind: 'title', text: 'Gadget' },
          { kind: 'badge', text: 'VERIFIED SELLER', tone: 'positive' },
        ],
      } as CardSpec,
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText('Gadget')).toBeTruthy();
    expect(screen.queryByText('VERIFIED SELLER')).toBeFalsy();
  });

  it('marks an expired persisted card (past expiresAt) as Expired (#6)', () => {
    addLifecycleMessage(THREAD, 'reply', {
      kind: 'service_query',
      status: 'resolved',
      taskId: 'task-exp',
      queryId: 'q-exp',
      capability: 'price_check',
      serviceName: 'Corner Market',
      cardSpec: {
        version: 1,
        blocks: [{ kind: 'title', text: 'Old Price' }],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      } as CardSpec,
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText('Old Price')).toBeTruthy();
    expect(screen.getByText('Expired', { exact: false })).toBeTruthy();
  });

  it('does NOT mark a fresh persisted card (ttl window still open) as Expired (#6)', () => {
    addLifecycleMessage(THREAD, 'reply', {
      kind: 'service_query',
      status: 'resolved',
      taskId: 'task-fresh',
      queryId: 'q-fresh',
      capability: 'price_check',
      serviceName: 'Corner Market',
      cardSpec: {
        version: 1,
        blocks: [{ kind: 'title', text: 'Fresh Price' }],
        generatedAt: new Date().toISOString(),
        ttlSeconds: 3600,
      } as CardSpec,
    });

    render(<InlineServiceQueryCard message={lastMessage()} />);

    expect(screen.getByText('Fresh Price')).toBeTruthy();
    expect(screen.queryByText('Expired', { exact: false })).toBeNull();
  });
});
