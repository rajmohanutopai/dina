/**
 * Metrics stub — provides the metrics interface used throughout the codebase.
 * In production, this would be backed by Prometheus client.
 * For now, it's a no-op implementation that satisfies the type contracts.
 */

export interface Metrics {
  incr(name: string, tags?: Record<string, string>): void
  gauge(name: string, value: number | string, tags?: Record<string, string>): void
  histogram(name: string, value: number, tags?: Record<string, string>): void
  counter(name: string, value: number, tags?: Record<string, string>): void
}

class StubMetrics implements Metrics {
  incr(_name: string, _tags?: Record<string, string>): void {}
  gauge(_name: string, _value: number | string, _tags?: Record<string, string>): void {}
  histogram(_name: string, _value: number, _tags?: Record<string, string>): void {}
  counter(_name: string, _value: number, _tags?: Record<string, string>): void {}
}

export const metrics: Metrics = new StubMetrics()
