/**
 * Per-scenario card test — MRS-05 (unknown-sender quarantine).
 *
 * This is the pattern for "did the RIGHT card show for the scenario, are
 * its INTERNALS fine, and do its BUTTONS work" — headless, no pixels:
 *
 *   1. Drive the scenario to produce the REAL card message
 *      (`quarantineMessage` = what the receive pipeline does for a
 *       stranger; the card message carries the same `lifecycle` metadata
 *       `bootstrap.onQuarantinedD2D` posts).
 *   2. Render the ACTUAL production card (`InlineQuarantineCard`).
 *   3. Assert the card's internals (the scenario-specific content + the
 *      two action buttons).
 *   4. Press a button and assert the real action fired (contact recorded,
 *      message released + re-staged) — not a stub.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

import { InlineQuarantineCard } from '../../src/components/InlineQuarantineCard';
import { addLifecycleMessage, getThread, resetThreads, type ChatMessage } from '@dina/brain/chat';
import { quarantineMessage, resetQuarantineState, clearGatesState } from '@dina/core/d2d';
import {
  getContact,
  resetContactDirectory,
  setPeopleRepository,
  claim,
  resetStagingState,
} from '@dina/core';
import { makeFakePeopleRepo } from '@dina/test-harness';

const THREAD = 'main';
const SENDER = 'did:plc:alonsoquarantinecard';

function lastMessage(): ChatMessage {
  const thread = getThread(THREAD);
  return thread[thread.length - 1]!;
}

/** Reproduce the scenario: a stranger's message arrives → quarantined →
 *  the chat gets the review card (same `lifecycle` metadata bootstrap posts). */
function stageQuarantineCard(): string {
  const q = quarantineMessage(SENDER, 'social.update', JSON.stringify({ text: "I'm coming over" }));
  addLifecycleMessage(THREAD, "Someone who isn't in your contacts wants to message you.", {
    kind: 'quarantine_request',
    quarantineId: q.id,
    senderDID: SENDER,
    messageType: 'social.update',
  });
  return q.id;
}

describe('MRS-05 quarantine card — right card, internals, working buttons', () => {
  beforeEach(() => {
    resetThreads();
    resetQuarantineState();
    resetContactDirectory();
    clearGatesState();
    resetStagingState();
    setPeopleRepository(makeFakePeopleRepo());
  });

  it('shows the unknown-sender card with the sender + both action buttons', () => {
    stageQuarantineCard();
    render(<InlineQuarantineCard message={lastMessage()} />);

    // Internals: the scenario-specific content + the two actions.
    expect(screen.getByText(/unknown sender/i)).toBeTruthy();
    expect(screen.getByText(/isn't in your contacts/i)).toBeTruthy();
    expect(screen.getByText(/did:plc:alonso/i)).toBeTruthy(); // shortened sender DID
    expect(screen.getByText('Block')).toBeTruthy();
    expect(screen.getByText('Add to contacts')).toBeTruthy();
  });

  it('"Add to contacts" records a verified contact + releases the message (real action)', () => {
    stageQuarantineCard();
    render(<InlineQuarantineCard message={lastMessage()} />);

    fireEvent.press(screen.getByText('Add to contacts'));

    // Card internals flip to the resolved state.
    expect(screen.getByText(/Added to contacts/i)).toBeTruthy();
    // Real action ran: sender is now a verified contact, quarantine cleared,
    // and the held message re-staged (claimable by the drain).
    expect(getContact(SENDER)?.trustLevel).toBe('verified');
    const staged = claim(10);
    expect(staged.some((s) => s.producer_id === SENDER)).toBe(true);
  });

  it('"Block" resolves without recording a contact', () => {
    stageQuarantineCard();
    render(<InlineQuarantineCard message={lastMessage()} />);

    fireEvent.press(screen.getByText('Block'));

    expect(screen.getByText(/Blocked/i)).toBeTruthy();
    expect(getContact(SENDER)).toBeNull();
  });
});
