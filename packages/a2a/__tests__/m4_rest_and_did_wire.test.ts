/**
 * M4 wire rules (design §5.1; notes M4 steps 1 and 3) the plan's area D
 * listed with no test of their own: the DID binding body is strict I-JSON
 * and its DID cannot carry a line break; :subscribe is served by GET and
 * POST; A2A-Version may appear once in a REST query; a dot-segment task id
 * matches no route and offers no method.
 */

import {
  A2A_REST_PATH,
  matchRestRequest,
  parseDidBindingRequest,
  restMethodsFor,
  restParams,
  type RestMatch,
} from '../src';

const CHALLENGE = `dch_${'B'.repeat(43)}`;
const SIG = 'cd'.repeat(64);

const matched = (method: string, path: string): RestMatch => {
  const m = matchRestRequest(method, `${A2A_REST_PATH}${path}`);
  if (m === null) throw new Error(`no route for ${method} ${path}`);
  return m;
};

describe('the DID binding body (§5.1 strict I-JSON)', () => {
  // Plan D14
  it.each([
    ['a __proto__ member beside the three', `{"did":"did:plc:abc","challenge":"${CHALLENGE}","signature":"${SIG}","__proto__":{}}`],
    ['the three inside a __proto__ member', `{"__proto__":{"did":"did:plc:abc"},"challenge":"${CHALLENGE}","signature":"${SIG}"}`],
  ])('refuses %s', (_name, text) => {
    expect(parseDidBindingRequest(text)).toBeNull();
  });

  // Plan D14
  it.each([
    ['a trailing line break', 'did:plc:abc\n'],
    ['a line break inside', 'did:plc:abc\nn4'],
    ['a carriage return', 'did:plc:abc\r'],
  ])('refuses a DID with %s, which could forge a line of the signing input', (_name, did) => {
    expect(parseDidBindingRequest(JSON.stringify({ did, challenge: CHALLENGE, signature: SIG }))).toBeNull();
  });
});

describe('REST routes and params (A2A §11, notes M4 step 3)', () => {
  // Plan D144
  it(':subscribe is served by both GET and POST, as the reference SDK serves it', () => {
    expect([...restMethodsFor(`${A2A_REST_PATH}/tasks/t-1:subscribe`)].sort()).toEqual(['GET', 'POST']);
  });

  // Plan D148
  it.each([
    ['GET', '/tasks', 'A2A-Version=1.0&A2A-Version=1.0', ''],
    ['GET', '/tasks/t-1', 'A2A-Version=1.0&A2A-Version=0.3', ''],
    ['POST', '/message:send', 'A2A-Version=1.0&A2A-Version=1.0', '{"message":{}}'],
  ])('refuses A2A-Version twice in the query of %s %s, whatever the values', (method, path, query, body) => {
    expect(restParams(matched(method, path), query, body)).toEqual({ ok: false, reason: 'query_not_allowed' });
    // Once is fine.
    expect(restParams(matched(method, path), 'A2A-Version=1.0', body)).toEqual(expect.objectContaining({ ok: true, versionParameter: '1.0' }));
  });

  // Plan D160
  // Every route that takes a task id: the dot segment matches none of them; three dots match each.
  const ID_ROUTES: [string, (id: string) => string][] = [
    ['GET', (id) => `/tasks/${id}`],
    ['POST', (id) => `/tasks/${id}:cancel`],
    ['GET', (id) => `/tasks/${id}:subscribe`],
    ['POST', (id) => `/tasks/${id}:subscribe`],
    ['GET', (id) => `/tasks/${id}/pushNotificationConfigs`],
    ['POST', (id) => `/tasks/${id}/pushNotificationConfigs`],
    ['GET', (id) => `/tasks/${id}/pushNotificationConfigs/c-1`],
    ['DELETE', (id) => `/tasks/${id}/pushNotificationConfigs/c-1`],
  ];
  it.each(['..', '.', '%2e%2e', '%2E'])('a task id that is a dot segment (%s) matches no route that takes a task id', (id) => {
    for (const [method, path] of ID_ROUTES) {
      expect([method, path(id), matchRestRequest(method, `${A2A_REST_PATH}${path(id)}`)]).toEqual([method, path(id), null]);
    }
    expect(restMethodsFor(`${A2A_REST_PATH}/tasks/${id}`)).toEqual([]);
  });

  it('an id of other dots is a task id like any other, on every route that takes one', () => {
    for (const [method, path] of ID_ROUTES) {
      const m = matchRestRequest(method, `${A2A_REST_PATH}${path('...')}`);
      // A config route names the task as taskId (its id is the config's).
      expect([method, path('...'), m?.ids.taskId ?? m?.ids.id]).toEqual([method, path('...'), '...']);
    }
  });
});
