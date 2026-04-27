/**
 * Demo loopback responder for the Bus Driver scenario.
 *
 * The mobile demo seeds an AppView profile for `did:plc:bus42demo`
 * (`busDriverDemoProfile()`), but no real peer answers at that DID —
 * outbound `service.query` envelopes go straight into `sendD2D` and
 * disappear. Without a response the workflow task ages out, the chat
 * thread never sees a result, and the README walk-through silently
 * fails.
 *
 * This module wraps `sendD2D`. When a `service.query` is dispatched to
 * the demo BusDriver DID, the wrapper:
 *   1. Computes a deterministic `eta_query` result from the params
 *      (route_id + location → "Bus 42 — 12 min to Castro Station" +
 *      Google Maps deep link).
 *   2. Finds the open `service_query` workflow task by
 *      `(query_id, peerDID, capability)` — same primitive Core's receive
 *      pipeline uses to correlate inbound responses.
 *   3. Completes that task with the synthesized response body.
 *      Completion fires a `completed` workflow_event whose
 *      `WorkflowEventConsumer` formats into a Dina chat message.
 *
 * This deliberately bypasses signature verification + audit logging:
 * we're impersonating a peer to exercise the requester half of the
 * pipeline. Production swaps the demo profile out for a real BusDriver
 * provider node and the wrapper becomes a no-op.
 */

import type { EtaQueryParams, EtaQueryResult } from '@dina/brain/src/service/capabilities/eta_query';
import { getWorkflowService } from '@dina/core/src/workflow/service';

export const DEMO_BUS_DRIVER_DID = 'did:plc:bus42demo';

/** Fallback location pin — Castro & Market, SF. Used when the LLM hasn't
 * supplied a location and we still need to render a map URL. */
const FALLBACK_LOCATION = { lat: 37.762, lng: -122.435 } as const;

/** Origin pin for the map deep link (Civic Center, SF). */
const MAP_ORIGIN = { lat: 37.7793, lng: -122.4193 } as const;

interface SendD2DFn {
  (to: string, type: string, body: Record<string, unknown>): Promise<void>;
}

interface DemoLogEntry {
  event: string;
  [k: string]: unknown;
}

export interface DemoBusDriverResponder {
  /**
   * Wrap a real `sendD2D` so that envelopes addressed to the demo
   * BusDriver short-circuit into a synthesized `service.response`.
   * Other DIDs pass through untouched.
   */
  wrap(sendD2D: SendD2DFn): SendD2DFn;
}

export interface DemoBusDriverResponderOptions {
  /** DID to short-circuit on. Defaults to `did:plc:bus42demo`. */
  busDID?: string;
  /**
   * Optional log sink. Same shape as `bootAppNode`'s `logger` so
   * callers can plumb the boot logger straight through.
   */
  log?: (entry: DemoLogEntry) => void;
  /**
   * Override the canned ETA result for tests. Defaults to a fixed
   * 12-min "on_route" Bus 42 response.
   */
  buildResult?: (params: EtaQueryParams) => EtaQueryResult;
}

export function createDemoBusDriverResponder(
  options: DemoBusDriverResponderOptions = {},
): DemoBusDriverResponder {
  const busDID = options.busDID ?? DEMO_BUS_DRIVER_DID;
  const buildResult = options.buildResult ?? defaultEtaResult;
  const log = options.log ?? (() => {});

  return {
    wrap(realSendD2D) {
      return async (to, type, body) => {
        if (to !== busDID || type !== 'service.query') {
          return realSendD2D(to, type, body);
        }
        // Schedule the synthesized response. Run on the next tick so
        // the caller's `sendServiceQuery` returns first — mirrors the
        // network-async behaviour the real path would have.
        setTimeout(() => {
          completeServiceQueryTask(busDID, body, buildResult, log);
        }, 50);
      };
    },
  };
}

function completeServiceQueryTask(
  busDID: string,
  queryBody: Record<string, unknown>,
  buildResult: (params: EtaQueryParams) => EtaQueryResult,
  log: (entry: DemoLogEntry) => void,
): void {
  const queryId = typeof queryBody.query_id === 'string' ? queryBody.query_id : '';
  const capability = typeof queryBody.capability === 'string' ? queryBody.capability : '';
  if (queryId === '' || capability === '') {
    log({
      event: 'demo.bus_driver.invalid_query',
      query_id: queryId,
      capability,
    });
    return;
  }
  const params = (queryBody.params ?? {}) as EtaQueryParams;

  const service = getWorkflowService();
  if (service === null) {
    log({ event: 'demo.bus_driver.no_workflow_service', query_id: queryId });
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let task;
  try {
    task = service.store().findServiceQueryTask(queryId, busDID, capability, nowSec);
  } catch (err) {
    log({
      event: 'demo.bus_driver.find_task_error',
      query_id: queryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (task === null) {
    log({ event: 'demo.bus_driver.no_matching_task', query_id: queryId, peer: busDID });
    return;
  }

  let serviceName = 'Bus 42';
  try {
    const payload = JSON.parse(task.payload) as { service_name?: string };
    if (typeof payload.service_name === 'string' && payload.service_name !== '') {
      serviceName = payload.service_name;
    }
  } catch {
    /* malformed payload — fall back to the default service name */
  }

  const result = buildResult(params);
  const responseBody = {
    query_id: queryId,
    capability,
    status: 'success' as const,
    result,
    ttl_seconds: 60,
  };
  const eventDetails = JSON.stringify({
    response_status: 'success',
    capability,
    service_name: serviceName,
  });

  service.store().completeWithDetails(
    task.id,
    '', // no agent claim — service.response completion is requester-side
    '', // result_summary — left empty so the consumer formats from the body
    JSON.stringify(responseBody),
    eventDetails,
    Date.now(),
  );
  log({
    event: 'demo.bus_driver.responded',
    task_id: task.id,
    query_id: queryId,
    eta_minutes: result.eta_minutes,
  });
}

function defaultEtaResult(params: EtaQueryParams): EtaQueryResult {
  const dest =
    params.location !== undefined &&
    typeof params.location.lat === 'number' &&
    typeof params.location.lng === 'number'
      ? params.location
      : FALLBACK_LOCATION;
  const routeId = typeof params.route_id === 'string' && params.route_id !== '' ? params.route_id : '42';
  return {
    eta_minutes: 12,
    vehicle_type: 'Bus',
    route_name: `Route ${routeId}`,
    stop_name: 'Castro Station',
    stop_distance_m: 240,
    map_url:
      `https://www.google.com/maps/dir/?api=1` +
      `&origin=${MAP_ORIGIN.lat},${MAP_ORIGIN.lng}` +
      `&destination=${dest.lat},${dest.lng}` +
      `&travelmode=transit`,
    status: 'on_route',
  };
}
