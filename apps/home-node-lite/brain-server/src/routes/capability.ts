/**
 * Tier-1 capability execution endpoint (`POST /api/v1/capability/run`).
 *
 * The lite Core owns the `dina.local` workflow lane (in-process, reserved —
 * the HTTP claim route 403s it by design). Its LocalDelegationRunner claims a
 * `service_query_execution` task and calls THIS endpoint to run the actual
 * Tier-1 runtime, which needs the LLM + the vault-read backend + the mirrored
 * persona registry — all wired here in the Brain process. Core resolves the
 * listing `ServiceConfig` in-process and passes it in the body, so this route
 * never round-trips back to Core for it.
 *
 * Request:  { capability: string, params: unknown,
 *             task: { id: string, payload: string }, config: ServiceConfig | null }
 * Response: 200 { result }  |  4xx/5xx { error }
 *
 * Loopback-only, unauthenticated — same posture as the brain's other routes
 * (it is reachable only from the co-located Core over localhost).
 */

import { makeTier1CapabilityRunner } from '@dina/brain';
import type { LLMProvider } from '@dina/brain';
import type { WorkflowTask } from '@dina/core';
import type { ServiceConfig } from '@dina/protocol';
import type { FastifyInstance } from 'fastify';

export interface RegisterCapabilityRoutesOptions {
  /** Resolves the live LLM (null when no AI is configured → fail-fast). */
  getLLM: () => LLMProvider | null;
  logger?: (entry: Record<string, unknown>) => void;
}

interface RunBody {
  capability?: unknown;
  params?: unknown;
  task?: { id?: unknown; payload?: unknown };
  config?: ServiceConfig | null;
}

export function registerCapabilityRoutes(
  app: FastifyInstance,
  options: RegisterCapabilityRoutesOptions,
): void {
  app.post('/api/v1/capability/run', async (req, reply) => {
    const body = (req.body ?? {}) as RunBody;
    const capability = typeof body.capability === 'string' ? body.capability : '';
    const taskId = typeof body.task?.id === 'string' ? body.task.id : '';
    const payload = typeof body.task?.payload === 'string' ? body.task.payload : '';
    if (capability === '' || payload === '') {
      await reply.code(400).send({ error: 'capability + task.payload are required' });
      return;
    }

    // Core already resolved the listing config (in-process) and passed it. The
    // runner's readConfig is sync; close over the passed value (it ignores the
    // rkey arg — Core resolved the right listing already).
    const config = body.config ?? null;
    const runner = makeTier1CapabilityRunner({
      getLLM: options.getLLM,
      readConfig: () => config,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });

    // Reconstruct the minimal WorkflowTask the runner reads (id + payload).
    const task = { id: taskId, payload } as unknown as WorkflowTask;
    try {
      const result = await runner(capability, body.params, task);
      await reply.code(200).send({ result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.logger?.({ event: 'capability.run_failed', capability, error: message });
      await reply.code(500).send({ error: message });
    }
  });
}
