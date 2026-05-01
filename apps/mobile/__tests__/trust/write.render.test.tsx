/**
 * Render tests for the compose / edit attestation flow (TN-MOB-013).
 *
 * Pins:
 *   - compose mode (no `editing` prop) — Publish label "Publish",
 *     no warning panel.
 *   - edit mode without cosig — "Publish edit" label, no warning.
 *   - edit mode with cosig — warning panel surfaces, plural copy.
 *   - field state machine: tap sentiment / confidence buttons toggles
 *     selection, tap-twice deselects, only one active at a time.
 *   - Publish CTA disabled until all required fields are valid.
 *   - inline error surfaces under the offending field.
 *   - submitError panel renders above actions when set.
 *   - isSubmitting disables the form + shows the spinner.
 *   - onCancel + onPublish wiring.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import WriteScreen from '../../app/trust/write';
import { emptyWriteFormState } from '../../src/trust/write_form_data';

describe('WriteScreen — compose vs edit mode', () => {
  it('compose mode: header reads "Write a review", Publish CTA reads "Publish"', () => {
    const { getByText, getByTestId } = render(
      <WriteScreen subjectTitle="Aeron chair" />,
    );
    expect(getByText('Write a review')).toBeTruthy();
    expect(getByTestId('write-publish').props.accessibilityLabel).toBe('Publish');
  });

  it('edit mode (no cosig): header reads "Edit review", CTA reads "Publish edit", no warning', () => {
    const { getByText, getByTestId, queryByTestId } = render(
      <WriteScreen
        subjectTitle="Aeron chair"
        editing={{ originalUri: 'at://x/y/1', cosigCount: 0 }}
      />,
    );
    expect(getByText('Edit review')).toBeTruthy();
    expect(getByTestId('write-publish').props.accessibilityLabel).toBe('Publish edit');
    expect(queryByTestId('write-edit-warning')).toBeNull();
  });

  it('edit mode (1 cosig): warning panel renders with singular copy', () => {
    const { getByTestId, getByText } = render(
      <WriteScreen
        subjectTitle="Aeron chair"
        editing={{ originalUri: 'at://x/y/1', cosigCount: 1 }}
      />,
    );
    expect(getByTestId('write-edit-warning')).toBeTruthy();
    expect(getByText(/1 cosignature\. Editing will release it/)).toBeTruthy();
  });

  it('edit mode (multiple cosigs): warning panel renders with plural copy', () => {
    const { getByText } = render(
      <WriteScreen
        subjectTitle="Aeron chair"
        editing={{ originalUri: 'at://x/y/1', cosigCount: 3 }}
      />,
    );
    expect(getByText(/3 cosignatures\. Editing will release them/)).toBeTruthy();
  });
});

describe('WriteScreen — sentiment selector', () => {
  it('tap on sentiment selects it (sets accessibilityState.selected)', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    const positive = getByTestId('write-sentiment-positive');
    expect(positive.props.accessibilityState).toMatchObject({ selected: false });
    fireEvent.press(positive);
    expect(getByTestId('write-sentiment-positive').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('tapping a different sentiment switches selection', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-sentiment-positive'));
    fireEvent.press(getByTestId('write-sentiment-negative'));
    expect(getByTestId('write-sentiment-positive').props.accessibilityState).toMatchObject({
      selected: false,
    });
    expect(getByTestId('write-sentiment-negative').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('tapping the same sentiment twice deselects', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-sentiment-positive'));
    fireEvent.press(getByTestId('write-sentiment-positive'));
    expect(getByTestId('write-sentiment-positive').props.accessibilityState).toMatchObject({
      selected: false,
    });
  });
});

describe('WriteScreen — confidence selector', () => {
  it('tap on confidence selects it', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-confidence-high'));
    expect(getByTestId('write-confidence-high').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('all four confidence levels are rendered', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    expect(getByTestId('write-confidence-certain')).toBeTruthy();
    expect(getByTestId('write-confidence-high')).toBeTruthy();
    expect(getByTestId('write-confidence-moderate')).toBeTruthy();
    expect(getByTestId('write-confidence-speculative')).toBeTruthy();
  });
});

describe('WriteScreen — Publish CTA disabled state', () => {
  it('Publish disabled on initial empty form', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    expect(getByTestId('write-publish').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('Publish disabled until all required fields are filled', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.changeText(getByTestId('write-headline-input'), 'Great chair');
    expect(getByTestId('write-publish').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    fireEvent.press(getByTestId('write-sentiment-positive'));
    expect(getByTestId('write-publish').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    fireEvent.press(getByTestId('write-confidence-high'));
    // Now all required fields are present.
    expect(getByTestId('write-publish').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it('Publish disabled when isSubmitting=true even with valid form', () => {
    const { getByTestId } = render(
      <WriteScreen
        subjectTitle="X"
        isSubmitting
        initial={{
          sentiment: 'positive',
          headline: 'Great',
          body: '',
          confidence: 'high',
        }}
      />,
    );
    expect(getByTestId('write-publish').props.accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });
  });
});

describe('WriteScreen — inline errors', () => {
  it('headline_empty error appears after publish attempt then clearing', () => {
    // Errors are suppressed on a fresh form to avoid the screen
    // scolding the user before they've touched anything. Tapping
    // Publish on an invalid form reveals errors and they stay visible
    // for subsequent edits.
    const { getByTestId, queryByTestId } = render(
      <WriteScreen
        subjectTitle="X"
        initial={{
          sentiment: 'positive',
          headline: 'Great',
          body: '',
          confidence: 'high',
        }}
      />,
    );
    expect(queryByTestId('write-error-headline_empty')).toBeNull();
    // Clear without publish-attempt → still suppressed.
    fireEvent.changeText(getByTestId('write-headline-input'), '');
    expect(queryByTestId('write-error-headline_empty')).toBeNull();
    // Refill, attempt publish (valid → fires onPublish), then clear
    // again — errors are now visible.
    fireEvent.changeText(getByTestId('write-headline-input'), 'Great');
    fireEvent.press(getByTestId('write-publish'));
    fireEvent.changeText(getByTestId('write-headline-input'), '');
    expect(getByTestId('write-error-headline_empty')).toBeTruthy();
  });

  it('headline_too_long error surfaces past the cap (length errors always show)', () => {
    // Length-overflow errors are exempt from the publish-gate — the
    // user OBVIOUSLY interacted with the field if its value exceeds
    // the cap, so showing the error immediately matches their action.
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.changeText(
      getByTestId('write-headline-input'),
      'a'.repeat(141),
    );
    expect(getByTestId('write-error-headline_too_long')).toBeTruthy();
  });

  it('body_too_long error surfaces past the body cap', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.changeText(
      getByTestId('write-body-input'),
      'a'.repeat(4001),
    );
    expect(getByTestId('write-error-body_too_long')).toBeTruthy();
  });
});

describe('WriteScreen — submit + cancel', () => {
  it('tap Publish on a valid form fires onPublish with state', () => {
    const onPublish = jest.fn();
    const { getByTestId } = render(
      <WriteScreen
        subjectTitle="X"
        initial={{
          sentiment: 'positive',
          headline: 'Great chair',
          body: 'It is great',
          confidence: 'high',
        }}
        onPublish={onPublish}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish).toHaveBeenCalledWith({
      sentiment: 'positive',
      headline: 'Great chair',
      body: 'It is great',
      confidence: 'high',
    });
  });

  it('tap Publish on invalid form does NOT fire onPublish', () => {
    const onPublish = jest.fn();
    const { getByTestId } = render(
      <WriteScreen subjectTitle="X" onPublish={onPublish} />,
    );
    fireEvent.press(getByTestId('write-publish'));
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('tap Cancel fires onCancel', () => {
    const onCancel = jest.fn();
    const { getByTestId } = render(
      <WriteScreen subjectTitle="X" onCancel={onCancel} />,
    );
    fireEvent.press(getByTestId('write-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders Cancel button when onCancel is omitted (router fallback)', () => {
    // The screen now provides a router-based navigation fallback so
    // Cancel is always wired in production. Callers that need a
    // bespoke close-handler pass it explicitly; omission just means
    // "fall back to navigation history".
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    expect(getByTestId('write-cancel')).toBeTruthy();
  });

  it('renders submitError panel when submitError is set', () => {
    const { getByTestId, getByText } = render(
      <WriteScreen subjectTitle="X" submitError="Network unreachable" />,
    );
    expect(getByTestId('write-submit-error')).toBeTruthy();
    expect(getByText('Network unreachable')).toBeTruthy();
  });
});

describe('WriteScreen — initial state seeding', () => {
  it('renders empty form when no initial provided', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    expect(getByTestId('write-headline-input').props.value).toBe('');
    expect(getByTestId('write-body-input').props.value).toBe('');
  });

  it('renders pre-filled form when initial is provided (edit mode)', () => {
    const { getByTestId } = render(
      <WriteScreen
        subjectTitle="X"
        initial={{
          sentiment: 'positive',
          headline: 'Existing headline',
          body: 'Existing body',
          confidence: 'high',
        }}
      />,
    );
    expect(getByTestId('write-headline-input').props.value).toBe('Existing headline');
    expect(getByTestId('write-body-input').props.value).toBe('Existing body');
    expect(getByTestId('write-sentiment-positive').props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(getByTestId('write-confidence-high').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });
});

describe('WriteScreen — accessibility (TN-TEST-061 surface)', () => {
  it('Publish CTA exposes busy state during submission', () => {
    const { getByTestId } = render(
      <WriteScreen
        subjectTitle="X"
        isSubmitting
        initial={{
          ...emptyWriteFormState(),
          sentiment: 'positive',
          headline: 'A',
          confidence: 'high',
        }}
      />,
    );
    expect(getByTestId('write-publish').props.accessibilityState).toMatchObject({
      busy: true,
    });
  });

  it('headline + body inputs have accessibilityLabel', () => {
    const { getByLabelText } = render(<WriteScreen subjectTitle="X" />);
    expect(getByLabelText('Headline')).toBeTruthy();
    expect(getByLabelText('Body')).toBeTruthy();
  });

  it('sentiment buttons have accessibilityRole + label', () => {
    const { getByLabelText } = render(<WriteScreen subjectTitle="X" />);
    expect(getByLabelText('Positive')).toBeTruthy();
    expect(getByLabelText('Neutral')).toBeTruthy();
    expect(getByLabelText('Negative')).toBeTruthy();
  });
});
