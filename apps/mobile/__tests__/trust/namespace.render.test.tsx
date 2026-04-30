/**
 * Render tests for the namespace management screen (TN-MOB-014).
 *
 * Three states pinned:
 *   1. **Loading** — `prior === null`. Spinner + "Loading…" text. Add
 *      CTA disabled (no prior op = no next-index to compute).
 *   2. **Empty** — `prior` has no namespaces. "No namespaces yet" copy.
 *      Add CTA enabled, label reads "Add namespace_0".
 *   3. **Populated** — one row per declared namespace, sorted by index.
 *      Add CTA enabled, label reads "Add namespace_<next>".
 *
 * Plus interaction tests: tapping the Add CTA fires `onAddNamespace`
 * with the next index; tapping a row fires `onSelectNamespace`.
 *
 * The data-layer derivation is covered exhaustively in
 * `namespace_screen_data.test.ts`; this file is concerned only with
 * the wire-up between props and rendered output.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import NamespaceScreen from '../../app/trust/namespace';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

const PRIOR_WITH_TWO = {
  verificationMethods: {
    namespace_0: 'multikey-0',
    namespace_1: 'multikey-1',
    atproto: 'multikey-root', // not a namespace — should be filtered out
  },
};

describe('NamespaceScreen — render states', () => {
  it('renders loading state when prior is null', () => {
    const { getByTestId, queryByTestId } = render(
      <NamespaceScreen did={DID} prior={null} />,
    );
    expect(getByTestId('namespace-loading')).toBeTruthy();
    expect(queryByTestId('namespace-empty')).toBeNull();
    // Add CTA is disabled while prior is loading.
    const cta = getByTestId('namespace-add-cta');
    expect(cta.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('renders empty state when prior has no namespaces', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <NamespaceScreen did={DID} prior={{ verificationMethods: {} }} />,
    );
    expect(getByTestId('namespace-empty')).toBeTruthy();
    expect(queryByTestId('namespace-loading')).toBeNull();
    // Add CTA enabled with index-0 label.
    const cta = getByTestId('namespace-add-cta');
    expect(cta.props.accessibilityState).toMatchObject({ disabled: false });
    expect(getByText(/Add namespace_0/)).toBeTruthy();
  });

  it('renders one row per declared namespace (filters non-namespace keys)', () => {
    const { getByTestId, queryByTestId, getAllByTestId } = render(
      <NamespaceScreen did={DID} prior={PRIOR_WITH_TWO} />,
    );
    expect(queryByTestId('namespace-empty')).toBeNull();
    expect(queryByTestId('namespace-loading')).toBeNull();
    const rows = getAllByTestId(/^namespace-row-/);
    expect(rows).toHaveLength(2);
    // Rows are sorted ascending — testID encodes the index.
    expect(getByTestId('namespace-row-0')).toBeTruthy();
    expect(getByTestId('namespace-row-1')).toBeTruthy();
  });

  it('Add CTA label shows the next index for an existing op', () => {
    const { getByText } = render(
      <NamespaceScreen did={DID} prior={PRIOR_WITH_TWO} />,
    );
    // Two namespaces (0 + 1) → next is 2.
    expect(getByText(/Add namespace_2/)).toBeTruthy();
  });

  it('renders with isAdding=true: CTA disabled + busy state', () => {
    const { getByTestId } = render(
      <NamespaceScreen did={DID} prior={PRIOR_WITH_TWO} isAdding />,
    );
    const cta = getByTestId('namespace-add-cta');
    expect(cta.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });
});

describe('NamespaceScreen — interactions', () => {
  it('tapping the Add CTA fires onAddNamespace with next index', () => {
    const onAdd = jest.fn();
    const { getByTestId } = render(
      <NamespaceScreen did={DID} prior={PRIOR_WITH_TWO} onAddNamespace={onAdd} />,
    );
    fireEvent.press(getByTestId('namespace-add-cta'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(2);
  });

  it('tapping the Add CTA does NOTHING when prior is null', () => {
    const onAdd = jest.fn();
    const { getByTestId } = render(
      <NamespaceScreen did={DID} prior={null} onAddNamespace={onAdd} />,
    );
    fireEvent.press(getByTestId('namespace-add-cta'));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('tapping a namespace row fires onSelectNamespace', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <NamespaceScreen did={DID} prior={PRIOR_WITH_TWO} onSelectNamespace={onSelect} />,
    );
    fireEvent.press(getByTestId('namespace-row-1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      index: 1,
      fragment: 'namespace_1',
      verificationMethodId: `${DID}#namespace_1`,
    });
  });
});

describe('NamespaceScreen — accessibility (TN-TEST-061 surface)', () => {
  it('Add CTA has the right accessibilityLabel', () => {
    const { getByLabelText } = render(
      <NamespaceScreen did={DID} prior={{ verificationMethods: {} }} />,
    );
    expect(getByLabelText('Add namespace_0')).toBeTruthy();
  });

  it('namespace rows have descriptive accessibilityLabel', () => {
    const { getByLabelText } = render(
      <NamespaceScreen
        did={DID}
        prior={PRIOR_WITH_TWO}
        onSelectNamespace={() => undefined}
      />,
    );
    expect(getByLabelText('Namespace namespace_0')).toBeTruthy();
    expect(getByLabelText('Namespace namespace_1')).toBeTruthy();
  });
});
