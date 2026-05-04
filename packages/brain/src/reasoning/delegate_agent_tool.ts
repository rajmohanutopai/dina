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

import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CoreClient, WorkflowTask } from '@dina/core';
import type { AgentTool } from './tool_registry';

export interface DelegateToAgentToolOptions {
  core: Pick<CoreClient, 'createWorkflowTask' | 'getWorkflowTask'>;
  /** Override the task-id generator (deterministic for tests). */
  generateTaskId?: () => string;
  /** Poll interval in ms. Default 1000. Tests use 0. */
  pollIntervalMs?: number;
  /** Total timeout from create→terminal-state in ms. Default 60_000. */
  timeoutMs?: number;
  /** Sleeper hook for tests (so we don't actually wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock hook for tests. */
  nowMsFn?: () => number;
}

export interface DelegateOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  /** Populated on `completed` — the agent's `result` JSON or summary. */
  result?: string;
  /** Populated on `failed` / `cancelled` / `timeout`. */
  error?: string;
  /** Stable task id so the operator can correlate via /taskstatus. */
  task_id: string;
}

/**
 * Build the `delegate_to_agent` tool. Receives a Core client (in-process
 * or HTTP) so it can create + poll workflow tasks. The registry call
 * signature stays sync; the tool body awaits.
 */
export function createDelegateToAgentTool(
  opts: DelegateToAgentToolOptions,
): AgentTool {
  const generateTaskId = opts.generateTaskId ?? (() => `task-${bytesToHex(randomBytes(8))}`);
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());

  return {
    name: 'delegate_to_agent',
    description:
      'Hand a self-contained task off to a paired agent (a separate device the user has paired to this Home Node) for execution. Use this when the user wants something DONE — e.g. "list my unread emails", "send Sancho a message", "run the deploy". Brain has no visibility into how the agent executes; it just hands over the task_description and waits for the result. Resolve any context (contacts, vault facts) BEFORE calling — the agent has no access to your tool surface.',
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
      const ttlSec = Math.max(1, Math.ceil(timeoutMs / 1000));
      const startMs = nowMsFn();

      await opts.core.createWorkflowTask({
        id: taskId,
        kind: 'delegation',
        description,
        // Deliberately NOT `service_query_execution` — that type is the
        // cross-Home-Node bridge contract. Free-form local-agent tasks
        // use their own type so the response bridge ignores them (no
        // D2D requester to send a service.response back to).
        payload: JSON.stringify({ type: 'free_form_task', description }),
        initialState: 'queued',
        expiresAtSec: Math.floor(startMs / 1000) + ttlSec,
        // Origins are allow-listed in `core/workflow/domain.ts` —
        // `dinamobile` is the right attribution for "user-driven turn
        // through the mobile chat UI" (the agentic loop fires on
        // behalf of /task). Bench / CLI / Telegram callers would each
        // pass their own origin via a different entry point.
        origin: 'dinamobile',
      });

      const deadlineMs = startMs + timeoutMs;
      while (nowMsFn() < deadlineMs) {
        await sleep(pollIntervalMs);
        const task = await opts.core.getWorkflowTask(taskId);
        if (task === null) {
          return { status: 'failed', error: `task ${taskId} disappeared`, task_id: taskId };
        }
        const terminal = readTerminal(task);
        if (terminal !== null) return { ...terminal, task_id: taskId };
      }
      return {
        status: 'timeout',
        error: `agent did not complete within ${Math.round(timeoutMs / 1000)}s`,
        task_id: taskId,
      };
    },
  };
}

function readTerminal(task: WorkflowTask): Omit<DelegateOutcome, 'task_id'> | null {
  if (task.status === 'completed') {
    const result = task.result ?? task.result_summary ?? '';
    return { status: 'completed', result };
  }
  if (task.status === 'failed' || task.status === 'cancelled') {
    return {
      status: task.status,
      error: task.error ?? task.result_summary ?? `task ${task.status}`,
    };
  }
  return null;
}
