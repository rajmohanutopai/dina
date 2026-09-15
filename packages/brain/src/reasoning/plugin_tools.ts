/**
 * `/ask` → installed plugins (PLUGIN_ARCHITECTURE.md §6, §9.1, §15.5).
 *
 * Two tools the agentic loop may call once the owner has installed a plugin:
 *
 *   `list_plugin_capabilities` — every consented `tool` capability on an active
 *   install, with its params schema and the data categories that may ride the
 *   params. The model reads this to decide WHETHER a plugin can answer and
 *   WHAT to send it.
 *
 *   `invoke_plugin` — ask one capability to run. TERMINAL and fire-and-forget:
 *   Core gates the ask (§8: a custom capability cards until the owner grants;
 *   a regulated one cards every time) and stages ONE task on the plugin lane.
 *   Brain learns only which of two things happened — the owner must approve
 *   on the phone's inbox card, or a grant the owner minted let it run — and
 *   the turn ends there. The runner's answer lands on the task, validated
 *   against the consented result schema; it never comes back into this loop.
 *
 * WHAT BRAIN MAY NOT DO. Brain never sees the runner, never decides the card
 * (on the server split Core refuses a `brain` caller on the approve/cancel
 * verbs; on the phone Brain and the owner share one VM, and the boundary is
 * the typed import graph — this module holds no approve path), and never names
 * dispatch metadata a grant's constraints match against (the route it uses
 * accepts only install, capability, params and the params' categories). The
 * categories are Brain's classification of the params (§11.5); anything
 * outside the consented scope, or unclassified, cards. Brain classifying
 * dishonestly buys nothing above what the owner already granted.
 *
 * No vault context rides the ask: the §11 context projector is not built, so
 * `context` stays empty and the params are the whole payload. Stated here so
 * a future projector is a change to this file, not a surprise elsewhere.
 */

import { INVOKE_PLUGIN_RESPONSE_MALFORMED } from '@dina/core';

import type { AgentTool } from './tool_registry';
import type { CoreClient } from '@dina/core';

export type PluginToolCoreClient = Pick<CoreClient, 'listPluginToolCapabilities' | 'invokePluginTool'>;

export interface PluginToolOptions {
  core: PluginToolCoreClient;
  logger?: (event: Record<string, unknown>) => void;
}

/** The list the model reads — snake_case exactly as Core hands it over. */
export function createListPluginCapabilitiesTool(options: PluginToolOptions): AgentTool {
  return {
    name: 'list_plugin_capabilities',
    description:
      "List the plugin capabilities the owner has installed and consented to (payment-status checks, tax registry lookups, filings, notices, …), each with its params_schema and the data categories that may ride the params. Call this before invoke_plugin to find the right capability and its exact params. Empty when nothing is installed.",
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<{ capabilities: unknown[] }> {
      const capabilities = await options.core.listPluginToolCapabilities();
      options.logger?.({ event: 'plugin_capabilities_listed', count: capabilities.length });
      return { capabilities };
    },
  };
}

/**
 * The two answers a SUCCESSFUL ask has; both end the turn (the tool is
 * terminal). A refusal is thrown instead — the loop feeds it back as a tool
 * error so the model can pick another capability or explain, rather than
 * ending the turn with nothing said.
 */
export interface InvokePluginToolOutcome {
  status: 'approval_required' | 'dispatched';
  task_id: string;
  /** What to tell the owner, in plain words. */
  note: string;
}

export function createInvokePluginTool(options: PluginToolOptions): AgentTool {
  return {
    name: 'invoke_plugin',
    // Fire-and-forget: the owner's decision and the runner's answer both land
    // outside this loop; continuing would only burn iterations.
    terminal: true,
    description:
      'Ask an installed plugin capability to run (from list_plugin_capabilities). Params MUST match its params_schema exactly. Classify every param in param_categories using the capability\'s data categories (e.g. ["payment"]). Fire-and-forget and turn-ending: Core either shows the owner an approval card on their phone or, under a standing grant, runs it; the answer arrives later on the task, never here — so say in one line what you are asking BEFORE calling this. Use once per request. A refusal comes back as an error you can act on.',
    parameters: {
      type: 'object',
      properties: {
        install_id: { type: 'string', description: 'install_id from list_plugin_capabilities.' },
        capability_id: { type: 'string', description: 'capability_id from list_plugin_capabilities.' },
        params: { type: 'object', description: "The capability's params, matching its params_schema." },
        param_categories: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Which of the capability's data categories the params carry. Params outside the consented categories, or left unclassified, require the owner's approval.",
        },
      },
      required: ['install_id', 'capability_id', 'params', 'param_categories'],
    },
    async execute(args): Promise<InvokePluginToolOutcome> {
      const installId = String(args.install_id ?? '');
      const capabilityId = String(args.capability_id ?? '');
      if (installId === '' || capabilityId === '') {
        throw new Error('invoke_plugin: install_id and capability_id are required');
      }
      const params = args.params;
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new Error('invoke_plugin: params must be an object');
      }
      // The classification the caller sent is the one Core judges (§11.5):
      // a mistyped list is refused, never quietly narrowed.
      const rawCategories = args.param_categories;
      if (!Array.isArray(rawCategories) || !rawCategories.every((c) => typeof c === 'string')) {
        throw new Error('invoke_plugin: param_categories must be an array of strings');
      }
      const paramCategories = rawCategories as string[];
      const result = await options.core.invokePluginTool({
        installId,
        capabilityId,
        params,
        paramCategories,
      });
      // Metadata only in the log: the outcome and the capability id, never the params.
      options.logger?.({
        event: 'plugin_invoked',
        capability_id: capabilityId,
        outcome: result.ok ? result.mode : `refused:${result.code}`,
      });
      if (!result.ok) {
        // Core ACCEPTED the ask but the reply was unreadable (transport fault):
        // a task already exists, so this ends the turn like a success would —
        // asking again would stage a second card for the same question.
        if (result.code === INVOKE_PLUGIN_RESPONSE_MALFORMED) {
          return {
            status: 'approval_required',
            task_id: '',
            note: 'Dina asked the plugin, but the reply could not be read. Check Activity → Needs action for a card, or Completed for the result, before asking again.',
          };
        }
        // A refusal is an error, not a value: a terminal tool's successful
        // value ends the turn, and a refusal must not end it with nothing said.
        throw new Error(`invoke_plugin refused (${result.code}): ${result.message}`);
      }
      if (result.mode === 'dispatched') {
        return {
          status: 'dispatched',
          task_id: result.taskId,
          note: 'The plugin has been asked under a standing approval. Its answer will appear in Activity when the runner replies.',
        };
      }
      return {
        status: 'approval_required',
        task_id: result.taskId,
        note: `The exact request is waiting for your approval in Activity → Needs action (${result.card.riskLevel.toLowerCase()} risk). Nothing runs until you approve it.`,
      };
    },
  };
}
