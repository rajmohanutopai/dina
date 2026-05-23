/**
 * `InlineServiceQueryCard` — covers the staged handoff stepper shown
 * while a service query is in flight, and the resolved ETA result.
 *
 * The stepper makes the Dina-to-Dina handoff visible: instead of one
 * opaque "Looking up…" spinner, the pending state walks four stages
 * (directory → found provider → sent to their Dina → awaiting reply).
 */

import { render, act, fireEvent } from '@testing-library/react-native';
import React from 'react';

import { InlineServiceQueryCard } from '../../src/components/InlineServiceQueryCard';
import type { ChatMessage } from '@dina/brain/chat';

const SERVICE = 'SF Transit Authority Live';

function msg(lifecycle: Record<string, unknown>, content = ''): ChatMessage {
  return {
    id: 'm1',
    threadId: 't1',
    type: 'dina',
    content,
    timestamp: Date.now(),
    metadata: { lifecycle },
  };
}

function pendingMsg(): ChatMessage {
  return msg({
    kind: 'service_query',
    status: 'pending',
    taskId: 'svc-exec-1',
    queryId: 'q-1',
    capability: 'eta_query',
    serviceName: SERVICE,
    providerDid: 'did:plc:6sk7wchkm6sfphb2jg3mwyzr',
    params: { route_id: '22' },
  });
}

function resolvedMsg(): ChatMessage {
  return msg({
    kind: 'service_query',
    status: 'resolved',
    taskId: 'svc-exec-1',
    queryId: 'q-1',
    capability: 'eta_query',
    serviceName: SERVICE,
    providerDid: 'did:plc:6sk7wchkm6sfphb2jg3mwyzr',
    result: {
      status: 'on_route',
      eta_minutes: 6,
      route_name: 'Route 42',
      stop_name: 'Mission and 16th',
      map_url: 'https://maps.example/x',
    },
  });
}

describe('InlineServiceQueryCard — pending handoff hop cards', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
  });

  it('renders all four handoff hops (not a single "Looking up")', () => {
    const { getByText, queryByText } = render(<InlineServiceQueryCard message={pendingMsg()} />);
    expect(getByText('Asked the Dina service directory')).toBeTruthy();
    expect(getByText(`Found ${SERVICE}`)).toBeTruthy();
    expect(getByText('Sent your query to their Dina')).toBeTruthy();
    expect(getByText(`Waiting for ${SERVICE} to reply…`)).toBeTruthy();
    // the old single-spinner copy is gone
    expect(queryByText(`Looking up ${SERVICE}…`)).toBeNull();
  });

  it('surfaces the other Dina: provider DID + the query params', () => {
    const { getByText } = render(<InlineServiceQueryCard message={pendingMsg()} />);
    // truncated provider DID is the "you're talking to someone else" signal
    expect(getByText('did:plc:6sk7wc…')).toBeTruthy();
    // params summary on the "sent query" hop (route_id → "route 22")
    expect(getByText('route 22')).toBeTruthy();
  });

  it('advances through the timeline without crashing', () => {
    const { getByText } = render(<InlineServiceQueryCard message={pendingMsg()} />);
    act(() => jest.advanceTimersByTime(4000));
    // labels persist across the advance (icon/card state changes, not text)
    expect(getByText(`Waiting for ${SERVICE} to reply…`)).toBeTruthy();
  });
});

describe('InlineServiceQueryCard — resolved ETA', () => {
  it('morphs into the ETA result card with route, eta, and map button', () => {
    const { getByText, getByTestId } = render(<InlineServiceQueryCard message={resolvedMsg()} />);
    expect(getByText('Route 42')).toBeTruthy();
    expect(getByText(/6 min/)).toBeTruthy();
    expect(getByText(/Mission and 16th/)).toBeTruthy();
    expect(getByTestId('service-query-map-button')).toBeTruthy();
    // stepper stages are no longer shown once resolved
    expect(() => getByText('Asked your Dina service directory')).toThrow();
  });

  it('persists the provider attribution on the resolved card', () => {
    const { getByText } = render(<InlineServiceQueryCard message={resolvedMsg()} />);
    // the Dina-to-Dina provenance survives the morph from hops → result
    expect(getByText(`via ${SERVICE} · did:plc:6sk7wc…`)).toBeTruthy();
  });

  it('expands the handoff path back into the hop cards on tap (collapsed by default)', () => {
    const { getByText, queryByText, getByLabelText } = render(
      <InlineServiceQueryCard message={resolvedMsg()} />,
    );
    // collapsed: the hop cards are not in the tree
    expect(queryByText('Asked the Dina service directory')).toBeNull();
    // tap the footer → the same hop cards reappear, frozen as the trail
    fireEvent.press(getByLabelText('Show handoff path'));
    expect(getByText('Asked the Dina service directory')).toBeTruthy();
    expect(getByText(`Found ${SERVICE}`)).toBeTruthy();
    expect(getByText('did:plc:6sk7wc…')).toBeTruthy();
    // last hop reads "replied" (no seconds — this fixture has no resolvedAt)
    expect(getByText(`${SERVICE} replied`)).toBeTruthy();
  });
});
