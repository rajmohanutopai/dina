/**
 * A local Dina node for the outside-agent runs (and the official A2A TCK).
 * Boots Core on DINA_CORE_PORT with Lane 2 on, seeds one public listing on a
 * paired "transit" runner (eta_query answered at once, price_check under the
 * owner's review), mints a client bearer into TCK_TOKEN_FILE, and runs a
 * stand-in runner that answers every call with a fixed result. See README.md.
 */
import { writeFileSync } from 'node:fs';

import {
  admitInboundClaim,
  bindRunner,
  createA2AClient,
  deriveDIDKey,
  getA2ARuntime,
  getPublicKey,
  getWorkflowService,
  setServiceConfigDurable,
} from '@dina/core';
import { registerDevice as pairDevice } from '@dina/core/devices';
import { registerDevice as registerCallerDevice } from '@dina/core/runtime';

import { bootServer } from '../../../apps/home-node-lite/core-server/src/boot';

const RUNNER_DID = deriveDIDKey(getPublicKey(new Uint8Array(32).fill(43)));
const ETA_PARAMS = { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } };
const ETA_RESULT = { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } };

async function main(): Promise<void> {
  await bootServer();
  const store = getA2ARuntime()?.store;
  if (store === undefined) throw new Error('no A2A runtime after boot');
  try {
    pairDevice('Transit runner', RUNNER_DID.slice('did:key:'.length), 'agent', 'runner');
  } catch {
    // Paired on an earlier start of this vault.
  }
  registerCallerDevice(RUNNER_DID, 'Transit runner');
  bindRunner(store, { lane: 'transit', device_did: RUNNER_DID }, Date.now());
  await setServiceConfigDurable(
    {
      isDiscoverable: true,
      discoverability: 'public',
      status: 'active',
      name: 'Bus 42',
      description: 'Arrival times for route 42.',
      capabilities: {
        eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' },
        price_check: { mcpServer: 'transit', mcpTool: 'get_price', responsePolicy: 'review', category: 'transit' },
      },
      capabilitySchemas: {
        eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h-eta' },
        price_check: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h-price' },
      },
    },
    'bus',
  );
  const made = createA2AClient(store, { display_name: 'A2A TCK' }, Date.now());
  if (!made.ok) throw new Error(made.reason);
  writeFileSync(process.env['TCK_TOKEN_FILE'] ?? '/dev/stdout', made.token);
  // The stand-in runner: claim, pass the boundary, answer.
  setInterval(() => {
    const wf = getWorkflowService();
    if (wf === null) return;
    for (;;) {
      const task = wf.store().claimDelegationTask(RUNNER_DID, Date.now(), 30_000, 'transit');
      if (task === null) return;
      if (admitInboundClaim(task, RUNNER_DID) !== 'admitted') continue;
      wf.complete(task.id, JSON.stringify({ eta_minutes: 5 }), 'done', RUNNER_DID, task.claim_id ?? undefined);
    }
  }, 250);
}

void main();
