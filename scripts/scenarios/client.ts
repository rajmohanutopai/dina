/**
 * Talking to one fleet node the way its owner does (docs/REAL_LIFE_SCENARIOS.md):
 * chat through Brain as a paired owner device (signed requests), replies read
 * from the chat stream, and state read back through Core's debug dispatch.
 */

import {
  pairOwnerSigner,
  type OwnerSigner,
} from '../../apps/home-node-lite/web/__e2e__/fixtures/owner_signer';

import type { FleetNode } from './fleet';

export interface ChatMessage {
  id: string;
  threadId: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

interface Lifecycle {
  kind?: string;
  status?: string;
}

function lifecycleOf(m: ChatMessage): Lifecycle | undefined {
  return m.metadata?.lifecycle as Lifecycle | undefined;
}

/** True once a message is no longer waiting on something (an ask, a service). */
export function settled(m: ChatMessage): boolean {
  const lc = lifecycleOf(m);
  if (lc === undefined) return true;
  if (lc.kind === 'ask_pending') return lc.status !== 'pending';
  return !['pending', 'in_flight', 'queued', 'working', 'sending', 'awaiting'].includes(lc.status ?? '');
}

/** A live view of one chat thread (SSE): every message, latest version of each. */
export class ThreadWatch {
  readonly messages = new Map<string, ChatMessage>();
  private readonly waiters: (() => void)[] = [];
  private readonly controller = new AbortController();
  private readonly ready: Promise<void>;

  constructor(
    private readonly dina: Dina,
    readonly threadId: string,
  ) {
    this.ready = this.open();
  }

  private async open(): Promise<void> {
    const url = `${this.dina.node.brain}/api/v1/chat/stream?threadId=${encodeURIComponent(this.threadId)}`;
    const res = await fetch(url, {
      headers: this.dina.signer.headers('GET', url),
      signal: this.controller.signal,
    });
    if (!res.ok || res.body === null) throw new Error(`${this.dina.name}: stream ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let first = true;
    const pump = async (): Promise<void> => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (data === '') continue;
          const msg = JSON.parse(data) as ChatMessage;
          this.messages.set(msg.id, msg);
          for (const w of this.waiters.splice(0)) w();
        }
        if (first) first = false;
      }
    };
    void pump();
    // Let the history flush land before callers act.
    await new Promise((r) => setTimeout(r, 300));
  }

  async opened(): Promise<void> {
    await this.ready;
  }

  /** Wait until `pred` holds over the messages, or throw after `ms`. */
  async waitFor<T>(pred: (msgs: ChatMessage[]) => T | undefined | false, ms: number, what: string): Promise<T> {
    await this.ready;
    const end = Date.now() + ms;
    for (;;) {
      const hit = pred([...this.messages.values()]);
      if (hit !== undefined && hit !== false) return hit;
      const left = end - Date.now();
      if (left <= 0) throw new Error(`${this.dina.name}: timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 2_000));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.controller.abort();
  }
}

/** A reminder as Core lists it. */
export interface Reminder {
  id: string;
  message: string;
  due_at: number;
  created_at: number;
  status: string;
  recurring: string;
  persona?: string;
}

export interface ChatResult {
  /** The settled reply text Dina gave for this message. */
  reply: string;
  /** Every message the thread gained during the turn. */
  added: ChatMessage[];
  intent: string;
}

/** One fleet node, driven as its owner. */
export class Dina {
  private constructor(
    readonly node: FleetNode,
    readonly signer: OwnerSigner,
  ) {}

  get name(): string {
    return this.node.name;
  }

  get did(): string {
    if (this.node.did === undefined) throw new Error(`${this.name} has no did:plc`);
    return this.node.did;
  }

  /** Pair a fresh owner device with the node's owner key. */
  static async connect(node: FleetNode): Promise<Dina> {
    return new Dina(node, await pairOwnerSigner(node.core, node.ownerCapability));
  }

  private async brainFetch(method: string, pathAndQuery: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const url = `${this.node.brain}${pathAndQuery}`;
    const text = body === undefined ? '' : JSON.stringify(body);
    const res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...this.signer.headers(method, url, text),
      },
      ...(body === undefined ? {} : { body: text }),
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = raw === '' ? {} : JSON.parse(raw);
    } catch {
      /* text body */
    }
    return { status: res.status, body: parsed };
  }

  watch(threadId = 'main'): ThreadWatch {
    return new ThreadWatch(this, threadId);
  }

  /**
   * Say `text` in chat and wait for Dina's settled reply. An ask that outlives
   * Brain's fast path comes back empty and finishes on the stream; this waits
   * for that too.
   */
  async chat(text: string, opts: { threadId?: string; timeoutMs?: number } = {}): Promise<ChatResult> {
    const threadId = opts.threadId ?? 'main';
    const watch = this.watch(threadId);
    await watch.opened();
    const before = new Set(watch.messages.keys());
    try {
      const res = await this.brainFetch('POST', '/api/v1/chat', { text, threadId });
      if (res.status !== 200) throw new Error(`${this.name}: chat ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      const resp = res.body as { response?: string; intent?: string; messageId?: string };
      const added = await watch.waitFor(
        (msgs) => {
          const fresh = msgs.filter((m) => !before.has(m.id));
          const dina = fresh.filter((m) => m.type !== 'user');
          if (dina.length === 0) return undefined;
          return dina.every(settled) ? fresh : undefined;
        },
        opts.timeoutMs ?? 180_000,
        `a settled reply to "${text.slice(0, 40)}"`,
      );
      const replies = added.filter((m) => m.type !== 'user').map((m) => m.content).filter((c) => c !== '');
      const reply = resp.response !== undefined && resp.response !== '' ? resp.response : replies.join('\n');
      return { reply, added, intent: resp.intent ?? '' };
    } finally {
      watch.close();
    }
  }

  /** Run any Core route as the owner (debug dispatch; loopback, test fleet only). */
  async core(method: string, routePath: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.node.core}/v1/debug/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, path: routePath, query: opts.query ?? {}, body: opts.body ?? null }),
    });
    // The dispatch answers with the route's own status and body, unwrapped.
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /**
   * An owner-only Core route (the A2A setup, group-plan decisions): signed by
   * the paired owner device and carrying the owner capability, as the web
   * app's owner calls do. The capability is a secret: never logged.
   */
  async coreOwner(method: string, routePath: string, body?: unknown): Promise<{ status: number; body: any }> {
    const url = `${this.node.core}${routePath}`;
    const text = body === undefined ? '' : JSON.stringify(body);
    const res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-dina-owner-capability': this.node.ownerCapability,
        ...this.signer.headers(method, url, text),
      },
      ...(body === undefined ? {} : { body: text }),
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = raw === '' ? {} : JSON.parse(raw);
    } catch {
      /* text */
    }
    return { status: res.status, body: parsed };
  }

  // ── State readers used by the checks ──

  async vaultQuery(persona: string, text: string, limit = 20): Promise<{ id: string; content: string; summary: string }[]> {
    const r = await this.core('POST', '/v1/vault/query', {
      query: { persona },
      body: { persona, text, mode: 'fts5', limit },
    });
    const items = ((r.body?.items ?? []) as Record<string, unknown>[]).map((i) => ({
      id: String(i.id ?? ''),
      content: String(i.body ?? i.content_l1 ?? ''),
      summary: String(i.summary ?? i.content_l0 ?? ''),
    }));
    return items;
  }

  async reminders(persona = 'general'): Promise<Reminder[]> {
    const r = await this.core('GET', '/v1/reminders', { query: { persona } });
    return (r.body?.reminders ?? r.body ?? []) as never;
  }

  async allReminders(): Promise<(Reminder & { persona: string })[]> {
    const out: (Reminder & { persona: string })[] = [];
    for (const p of ['general', 'health', 'finance', 'work']) for (const r of await this.reminders(p)) out.push({ ...r, persona: p });
    return out;
  }

  async people(): Promise<{ personId: string; canonicalName: string; surfaces?: { surface: string; status: string }[] }[]> {
    const r = await this.core('GET', '/v1/people');
    return (r.body?.people ?? []) as never;
  }

  async contacts(): Promise<{ did: string; displayName: string; trustLevel: string; preferredFor?: string[] }[]> {
    const r = await this.core('GET', '/v1/contacts');
    return (r.body?.contacts ?? r.body ?? []) as never;
  }

  async addContact(did: string, displayName: string): Promise<void> {
    const r = await this.core('POST', '/v1/contacts', { body: { did, display_name: displayName, trust_level: 'verified' } });
    if (r.status >= 300 && r.status !== 409) throw new Error(`${this.name}: add contact ${r.status}`);
  }

  async quarantine(): Promise<{ sender_did?: string; senderDid?: string }[]> {
    const r = await this.core('GET', '/v1/d2d/quarantine');
    return (r.body?.messages ?? r.body?.items ?? r.body ?? []) as never;
  }

  async tasks(kind: string, state: string): Promise<{ id: string; kind: string; state: string; payload?: string }[]> {
    const r = await this.core('GET', '/v1/workflow/tasks', { query: { kind, state } });
    return (r.body?.tasks ?? []) as never;
  }

  /** Send a D2D message as the owner (the Talk screen's path). */
  async send(toDid: string, type: string, body: Record<string, unknown>): Promise<void> {
    const r = await this.core('POST', '/v1/msg/send', { body: { recipient_did: toDid, type, body } });
    if (r.status >= 300) throw new Error(`${this.name}: send ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  async brain(method: string, pathAndQuery: string, body?: unknown): Promise<{ status: number; body: any }> {
    return this.brainFetch(method, pathAndQuery, body);
  }
}

/** A paired agent device on one node (role `agent`), making signed Core calls. */
export class Agent {
  private constructor(
    readonly node: FleetNode,
    readonly did: string,
    private readonly secret: Uint8Array,
  ) {}

  /** Pair through Core's real ceremony: the owner mints a code, the agent completes it. */
  static async pair(owner: Dina, deviceName: string, scope?: 'coding' | 'runner'): Promise<Agent> {
    const { randomBytes } = await import('node:crypto');
    const ed = await import('@noble/ed25519');
    const { sha512 } = await import('@noble/hashes/sha2.js');
    const { base58 } = await import('@scure/base');
    const hashes = ed.hashes as { sha512?: (...m: Uint8Array[]) => Uint8Array };
    hashes.sha512 = (...m: Uint8Array[]) => {
      const h = sha512.create();
      for (const x of m) h.update(x);
      return h.digest();
    };
    const secret = new Uint8Array(randomBytes(32));
    const pub = ed.getPublicKey(secret);
    const payload = new Uint8Array(2 + pub.length);
    payload[0] = 0xed;
    payload[1] = 0x01;
    payload.set(pub, 2);
    const multibase = `z${base58.encode(payload)}`;
    const init = await owner.core('POST', '/v1/pair/initiate', {
      body: { device_name: deviceName, role: 'agent', ...(scope !== undefined ? { scope } : {}) },
    });
    const code = String(init.body?.code ?? '');
    if (code === '') throw new Error(`pair initiate ${init.status}`);
    const res = await fetch(`${owner.node.core}/v1/pair/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, public_key_multibase: multibase }),
    });
    if (res.status !== 201 && res.status !== 200) throw new Error(`pair complete ${res.status} ${await res.text()}`);
    return new Agent(owner.node, `did:key:${multibase}`, secret);
  }

  async call(
    method: string,
    routePath: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> {
    const ed = await import('@noble/ed25519');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { bytesToHex } = await import('@noble/hashes/utils.js');
    const { randomBytes } = await import('node:crypto');
    const query = opts.query ?? {};
    const queryStr = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const bodyText = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const timestamp = new Date().toISOString();
    const nonce = bytesToHex(new Uint8Array(randomBytes(16)));
    const canonical = `${method}\n${routePath}\n${queryStr}\n${timestamp}\n${nonce}\n${bytesToHex(sha256(new TextEncoder().encode(bodyText)))}`;
    const signature = bytesToHex(ed.sign(new TextEncoder().encode(canonical), this.secret));
    const res = await fetch(`${this.node.core}${routePath}${queryStr !== '' ? `?${queryStr}` : ''}`, {
      method,
      headers: { 'content-type': 'application/json', 'X-DID': this.did, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature },
      ...(opts.body === undefined ? {} : { body: bodyText }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: res.status, body: parsed };
  }

  async startSession(label: string): Promise<string> {
    const r = await this.call('POST', '/v1/session/start', { body: { host_session_id: label } });
    const id = String(r.body?.session_id ?? '');
    if (id === '') throw new Error(`session start ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    return id;
  }

  /**
   * `dina ask`: submit, then poll until the ask is done, failed, expired or
   * waiting on the owner's approval. Returns the last status body.
   */
  async ask(question: string, session: string, ms = 180_000): Promise<{ status: string; body: any }> {
    const sub = await this.call('POST', '/api/v1/ask', { body: { question, session_id: session } });
    if (sub.status >= 400) return { status: `http_${sub.status}`, body: sub.body };
    const id = String(sub.body?.request_id ?? sub.body?.id ?? '');
    let body = sub.body;
    const end = Date.now() + ms;
    while (['in_flight', 'pending', 'queued', undefined, ''].includes(body?.status) && Date.now() < end) {
      if (id === '') break;
      await new Promise((r) => setTimeout(r, 2_000));
      body = (await this.call('GET', `/api/v1/ask/${encodeURIComponent(id)}/status`, { query: { session_id: session } })).body;
    }
    return { status: String(body?.status ?? 'unknown'), body: { ...body, request_id: id } };
  }

  /** Poll an ask already submitted (e.g. one resumed after an approval). */
  async waitAsk(requestId: string, session: string, ms = 120_000): Promise<{ status: string; body: any }> {
    const end = Date.now() + ms;
    let body: any;
    do {
      body = (await this.call('GET', `/api/v1/ask/${encodeURIComponent(requestId)}/status`, { query: { session_id: session } })).body;
      if (!['in_flight', 'pending', 'queued', 'pending_approval', undefined, ''].includes(body?.status)) break;
      await new Promise((r) => setTimeout(r, 2_000));
    } while (Date.now() < end);
    return { status: String(body?.status ?? 'unknown'), body: { ...body, request_id: requestId } };
  }
}
