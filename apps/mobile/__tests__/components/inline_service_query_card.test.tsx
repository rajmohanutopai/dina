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

import { InlineServiceQueryCard } from '../../src/components/InlineServiceQueryCard';
import {
  addLifecycleMessage,
  resetThreads,
  type ChatMessage,
  getThread,
} from '@dina/brain/chat';
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
});
