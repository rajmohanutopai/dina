/**
 * Round-B B-02 (full fix) — the CORE-SERVED owner console. Core serves a
 * self-contained page whose owner calls target Core's OWN routes same-origin,
 * so the owner capability never transits Brain.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerOwnerConsoleRoute } from '../src/server/owner_console';

async function makeApp(enabled: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerOwnerConsoleRoute(app as never, { enabled });
  await app.ready();
  return app;
}

describe('Core owner console (B-02)', () => {
  it('serves a script that parses (template-string escapes survive)', async () => {
    const app = await makeApp(true);
    try {
      const res = await app.inject({ method: 'GET', url: '/owner' });
      const scripts = [...res.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(() => new Function(script)).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it('carries the A2A Lane 1 surfaces: the full consent card and remote agents', async () => {
    const app = await makeApp(true);
    try {
      const body = (await app.inject({ method: 'GET', url: '/owner' })).body;
      expect(body).toContain('a2a_delegation_consent');
      expect(body).toContain('Exactly what will be sent:');
      expect(body).toContain('/v1/owner/a2a/remote-agents');
      expect(body).toContain('/v1/owner/a2a/operations');
      expect(body).toContain('Use without a credential');
      // Remote text is only ever set as text, never parsed as markup.
      expect(body).not.toContain('innerHTML');
    } finally {
      await app.close();
    }
  });

  it('serves a self-contained HTML page at /owner when enabled', async () => {
    const app = await makeApp(true);
    try {
      const res = await app.inject({ method: 'GET', url: '/owner' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      const body = res.body;
      // Same-origin owner calls — the page hits Core's OWN routes.
      expect(body).toContain('/v1/run/list');
      expect(body).toContain('/v1/run/start');
      expect(body).toContain('/v1/watch/list');
      expect(body).toContain('/v1/owner/setup/coding-agent');
      expect(body).toContain('/v1/owner/setup/coding-agent/');
      expect(body).toContain('/v1/owner/setup/phone');
      expect(body).toContain('/v1/owner/agent-policies');
      expect(body).toContain('/v1/reasoning/backends/register');
      expect(body).toContain('/v1/owner/reasoning/jobs?limit=50');
      expect(body).toContain('/v1/owner/reasoning/');
      expect(body).toContain('Connected Brain work');
      expect(body).toContain('pending');
      expect(body).toContain('Standard');
      expect(body).toContain('Use this agent as Brain');
      expect(body).toContain('Pair coding agent');
      expect(body).toContain('stale_policies');
      expect(body).toContain("This Home Node's identity changed");
      // The owner can create a poll-mode subscription from this page (Piece 2).
      expect(body).toContain('/v1/watch/create');
      expect(body).toContain('New subscription');
      // NEGOTIATION_PLAN §4.3/§4.5/§4.7 — the owner's own cards and tenders,
      // decided here because Core refuses Brain these cards.
      expect(body).toContain('/v1/workflow/tasks?kind=approval&state=pending_approval');
      expect(body).toContain('A buyer asks for a lower price');
      expect(body).toContain('/v1/commerce/trade/tender/ranking?tender_id=');
      expect(body).toContain('/v1/commerce/trade/tender/award');
      expect(body).toContain('/v1/commerce/orders/submit');
      // A presence 403 raises the passphrase box; it is not a wrong key.
      expect(body).toContain('no_user_presence');
      expect(body).toContain('/v1/commerce/catalog/drafts/presence');
      // Item 1 — Dina's own packs update in place: list, review, confirm.
      expect(body).toContain('/v1/commerce/install/updates');
      expect(body).toContain('/v1/commerce/install/update/prepare');
      expect(body).toContain('/v1/commerce/install/update/confirm');
      // Presents the capability header the HTTP adapter validates.
      expect(body).toContain('x-dina-owner-capability');
      // Never targets a Brain-origin proxy path from this page.
      expect(body).not.toContain('/api/v1/run');
      // Self-contained: no external script/style/fetch host.
      expect(body).not.toMatch(/src="https?:\/\//);
      expect(body).not.toMatch(/href="https?:\/\//);
      // XSS-safe: builds DOM with textContent, never innerHTML.
      expect(body).not.toContain('innerHTML');
      const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(script).toBeDefined();
      expect(() => new Function(script as string)).not.toThrow();
      // Every helper the page calls is defined: `clear` was called in four
      // places and defined nowhere, so the staff-device, agent and Brain-work
      // lists died with a ReferenceError before they rendered.
      expect(script).toMatch(/function clear\(node\)/);
      // Framing + CSP hardening headers.
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    } finally {
      await app.close();
    }
  });

  it('renders the A2A consent card from its payload: every field as text, the full projection, hostile text inert', async () => {
    const app = await makeApp(true);
    try {
      const body = (await app.inject({ method: 'GET', url: '/owner' })).body;
      const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
      // Lift the three functions the card is drawn with out of the served page.
      const source = (name: string): string => {
        const start = script.indexOf(`function ${name}(`);
        if (start < 0) throw new Error(`no function ${name}`);
        let depth = 0;
        for (let i = script.indexOf('{', start); i < script.length; i += 1) {
          if (script[i] === '{') depth += 1;
          else if (script[i] === '}' && (depth -= 1) === 0) return script.slice(start, i + 1);
        }
        throw new Error(`unbalanced ${name}`);
      };
      interface FakeNode { tag: string; className: string; textContent: string; children: FakeNode[]; attrs: Record<string, string> }
      const document = {
        createElement: (tag: string): FakeNode & { appendChild(c: FakeNode): void; setAttribute(k: string, v: string): void } => {
          const node = {
            tag,
            className: '',
            textContent: '',
            children: [] as FakeNode[],
            attrs: {} as Record<string, string>,
            appendChild(c: FakeNode) {
              node.children.push(c);
            },
            setAttribute(k: string, v: string) {
              node.attrs[k] = v;
            },
          };
          return node;
        },
      };
      const render = new Function(
        'document',
        `${source('el')}\n${source('partText')}\n${source('a2aConsentCard')}\nreturn a2aConsentCard;`,
      )(document) as (card: FakeNode, payload: unknown) => void;
      const hostile = '<img src=x onerror=alert(1)>';
      const card = document.createElement('div');
      render(card, {
        consent_hash: 'ab'.repeat(32),
        consent: {
          skill: 'summarize',
          projection: { parts: [{ text: `Summarize: ${hostile}` }, { data: { total: 3 } }] },
        },
        display: {
          agent_name: hostile,
          skill_name: 'Summarize',
          endpoint: 'https://agent.example/rpc',
          card_url: 'https://agent.example/.well-known/agent-card.json',
          signature_state: 'unsigned',
          signature_detail: '',
          credential: 'No credential is sent.',
          effect: 'It only reads.',
          labels: ['Dina cannot yet prove where any of this text came from.'],
          placeholders: [{ type: 'EMAIL', count: 1 }],
        },
      });
      const lines = card.children.map((c) => c.textContent);
      expect(lines[0]).toBe(`Send to ${hostile}: Summarize`);
      expect(lines).toContain('Dina cannot yet prove where any of this text came from.');
      expect(lines).toContain('Replaced with placeholders: EMAIL ×1');
      const pre = card.children.find((c) => c.tag === 'pre');
      expect(pre?.textContent).toBe(`Summarize: ${hostile}\n\n{\n  "total": 3\n}`);
      // Text only: no node carries markup or event attributes.
      expect(card.children.every((c) => Object.keys(c.attrs).length === 0 && c.children.length === 0)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('shows the directory’s PeerLens evidence beside a remote agent, and only when it is this agent’s (§6.1, §8.4)', async () => {
    const app = await makeApp(true);
    try {
      const script = (await app.inject({ method: 'GET', url: '/owner' })).body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
      const start = script.indexOf('function a2aEvidenceText(');
      let end = -1;
      for (let i = script.indexOf('{', start), depth = 0; i < script.length; i += 1) {
        if (script[i] === '{') depth += 1;
        else if (script[i] === '}' && (depth -= 1) === 0) {
          end = i + 1;
          break;
        }
      }
      const text = new Function(`${script.slice(start, end)}\nreturn a2aEvidenceText;`)() as (r: unknown) => string;
      const did = 'did:plc:abcdefghijklmnopqrstuvwx';
      const listed = text({ status: 200, body: { status: 'listed', did, trust_score: 0.8123, recommendation: 'proceed', indexed_at: '2026-10-01T00:00:00.000Z', stale: true } });
      expect(listed).toBe(
        `PeerLens: proceed (trust 0.81) for ${did}, listed 2026-10-01; the listing may be behind the live card. Evidence informs your review; it allows nothing.`,
      );
      // Another agent's evidence is named as such, and none of its trust is shown.
      const other = text({ status: 200, body: { status: 'other_endpoint', did } });
      expect(other).toContain('is not this agent');
      expect(other).not.toMatch(/trust|proceed/);
      expect(text({ status: 200, body: { status: 'not_listed', did } })).toBe(`PeerLens: ${did} is not in the agent directory.`);
      expect(text({ status: 200, body: { status: 'not_dina' } })).toBe('PeerLens: no record. This agent’s card names no Dina node.'.replace('’', "'"));
      expect(text({ status: 503, body: { error: 'a2a_unavailable' } })).toBe('PeerLens: the agent directory is not available right now.');
      // The agent's card asks for it.
      expect(script).toContain('call("GET", base + "/evidence")');
    } finally {
      await app.close();
    }
  });

  it('does NOT serve the console when disabled (default off)', async () => {
    const app = await makeApp(false);
    try {
      const res = await app.inject({ method: 'GET', url: '/owner' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('registerOwnerConsoleRoute returns the bound path (enabled) or null (disabled)', async () => {
    const on = Fastify({ logger: false });
    const off = Fastify({ logger: false });
    try {
      expect(registerOwnerConsoleRoute(on as never, { enabled: true })).toBe('/owner');
      expect(registerOwnerConsoleRoute(off as never, { enabled: false })).toBeNull();
    } finally {
      await on.close();
      await off.close();
    }
  });
});

/** A node of the fake page the console's functions draw into. */
interface PageNode {
  tag: string;
  className: string;
  textContent: string;
  children: PageNode[];
  attrs: Record<string, string>;
  clicks: (() => void)[];
  firstChild: PageNode | null;
}

/**
 * The console's own functions, lifted out of the page Core serves and run
 * over a fake document: what an owner would see, with no browser. `deps` are
 * the page's names the functions call; `stubs` replaces some (`call`, a
 * loader) with a test's own.
 */
async function consoleFunctions(
  names: readonly string[],
  stubs: Record<string, unknown> = {},
  byId: Record<string, PageNode> = {},
): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const app = await makeApp(true);
  let script: string;
  try {
    script = (await app.inject({ method: 'GET', url: '/owner' })).body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  } finally {
    await app.close();
  }
  // A function, or a `var NAME = {…};` table, as the page declares it.
  const source = (name: string): string => {
    const fn = script.indexOf(`function ${name}(`);
    const table = script.indexOf(`var ${name} = {`);
    const start = fn >= 0 ? fn : table;
    if (start < 0) throw new Error(`no function or table ${name}`);
    let depth = 0;
    for (let i = script.indexOf('{', fn >= 0 ? start : start + `var ${name} = `.length - 1); i < script.length; i += 1) {
      if (script[i] === '{') depth += 1;
      else if (script[i] === '}' && (depth -= 1) === 0) return script.slice(start, i + 1) + (fn >= 0 ? '' : ';');
    }
    throw new Error(`unbalanced ${name}`);
  };
  const document = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: (tag: string) => {
      const node: PageNode & Record<string, unknown> = {
        tag,
        className: '',
        textContent: '',
        children: [],
        attrs: {},
        clicks: [],
        get firstChild() {
          return node.children[0] ?? null;
        },
        appendChild(c: PageNode) {
          node.children.push(c);
        },
        removeChild(c: PageNode) {
          node.children.splice(node.children.indexOf(c), 1);
        },
        setAttribute(k: string, v: string) {
          node.attrs[k] = v;
        },
        addEventListener(_kind: string, fn: () => void) {
          node.clicks.push(fn);
        },
      };
      return node;
    },
  };
  const stubNames = Object.keys(stubs);
  const lifted = [...new Set(['el', 'clear', 'btn', ...names])].filter((n) => !stubNames.includes(n));
  return new Function(
    'document',
    ...stubNames,
    `${lifted.map(source).join('\n')}\nreturn { ${names.join(', ')} };`,
  )(document, ...stubNames.map((n) => stubs[n])) as Record<string, (...args: unknown[]) => unknown>;
}

/** A bare page node, for `byId`. */
function pageNode(tag = 'div'): PageNode & { appendChild(c: PageNode): void } {
  const node = {
    tag,
    className: '',
    textContent: '',
    children: [] as PageNode[],
    attrs: {},
    clicks: [] as (() => void)[],
    get firstChild() {
      return node.children[0] ?? null;
    },
    appendChild(c: PageNode) {
      node.children.push(c);
    },
  };
  return node;
}

/** The button labelled `label` under `node`. */
function buttonOf(node: PageNode, label: string): PageNode {
  const find = (n: PageNode): PageNode | undefined =>
    n.tag === 'button' && n.textContent === label ? n : n.children.map(find).find((b) => b !== undefined);
  const found = find(node);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

/** Every text a node and its children show, in order. */
function textsOf(node: PageNode): string[] {
  return [node.textContent, ...node.children.flatMap(textsOf)].filter((t) => t !== '');
}

/** The buttons a node holds, by label. */
function buttonsOf(node: PageNode): string[] {
  return [...(node.tag === 'button' ? [node.textContent] : []), ...node.children.flatMap(buttonsOf)];
}

describe('the owner console’s A2A operation row: the owner’s cancel (A2A §6.4)', () => {
  const op = (over: Record<string, unknown>) => ({
    operation_id: 'op-1',
    state: 'running',
    reason: null,
    agent_name: 'Summarizer',
    skill: 'summarize',
    result: null,
    cancel: null,
    ...over,
  });

  it.each([
    ['running, never cancelled: the Cancel button', {}, null, ['Cancel']],
    ['cancel asked, waiting: no second button', { cancel: 'attempting' }, 'Cancel asked. Waiting for the agent\'s answer.', []],
    ['cancel requested, not yet asked: no second button', { cancel: 'requested' }, 'Cancel asked. Waiting for the agent\'s answer.', []],
    ['cancel refused by the agent: said so, no button', { cancel: 'refused' }, 'The agent refused to cancel. The task runs on to its own end.', []],
    ['queued: the Cancel button', { state: 'queued' }, null, ['Cancel']],
  ])('%s', async (_name, over, notice, buttons) => {
    const { a2aOpRow } = await consoleFunctions(['a2aOpRow', 'partText'], { call: () => new Promise(() => undefined) });
    const row = (a2aOpRow as (op: unknown) => PageNode)(op(over));
    const texts = textsOf(row);
    if (notice === null) expect(texts.filter((t) => /cancel/i.test(t) && t !== 'Cancel')).toEqual([]);
    else expect(texts).toContain(notice);
    expect(buttonsOf(row)).toEqual(buttons);
  });
});

describe('the owner console’s agent directory panel (A2A §8.2, cold audit C3-12)', () => {
  const PANEL = ['a2aDirectoryPanel', 'A2A_PUBLISH_STATES', 'A2A_STAND_DOWN_NOTICES'];
  const view = (over: Record<string, unknown>) => ({
    listing_enabled: true,
    active: true,
    state: 'published',
    eligible: true,
    publisher_epoch: 1,
    published_uri: 'at://did:plc:node/com.dinakernel.a2a.card/self',
    published_at: Date.parse('2026-10-04T10:00:00Z'),
    attempts: 0,
    next_retry_at: null,
    notice: null,
    ...over,
  });
  async function panel(v: Record<string, unknown>): Promise<{ node: PageNode; acts: [string, unknown][] }> {
    const acts: [string, unknown][] = [];
    const { a2aDirectoryPanel } = await consoleFunctions(PANEL);
    const node = (a2aDirectoryPanel as (v: unknown, act: (p: string, b: unknown) => void) => PageNode)(v, (path, body) => acts.push([path, body]));
    return { node, acts };
  }

  it.each([
    ['another_server_publishing', 'Another server now publishes this node’s card'],
    ['fence_missing', 'publishing fence is gone'],
    ['fence_unverifiable', 'could not verify the publishing fence'],
  ])('a node that stood down (%s) says why in words, and offers to start publishing again', async (notice, words) => {
    const { node, acts } = await panel(view({ state: 'stood_down', active: false, eligible: false, notice }));
    const texts = textsOf(node).join(' | ');
    expect(texts).toContain('Stopped publishing.');
    expect(texts.replace(/'/g, '’')).toContain(words);
    expect(texts).not.toContain(notice);
    expect(buttonsOf(node)).toEqual(['Turn listing off', 'Start publishing']);
    buttonOf(node, 'Start publishing').clicks.forEach((fn) => fn());
    expect(acts).toEqual([['/v1/owner/a2a/publisher/activate', {}]]);
  });

  it('listing off: one switch turns it on', async () => {
    const { node, acts } = await panel(view({ listing_enabled: false, active: false, state: 'not_published', published_at: null }));
    expect(textsOf(node)).toContain('Listing is off.');
    buttonOf(node, 'Turn listing on').clicks.forEach((fn) => fn());
    expect(acts).toEqual([['/v1/owner/a2a/directory-listing', { enabled: true }]]);
  });

  it('publishing: says when and where, and stops on the owner’s word', async () => {
    const { node, acts } = await panel(view({}));
    expect(textsOf(node)).toContain('Last published 2026-10-04T10:00:00.000Z as at://did:plc:node/com.dinakernel.a2a.card/self.');
    buttonOf(node, 'Stop publishing').clicks.forEach((fn) => fn());
    buttonOf(node, 'Turn listing off').clicks.forEach((fn) => fn());
    expect(acts).toEqual([
      ['/v1/owner/a2a/publisher/deactivate', {}],
      ['/v1/owner/a2a/directory-listing', { enabled: false }],
    ]);
  });

  it('replacing an unverifiable fence is offered only after activation found one, and sends refence', async () => {
    const box = pageNode();
    const posted: [string, unknown][] = [];
    let answer: { status: number; body: unknown } = { status: 409, body: { error: 'fence_unverifiable' } };
    const { directoryAct } = await consoleFunctions(
      ['directoryAct', 'a2aRefenceOffer'],
      {
        call: (_method: string, path: string, body: unknown) => {
          posted.push([path, body]);
          return Promise.resolve(answer);
        },
        loadDirectory: () => undefined,
        alert: () => undefined,
        a2aRefusal: () => '',
      },
      { a2aDirectory: box },
    );
    const act = directoryAct as (path: string, body: unknown) => void;
    act('/v1/owner/a2a/publisher/activate', {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(buttonsOf(box)).toEqual(['Replace the fence and publish from here']);
    answer = { status: 200, body: {} };
    buttonOf(box, 'Replace the fence and publish from here').clicks.forEach((fn) => fn());
    await new Promise((resolve) => setImmediate(resolve));
    expect(posted).toEqual([
      ['/v1/owner/a2a/publisher/activate', {}],
      ['/v1/owner/a2a/publisher/activate', { refence: true }],
    ]);
  });

  it('control: any other refusal is told, never answered with an offer to replace the fence', async () => {
    const box = pageNode();
    const told: string[] = [];
    const { directoryAct } = await consoleFunctions(
      ['directoryAct', 'a2aRefenceOffer'],
      {
        call: () => Promise.resolve({ status: 409, body: { error: 'repo_unreachable' } }),
        loadDirectory: () => undefined,
        alert: (text: string) => told.push(text),
        a2aRefusal: (r: { body: { error: string } }) => r.body.error,
      },
      { a2aDirectory: box },
    );
    (directoryAct as (path: string, body: unknown) => void)('/v1/owner/a2a/publisher/activate', {});
    await new Promise((resolve) => setImmediate(resolve));
    expect([buttonsOf(box), told]).toEqual([[], ['repo_unreachable']]);
  });
});
