/**
 * REQ-19 (docs/STATE_MACHINES.md): when the model does not answer, Brain fails
 * the item with the closed code `model_unavailable`. Core holds it: for its
 * first day it waits ten minutes and tries again without spending a retry,
 * so an outage neither loses the owner's fact nor files it where no model
 * chose. After a day the normal retries apply.
 */

import { InProcessTransport } from '../../src/client/in-process-transport';
import { CoreRouter } from '../../src/server/router';
import { registerStagingRoutes } from '../../src/server/routes/staging';
import {
  claimById,
  fail,
  getItem,
  ingest,
  resetStagingState,
  sweep,
} from '../../src/staging/service';
import {
  STAGING_MODEL_HOLD_LIMIT_SECONDS,
  STAGING_MODEL_HOLD_SECONDS,
  STAGING_MODEL_UNAVAILABLE,
  stagingRetryDelaySeconds,
} from '../../src/staging/state_machine';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const sec = (ms: number): number => Math.floor(ms / 1000);

function stageAndClaim(sourceId = 's1'): { id: string; token: string } {
  const { id } = ingest({
    source: 'user_remember',
    source_id: sourceId,
    data: { body: 'my blood pressure was 150/95' },
  });
  const claimed = claimById(id);
  if (claimed === null) throw new Error('not claimed');
  return { id, token: claimed.claim_token ?? '' };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  resetStagingState();
});

afterEach(() => {
  resetStagingState();
  jest.useRealTimers();
});

describe('fail with holdForModel', () => {
  it('holds a row in its first day without spending a retry, and requeues it after ten minutes', () => {
    const { id, token } = stageAndClaim();
    fail(id, STAGING_MODEL_UNAVAILABLE, token, { holdForModel: true });
    expect(getItem(id)).toMatchObject({
      status: 'failed',
      retry_count: 0,
      lease_until: sec(T0) + STAGING_MODEL_HOLD_SECONDS,
      error: STAGING_MODEL_UNAVAILABLE,
    });
    sweep(sec(T0) + STAGING_MODEL_HOLD_SECONDS - 1);
    expect(getItem(id)?.status).toBe('failed');
    sweep(sec(T0) + STAGING_MODEL_HOLD_SECONDS);
    expect(getItem(id)?.status).toBe('received');
  });

  it('holds through many outages in the first day, so the fact is never dead-lettered then', () => {
    const { id } = stageAndClaim();
    for (let i = 0; i < 20; i++) {
      jest.setSystemTime(T0 + i * STAGING_MODEL_HOLD_SECONDS * 1000);
      const again = claimById(id);
      fail(id, STAGING_MODEL_UNAVAILABLE, again?.claim_token, { holdForModel: true });
      sweep(sec(Date.now()) + STAGING_MODEL_HOLD_SECONDS);
    }
    expect(getItem(id)).toMatchObject({ status: 'received', retry_count: 0 });
  });

  it('spends retries again once the row is a day old', () => {
    const { id, token } = stageAndClaim();
    jest.setSystemTime(T0 + STAGING_MODEL_HOLD_LIMIT_SECONDS * 1000);
    fail(id, STAGING_MODEL_UNAVAILABLE, token, { holdForModel: true });
    expect(getItem(id)).toMatchObject({
      retry_count: 1,
      lease_until: sec(Date.now()) + stagingRetryDelaySeconds(1),
    });
  });

  it('leaves an ordinary failure as it was', () => {
    const { id, token } = stageAndClaim();
    fail(id, undefined, token);
    expect(getItem(id)).toMatchObject({
      retry_count: 1,
      lease_until: sec(T0) + stagingRetryDelaySeconds(1),
    });
  });
});

describe('POST /v1/staging/fail', () => {
  function client(): InProcessTransport {
    const router = new CoreRouter();
    registerStagingRoutes(router);
    return new InProcessTransport(router);
  }

  it('holds only for the closed model_unavailable code', async () => {
    const core = client();
    const a = stageAndClaim('a');
    await core.stagingFail(a.id, STAGING_MODEL_UNAVAILABLE, a.token);
    expect(getItem(a.id)).toMatchObject({ retry_count: 0, error: STAGING_MODEL_UNAVAILABLE });

    const b = stageAndClaim('b');
    await core.stagingFail(b.id, 'disk full', b.token);
    expect(getItem(b.id)?.retry_count).toBe(1);
    expect(getItem(b.id)?.error).toBeUndefined();
  });
});
