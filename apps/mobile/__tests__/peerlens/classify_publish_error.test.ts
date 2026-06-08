/**
 * The shared publish-error classifier — one table that pins every case this
 * thread previously fixed piecemeal (429/408 retryable; 401/403/400/lexicon/
 * identity permanent; network retryable), so the immediate path and the worker
 * can't drift on retry policy.
 */

import { PDSPublisherError } from '@dina/brain';


import { classifyPublishError, describePublishErrorCode } from '../../src/peerlens/classify_publish_error';
import {
  AttestationIdentityMismatchError,
  AttestationLexiconError,
} from '../../src/peerlens/publish_attestation';

import type { ClassifiedError } from '@dina/core';

interface Case {
  name: string;
  err: unknown;
  class: ClassifiedError['class'];
  code: ClassifiedError['code'];
}

const cases: Case[] = [
  { name: 'network (status null)', err: new PDSPublisherError('net', null), class: 'retryable', code: 'network' },
  { name: '408 timeout', err: new PDSPublisherError('t', 408), class: 'retryable', code: 'request_timeout' },
  { name: '429 rate limit', err: new PDSPublisherError('r', 429), class: 'retryable', code: 'rate_limited' },
  { name: '500 server', err: new PDSPublisherError('s', 500), class: 'retryable', code: 'server_5xx' },
  { name: '503 server', err: new PDSPublisherError('s', 503), class: 'retryable', code: 'server_5xx' },
  { name: '400 bad request', err: new PDSPublisherError('b', 400), class: 'permanent', code: 'bad_request' },
  { name: '401 unauthorized', err: new PDSPublisherError('u', 401), class: 'permanent', code: 'unauthorized' },
  { name: '403 forbidden', err: new PDSPublisherError('f', 403), class: 'permanent', code: 'forbidden' },
  { name: '404 other 4xx', err: new PDSPublisherError('n', 404), class: 'permanent', code: 'bad_request' },
  {
    name: 'identity mismatch',
    err: new AttestationIdentityMismatchError('did:plc:me', 'did:plc:other'),
    class: 'permanent',
    code: 'identity_mismatch',
  },
  { name: 'lexicon invalid', err: new AttestationLexiconError('too long'), class: 'permanent', code: 'lexicon_invalid' },
  { name: 'unknown Error', err: new Error('weird'), class: 'retryable', code: 'unknown' },
  { name: 'non-Error throw', err: 'a string', class: 'retryable', code: 'unknown' },
];

describe('classifyPublishError', () => {
  it.each(cases)('$name → $class/$code', ({ err, class: cls, code }) => {
    const out = classifyPublishError(err);
    expect(out.class).toBe(cls);
    expect(out.code).toBe(code);
    expect(typeof out.message).toBe('string');
  });

  it('carries the underlying technical message through for diagnostics', () => {
    expect(classifyPublishError(new PDSPublisherError('HTTP 503 bad gateway', 503)).message).toBe(
      'HTTP 503 bad gateway',
    );
  });
});

describe('describePublishErrorCode', () => {
  it('gives a friendly, non-raw line for every code', () => {
    const codes: ClassifiedError['code'][] = [
      'network',
      'timeout',
      'server_5xx',
      'rate_limited',
      'request_timeout',
      'lease_expired',
      'identity_mismatch',
      'lexicon_invalid',
      'bad_request',
      'unauthorized',
      'forbidden',
      'no_credentials',
      'retries_exhausted',
      'demo_scope',
      'unknown',
    ];
    for (const code of codes) {
      const msg = describePublishErrorCode(code);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/HTTP \d{3}/); // never a raw status line
    }
  });

  it('credential failures point the user at PDS setup', () => {
    expect(describePublishErrorCode('unauthorized')).toMatch(/credentials|infrastructure|re-onboard/i);
  });
});
