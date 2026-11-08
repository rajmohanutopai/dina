/**
 * The app is on screen while Dina starts. When boot ends the gate turns on, and
 * that must not rebuild the app: whatever screen was opened or text typed in
 * those seconds would be lost. Found on the simulator: tap People during
 * "Starting Dina…", and four seconds later the app is back on Chat.
 */

import React, { useEffect } from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import { GuidedDemoGate } from '../../src/components/guided_demo/GuidedDemoGate';
import { useGuidedDemoGate } from '../../src/guided_demo/useGuidedDemoGate';

jest.mock('../../src/guided_demo/useGuidedDemoGate', () => ({ useGuidedDemoGate: jest.fn() }));

const gateMock = useGuidedDemoGate as jest.Mock;
const phase = (p: string): void => {
  gateMock.mockReturnValue({ phase: p, demoActive: false, currentAction: null });
};

let mounts = 0;
function App(): React.ReactElement {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <Text>the app</Text>;
}

const tree = (enabled: boolean): React.ReactElement => (
  <GuidedDemoGate enabled={enabled}>
    <App />
  </GuidedDemoGate>
);

describe('GuidedDemoGate keeps the app mounted across boot', () => {
  beforeEach(() => {
    mounts = 0;
  });

  it('booting → checking → running mounts the app once', () => {
    phase('checking');
    const view = render(tree(false));
    expect(screen.getByText('the app')).toBeTruthy();
    view.rerender(tree(true));
    phase('running');
    view.rerender(tree(true));
    expect(screen.getByText('the app')).toBeTruthy();
    expect(mounts).toBe(1);
  });

  it('while checking, the app is covered, never display:none', () => {
    // A browser runs no animations under display:none, so a closing menu would
    // never finish and its backdrop would block every tap (web functional suite).
    phase('checking');
    const view = render(tree(true));
    expect(screen.getByTestId('guided-demo-checking')).toBeTruthy();
    const hiddenAncestor = (node: { props?: { style?: unknown }; parent?: unknown } | null) => {
      for (let n = node; n !== null && n !== undefined; n = (n as { parent: typeof node }).parent) {
        const style = [n.props?.style].flat(Infinity) as { display?: string }[];
        if (style.some((s) => s?.display === 'none')) return true;
      }
      return false;
    };
    expect(hiddenAncestor(screen.getByText('the app') as never)).toBe(false);
    view.unmount();
  });

  it('first run still shows the entry screen in place of the app', () => {
    phase('entry');
    const view = render(tree(false));
    view.rerender(tree(true));
    expect(screen.queryByText('the app')).toBeNull();
  });
});
