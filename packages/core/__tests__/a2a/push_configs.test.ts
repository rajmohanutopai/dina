/**
 * Webhook configs (A2A §3.1.7–§3.1.10, design §7.5, §6.6): checked when set,
 * capped per task, the client's own only, deleted idempotently.
 */

import {
  MAX_PUSH_CONFIGS_PER_TASK,
  ingressCreatePushConfig,
  ingressDeletePushConfig,
  ingressGetPushConfig,
  ingressListPushConfigs,
  ingressSendMessage,
  createA2AClient,
} from '../../src/a2a';

import { InboundWorld, errorOf, resultOf, sentTask } from './inbound_fixture';

let iw: InboundWorld;
let taskId: string;
beforeEach(async () => {
  iw = await InboundWorld.create();
  taskId = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
});
afterEach(() => iw.close());

const create = (params: Record<string, unknown>, auth?: string) =>
  ingressCreatePushConfig(
    iw.rt,
    iw.request('CreateTaskPushNotificationConfig', { taskId, ...params }, {}, auth),
    String(params.taskId ?? taskId),
  );
const get = (id: string) =>
  ingressGetPushConfig(
    iw.rt,
    iw.request('GetTaskPushNotificationConfig', { taskId, id }),
    taskId,
    id,
  );
const list = () =>
  ingressListPushConfigs(iw.rt, iw.request('ListTaskPushNotificationConfigs', { taskId }), taskId);
const remove = (id: string) =>
  ingressDeletePushConfig(
    iw.rt,
    iw.request('DeleteTaskPushNotificationConfig', { taskId, id }),
    taskId,
    id,
  );

describe('create, get, list, delete', () => {
  it('stores the config with a server id and hands it back as set', () => {
    const made = resultOf(
      create({
        id: 'ignored-client-id',
        url: 'https://hooks.example.test/a2a?x=1',
        token: 'tok-1',
        authentication: { scheme: 'Bearer', credentials: 'sekrit' },
      }),
    );
    expect(made).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      taskId,
      url: 'https://hooks.example.test/a2a?x=1',
      token: 'tok-1',
      authentication: { scheme: 'Bearer', credentials: 'sekrit' },
    });
    expect(resultOf(get(made.id as string))).toEqual(made);
    expect(resultOf(list())).toEqual({ configs: [made], nextPageToken: '' });
    expect(resultOf(remove(made.id as string))).toEqual({});
    expect(resultOf(list())).toEqual({ configs: [], nextPageToken: '' });
  });

  it('delete is idempotent; get of a gone config is TaskNotFound', () => {
    const made = resultOf(create({ url: 'https://hooks.example.test/a' }));
    expect(resultOf(remove(made.id as string))).toEqual({});
    expect(resultOf(remove(made.id as string))).toEqual({});
    expect(errorOf(get(made.id as string)).code).toBe(-32001);
  });

  it(`holds at most ${MAX_PUSH_CONFIGS_PER_TASK} per task`, () => {
    for (let i = 0; i < MAX_PUSH_CONFIGS_PER_TASK; i += 1) {
      expect(create({ url: `https://hooks.example.test/${i}` }).status).toBe(200);
    }
    expect(errorOf(create({ url: 'https://hooks.example.test/x' }))).toEqual({
      code: -32602,
      reason: 'too_many_push_configs',
    });
  });

  it('another client’s task, or one that does not exist, is TaskNotFound', async () => {
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    expect(
      errorOf(create({ url: 'https://hooks.example.test/a' }, `Bearer ${other.token}`)).code,
    ).toBe(-32001);
    expect(
      errorOf(create({ taskId: 'no-such-task', url: 'https://hooks.example.test/a' })).code,
    ).toBe(-32001);
  });
});

describe('what a config may say (§6.6: the URL rule every outbound connection follows)', () => {
  it.each([
    ['plain http', { url: 'http://hooks.example.test/a' }, 'push_url_not_https'],
    ['a literal address', { url: 'https://10.0.0.5/a' }, 'push_url_literal_ip'],
    ['a literal IPv6 address', { url: 'https://[::1]/a' }, 'push_url_literal_ip'],
    [
      'credentials in the URL',
      { url: 'https://u:p@hooks.example.test/a' },
      'push_url_credentials_in_url',
    ],
    ['a fragment', { url: 'https://hooks.example.test/a#x' }, 'push_url_fragment'],
    ['no URL', {}, 'push_url_missing'],
    [
      'a token that would split a header',
      { url: 'https://h.test/a', token: 'a\r\nX-Evil: 1' },
      'push_token_malformed',
    ],
    [
      'a scheme that is not a token',
      { url: 'https://h.test/a', authentication: { scheme: 'Bear er' } },
      'push_auth_malformed',
    ],
    [
      'credentials that would split a header',
      { url: 'https://h.test/a', authentication: { scheme: 'Bearer', credentials: 'x\ny' } },
      'push_auth_malformed',
    ],
    ['a tenant', { url: 'https://h.test/a', tenant: 'acme' }, 'tenant_unsupported'],
  ])('refuses %s', (_name, params, reason) => {
    expect(errorOf(create(params))).toEqual({ code: -32602, reason });
    expect(resultOf(list())).toEqual({ configs: [], nextPageToken: '' });
  });

  it('a bad inline config refuses the whole call, before anything is stored', () => {
    const before = iw.world.store.db.query(
      "SELECT COUNT(*) AS n FROM a2a_tasks WHERE direction = 'inbound'",
    );
    const answer = ingressSendMessage(
      iw.rt,
      iw.request('SendMessage', {
        ...iw.message({ skill: 'eta_query', params: { route_id: '42' } }),
        configuration: { taskPushNotificationConfig: { url: 'http://insecure.test/a' } },
      }),
    );
    expect(errorOf(answer)).toEqual({ code: -32602, reason: 'push_url_not_https' });
    expect(
      iw.world.store.db.query("SELECT COUNT(*) AS n FROM a2a_tasks WHERE direction = 'inbound'"),
    ).toEqual(before);
  });
});
