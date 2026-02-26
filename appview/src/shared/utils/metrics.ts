/**
 * Metrics implementation backed by structured logging.
 *
 * In production, this should be replaced with a real metrics backend
 * (e.g. prom-client for Prometheus). For now, metrics are emitted as
 * structured log lines so they appear in log aggregators (ELK, CloudWatch, etc.).
 */

import { logger } from './logger.js'

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

export const metrics: Metrics = new LoggingMetrics()
