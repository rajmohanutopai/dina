/**
 * The INVOCATION surfaces for installed plugins (PLUGIN_ARCHITECTURE §6, §9.1,
 * §15.5): ask an installed `tool` capability to do something.
 *
 *   POST /v1/plugins/invoke            → OWNER: gate the ask; stage ONE task on
 *                                        the plugin lane, `queued` (silent) or
 *                                        `pending_approval` (card); the owner may
 *                                        name dispatch metadata (resource/value,
 *                                        idempotency key, correlation id)
 *   GET  /v1/plugins/tool-capabilities → BRAIN (and owner): every consented `tool`
 *                                        capability on an active install — what
 *                                        `/ask` may route to (§6)
 *   POST /v1/plugins/tool-invoke       → BRAIN (and owner): the same gate, with a
 *                                        NARROW body — install, capability, params
 *                                        and the classifier's categories; no
 *                                        dispatch metadata a caller could tune
 *                                        to fit a grant's constraints
 *
 * Brain never bypasses the owner: a custom capability floors at MODERATE and
 * cards until the owner grants; a regulated one cards every time; a grant the
 * owner minted is what lets a Brain-routed ask run silent, exactly as §8
 * intends. What Brain may NOT do is decide the card — `brainPluginInvocationGuard`
 * on the workflow verbs.
 *
 * The decision on a carded task rides the existing workflow verbs
 * (`/v1/workflow/tasks/:id/approve` | `/cancel`), which know a plugin
 * invocation by its payload and record the owner's decision (`invocation_*`)
 * — plus an optional grant on approve (`plugin_grant`). The result rides the
 * task too (`GET /v1/workflow/tasks/:id`): the runner's `/complete` validates
 * it against the pinned result schema before it lands.
 */

import { type InvocationSubject } from '../../plugins/context_sources';
import { consentedCapability } from '../../plugins/host_operation_lane';
import { invokeToolCapability, type InvokePolicy, type InvokeToolCapabilityResult } from '../../plugins/invoke';
import { getPluginInstallRepository } from '../../plugins/registry';
import { getWorkflowService } from '../../workflow/service';

import { makeOwnerGuard } from './owner_guard';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

/** One routable capability, as `/ask`'s classifier sees it (§6). */
export interface PluginToolCapabilityView {
  install_id: string;
  plugin_id: string;
  plugin_display_name: string;
  capability_id: string;
  display_name: string;
  action_class: string;
  privacy_class: string;
  /** The consented params schema — what the caller must supply. */
  params_schema: unknown;
  /** The consented categories that may ride the params (§11.5). */
  data_scope_categories: string[];
}

/** Every consented `tool` capability on an active install. */
export function listPluginToolCapabilities(): PluginToolCapabilityView[] {
  const installs = getPluginInstallRepository();
  if (installs === null) return [];
  const out: PluginToolCapabilityView[] = [];
  for (const install of installs.list()) {
    if (install.status !== 'active') continue;
    for (const declared of install.manifest.capabilities) {
      const cap = consentedCapability(install, declared.id);
      if (cap === null || !(cap.kinds ?? []).includes('tool')) continue;
      out.push({
        install_id: install.installId,
        plugin_id: install.pluginId,
        plugin_display_name: install.manifest.display_name,
        capability_id: cap.id,
        display_name: cap.display_name,
        action_class: cap.action_class,
        privacy_class: cap.privacy_class,
        params_schema: cap.params_schema ?? null,
        data_scope_categories: [...(cap.data_scope?.categories ?? [])],
      });
    }
  }
  return out;
}

/** Brain (server: the signed service key; phone: in-process) or the owner. */
function brainOrOwner(req: CoreRequest, ownerOnlyGuard: (r: CoreRequest) => CoreResponse | null): CoreResponse | null {
  if (req.callerType === 'brain') return null;
  // In-process Brain calls carry no caller type — the phone's one VM.
  if (req.trustedInProcess === true && req.callerType === undefined) return null;
  return ownerOnlyGuard(req);
}

function invokeResponse(result: InvokeToolCapabilityResult): CoreResponse {
  if (!result.ok) {
    const status =
      result.code === 'registry_unavailable'
        ? 503
        : result.code === 'install_unknown'
          ? 404
          : result.code === 'params_invalid'
            ? 400
            : result.code === 'blocked'
              ? 403
              : 409;
    return { status, body: { ok: false, code: result.code, message: result.message } };
  }
  if (result.mode === 'dispatched') {
    return {
      status: 202,
      body: {
        ok: true,
        mode: 'dispatched',
        task_id: result.taskId,
        execution_id: result.executionId,
        ...(result.grantId !== undefined ? { grant_id: result.grantId } : {}),
      },
    };
  }
  return {
    status: 202,
    body: {
      ok: true,
      mode: 'approval_required',
      task_id: result.taskId,
      execution_id: result.executionId,
      card: {
        risk_level: result.card.riskLevel,
        reasons: result.card.reasons,
        params_text: result.card.paramsText,
        // What Core's own projection added, as metadata (§11 point 4). The
        // owner is told a filing carries two business-registry facts; the
        // facts themselves are already in `params_text`, and printing a
        // second copy here would make the card the thing that leaks.
        context: {
          categories: result.card.context.categories,
          item_count: result.card.context.item_count,
        },
      },
    },
  };
}

/**
 * The OWNER's subject block (§11): who and what the task is about. Identities
 * only — never facts. There is no context field on either route on purpose:
 * §11 gives Core the projection, so a body that could carry one would make
 * every caller a projector.
 */
function invocationSubject(value: unknown): InvocationSubject | null | 'invalid' {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const raw = value as { contact_did?: unknown; document_digest?: unknown };
  if (raw.contact_did !== undefined && typeof raw.contact_did !== 'string') return 'invalid';
  if (raw.document_digest !== undefined && typeof raw.document_digest !== 'string') return 'invalid';
  return {
    ...(typeof raw.contact_did === 'string' ? { contactDid: raw.contact_did } : {}),
    ...(typeof raw.document_digest === 'string' ? { documentDigest: raw.document_digest } : {}),
  };
}

function stringList(value: unknown): string[] | null | 'invalid' {
  if (value === undefined) return null;
  return Array.isArray(value) && value.every((c) => typeof c === 'string') ? (value as string[]) : 'invalid';
}

export function registerPluginInvokeRoutes(
  router: CoreRouter,
  ownerCapability?: string,
  policy?: InvokePolicy,
): void {
  const ownerOnlyGuard = makeOwnerGuard(ownerCapability, 'only the owner may invoke a plugin');

  router.post('/v1/plugins/invoke', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const installId = typeof body.install_id === 'string' ? body.install_id : '';
    const capabilityId = typeof body.capability_id === 'string' ? body.capability_id : '';
    if (installId === '' || capabilityId === '') {
      return { status: 400, body: { error: 'install_id and capability_id are required' } };
    }
    if (!('params' in body)) {
      return { status: 400, body: { error: 'params are required (use {} for none)' } };
    }
    const categories = body.param_categories;
    if (categories !== undefined && !(Array.isArray(categories) && categories.every((c) => typeof c === 'string'))) {
      return { status: 400, body: { error: 'param_categories must be a list of strings' } };
    }
    const subject = invocationSubject(body.subject);
    if (subject === 'invalid') {
      return { status: 400, body: { error: 'subject must be an object with string contact_did / document_digest' } };
    }
    const workflow = getWorkflowService();
    if (workflow === null) return { status: 503, body: { error: 'workflow service not wired' } };

    const result = invokeToolCapability(
      {
        installId,
        capabilityId,
        params: body.params,
        ...(subject !== null ? { subject } : {}),
        ...(categories !== undefined ? { paramCategories: categories as string[] } : {}),
        ...(typeof body.resource === 'string' ? { resource: body.resource } : {}),
        ...(typeof body.value === 'number' ? { value: body.value } : {}),
        ...(typeof body.idempotency_key === 'string' ? { idempotencyKey: body.idempotency_key } : {}),
        ...(typeof body.correlation_id === 'string' ? { correlationId: body.correlation_id } : {}),
        origin: 'api',
        nowMs: Date.now(),
      },
      { workflow, ...(policy !== undefined ? { policy } : {}) },
    );
    return invokeResponse(result);
  });

  router.get('/v1/plugins/tool-capabilities', async (req): Promise<CoreResponse> => {
    const denied = brainOrOwner(req, ownerOnlyGuard);
    if (denied !== null) return denied;
    if (getPluginInstallRepository() === null) {
      return { status: 503, body: { error: 'plugin_registry_unavailable' } };
    }
    return { status: 200, body: { capabilities: listPluginToolCapabilities() } };
  });

  router.post('/v1/plugins/tool-invoke', async (req): Promise<CoreResponse> => {
    const denied = brainOrOwner(req, ownerOnlyGuard);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const installId = typeof body.install_id === 'string' ? body.install_id : '';
    const capabilityId = typeof body.capability_id === 'string' ? body.capability_id : '';
    if (installId === '' || capabilityId === '') {
      return { status: 400, body: { error: 'install_id and capability_id are required' } };
    }
    if (!('params' in body)) {
      return { status: 400, body: { error: 'params are required (use {} for none)' } };
    }
    const categories = stringList(body.param_categories);
    if (categories === 'invalid') {
      return { status: 400, body: { error: 'param_categories must be a list of strings' } };
    }
    const workflow = getWorkflowService();
    if (workflow === null) return { status: 503, body: { error: 'workflow service not wired' } };
    // No resource / value / idempotency key from this caller: those are
    // dispatch metadata a grant's constraints match against, and the party
    // asking must not be the party that fits the ask to the grant.
    const result = invokeToolCapability(
      {
        installId,
        capabilityId,
        params: body.params,
        ...(categories !== null ? { paramCategories: categories } : {}),
        origin: req.callerType === 'brain' || req.callerType === undefined ? 'system' : 'api',
        nowMs: Date.now(),
      },
      { workflow, ...(policy !== undefined ? { policy } : {}) },
    );
    return invokeResponse(result);
  });
}
