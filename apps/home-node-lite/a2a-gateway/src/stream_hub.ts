/**
 * The gateway's open streams (design §7.5, A2A §3.5.2): every stream of a
 * task gets the same events in the same order, and the stream ends when its
 * task does.
 *
 * Core answers a streaming call with the Task the stream opens with and the
 * sequence number of the last event that Task already reflects (the
 * cursor). Each stream is sent only events after its cursor, each at most
 * once: an event claimed again after a restart, or replayed from the
 * buffer, is dropped by sequence number.
 *
 * The delivery loop may hand over an event in the moment between Core's
 * answer and the stream's registration (the Task was built, an event was
 * recorded and delivered, then the stream opened). Only an event recorded
 * after a streaming call reached Core can fall in that gap; one recorded
 * before it is already in the opening Task. So the hub keeps recent events
 * only while a streaming call is on its way (`expect` … `arrived`), and
 * replays those after the new stream's cursor. What it keeps is bounded by
 * age, per task, by task count and by bytes.
 *
 * Each stream also keeps the client (an opaque key) and the credential
 * generation it was opened under (design §10: a credential that ends takes
 * what it set up with it). Each event comes with the generation current
 * when Core handed it over, and a stream older than that ends instead of
 * getting the event. Each claim carries the fences of the clients whose
 * credential ended lately (`setFences`): their older streams end at once,
 * on every task, and an older stream that registers later is refused
 * before it is sent anything, buffered events included.
 */

import { endsStream, type JsonObject } from '@dina/a2a';

import { clientKeyOf } from './edge_limit';

export interface StreamSink {
  /** Write one event to the client. */
  send(event: JsonObject): void;
  /** End the client's stream. */
  end(): void;
}

export interface StreamHubOptions {
  /** Streams open at once, across all clients. */
  maxStreams: number;
  /** How long an event is kept for a stream that opens late. */
  bufferMs: number;
  /** Recent events kept per task. */
  bufferEvents: number;
  /** Tasks whose recent events are kept at once; the oldest go first. */
  bufferTasks: number;
  /** Bytes of recent events kept at once (their JSON); the oldest tasks go first. */
  bufferBytes: number;
  now?: () => number;
}

interface Stream {
  sink: StreamSink;
  lastSeq: number;
  client: string;
  credentialGen: number;
}

/** Where an event sits in its task's sequence, and the client's credential generation when Core handed it over. */
export interface EventMark {
  seq: number;
  credentialGen: number;
}

/** Where a new stream starts: after the event its opening Task reflects, for the client and generation its call was authenticated as. */
export interface StreamStart {
  afterSeq: number;
  client: string;
  credentialGen: number;
}

interface Buffered extends EventMark {
  event: JsonObject;
  at: number;
  bytes: number;
}

export class StreamHub {
  private readonly streams = new Map<string, Set<Stream>>();
  /** Recent events per task; the map's order is least recently written first. */
  private readonly recent = new Map<string, Buffered[]>();
  /** Each fenced client's generation, from the last claim: an older stream of its ends, and none opens. */
  private fences = new Map<string, number>();
  private recentBytes = 0;
  private open_ = 0;
  private awaiting_ = 0;
  private readonly now: () => number;

  constructor(private readonly options: StreamHubOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Streams open now. */
  get size(): number {
    return this.open_;
  }

  /** Streaming calls on their way to Core, whose streams are not open yet. */
  get awaiting(): number {
    return this.awaiting_;
  }

  /** The most streams that may be open (or on their way) at once. */
  get capacity(): number {
    return this.options.maxStreams;
  }

  /** Bytes of recent events held now. */
  get bufferedBytes(): number {
    return this.recentBytes;
  }

  /** A streaming call left for Core: keep recent events until it arrives. */
  expect(): void {
    this.awaiting_ += 1;
  }

  /** Core answered a streaming call (its stream opens now, or never). */
  arrived(): void {
    this.awaiting_ = Math.max(0, this.awaiting_ - 1);
    if (this.awaiting_ === 0) this.forgetAll();
  }

  /**
   * Register a stream for `taskId`, sent only events after `start.afterSeq`;
   * returns the way to unregister it, or null when the hub is full. The
   * task's buffered events after the cursor are sent at once, and a stream
   * they end is ended (and unregistered) before this returns.
   */
  open(taskId: string, start: StreamStart, sink: StreamSink): (() => void) | null {
    if (this.open_ >= this.options.maxStreams) return null;
    // A credential that ended after the call was authenticated: the stream never opens.
    if (this.fenced(start.client, start.credentialGen)) return null;
    const stream: Stream = { sink, lastSeq: start.afterSeq, client: start.client, credentialGen: start.credentialGen };
    let set = this.streams.get(taskId);
    if (set === undefined) {
      set = new Set();
      this.streams.set(taskId, set);
    }
    set.add(stream);
    this.open_ += 1;
    const unregister = (): void => this.remove(taskId, stream);
    this.sweep();
    for (const b of this.recent.get(taskId) ?? []) {
      if (!this.deliver(taskId, stream, b, b.event)) break;
    }
    return unregister;
  }

  /** One event for a task: to every stream of it, in order, and kept while a streaming call is on its way. */
  publish(taskId: string, mark: EventMark, event: JsonObject): void {
    if (this.awaiting_ > 0) this.remember(taskId, mark, event);
    const set = this.streams.get(taskId);
    if (set === undefined) return;
    for (const stream of [...set]) this.deliver(taskId, stream, mark, event);
  }

  /**
   * The fences Core holds now, from a claim: they replace the last ones.
   * Every stream of a fenced client opened under an earlier generation ends
   * at once, sending nothing more.
   */
  setFences(fences: readonly { client: string; before_gen: number }[]): void {
    const next = new Map<string, number>();
    for (const f of fences) next.set(f.client, Math.max(next.get(f.client) ?? 0, f.before_gen));
    this.fences = next;
    if (next.size === 0) return;
    for (const [taskId, set] of [...this.streams]) {
      for (const stream of [...set]) {
        if (this.fenced(stream.client, stream.credentialGen)) this.end(taskId, stream);
      }
    }
  }

  /** Whether a stream of `client` opened under `gen` may be sent anything: its client's fence, if any, lets it through. */
  admits(client: string, gen: number): boolean {
    return !this.fenced(client, gen);
  }

  /** Whether a stream of `client` opened under `gen` is behind its client's fence. */
  private fenced(client: string, gen: number): boolean {
    return gen < (this.fences.get(client) ?? 0);
  }

  /** End every stream of a task now, sending nothing more, and forget its events (its authority went). */
  close(taskId: string): void {
    this.forget(taskId);
    const set = this.streams.get(taskId);
    if (set === undefined) return;
    for (const stream of [...set]) this.end(taskId, stream);
  }

  /** End every stream (shutdown). */
  closeAll(): void {
    for (const taskId of [...this.streams.keys()]) this.close(taskId);
    this.forgetAll();
  }

  /**
   * Send one event to one stream if it is new to it; false once the stream
   * has ended. A stream opened under an earlier credential generation than
   * the event's ends instead: that credential ended before Core handed the
   * event over.
   */
  private deliver(taskId: string, stream: Stream, mark: EventMark, event: JsonObject): boolean {
    if (stream.credentialGen < mark.credentialGen) {
      this.end(taskId, stream);
      return false;
    }
    if (mark.seq <= stream.lastSeq) return true;
    stream.lastSeq = mark.seq;
    stream.sink.send(event);
    if (!endsStream(event)) return true;
    this.end(taskId, stream);
    return false;
  }

  private end(taskId: string, stream: Stream): void {
    this.remove(taskId, stream);
    stream.sink.end();
  }

  private remove(taskId: string, stream: Stream): void {
    const set = this.streams.get(taskId);
    if (set === undefined || !set.delete(stream)) return;
    this.open_ -= 1;
    if (set.size === 0) this.streams.delete(taskId);
  }

  private forget(taskId: string): void {
    for (const b of this.recent.get(taskId) ?? []) this.recentBytes -= b.bytes;
    this.recent.delete(taskId);
  }

  private forgetAll(): void {
    this.recent.clear();
    this.recentBytes = 0;
  }

  /**
   * Drop what is too old, oldest written first, then whole tasks while too
   * many or too large. A task's last write is its newest event, so the first
   * task still young enough ends the age sweep.
   */
  private sweep(): void {
    const cutoff = this.now() - this.options.bufferMs;
    for (const [taskId, kept] of this.recent) {
      if ((kept[kept.length - 1]?.at ?? 0) >= cutoff) break;
      this.forget(taskId);
    }
    while (this.recent.size > this.options.bufferTasks || this.recentBytes > this.options.bufferBytes) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.forget(oldest);
    }
  }

  private remember(taskId: string, mark: EventMark, event: JsonObject): void {
    const kept = this.recent.get(taskId) ?? [];
    if (kept.some((b) => b.seq === mark.seq)) return;
    const bytes = JSON.stringify(event).length;
    kept.push({ seq: mark.seq, credentialGen: mark.credentialGen, event, at: this.now(), bytes });
    this.recentBytes += bytes;
    kept.sort((a, b) => a.seq - b.seq);
    while (kept.length > this.options.bufferEvents) this.recentBytes -= kept.shift()?.bytes ?? 0;
    // Re-insert so the map's order is least recently written first.
    this.recent.delete(taskId);
    this.recent.set(taskId, kept);
    this.sweep();
  }
}

/**
 * Stream slots, taken before a streaming call reaches Core (so a client
 * over its limit creates no task it cannot watch) and held until its
 * stream ends: at most `perIp` per client (an IPv4 address or an IPv6 /64,
 * as the edge limit counts them), and never more than the hub can hold,
 * counting calls still on their way.
 */
export class StreamSlots {
  private readonly byClient = new Map<string, number>();

  constructor(
    private readonly hub: StreamHub,
    private readonly perIp: number,
  ) {}

  /** Take a slot for a streaming call from `ip`; false when the client or the gateway is full. */
  take(ip: string): boolean {
    const client = clientKeyOf(ip);
    const held = this.byClient.get(client) ?? 0;
    if (held >= this.perIp || this.hub.size + this.hub.awaiting >= this.hub.capacity) return false;
    this.byClient.set(client, held + 1);
    this.hub.expect();
    return true;
  }

  /** Core answered the call: it is no longer on its way (the hub counts an opened stream itself). */
  answered(): void {
    this.hub.arrived();
  }

  /** The call's stream ended, or it opened none: the client's slot is free. */
  release(ip: string): void {
    const client = clientKeyOf(ip);
    const held = (this.byClient.get(client) ?? 1) - 1;
    if (held <= 0) this.byClient.delete(client);
    else this.byClient.set(client, held);
  }
}
