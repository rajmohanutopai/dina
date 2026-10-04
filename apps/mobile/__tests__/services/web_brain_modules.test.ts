/**
 * WEB_OWNER_SURFACE_PLAN §3.4 — the web modules that read Brain reach it at
 * the origin the runtime config names, cross-origin and without credentials.
 * The architecture scan (`web_brain_calls.test.ts`) keeps raw calls out; this
 * drives each module and checks where its requests land.
 */

import { appViewBase } from '../../src/peerlens/appview_base.web';
import { loadContacts, deleteContact } from '../../src/services/contacts_source.web';
import { getGroupPlanReader } from '../../src/services/group_plan_reader.web';
import { installServerNotifications } from '../../src/services/server_notifications.web';
import { resolveServiceConfigCoreClient } from '../../src/services/service_config_resolver.web';
import { loadTradeDetails } from '../../src/services/trade_details_source.web';
import {
  BRAIN,
  configLoaded,
  installBrainStreams,
  installCoreServedPage,
  streamDelivered,
} from '../setup/web_brain';

import type { ServiceConfigCoreClient } from '../../src/hooks/useServiceConfigForm';

type Call = [string, RequestInit | undefined];

let calls: Call[];

function answering(body: unknown, status = 200): void {
  calls = [];
  installCoreServedPage(async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function landed(): string[] {
  for (const [, init] of calls) expect(init?.credentials).toBe('omit');
  return calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
}

it('contacts', async () => {
  answering({ contacts: [], deleted: true });
  await loadContacts();
  await deleteContact('did:plc:a/b');
  expect(landed()).toEqual([
    `GET ${BRAIN}/api/v1/contacts`,
    `DELETE ${BRAIN}/api/v1/contacts/did%3Aplc%3Aa%2Fb`,
  ]);
});

it('trade details', async () => {
  answering({ contact: { legalName: 'Sancho Traders' } });
  expect((await loadTradeDetails('did:plc:s')).legalName).toBe('Sancho Traders');
  expect(landed()).toEqual([`GET ${BRAIN}/api/v1/contacts/lookup?q=did%3Aplc%3As`]);
});

it('service config', async () => {
  answering({ listings: [] });
  const client = resolveServiceConfigCoreClient({} as ServiceConfigCoreClient);
  await client.listServiceConfigs();
  await client.deleteServiceConfig('bakery');
  expect(landed()).toEqual([
    `GET ${BRAIN}/api/v1/service/configs`,
    `DELETE ${BRAIN}/api/v1/service/config/bakery`,
  ]);
});

it('group plan reads', async () => {
  answering({ plan: { id: 'p1' } });
  expect(await getGroupPlanReader()?.get('p1')).toEqual({ id: 'p1' });
  expect(landed()).toEqual([`GET ${BRAIN}/api/v1/coordination/plans/p1`]);
});

it('notifications: the snapshot, then the stream, both on Brain', async () => {
  answering({ notifications: [] });
  const streams = installBrainStreams();
  const dispose = installServerNotifications();
  for (let i = 0; i < 5 && streams.opened.length === 0; i++) await streamDelivered();
  dispose();
  expect(landed()[0]).toBe(`GET ${BRAIN}/api/v1/notifications`);
  expect(streams.opened.map((s) => s.url)).toEqual([`${BRAIN}/api/v1/notifications/stream`]);
});

it('PeerLens reads go to Brain’s AppView proxy', async () => {
  answering({});
  expect(await appViewBase()).toBe(`${BRAIN}/api/peerlens`);
});
