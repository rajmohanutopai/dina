/**
 * Starter Credits cards — copy-rule + behavior pins. The copy
 * assertions are LOAD-BEARING (App Review 3.1.1 + the honest-privacy
 * rules from docs/CREDITS_DESIGN.md): if marketing-flavored phrases
 * sneak back in, these tests fail the build.
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { InlineCreditsCard } from '../../src/components/InlineCreditsCard';

const noop = (): void => undefined;

describe('InlineCreditsCard — low-balance', () => {
  it('renders the count, both options, and Set up / Later', () => {
    const onSetUp = jest.fn();
    const onDismiss = jest.fn();
    const { getByTestId, getByText } = render(
      <InlineCreditsCard
        variant="low-balance"
        estConversationsLeft={5}
        onSetUp={onSetUp}
        onDismiss={onDismiss}
      />,
    );
    expect(getByTestId('chat-card-credits-low-balance')).toBeTruthy();
    expect(getByText(/about 5 left/)).toBeTruthy();
    fireEvent.press(getByTestId('credits-low-balance-setup'));
    expect(onSetUp).toHaveBeenCalled();
    fireEvent.press(getByTestId('credits-low-balance-later'));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('InlineCreditsCard — wall', () => {
  it('renders the warm goodbye, data-stays-yours line, no Later button', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <InlineCreditsCard variant="wall" onSetUp={noop} />,
    );
    expect(getByTestId('chat-card-credits-wall')).toBeTruthy();
    expect(getByText(/stays yours, on this device/)).toBeTruthy();
    expect(queryByTestId('credits-low-balance-later')).toBeNull();
  });
});

describe('copy rules (3.1.1 + honesty) — both variants', () => {
  it.each(['low-balance', 'wall'] as const)('%s carries no banned phrases', (variant) => {
    const { toJSON } = render(
      <InlineCreditsCard variant={variant} estConversationsLeft={5} onSetUp={noop} onDismiss={noop} />,
    );
    const text = JSON.stringify(toJSON());
    // 3.1.1: no IAP-steering language in-app.
    expect(text).not.toMatch(/free forever/i);
    // No purchasable-credits mention until #362 ships.
    expect(text).not.toMatch(/top.?up|coming soon|buy|purchase/i);
    // Currency stays internal.
    expect(text).not.toMatch(/₹|\$|rupee|dollar|credit balance/i);
    // Honesty: "fully private" is reserved; cards use "most private".
    expect(text).not.toMatch(/fully private|nothing logged|no logging/i);
    // No urgency language.
    expect(text).not.toMatch(/running out!|hurry|expires?/i);
    // The neutral BYOK line is present.
    expect(text).toMatch(/Use your own AI provider key/);
    expect(text).toMatch(/most private/);
  });
});
