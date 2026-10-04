/**
 * The gateway's delivery loop (design §7.5, §6.6): claims the task events
 * Core has due, writes stream events to the hub, POSTs webhook events, and
 * reports each back.
 *
 * Each turn first reports what finished since the last, then claims: every
 * due stream event, and no more webhook events than it has free POST slots,
 * so a claimed webhook event starts at once and finishes well inside its
 * lease. Stream events are reported as soon as the hub has them. Webhook
 * POSTs run in the background, through the host transport (the same policy
 * as every outbound connection: HTTPS, no private address, the vetted
 * address pinned, no redirects), and are reported on the next turn.
 *
 * A webhook's answer decides its report: 2xx is delivered; 408, 429 and 5xx
 * are worth a retry, and so is a failure to reach it; any other answer,
 * and a destination the policy refuses, is final. Core decides when a
 * retry runs and when retrying stops. A report Core never got leaves the
 * claim to lapse, and the event comes again: delivery is at least once,
 * as A2A asks.
 *
 * Logs carry counts and statuses only: never a URL, a token, an event or a
 * task id.
 */

import { type DeliveryAck, type DeliveryOutcome, type WebhookDeliveryItem } from '@dina/a2a';
import { A2A_FETCH_LIMITS, type A2AHostTransport, type A2AHttpResult } from '@dina/core';

import type { CoreLink } from './core_link';
import type { StreamHub } from './stream_hub';
import type { Logger } from 'pino';

export interface DeliveryPumpOptions {
  core: CoreLink;
  hub: StreamHub;
  transport: A2AHostTransport;
  logger: Logger;
  /** The wait between turns when the last one found fewer stream events than a full claim. */
  intervalMs: number;
  /** Webhook POSTs in flight at once. */
  webhookConcurrency: number;
  /** Stream events one claim may take (webhook events are bounded by free POST slots). */
  claimLimit: number;
}

/** What a webhook's answer means for its event. */
export function webhookOutcome(result: A2AHttpResult): DeliveryOutcome {
  if (result.ok) {
    if (result.status >= 200 && result.status < 300) return 'delivered';
    return result.status === 408 || result.status === 429 || result.status >= 500 ? 'retry' : 'failed';
  }
  return result.error === 'url_refused' || result.error === 'address_blocked' || result.error === 'redirect_refused'
    ? 'failed'
    : 'retry';
}

export class DeliveryPump {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private finished: DeliveryAck[] = [];

  constructor(private readonly options: DeliveryPumpOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Stop claiming, let the POSTs in flight finish, and report them. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    await Promise.all([...this.inFlight]);
    await this.report();
  }

  /**
   * One turn: report, claim, hand out. Returns how many stream events the
   * claim took; a full claim means more may be waiting, so the loop goes
   * again at once.
   */
  async turn(): Promise<number> {
    await this.report();
    const free = Math.max(0, this.options.webhookConcurrency - this.inFlight.size);
    const claimed = await this.options.core.claimEvents(this.options.claimLimit, free);
    if (!claimed.ok) {
      this.options.logger.warn({ core_status: claimed.status }, 'a2a delivery claim refused');
      return 0;
    }
    const { items, closed, fenced } = claimed.claim;
    this.options.hub.setFences(fenced);
    for (const taskId of closed) this.options.hub.close(taskId);
    const streamed: DeliveryAck[] = [];
    for (const item of items) {
      if (item.target === 'sse') {
        this.options.hub.publish(item.task_id, { seq: item.seq, credentialGen: item.credential_gen }, item.event);
        streamed.push({ id: item.id, claim_id: item.claim_id, outcome: 'delivered' });
      } else {
        this.post(item);
      }
    }
    if (streamed.length > 0) await this.send(streamed);
    if (items.length > 0 || closed.length > 0 || fenced.length > 0) {
      this.options.logger.debug(
        { streamed: streamed.length, webhooks: items.length - streamed.length, closed: closed.length, fenced: fenced.length },
        'a2a delivery turn',
      );
    }
    return streamed.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let taken = 0;
      try {
        taken = await this.turn();
      } catch (err) {
        this.options.logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'a2a delivery turn failed');
      }
      if (!this.running) break;
      if (taken < this.options.claimLimit) await this.pause();
    }
  }

  /** Wait out the interval, or less when `stop` wakes it. */
  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, this.options.intervalMs);
      timer.unref?.();
      this.wake = finish;
    });
  }

  private post(item: WebhookDeliveryItem): void {
    const hook = item.webhook;
    const job = this.options
      .transport({
        method: 'POST',
        url: hook.url,
        headers: hook.headers,
        body: JSON.stringify(item.event),
        contentType: 'application/a2a+json',
        response: 'status',
        ...A2A_FETCH_LIMITS.webhook,
      })
      .catch((): A2AHttpResult => ({ ok: false, error: 'io_error', sent: true }))
      .then((result) => {
        this.finished.push({ id: item.id, claim_id: item.claim_id, outcome: webhookOutcome(result) });
      })
      .finally(() => {
        this.inFlight.delete(job);
      });
    this.inFlight.add(job);
  }

  private async report(): Promise<void> {
    if (this.finished.length === 0) return;
    const batch = this.finished;
    this.finished = [];
    await this.send(batch);
  }

  private async send(acks: DeliveryAck[]): Promise<void> {
    const sent = await this.options.core.ackEvents(acks);
    // Unreported claims lapse and come again; nothing is lost, only repeated.
    if (!sent.ok) this.options.logger.warn({ core_status: sent.status, count: acks.length }, 'a2a delivery report refused');
  }
}
