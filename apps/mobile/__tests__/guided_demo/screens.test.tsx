/**
 * Guided-demo UI surfaces — render + callback wiring.
 */

import { render, screen, fireEvent } from '@testing-library/react-native';
import React from 'react';

import {
  GuidedDemoEntry,
  GuidedDemoBanner,
  GuidedDemoRecoveryPrompt,
  GuidedDemoTeardown,
} from '../../src/components/guided_demo/GuidedDemoScreens';

describe('guided demo screens', () => {
  it('entry shows the spec copy + fires Start demo / Start empty', () => {
    const onStartDemo = jest.fn();
    const onStartEmpty = jest.fn();
    render(<GuidedDemoEntry onStartDemo={onStartDemo} onStartEmpty={onStartEmpty} />);

    expect(screen.getByText('See Dina in action')).toBeTruthy();
    expect(screen.getByText(/Nothing from the demo is kept/)).toBeTruthy();

    fireEvent.press(screen.getByTestId('guided-demo-start'));
    expect(onStartDemo).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('guided-demo-skip'));
    expect(onStartEmpty).toHaveBeenCalledTimes(1);
  });

  it('banner shows the indicator + fires exit', () => {
    const onExit = jest.fn();
    render(<GuidedDemoBanner onExit={onExit} />);
    expect(screen.getByText(/Guided demo/)).toBeTruthy();
    fireEvent.press(screen.getByTestId('guided-demo-exit'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('banner stepper shows the caption + step count and fires Next', () => {
    const onExit = jest.fn();
    const onAdvance = jest.fn();
    render(
      <GuidedDemoBanner
        onExit={onExit}
        onAdvance={onAdvance}
        caption="First, tell Dina about someone."
        step={1}
        stepCount={6}
        demoComplete={false}
      />,
    );
    expect(screen.getByTestId('guided-demo-caption')).toBeTruthy();
    // Progress now reads in the eyebrow tag as "Guided demo · 1/6".
    expect(screen.getByText(/1\/6/)).toBeTruthy();
    fireEvent.press(screen.getByTestId('guided-demo-next'));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('banner disables Next + shows "Working…" while a step is in flight', () => {
    render(
      <GuidedDemoBanner
        onExit={jest.fn()}
        onAdvance={jest.fn()}
        caption="First, tell Dina about someone."
        step={1}
        stepCount={6}
        demoComplete={false}
        actionInFlight
      />,
    );
    // Label flips to a working state and the button is disabled — the real
    // double-tap guard is the gate's advanceDemo serialization (gate.test).
    expect(screen.getByText(/Working/)).toBeTruthy();
    expect(screen.getByTestId('guided-demo-next')).toBeDisabled();
  });

  it('banner shows the complete state (Exit CTA, no Next) once every step has run', () => {
    const onExit = jest.fn();
    render(
      <GuidedDemoBanner
        onExit={onExit}
        onAdvance={jest.fn()}
        caption={null}
        step={6}
        stepCount={6}
        demoComplete
      />,
    );
    expect(screen.getByTestId('guided-demo-complete')).toBeTruthy();
    expect(screen.queryByTestId('guided-demo-next')).toBeNull();
    // The prominent body Exit CTA fires onExit (not just the header link).
    fireEvent.press(screen.getByTestId('guided-demo-exit-cta'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('teardown surface renders a non-interactive "ending demo" indicator', () => {
    render(<GuidedDemoTeardown />);
    expect(screen.getByTestId('guided-demo-tearing-down')).toBeTruthy();
    expect(screen.getByText(/clearing the sample data/)).toBeTruthy();
  });

  it('recovery prompt fires Continue / Delete', () => {
    const onContinue = jest.fn();
    const onDelete = jest.fn();
    render(<GuidedDemoRecoveryPrompt onContinue={onContinue} onDelete={onDelete} />);
    expect(screen.getByText('You were in the guided demo.')).toBeTruthy();

    fireEvent.press(screen.getByTestId('guided-demo-recovery-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('guided-demo-recovery-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
