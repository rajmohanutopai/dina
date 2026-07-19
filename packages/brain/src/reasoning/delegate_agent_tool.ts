/**
 * `delegate_to_agent` — agentic-loop tool that hands a task off to a
 * paired agent for execution.
 *
 * Why this exists: the agentic loop's other tools cover read paths
 * (vault search, geocode, AppView discovery, query peer service). When
 * the user types "/task do X" or "/ask please send Sancho a message",
 * the loop has no path that actually *does* X — it can only describe
 * doing it. This tool closes that gap.
 *
 * Architecture (important): Brain does NOT know what executes on the
 * agent side. The contract stops at "create a delegation workflow
 * task; some paired `dina-agent` will claim it via the standard
 * `POST /v1/workflow/tasks/claim`, do the work however its runtime
 * decides, and report back via `dina_task_complete`." Whether the
 * paired side uses OpenClaw, Hermes, a custom runner, or a hand-rolled
 * script is opaque to Brain — and intentionally so. Brain's job ends
 * at the task description; the agent's runtime owns execution choice.
 *
 * **Async delivery (no blocking poll).** This tool creates the
 * delegation and returns IMMEDIATELY with `status: 'delegated'`. It does
 * NOT wait for the agent to finish. The agent's terminal result is
 * delivered back to the chat thread by the `WorkflowEventConsumer`
 * (delegation branch) once the task reaches `completed` / `failed` /
 * `cancelled`. This replaces the old 60s create→terminal poll, which
 * raced the owner's approval: an agent that paused mid-task on a
 * sensitive vault-read (`dina ask` → approval gate) routinely blew the
 * 60s window and surfaced "agent did not complete within 60s" even
 * though it was simply waiting for the owner to tap Approve. With async
 * delivery there is no timeout race — the owner approves whenever, the
 * agent finishes, and the result lands in chat as a follow-up bubble.
 *
 * Single-Home-Node path: this is NOT cross-Home-Node delegation. For
 * cross-Home-Node use `query_service` (D2D service.query). The two
 * coexist — this is "the agent paired to my own Home Node does the
 * work"; that one is "ask another person's Home Node to do the work".
 *
 * Context enrichment is the LLM's job *before* calling this tool. Pass
 * an enriched, self-contained `task_description` — e.g. resolve
 * "sancho" to a contact identifier first using `vault_search` /
 * `find_preferred_provider`, then pass the resolved description here.
 * The agent has no access to the Brain-side tool surface.
 */

import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';

import { scrubPII, type CoreClient } from '@dina/core';

import type { AgentTool } from './tool_registry';

export interface DelegateToAgentToolOptions {
  core: Pick<CoreClient, 'createWorkflowTask'>;
  /** Override the task-id generator (deterministic for tests). */
  generateTaskId?: () => string;
  /** Clock hook for tests. */
  nowMsFn?: () => number;
  /** Dina-agent CLI session id/name to bind onto the delegation task. */
  sessionName?: string;
  /**
   * Seconds the delegation stays claimable before it expires unstarted.
   * Generous by default (1h) so a human has time to approve any sensitive
   * vault-read the agent needs mid-task. The old design tied this to a 60s
   * create→terminal poll, which raced the owner's approval; async delivery
   * removes the poll, so this is now purely the claim/expiry TTL.
   */
  expirySec?: number;
}

export interface DelegateOutcome {
  /**
   * Always `'delegated'`. The tool no longer blocks on execution — it creates
   * the delegation and returns. The agent's terminal result is delivered to
   * the chat thread asynchronously by the `WorkflowEventConsumer` (delegation
   * branch) when the task completes/fails/cancels.
   */
  status: 'delegated';
  /** Stable task id so the operator can correlate via /taskstatus. */
  task_id: string;
  /** Human-friendly note for the LLM to relay — it must NOT claim completion. */
  note: string;
}

/**
 * Build the `delegate_to_agent` tool. Receives a Core client (in-process
 * or HTTP) so it can create the workflow task. The registry call
 * signature stays sync; the tool body awaits the single create.
 */
export function createDelegateToAgentTool(opts: DelegateToAgentToolOptions): AgentTool {
  const generateTaskId = opts.generateTaskId ?? (() => `task-${bytesToHex(randomBytes(8))}`);
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const sessionName = opts.sessionName?.trim() ?? '';
  const expirySec = opts.expirySec ?? 3600;

  return {
    name: 'delegate_to_agent',
    description:
      'Hand a self-contained task off to a paired agent (a separate device the user has paired to this Home Node) for execution. Use this when the user wants something DONE — e.g. "list my unread emails", "send Sancho a message", "run the deploy". This returns IMMEDIATELY with status "delegated": the agent runs asynchronously and its result is posted to the chat when it finishes (the user may be asked to approve a vault read mid-task). Tell the user you have delegated the task and will report back when it is done — do NOT claim the task is already finished or invent a result. Resolve any context (contacts, vault facts) BEFORE calling — the agent has no access to your tool surface.',
    parameters: {
      type: 'object',
      properties: {
        task_description: {
          type: 'string',
          description:
            'A complete, self-contained description of what the paired agent should do. Include any resolved contact identifiers, vault facts, or constraints the agent needs. The agent reads this verbatim — DO NOT rely on the agent re-resolving names you saw in the user prompt.',
        },
      },
      required: ['task_description'],
    },
    async execute(args): Promise<DelegateOutcome> {
      const description = String(args.task_description ?? '').trim();
      if (description === '') {
        throw new Error('delegate_to_agent: task_description is required');
      }
      const taskId = generateTaskId();
      const startMs = nowMsFn();

      // MT-46 — PII scrub before the description crosses the Home Node trust
      // boundary. The agent (paired CLI agent / OpenClaw container) reads
      // `description` (and `payload.description`) when it claims this task;
      // raw PII in either field would leak values like email addresses, phone
      // numbers, IBAN/SSN strings outside the Home Node. Scrub replaces those
      // with stable placeholder tokens (`[EMAIL_1]`, `[PHONE_2]`, …). The
      // original entities ride on the payload under `_pii_entities` so a
      // future rehydrate-on-validate flow can restore the value at the
      // user-approval boundary.
      const { scrubbed: scrubbedDescription, entities } = scrubPII(description);

      await opts.core.createWorkflowTask({
        id: taskId,
        kind: 'delegation',
        description: scrubbedDescription,
        // Deliberately NOT `service_query_execution` — that type is the
        // cross-Home-Node bridge contract. Free-form local-agent tasks use
        // their own type so the response bridge ignores them (no D2D
        // requester to send a service.response back to). `_pii_entities` is
        // the rehydration table: never read by the agent.
        payload: JSON.stringify({
          type: 'free_form_task',
          description: scrubbedDescription,
          _pii_entities: entities,
        }),
        initialState: 'queued',
        // Generous claim/expiry TTL — async delivery means the owner may take
        // minutes to approve a mid-task vault read; the task must stay live.
        expiresAtSec: Math.floor(startMs / 1000) + expirySec,
        ...(sessionName !== '' ? { sessionName } : {}),
        // `dinamobile` is the right attribution for "user-driven turn through
        // the mobile chat UI" (the agentic loop fires on behalf of /task).
        origin: 'dinamobile',
      });

      // Fire-and-return: do NOT block on execution. The paired agent claims
      // this task, runs it (pausing for the owner's approval on any sensitive
      // vault read), and reports back; the WorkflowEventConsumer delivers the
      // terminal result to chat as a follow-up message. No timeout race.
      return {
        status: 'delegated',
        task_id: taskId,
        note: "Delegated to your paired agent. I'll post the result here when it finishes — you may be asked to approve a vault read along the way.",
      };
    },
  };
}
