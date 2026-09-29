/**
 * The "confirm it's you" sheet, as accessibility tools see it. Reported:
 * Verify did not appear to accessibility tools while Cancel did — Verify was
 * a bare Pressable disabled while the field's state was empty, and a
 * disabled element is hidden from some tools. Pinned: both are buttons with
 * labels; Verify is pressable with an empty field (the gate says what is
 * missing); while a proof runs it keeps a label and reads as busy.
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { PresenceSheet, type PresenceSheetProps } from '../../src/components/PresenceSheet';

function sheet(
  over: Partial<PresenceSheetProps> = {},
): PresenceSheetProps & { onSubmit: jest.Mock } {
  return {
    visible: true,
    secretKind: 'passphrase',
    secret: '',
    onChangeSecret: jest.fn(),
    error: null,
    busy: false,
    onSubmit: jest.fn(),
    onCancel: jest.fn(),
    ...over,
  } as never;
}

it('Verify and Cancel are both labelled buttons, and Verify is pressable with an empty field', () => {
  const props = sheet();
  const view = render(<PresenceSheet {...props} />);
  const verify = view.getByTestId('presence-submit');
  const cancel = view.getByTestId('presence-cancel');
  expect(verify.props.accessibilityRole).toBe('button');
  expect(verify.props.accessibilityLabel).toBe('Verify');
  expect(verify.props.accessibilityState).toMatchObject({ disabled: false });
  expect(cancel.props.accessibilityRole).toBe('button');
  expect(cancel.props.accessibilityLabel).toBe('Cancel');
  fireEvent.press(verify);
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
});

it('while a proof runs, Verify keeps a label and reads as busy', () => {
  const view = render(<PresenceSheet {...sheet({ busy: true, secret: 'x' })} />);
  const verify = view.getByTestId('presence-submit');
  expect(verify.props.accessibilityLabel).toBe('Verifying');
  expect(verify.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
});
