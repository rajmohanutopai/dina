import { validateLexicon } from '@dina/core';

import { buildAttestationRecord } from '../../src/peerlens/publish_helpers';
import {
  emptyWriteFormState,
  emptyWriteFormStateWithSubject,
} from '../../src/peerlens/write_form_data';

import type { Attestation } from '@dina/core';

describe('buildAttestationRecord', () => {
  it('produces a record accepted by the canonical AppView lexicon', () => {
    const state = {
      ...emptyWriteFormStateWithSubject('product'),
      sentiment: 'positive' as const,
      headline: 'Solid',
      body: 'Good support.',
      confidence: 'high' as const,
      subject: {
        kind: 'product' as const,
        name: 'Chair',
        did: '',
        uri: '',
        identifier: '',
      },
    };

    const record = buildAttestationRecord(state);

    expect(validateLexicon(record as Attestation)).toEqual([]);
  });

  it('accepts a resolved subject when the form targets an existing AppView subject', () => {
    const state = {
      ...emptyWriteFormState(),
      sentiment: 'positive' as const,
      headline: 'Still excellent',
      confidence: 'moderate' as const,
    };

    const record = buildAttestationRecord(state, {
      subject: { type: 'product', name: 'Chair', identifier: 'chair-1' },
      kind: 'product',
    });

    expect(validateLexicon(record as Attestation)).toEqual([]);
  });
});
