/**
 * Metrics surface — TN-OBS-001 / Plan §13.8.
 *
 * Two emission paths in parallel (composite — see `CompositeMetrics`
 * below):
 *   1. Structured-log path (`LoggingMetrics`) — every event becomes a
 *      JSON log line readable by Loki / CloudWatch / ELK without a
 *      separate scraper. Useful for ad-hoc grep + log-aggregator
 *      dashboards.
 *   2. In-memory aggregator (`AggregatingMetrics`) — running counters
 *      / gauges / histograms exposed via `/metrics` in the
 *      Prometheus exposition format (see `metrics-aggregator.ts`).
 *
 * Operators picking one observability backend or the other (or both)
 * don't need to instrument differently — every callsite uses the same
 * `metrics.incr(...)` / `metrics.gauge(...)` / etc. surface.
 *
 * **Why both** rather than picking one: V1 deploys may go to either
 * stack depending on operator preference. Forcing prom-client would
 * pin the choice; forcing log-only would lose Prometheus integration.
 * The composite shares the cost (one virtual call per metric) for
 * full backend flexibility.
 */

import { logger } from './logger.js'
import { AggregatingMetrics } from './metrics-aggregator.js'

export interface Metrics {
  incr(name: string, tags?: Record<string, string>): void
  gauge(name: string, value: number | string, tags?: Record<string, string>): void
  histogram(name: string, value: number, tags?: Record<string, string>): void
  counter(name: string, value: number, tags?: Record<string, string>): void
}

class LoggingMetrics implements Metrics {
  incr(name: string, tags?: Record<string, string>): void {
    logger.debug({ metric: name, type: 'incr', ...tags }, `metric:${name}`)
  }
  gauge(name: string, value: number | string, tags?: Record<string, string>): void {
    logger.debug({ metric: name, type: 'gauge', value, ...tags }, `metric:${name}`)
  }
  histogram(name: string, value: number, tags?: Record<string, string>): void {
    logger.debug({ metric: name, type: 'histogram', value, ...tags }, `metric:${name}`)
  }
  counter(name: string, value: number, tags?: Record<string, string>): void {
    logger.debug({ metric: name, type: 'counter', value, ...tags }, `metric:${name}`)
  }
}

/**
 * Fan-out wrapper: every metric event lands in BOTH the structured-log
 * path AND the in-memory aggregator. Callers don't see this — they
 * call `metrics.incr(...)` and both paths emit.
 *
 * Order: log first, aggregator second. Log-first means a callsite
 * that throws inside the aggregator path (shouldn't happen — pure
 * Map operations — but defence in depth) doesn't lose the structured
 * log line. The aggregator never throws on well-formed input; we
 * still keep the order so a future change can't regress observability
 * silently.
 */
class CompositeMetrics implements Metrics {
  constructor(
    private readonly logging: Metrics,
    private readonly aggregating: AggregatingMetrics,
  ) {}
  incr(name: string, tags?: Record<string, string>): void {
    this.logging.incr(name, tags)
    this.aggregating.incr(name, tags)
  }
  gauge(name: string, value: number | string, tags?: Record<string, string>): void {
    this.logging.gauge(name, value, tags)
    this.aggregating.gauge(name, value, tags)
  }
  histogram(name: string, value: number, tags?: Record<string, string>): void {
    this.logging.histogram(name, value, tags)
    this.aggregating.histogram(name, value, tags)
  }
  counter(name: string, value: number, tags?: Record<string, string>): void {
    this.logging.counter(name, value, tags)
    this.aggregating.counter(name, value, tags)
  }
}

/**
 * Process-singleton aggregator, exported so the `/metrics` HTTP
 * endpoint can call `aggregator.serialize()`. Tests can call
 * `aggregator.reset()` between cases.
 */
export const aggregator = new AggregatingMetrics()

export const metrics: Metrics = new CompositeMetrics(
  new LoggingMetrics(),
  aggregator,
)
