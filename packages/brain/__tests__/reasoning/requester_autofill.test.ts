/**
 * Requester-identity auto-fill tests (WM-BRAIN-06e + WM-TEST-03).
 *
 * Ported from main-dina's `brain/tests/test_query_service_autofill.py`.
 * Two groups:
 *
 *   looksLikeRequesterField — the name heuristic
 *   autofillRequesterFields — the schema-aware filler
 */

import {
  autofillRequesterFields,
  looksLikeRequesterField,
  REQUESTER_SELF_SENTINEL,
} from '../../src/reasoning/requester_autofill';

// ---------------------------------------------------------------------------
// looksLikeRequesterField
// ---------------------------------------------------------------------------

describe('looksLikeRequesterField', () => {
  it('patient_prefix', () => {
    expect(looksLikeRequesterField('patient_id')).toBe(true);
    expect(looksLikeRequesterField('patient_ref')).toBe(true);
    expect(looksLikeRequesterField('patient_number')).toBe(true);
  });

  it('customer_prefix', () => {
    expect(looksLikeRequesterField('customer_id')).toBe(true);
    expect(looksLikeRequesterField('customer_ref')).toBe(true);
    expect(looksLikeRequesterField('customer_number')).toBe(true);
  });

  it('account_prefix', () => {
    expect(looksLikeRequesterField('account_id')).toBe(true);
    expect(looksLikeRequesterField('account_number')).toBe(true);
    expect(looksLikeRequesterField('account_ref')).toBe(true);
  });

  it('member_prefix', () => {
    expect(looksLikeRequesterField('member_id')).toBe(true);
    expect(looksLikeRequesterField('member_number')).toBe(true);
  });

  it('plain_id_not_a_match', () => {
    // The load-bearing negative case. Plain `id` / `ref` must NOT
    // match — `reservation_id` is a legit schema field whose absence
    // should remain a caller error, not get silently papered over.
    expect(looksLikeRequesterField('id')).toBe(false);
    expect(looksLikeRequesterField('ref')).toBe(false);
    expect(looksLikeRequesterField('reservation_id')).toBe(false);
    expect(looksLikeRequesterField('order_ref')).toBe(false);
  });

  it('unrelated_fields', () => {
    expect(looksLikeRequesterField('stop_id')).toBe(false);
    expect(looksLikeRequesterField('route_name')).toBe(false);
    expect(looksLikeRequesterField('amount')).toBe(false);
    expect(looksLikeRequesterField('notes')).toBe(false);
  });

  it('empty_string', () => {
    expect(looksLikeRequesterField('')).toBe(false);
    expect(looksLikeRequesterField('   ')).toBe(false);
  });

  it('case_insensitive', () => {
    expect(looksLikeRequesterField('Patient_ID')).toBe(true);
    expect(looksLikeRequesterField('CUSTOMER_REF')).toBe(true);
    expect(looksLikeRequesterField('Account_Number')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// autofillRequesterFields
// ---------------------------------------------------------------------------

describe('autofillRequesterFields', () => {
  it('fills_missing_required_requester_field', () => {
    const out = autofillRequesterFields(
      {},
      {
        required: ['patient_id'],
        properties: { patient_id: { type: 'string' } },
      },
    );
    expect(out.params).toEqual({ patient_id: REQUESTER_SELF_SENTINEL });
    expect(out.filled).toEqual(['patient_id']);
  });

  it('does_not_overwrite_supplied_value', () => {
    const out = autofillRequesterFields(
      { patient_id: 'P-42' },
      {
        required: ['patient_id'],
        properties: { patient_id: { type: 'string' } },
      },
    );
    expect(out.params).toEqual({ patient_id: 'P-42' });
    expect(out.filled).toEqual([]);
  });

  it('does_not_fill_non_requester_fields', () => {
    // `reservation_id` is required AND missing — but it's NOT a
    // requester identity. Leave it missing so the provider's own
    // validation surfaces the error.
    const out = autofillRequesterFields(
      {},
      {
        required: ['reservation_id'],
        properties: { reservation_id: { type: 'string' } },
      },
    );
    expect(out.params).toEqual({});
    expect(out.filled).toEqual([]);
  });

  it('does_not_fill_optional_fields', () => {
    // `patient_id` IS a requester field but it's not in `required`
    // — the filler only targets required slots.
    const out = autofillRequesterFields(
      {},
      {
        required: [],
        properties: { patient_id: { type: 'string' } },
      },
    );
    expect(out.params).toEqual({});
    expect(out.filled).toEqual([]);
  });

  it('empty_required_list_is_noop', () => {
    // Same as above, phrased to match the Python test name.
    const out = autofillRequesterFields({}, { required: [], properties: {} });
    expect(out.filled).toEqual([]);
  });

  it('missing_required_key_in_schema_is_noop', () => {
    // `required` declares `patient_id`, but the schema's `properties`
    // doesn't — the published schema is inconsistent. We skip the
    // slot rather than invent it.
    const out = autofillRequesterFields(
      {},
      {
        required: ['patient_id'],
        properties: {},
      },
    );
    expect(out.params).toEqual({});
    expect(out.filled).toEqual([]);
  });

  it('does_not_mutate_input', () => {
    const input = { patient_id: '', amount: 42 };
    const out = autofillRequesterFields(input, {
      required: ['patient_id'],
      properties: { patient_id: { type: 'string' }, amount: { type: 'number' } },
    });
    expect(input).toEqual({ patient_id: '', amount: 42 }); // unchanged
    expect(out.params).toEqual({ patient_id: REQUESTER_SELF_SENTINEL, amount: 42 });
    expect(out.params).not.toBe(input); // new object
  });

  it('empty_string_value_treated_as_missing', () => {
    const out = autofillRequesterFields(
      { patient_id: '' },
      {
        required: ['patient_id'],
        properties: { patient_id: { type: 'string' } },
      },
    );
    expect(out.params).toEqual({ patient_id: REQUESTER_SELF_SENTINEL });
    expect(out.filled).toEqual(['patient_id']);
  });

  // -------------------------------------------------------------------
  // Extra defensive behaviours (not explicit in the test-name spec but
  // called out in the task doc description).
  // -------------------------------------------------------------------

  it('fills multiple requester fields at once', () => {
    const out = autofillRequesterFields(
      {},
      {
        required: ['patient_id', 'member_number'],
        properties: {
          patient_id: { type: 'string' },
          member_number: { type: 'string' },
        },
      },
    );
    expect(out.params).toEqual({
      patient_id: REQUESTER_SELF_SENTINEL,
      member_number: REQUESTER_SELF_SENTINEL,
    });
    expect(out.filled.sort()).toEqual(['member_number', 'patient_id']);
  });

  it('pass-through when schema is null / undefined', () => {
    expect(autofillRequesterFields({ a: 1 }, null)).toEqual({
      params: { a: 1 },
      filled: [],
    });
    expect(autofillRequesterFields({ a: 1 }, undefined)).toEqual({
      params: { a: 1 },
      filled: [],
    });
  });

  it('properties missing — skips the "declared in properties" check', () => {
    // When `properties` is absent, the filler still runs against
    // `required`. This mirrors the Python behaviour for callers that
    // hand in a partial schema.
    const out = autofillRequesterFields({}, { required: ['patient_id'] });
    expect(out.params).toEqual({ patient_id: REQUESTER_SELF_SENTINEL });
    expect(out.filled).toEqual(['patient_id']);
  });

  it('preserves falsy non-empty-string values (0, false)', () => {
    // Empty-string is "missing". Zero / false are real supplied
    // values and must not be overwritten.
    const out = autofillRequesterFields(
      { patient_id: 0, customer_id: false } as Record<string, unknown>,
      {
        required: ['patient_id', 'customer_id'],
        properties: {
          patient_id: { type: 'integer' },
          customer_id: { type: 'boolean' },
        },
      },
    );
    expect(out.params).toEqual({ patient_id: 0, customer_id: false });
    expect(out.filled).toEqual([]);
  });
});
