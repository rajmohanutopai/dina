/**
 * Render tests for `SubjectAnchorView` — the compact "what you're
 * reviewing" header used on the trust write/edit screen.
 *
 * Pinned: title + subtitle render, kind icon resolution, fallback for
 * unknown kinds, accessibility role + label.
 */
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import { SubjectAnchorView } from '../../../src/trust/components/subject_anchor_view';

describe('SubjectAnchorView', () => {
  it('renders title + subtitle when category resolves', () => {
    const { getByText, getByTestId } = render(
      <SubjectAnchorView
        title="Aeron chair"
        kind="product"
        category="commerce/product/furniture"
      />,
    );
    expect(getByTestId('subject-anchor')).toBeTruthy();
    expect(getByText('Aeron chair')).toBeTruthy();
    // Subtitle prefers subject-kind label over generic commerce/* category
    // (matches the behaviour of `deriveCardSubtitle`).
    expect(getByText('Product')).toBeTruthy();
  });

  it('renders just the title when category is null', () => {
    const { getByText, queryByText } = render(
      <SubjectAnchorView title="Standalone" kind={null} category={null} />,
    );
    expect(getByText('Standalone')).toBeTruthy();
    // No subtitle — pin against a regression that renders 'null' as text.
    expect(queryByText('null')).toBeNull();
  });

  it('a11y label combines title and subtitle when both present', () => {
    const { getByLabelText } = render(
      <SubjectAnchorView
        title="The Bistro"
        kind="place"
        category="place/restaurant"
      />,
    );
    // `deriveCardSubtitle` humanises the first segment ('place' →
    // 'Place') because 'place' isn't in the generic-prefix set
    // (commerce/claim/identity). The leaf 'restaurant' isn't surfaced
    // — pin matches the existing card-subtitle behaviour.
    expect(getByLabelText('The Bistro, Place')).toBeTruthy();
  });

  it('a11y label is title-only when subtitle absent', () => {
    const { getByLabelText } = render(
      <SubjectAnchorView title="Solo" kind={null} category={null} />,
    );
    expect(getByLabelText('Solo')).toBeTruthy();
  });

  it('accepts an unknown kind without crashing (fallback icon)', () => {
    const { getByText } = render(
      <SubjectAnchorView title="Mystery" kind="future_kind" category={null} />,
    );
    expect(getByText('Mystery')).toBeTruthy();
  });

  it('respects a custom testID', () => {
    const { getByTestId } = render(
      <SubjectAnchorView
        title="Custom"
        kind="product"
        category={null}
        testID="my-anchor"
      />,
    );
    expect(getByTestId('my-anchor')).toBeTruthy();
  });

  it('truncates very long titles to 2 lines (numberOfLines pinned)', () => {
    // RTL doesn't render layout but does pass numberOfLines through to the
    // host component — sanity check by querying the prop on the rendered
    // text node.
    const longTitle = 'A'.repeat(200);
    const { getByText } = render(
      <SubjectAnchorView title={longTitle} kind={null} category={null} />,
    );
    const titleNode = getByText(longTitle);
    expect(titleNode.props.numberOfLines).toBe(2);
  });
});
