/**
 * Structured reasoning trace — audit trail for the chat reasoning pipeline.
 *
 * Captures every step the pipeline takes so that:
 *   - Debugging: understand why a particular answer was generated
 *   - Audit: comply with data governance (who/what/when/why)
 *   - Monitoring: measure performance and tool usage patterns
 *   - Correlation: X-Request-ID links trace to Core audit log
 *
 * The trace is append-only during a single reasoning request.
 * It is NOT persisted — callers can log/store it as needed.
 *
 * Source: brain/src/service/guardian.py — reasoning trace audit
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type TraceStepType =
  | 'anti_her_screen'
  | 'context_assembly'
  | 'cloud_gate'
  | 'llm_reasoning'
  | 'guard_scan'
  | 'pii_rehydrate'
  | 'density_analysis'
  | 'tool_call'
  | 'error';

export interface TraceStep {
  step: TraceStepType;
  timestamp: number;
  durationMs: number;
  detail: Record<string, unknown>;
}

export interface ReasoningTrace {
  /** Unique request ID for correlation with Core audit log. */
  requestId: string;
  /** When the reasoning request started. */
  startedAt: number;
  /** Total duration of the reasoning pipeline in ms. */
  totalDurationMs: number;
  /** Ordered list of pipeline steps executed. */
  steps: TraceStep[];
  /** Summary statistics. */
  stats: {
    contextItemCount: number;
    toolCallCount: number;
    guardViolationCount: number;
    llmCallCount: number;
    piiScrubbed: boolean;
    antiHerTriggered: boolean;
  };
}

// ---------------------------------------------------------------
// Trace Builder
// ---------------------------------------------------------------

/**
 * Builder for constructing a reasoning trace during pipeline execution.
 *
 * Usage:
 *   const trace = new TraceBuilder();
 *   trace.step('context_assembly', { items: 5 });
 *   trace.step('llm_reasoning', { model: 'claude' });
 *   const result = trace.build();
 */
export class TraceBuilder {
  private readonly requestId: string;
  private readonly startedAt: number;
  private readonly steps: TraceStep[] = [];
  private lastStepTime: number;

  // Stats counters
  private contextItemCount = 0;
  private toolCallCount = 0;
  private guardViolationCount = 0;
  private llmCallCount = 0;
  private piiScrubbed = false;
  private antiHerTriggered = false;

  constructor(requestId?: string) {
    this.requestId = requestId ?? generateRequestId();
    this.startedAt = Date.now();
    this.lastStepTime = this.startedAt;
  }

  /** Record a pipeline step with timing. */
  step(type: TraceStepType, detail: Record<string, unknown> = {}): this {
    const now = Date.now();
    const durationMs = now - this.lastStepTime;
    this.steps.push({ step: type, timestamp: now, durationMs, detail });
    this.lastStepTime = now;

    // Update stats from detail
    if (type === 'context_assembly' && typeof detail.itemCount === 'number') {
      this.contextItemCount = detail.itemCount;
    }
    if (type === 'tool_call') {
      this.toolCallCount++;
    }
    if (type === 'guard_scan' && typeof detail.violationCount === 'number') {
      this.guardViolationCount = detail.violationCount;
    }
    if (type === 'llm_reasoning') {
      this.llmCallCount++;
    }
    if (type === 'cloud_gate' && detail.scrubbed === true) {
      this.piiScrubbed = true;
    }
    if (type === 'anti_her_screen') {
      this.antiHerTriggered = detail.triggered === true;
    }

    return this;
  }

  /** Record an error step. */
  error(message: string, detail: Record<string, unknown> = {}): this {
    return this.step('error', { message, ...detail });
  }

  /** Get the request ID for X-Request-ID header propagation. */
  getRequestId(): string {
    return this.requestId;
  }

  /** Build the final trace. */
  build(): ReasoningTrace {
    return {
      requestId: this.requestId,
      startedAt: this.startedAt,
      totalDurationMs: Date.now() - this.startedAt,
      steps: [...this.steps],
      stats: {
        contextItemCount: this.contextItemCount,
        toolCallCount: this.toolCallCount,
        guardViolationCount: this.guardViolationCount,
        llmCallCount: this.llmCallCount,
        piiScrubbed: this.piiScrubbed,
        antiHerTriggered: this.antiHerTriggered,
      },
    };
  }
}

function generateRequestId(): string {
  return `req-${bytesToHex(randomBytes(8))}`;
}
