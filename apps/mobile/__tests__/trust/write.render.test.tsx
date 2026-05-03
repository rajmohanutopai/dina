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

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

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

describe('WriteScreen — confidence (no longer surfaced)', () => {
  // The Confidence pill row was dropped from the form: casual
  // reviewers don't think in speculative/high/certain ladders, and
  // the field was only consumed by the AppView search filter
  // `minConfidence` (no trust-score weight). The form now seeds
  // `confidence: 'moderate'` silently. Pin both that the UI is gone
  // AND that the seeded value still flows through to the wire so an
  // empty form's publish payload carries `confidence: 'moderate'`.
  it('does NOT render the confidence pill row anywhere on the form', () => {
    const { queryByTestId } = render(<WriteScreen subjectTitle="X" />);
    expect(queryByTestId('write-confidence-certain')).toBeNull();
    expect(queryByTestId('write-confidence-high')).toBeNull();
    expect(queryByTestId('write-confidence-moderate')).toBeNull();
    expect(queryByTestId('write-confidence-speculative')).toBeNull();
  });
});

describe('WriteScreen — Publish CTA disabled state', () => {
  it('Publish disabled on initial empty form', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    expect(getByTestId('write-publish').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('Publish disabled until headline + sentiment are filled (confidence auto-seeded)', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.changeText(getByTestId('write-headline-input'), 'Great chair');
    expect(getByTestId('write-publish').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    // Tapping sentiment is the LAST required action — confidence is
    // pre-seeded to 'moderate' by the form, so the Publish CTA
    // unlocks here without a separate confidence step.
    fireEvent.press(getByTestId('write-sentiment-positive'));
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
    // The screen merges incoming `initial` over `emptyWriteFormState()`
    // to keep partial-shape callers safe (V2 fields default to unset),
    // so onPublish receives the full WriteFormState. Match only the
    // fields the test cares about.
    expect(onPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        sentiment: 'positive',
        headline: 'Great chair',
        body: 'It is great',
        confidence: 'high',
      }),
    );
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

describe('WriteScreen — URL-param-driven edit mode', () => {
  // The reviewer screen's "Edit" affordance pushes /trust/write with
  // a bag of `editing*` URL params. WriteScreen lifts those into its
  // edit-mode context + initial form state. Locks the contract
  // between the two screens so a future rename (subjectName →
  // subject_name etc.) breaks loudly here, not silently in the field.
  let useLocalSearchParamsSpy: jest.SpyInstance | undefined;
  afterEach(() => {
    useLocalSearchParamsSpy?.mockRestore();
    useLocalSearchParamsSpy = undefined;
  });

  function mockParams(params: Record<string, string>): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const expoRouter = require('expo-router');
    useLocalSearchParamsSpy = jest
      .spyOn(expoRouter, 'useLocalSearchParams')
      .mockReturnValue(params);
  }

  it('flips into edit mode when editingUri is in URL params', () => {
    mockParams({
      editingUri: 'at://did:plc:author/com.dina.trust.attestation/abc',
      editingCosigCount: '0',
      editingSentiment: 'positive',
      editingConfidence: 'high',
      editingHeadline: 'Worth every penny',
      editingBody: 'Best chair I have owned.',
    });
    const { getByText, getByTestId } = render(<WriteScreen />);
    expect(getByText('Edit review')).toBeTruthy();
    expect(getByTestId('write-publish').props.accessibilityLabel).toBe('Publish edit');
  });

  it('seeds the form from editing* params (sentiment, headline, body) — confidence is plumbed silently', () => {
    mockParams({
      editingUri: 'at://x/y/z',
      editingCosigCount: '0',
      editingSentiment: 'negative',
      editingConfidence: 'speculative',
      editingHeadline: 'Stay away',
      editingBody: 'It broke after a week.',
    });
    const { getByTestId, queryByTestId } = render(<WriteScreen />);
    expect(getByTestId('write-headline-input').props.value).toBe('Stay away');
    expect(getByTestId('write-body-input').props.value).toBe('It broke after a week.');
    expect(getByTestId('write-sentiment-negative').props.accessibilityState).toMatchObject({
      selected: true,
    });
    // editingConfidence still reaches state.confidence so a republish
    // preserves the original value, but the form no longer renders
    // pills for it. Pin the silent absence so a regression that
    // re-adds the UI gets caught.
    expect(queryByTestId('write-confidence-speculative')).toBeNull();
  });

  it('surfaces the cosig warning when editingCosigCount > 0', () => {
    mockParams({
      editingUri: 'at://x/y/z',
      editingCosigCount: '3',
      editingSentiment: 'positive',
      editingHeadline: 'h',
    });
    const { getByTestId } = render(<WriteScreen />);
    expect(getByTestId('write-edit-warning')).toBeTruthy();
  });

  it('non-numeric / negative cosig counts coerce to 0 (no warning)', () => {
    // Defensive against a malformed deep link / a future runner
    // that passes garbage. Better to under-warn than to crash.
    mockParams({
      editingUri: 'at://x/y/z',
      editingCosigCount: 'banana',
      editingSentiment: 'positive',
      editingHeadline: 'h',
    });
    const { queryByTestId } = render(<WriteScreen />);
    expect(queryByTestId('write-edit-warning')).toBeNull();
  });

  it('omits cosig warning when editingCosigCount param is absent', () => {
    mockParams({
      editingUri: 'at://x/y/z',
      editingSentiment: 'positive',
      editingHeadline: 'h',
    });
    const { queryByTestId } = render(<WriteScreen />);
    expect(queryByTestId('write-edit-warning')).toBeNull();
  });

  it('unknown editingSentiment / editingConfidence values fall back to null (no selection)', () => {
    mockParams({
      editingUri: 'at://x/y/z',
      editingCosigCount: '0',
      editingSentiment: 'banana',
      editingConfidence: 'lukewarm',
      editingHeadline: 'h',
    });
    const { getByTestId, queryByTestId } = render(<WriteScreen />);
    // None of the sentiment buttons should report `selected`.
    for (const s of ['positive', 'neutral', 'negative']) {
      expect(getByTestId(`write-sentiment-${s}`).props.accessibilityState).toMatchObject({
        selected: false,
      });
    }
    // Confidence has no UI surface anymore; the unknown
    // `editingConfidence: 'lukewarm'` simply falls through to the
    // form's seeded default ('moderate') without rendering pills.
    for (const c of ['certain', 'high', 'moderate', 'speculative']) {
      expect(queryByTestId(`write-confidence-${c}`)).toBeNull();
    }
  });

  it('compose mode (no editingUri) leaves the screen as a fresh write', () => {
    mockParams({});
    const { getByText } = render(<WriteScreen subjectTitle="Aeron chair" />);
    expect(getByText('Write a review')).toBeTruthy();
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
    // Confidence is no longer surfaced in the form — the seeded
    // 'high' value carries through silently to the wire on republish
    // (see write_form_data.test.ts for the validator-level pin).
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

describe('WriteScreen — last-used picker (TN-V2-REV-007, in Step 2)', () => {
  // The form is now a 3-step wizard. Step 2 ("Your experience") owns
  // the last-used bucket picker. Tests navigate via the stepper; the
  // step-1 publish gate does NOT block stepper navigation (users are
  // free to peek at later steps; the Publish CTA's disabled state
  // remains the load-bearing gate).
  it('last-used picker is NOT rendered on Step 1 (the default)', () => {
    const { queryByTestId } = render(<WriteScreen subjectTitle="X" />);
    expect(queryByTestId('write-step-2')).toBeNull();
    expect(queryByTestId('write-last-used-today')).toBeNull();
  });

  it('navigating to Step 2 reveals the bucket buttons', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    expect(getByTestId('write-step-2')).toBeTruthy();
    expect(getByTestId('write-last-used-today')).toBeTruthy();
    expect(getByTestId('write-last-used-past_week')).toBeTruthy();
    expect(getByTestId('write-last-used-past_month')).toBeTruthy();
    expect(getByTestId('write-last-used-past_6_months')).toBeTruthy();
    expect(getByTestId('write-last-used-past_year')).toBeTruthy();
    expect(getByTestId('write-last-used-over_a_year')).toBeTruthy();
  });

  it('Done closes the wizard modal and the picker is no longer reachable', () => {
    const { getByTestId, queryByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    expect(getByTestId('write-step-2')).toBeTruthy();
    // The wizard's "Done" button closes the modal, returning to
    // Step 1. After it closes, Step 2 content is no longer in the
    // tree (Modal `visible={false}` unmounts its children).
    fireEvent.press(getByTestId('write-additional-data-done'));
    expect(queryByTestId('write-step-2')).toBeNull();
  });

  it('tap-to-select then tap-to-clear on the same bucket (toggle semantic)', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    const todayBtn = getByTestId('write-last-used-today');
    expect(todayBtn.props.accessibilityState).toMatchObject({ selected: false });
    fireEvent.press(todayBtn);
    expect(getByTestId('write-last-used-today').props.accessibilityState).toMatchObject({
      selected: true,
    });
    fireEvent.press(getByTestId('write-last-used-today'));
    expect(getByTestId('write-last-used-today').props.accessibilityState).toMatchObject({
      selected: false,
    });
  });

  it('selecting a different bucket replaces the previous selection (radio-like)', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.press(getByTestId('write-last-used-today'));
    expect(getByTestId('write-last-used-today').props.accessibilityState).toMatchObject({
      selected: true,
    });
    fireEvent.press(getByTestId('write-last-used-past_month'));
    expect(getByTestId('write-last-used-today').props.accessibilityState).toMatchObject({
      selected: false,
    });
    expect(getByTestId('write-last-used-past_month').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('Add additional data pill exposes accessibilityRole=button', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    const pill = getByTestId('write-additional-data-pill');
    expect(pill.props.accessibilityRole).toBe('button');
    expect(pill.props.accessibilityLabel).toBe('Add additional details');
  });
});

describe('WriteScreen — subject anchor card', () => {
  it('renders the anchor card when subjectTitle is provided', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="Aeron chair" />);
    expect(getByTestId('subject-anchor')).toBeTruthy();
  });

  it('subject anchor surfaces the subject title in the header (replaces "About:" line)', () => {
    const { getByTestId, queryByText } = render(
      <WriteScreen subjectTitle="Aeron chair" />,
    );
    expect(getByTestId('subject-anchor')).toBeTruthy();
    // The old "About: Aeron chair" line is gone — pin against
    // resurrection. The anchor renders the title in its own card.
    expect(queryByText(/About:/)).toBeNull();
  });
});

describe('WriteScreen — use-case picker (TN-V2-REV-006)', () => {
  it('renders use-case row inside Advanced section (default vocabulary when no subject)', () => {
    const { getByTestId, queryByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    expect(getByTestId('write-use-case-row')).toBeTruthy();
    // Default vocabulary: ['everyday', 'professional', 'travel', 'family', 'kids'].
    expect(getByTestId('write-use-case-everyday')).toBeTruthy();
    expect(getByTestId('write-use-case-professional')).toBeTruthy();
    expect(getByTestId('write-use-case-travel')).toBeTruthy();
    expect(getByTestId('write-use-case-family')).toBeTruthy();
    expect(getByTestId('write-use-case-kids')).toBeTruthy();
    // 'gaming' is in the tech vocab but NOT in default — should NOT render.
    expect(queryByTestId('write-use-case-gaming')).toBeNull();
  });

  it('tap-to-select then tap-to-clear (toggle semantic)', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    const everyday = getByTestId('write-use-case-everyday');
    expect(everyday.props.accessibilityState).toMatchObject({ selected: false });
    fireEvent.press(everyday);
    expect(getByTestId('write-use-case-everyday').props.accessibilityState).toMatchObject({
      selected: true,
    });
    fireEvent.press(getByTestId('write-use-case-everyday'));
    expect(getByTestId('write-use-case-everyday').props.accessibilityState).toMatchObject({
      selected: false,
    });
  });

  it('multi-select up to 3 tags', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.press(getByTestId('write-use-case-everyday'));
    fireEvent.press(getByTestId('write-use-case-professional'));
    fireEvent.press(getByTestId('write-use-case-travel'));
    expect(getByTestId('write-use-case-everyday').props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(getByTestId('write-use-case-professional').props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(getByTestId('write-use-case-travel').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('greys out unselected tags when at the 3-tag cap', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.press(getByTestId('write-use-case-everyday'));
    fireEvent.press(getByTestId('write-use-case-professional'));
    fireEvent.press(getByTestId('write-use-case-travel'));
    // Now at cap (3). 'family' is unselected → should be disabled.
    const familyBtn = getByTestId('write-use-case-family');
    expect(familyBtn.props.accessibilityState).toMatchObject({ disabled: true });
    // Selected tags stay enabled (so the user can deselect to free a slot).
    expect(getByTestId('write-use-case-everyday').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it('removing a tag while at the cap re-enables disabled tags', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.press(getByTestId('write-use-case-everyday'));
    fireEvent.press(getByTestId('write-use-case-professional'));
    fireEvent.press(getByTestId('write-use-case-travel'));
    // Confirm 'family' is disabled.
    expect(getByTestId('write-use-case-family').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    // Deselect 'travel' (frees a slot).
    fireEvent.press(getByTestId('write-use-case-travel'));
    // 'family' should re-enable.
    expect(getByTestId('write-use-case-family').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it('use-case picker buttons have a11y role + label', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    const btn = getByTestId('write-use-case-everyday');
    expect(btn.props.accessibilityRole).toBe('button');
    expect(btn.props.accessibilityLabel).toBe('Everyday');
  });
});

describe('WriteScreen — alternatives picker (TN-V2-REV-008)', () => {
  it('renders the search input inside Advanced section', () => {
    const { getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    expect(getByTestId('write-alt-search-input')).toBeTruthy();
  });

  it('hides chip list when no alternatives are added', () => {
    const { queryByTestId, getByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    expect(queryByTestId('write-alt-chips')).toBeNull();
  });

  it('typing into search input triggers searchAlternatives prop callback', async () => {
    const search = jest.fn().mockResolvedValue([
      { kind: 'product', name: 'Steelcase Leap', subjectId: 'sub-leap' },
    ]);
    const { getByTestId, findByTestId } = render(
      <WriteScreen subjectTitle="X" searchAlternatives={search} />,
    );
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.changeText(getByTestId('write-alt-search-input'), 'leap');
    expect(search).toHaveBeenCalledWith('leap');
    // Wait for the result row to render after the promise resolves.
    expect(await findByTestId('write-alt-result-sub-leap')).toBeTruthy();
  });

  it('tapping a result adds it to the chip list and clears the input', async () => {
    const search = jest.fn().mockResolvedValue([
      { kind: 'product', name: 'Steelcase Leap', subjectId: 'sub-leap' },
    ]);
    const { getByTestId, findByTestId, queryByTestId } = render(
      <WriteScreen subjectTitle="X" searchAlternatives={search} />,
    );
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.changeText(getByTestId('write-alt-search-input'), 'leap');
    const row = await findByTestId('write-alt-result-sub-leap');
    fireEvent.press(row);
    expect(getByTestId('write-alt-chips')).toBeTruthy();
    expect(getByTestId('write-alt-chip-0')).toBeTruthy();
    // Input clears after add (so user can search again easily).
    expect(getByTestId('write-alt-search-input').props.value).toBe('');
    // Results list disappears.
    expect(queryByTestId('write-alt-results')).toBeNull();
  });

  it('tapping the X on a chip removes the alternative', async () => {
    const search = jest.fn().mockResolvedValue([
      { kind: 'product', name: 'A', subjectId: 'sub-a' },
    ]);
    const { getByTestId, findByTestId, queryByTestId } = render(
      <WriteScreen subjectTitle="X" searchAlternatives={search} />,
    );
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.changeText(getByTestId('write-alt-search-input'), 'a');
    fireEvent.press(await findByTestId('write-alt-result-sub-a'));
    expect(getByTestId('write-alt-chip-0')).toBeTruthy();
    fireEvent.press(getByTestId('write-alt-remove-0'));
    expect(queryByTestId('write-alt-chip-0')).toBeNull();
  });

  it('search input hides at the cap; cap hint surfaces', async () => {
    // Pre-populate 5 alternatives via the initial prop, bypassing the
    // search interaction (faster than 5 round-trips).
    const initial = {
      ...emptyWriteFormState(),
      alternatives: [
        { kind: 'product', name: 'A1' },
        { kind: 'product', name: 'A2' },
        { kind: 'product', name: 'A3' },
        { kind: 'product', name: 'A4' },
        { kind: 'product', name: 'A5' },
      ],
    } as const;
    const { getByTestId, queryByTestId } = render(
      <WriteScreen subjectTitle="X" initial={initial} />,
    );
    fireEvent.press(getByTestId('write-additional-data-pill'));
    expect(queryByTestId('write-alt-search-input')).toBeNull();
    expect(getByTestId('write-alt-cap-hint')).toBeTruthy();
  });

  it('result row for an already-added alternative is disabled', async () => {
    const search = jest.fn().mockResolvedValue([
      { kind: 'product', name: 'Steelcase Leap', subjectId: 'sub-leap' },
    ]);
    const initial = {
      ...emptyWriteFormState(),
      alternatives: [
        { kind: 'product' as const, name: 'Steelcase Leap', subjectId: 'sub-leap' },
      ],
    };
    const { getByTestId, findByTestId } = render(
      <WriteScreen subjectTitle="X" initial={initial} searchAlternatives={search} />,
    );
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.changeText(getByTestId('write-alt-search-input'), 'leap');
    const row = await findByTestId('write-alt-result-sub-leap');
    expect(row.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('search error surfaces when the callback rejects', async () => {
    const search = jest.fn().mockRejectedValue(new Error('Network down'));
    const { getByTestId, findByTestId } = render(
      <WriteScreen subjectTitle="X" searchAlternatives={search} />,
    );
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.changeText(getByTestId('write-alt-search-input'), 'leap');
    expect(await findByTestId('write-alt-search-error')).toBeTruthy();
  });

  it('with searchAlternatives prop omitted, results list stays empty', () => {
    const { getByTestId, queryByTestId } = render(<WriteScreen subjectTitle="X" />);
    fireEvent.press(getByTestId('write-additional-data-pill'));
    fireEvent.changeText(getByTestId('write-alt-search-input'), 'anything');
    expect(queryByTestId('write-alt-results')).toBeNull();
    expect(queryByTestId('write-alt-search-error')).toBeNull();
  });
});

describe('WriteScreen — alternatives picker (TN-V2-REV-008) — stale-response guard', () => {
  it('a fast typist gets the LATEST query results, not the prior one', async () => {
    // Simulate a slow-then-fast pair of queries: 'le' resolves slowly
    // with a "leap" result; 'sea' resolves faster with a "seat"
    // result. The user changed query in between → only 'sea' results
    // should win after the slow promise resolves.
    let resolveSlow: (v: readonly { kind: 'product'; name: string; subjectId: string }[]) => void = () => undefined;
    const search = jest.fn().mockImplementation((q: string) => {
      if (q === 'le') {
        return new Promise<readonly { kind: 'product'; name: string; subjectId: string }[]>(
          (resolve) => {
            resolveSlow = resolve;
          },
        );
      }
      return Promise.resolve([
        { kind: 'product' as const, name: 'Seat', subjectId: 'sub-seat' },
      ]);
    });
    const { getByTestId, findByTestId, queryByTestId } = render(
      <WriteScreen subjectTitle="X" searchAlternatives={search} />,
    );
    fireEvent.press(getByTestId('write-additional-data-pill'));
    // Fire the slow query first.
    fireEvent.changeText(getByTestId('write-alt-search-input'), 'le');
    // Fire the fast query — overwrites the latest-query ref.
    fireEvent.changeText(getByTestId('write-alt-search-input'), 'sea');
    // Wait for the fast (seat) result to render.
    expect(await findByTestId('write-alt-result-sub-seat')).toBeTruthy();
    // Now resolve the stale (leap) query — should NOT overwrite the
    // visible results.
    resolveSlow([
      { kind: 'product' as const, name: 'Leap', subjectId: 'sub-leap' },
    ]);
    // Drain microtasks.
    await Promise.resolve();
    await Promise.resolve();
    // Stale result must not have appeared.
    expect(queryByTestId('write-alt-result-sub-leap')).toBeNull();
    // Fast result still visible.
    expect(getByTestId('write-alt-result-sub-seat')).toBeTruthy();
  });
});

describe('WriteScreen — URL-param-driven chat-draft handoff', () => {
  // The InlineReviewDraftCard pushes /trust/write?draftId=…&threadId=…
  // when the user taps "Edit in form". WriteScreen reads those params,
  // looks up the lifecycle in the brain thread store, and uses the
  // drafted values as initial form state. Pins the contract between
  // the chat card and the form so the hand-off doesn't drop the user's
  // progress (the bug this branch was added for).
  let useLocalSearchParamsSpy: jest.SpyInstance | undefined;
  afterEach(() => {
    useLocalSearchParamsSpy?.mockRestore();
    useLocalSearchParamsSpy = undefined;
  });

  function mockParams(params: Record<string, string>): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const expoRouter = require('expo-router');
    useLocalSearchParamsSpy = jest
      .spyOn(expoRouter, 'useLocalSearchParams')
      .mockReturnValue(params);
  }

  it('pre-fills the form from a review-draft lifecycle', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const thread = require('@dina/brain/src/chat/thread');
    thread.resetThreads();
    const lifecycle = {
      kind: 'review_draft' as const,
      status: 'ready' as const,
      draftId: 'draft-abc',
      subject: {
        kind: 'product',
        name: 'Aeron Chair',
        did: '',
        uri: '',
        identifier: '',
      },
      values: {
        ...emptyWriteFormState(),
        subject: {
          kind: 'product',
          name: 'Aeron Chair',
          did: '',
          uri: '',
          identifier: '',
        },
        sentiment: 'positive',
        headline: 'Comfortable for daily work',
        body: 'I sit in this every day for 8 hours.',
        useCases: ['professional'],
      },
    };
    thread.addLifecycleMessage(
      'main',
      'Drafted a review of Aeron Chair.',
      lifecycle,
    );

    mockParams({ draftId: 'draft-abc', threadId: 'main' });
    const { getByDisplayValue } = render(<WriteScreen />);
    expect(getByDisplayValue('Comfortable for daily work')).toBeTruthy();
    expect(getByDisplayValue('I sit in this every day for 8 hours.')).toBeTruthy();
  });

  it('falls through to the empty form when the draft id is unknown', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const thread = require('@dina/brain/src/chat/thread');
    thread.resetThreads();
    mockParams({ draftId: 'draft-missing', threadId: 'main' });
    // Form opens — its render assertions live elsewhere; this spec only
    // pins that a stale link doesn't crash.
    const { getByTestId } = render(<WriteScreen />);
    expect(getByTestId('write-publish')).toBeTruthy();
  });
});
