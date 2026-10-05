/**
 * Round-B B-02 (full fix) — the CORE-SERVED owner console. Core serves a
 * self-contained page whose owner calls target Core's OWN routes same-origin,
 * so the owner capability never transits Brain.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { REVIEW_REASON_WORDS } from '@dina/core';

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

  it('carries the UCP search review card: every shop, the exact query, and Core’s reasons in its own words', async () => {
    const app = await makeApp(true);
    try {
      const body = (await app.inject({ method: 'GET', url: '/owner' })).body;
      expect(body).toContain('"ucp_search_review"');
      expect(body).toContain('Send this search');
      expect(body).toContain('Dina held this search before it left:');
      for (const words of Object.values(REVIEW_REASON_WORDS)) expect(body).toContain(JSON.stringify(words));
      // The Shopping section reads and saves the owner's UCP settings.
      expect(body).toContain('/v1/owner/ucp/settings');
      expect(body).toContain('id="ucpMerchants"');
    } finally {
      await app.close();
    }
  });

  it('runs the page’s own UCP code: the review card as text, and a save that trims, drops blanks, and names a refused field', async () => {
    const app = await makeApp(true);
    try {
      const script = (await app.inject({ method: 'GET', url: '/owner' })).body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
      // A function or `var` statement lifted out of the served page, braces balanced.
      const lift = (head: string): string => {
        const start = script.indexOf(head);
        if (start < 0) throw new Error(`no ${head}`);
        let depth = 0;
        for (let i = script.indexOf('{', start); i < script.length; i += 1) {
          if (script[i] === '{') depth += 1;
          else if (script[i] === '}' && (depth -= 1) === 0) return script.slice(start, script[i + 1] === ';' ? i + 2 : i + 1);
        }
        throw new Error(`unbalanced ${head}`);
      };
      interface Node { tag: string; className: string; textContent: string; value: string; checked?: boolean; children: Node[]; appendChild(c: Node): void; setAttribute(k: string, v: string): void }
      const make = (tag: string): Node => {
        const node: Node = {
          tag,
          className: '',
          textContent: '',
          value: '',
          children: [],
          appendChild: (c) => node.children.push(c),
          setAttribute: () => undefined,
        };
        return node;
      };
      const ids = ['ucpSettingsNote', 'ucpMerchants', 'ucpCountry', 'ucpRegion', 'ucpLanguage', 'ucpPostal', 'ucpOrderWebhooks', 'ucpWebhookNote'] as const;
      const byId = Object.fromEntries(ids.map((id) => [id, make('input')])) as Record<(typeof ids)[number], Node>;
      const document = { createElement: make, getElementById: (id: string) => (byId as Record<string, Node | undefined>)[id] };
      const sent: { method: string; path: string; body: unknown }[] = [];
      let answer: { status: number; body: unknown } = { status: 200, body: {} };
      const call = (method: string, path: string, body: unknown) => {
        sent.push({ method, path, body });
        return Promise.resolve(answer);
      };
      const code = [
        lift('function el('),
        lift('function refusal('),
        lift('var UCP_REVIEW_REASONS'),
        lift('function ucpSearchReviewCard('),
        lift('var UCP_FIELDS'),
        lift('var UCP_FIELD_WORDS'),
        lift('function showUcpSettings('),
        lift('function saveUcpSettings('),
        lift('function loadUcpSettings('),
      ].join('\n');
      const page = new Function('document', 'call', `${code}\nreturn { ucpSearchReviewCard, saveUcpSettings, loadUcpSettings };`)(document, call) as {
        ucpSearchReviewCard: (card: Node, payload: unknown) => void;
        saveUcpSettings: () => void;
        loadUcpSettings: () => void;
      };

      const hostile = '<img src=x onerror=alert(1)>';
      const card = make('div');
      page.ucpSearchReviewCard(card, {
        merchants: ['https://a-shop.example', 'https://b-shop.example'],
        why: ['personal_data', 'made_up'],
        query: `tea for ${hostile}`,
      });
      expect(card.children.map((c) => c.textContent)).toEqual([
        'Search 2 shops?',
        'Dina held this search before it left:',
        REVIEW_REASON_WORDS.personal_data,
        'made_up',
        'It goes to:',
        'https://a-shop.example',
        'https://b-shop.example',
        'Exactly what will be sent:',
        `tea for ${hostile}`,
      ]);
      expect(card.children.every((c) => c.children.length === 0)).toBe(true);

      byId.ucpMerchants.value = ' https://a-shop.example \n\n https://b-shop.example';
      byId.ucpCountry.value = ' DE ';
      byId.ucpPostal.value = '   ';
      byId.ucpOrderWebhooks.checked = true;
      answer = {
        status: 200,
        body: {
          merchants: ['https://a-shop.example', 'https://b-shop.example'],
          context: { address_country: 'DE' },
          order_webhooks: true,
          order_webhook_url: 'https://node.example/ucp/webhooks/orders',
        },
      };
      page.saveUcpSettings();
      await Promise.resolve();
      expect(sent.at(-1)).toEqual({
        method: 'PUT',
        path: '/v1/owner/ucp/settings',
        body: { merchants: ['https://a-shop.example', 'https://b-shop.example'], context: { address_country: 'DE' }, order_webhooks: true },
      });
      expect(byId.ucpSettingsNote.textContent).toBe('Saved.');
      expect(byId.ucpWebhookNote.textContent).toBe(
        'Shops send order updates to https://node.example/ucp/webhooks/orders. They learn this address, which the A2A directory links to your DID.',
      );
      // Turned off: the save says so, and the note too.
      byId.ucpOrderWebhooks.checked = false;
      answer = {
        status: 200,
        body: { merchants: ['https://a-shop.example', 'https://b-shop.example'], context: {}, order_webhooks: false, order_webhook_url: null },
      };
      page.saveUcpSettings();
      await Promise.resolve();
      expect((sent.at(-1)?.body as { order_webhooks: boolean }).order_webhooks).toBe(false);
      expect(byId.ucpOrderWebhooks.checked).toBe(false);
      expect(byId.ucpWebhookNote.textContent).toBe('Off: Dina asks each shop for order updates itself.');
      expect(byId.ucpMerchants.value).toBe('https://a-shop.example\nhttps://b-shop.example');

      answer = { status: 400, body: { error: 'invalid_settings', field: 'address_country' } };
      byId.ucpCountry.value = 'Germany';
      page.saveUcpSettings();
      await Promise.resolve();
      expect(byId.ucpSettingsNote.textContent).toBe('Use the two-letter country code, in capitals (e.g. DE).');

      // Loaded where search is off: the section says so.
      answer = { status: 200, body: { merchants: ['https://a-shop.example'], context: {}, searching: false, order_webhooks: true, order_webhook_url: null } };
      page.loadUcpSettings();
      await Promise.resolve();
      expect(byId.ucpWebhookNote.textContent).toBe('This node has no public address, so Dina asks each shop for order updates itself.');
      expect(byId.ucpSettingsNote.textContent).toBe(
        '1 shop(s). Shop search is not switched on for this node yet; these settings apply once it is.',
      );
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
  let text = '';
  const node = {
    tag,
    className: '',
    // As the DOM's: setting the text replaces every child.
    get textContent() {
      return text;
    },
    set textContent(value: string) {
      text = value;
      node.children.length = 0;
    },
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

describe('shop orders on the console (UCP plan §3.14)', () => {
  const textOf = (n: PageNode): string => [n.textContent, ...n.children.map(textOf)].join('\n');
  it('lists each order in Core’s words, with its notes, the shop’s page, and "Mark as done" only for an order the shop does not share', async () => {
    const box = pageNode();
    const sent: [string, string, unknown][] = [];
    const orders = [
      {
        merchant_origin: 'https://tea.example',
        merchant_host: 'tea.example',
        order_id: 'ord_1',
        state: 'open',
        headline: 'Shipped',
        summary: {
          currency: 'EUR',
          total: '1800',
          lines: [
            { title: 'Rice <b>', quantity: '1.5', unit: 'kg', status: 'processing' },
            { title: 'Gone', quantity: '1', status: 'removed' },
          ],
        },
        notes: ['A refund: completed'],
        permalink_url: 'https://tea.example/orders/ord_1',
      },
      {
        merchant_origin: 'https://tea.example',
        merchant_host: 'tea.example',
        order_id: 'ord_2',
        state: 'not_shared',
        headline: 'tea.example does not share this order with Dina',
        summary: null,
        notes: [],
        permalink_url: 'javascript:alert(1)',
      },
    ];
    const page = await consoleFunctions(['loadShopOrders', 'shopOrderCard'], {
      call: (method: string, path: string, body: unknown) => {
        sent.push([method, path, body]);
        return Promise.resolve({ status: 200, body: { orders } });
      },
      money: (m: string, c: string) => `${c} ${m}`,
      alert: () => undefined,
      refusal: (e: string) => e,
    }, { shopOrders: box });
    (page.loadShopOrders as () => void)();
    await new Promise((r) => setImmediate(r));
    const [first, second] = box.children;
    expect(textOf(first as PageNode)).toContain('1.5 kg Rice <b>');
    expect(textOf(first as PageNode)).not.toContain('Gone');
    expect(textOf(first as PageNode)).toContain('A refund: completed');
    expect(buttonsOf(first as PageNode)).toEqual([]);
    const links = (n: PageNode): PageNode[] => [...(n.tag === 'a' ? [n] : []), ...n.children.flatMap(links)];
    expect(links(first as PageNode)[0]?.attrs).toMatchObject({ href: 'https://tea.example/orders/ord_1', rel: 'noopener noreferrer' });
    expect(links(second as PageNode)).toEqual([]);
    expect(buttonsOf(second as PageNode)).toEqual(['Mark as done']);
    buttonOf(second as PageNode, 'Mark as done').clicks.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    expect(sent).toContainEqual(['POST', '/v1/owner/ucp/orders/done', { merchant_origin: 'https://tea.example', order_id: 'ord_2' }]);
  });
});

describe('linked accounts on the console (UCP plan §3.17)', () => {
  const textOf = (n: PageNode): string => [n.textContent, ...n.children.map(textOf)].join('\n');
  const anchors = (n: PageNode): PageNode[] => [...(n.tag === 'a' ? [n] : []), ...n.children.flatMap(anchors)];

  it('lists each link with its state, offers Link for the owner’s other shops, and Unlink only after a confirm', async () => {
    const box = pageNode();
    const sent: [string, string, unknown][] = [];
    let confirmed = false;
    const page = await consoleFunctions(['loadLinks', 'linkCard', 'startLink', 'linkRefusal'], {
      call: (method: string, path: string, body: unknown) => {
        sent.push([method, path, body]);
        if (path === '/v1/owner/ucp/links')
          return Promise.resolve({
            status: 200,
            body: {
              links: [
                { merchant_origin: 'https://tea.example', merchant_host: 'tea.example', state: 'active', scopes: ['dev.ucp.shopping.order:read'] },
                { merchant_origin: 'https://rice.example', merchant_host: 'rice.example', state: 'needs_relink', scopes: [] },
              ],
            },
          });
        if (path === '/v1/owner/ucp/settings')
          return Promise.resolve({ status: 200, body: { merchants: ['https://tea.example', 'https://bread.example'] } });
        return Promise.resolve({ status: 200, body: { unlinked: true } });
      },
      confirm: () => confirmed,
      alert: () => undefined,
      refusal: (e: string) => e,
      loadApprovals: () => undefined,
    }, { links: box, linkLinks: pageNode() });
    (page.loadLinks as () => void)();
    await new Promise((r) => setImmediate(r));
    const [tea, rice, bread] = box.children;
    expect(textOf(tea as PageNode)).toContain('tea.example · Linked');
    expect(buttonsOf(tea as PageNode)).toEqual(['Unlink']);
    expect(textOf(rice as PageNode)).toContain('rice.example · Needs linking again');
    expect(buttonsOf(rice as PageNode)).toEqual(['Link again', 'Unlink']);
    expect(textOf(bread as PageNode)).toContain('bread.example');
    expect(buttonsOf(bread as PageNode)).toEqual(['Link']);
    buttonOf(tea as PageNode, 'Unlink').clicks.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    expect(sent.filter(([, p]) => p === '/v1/owner/ucp/links/unlink')).toEqual([]);
    confirmed = true;
    buttonOf(tea as PageNode, 'Unlink').clicks.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    expect(sent).toContainEqual(['POST', '/v1/owner/ucp/links/unlink', { merchant_origin: 'https://tea.example' }]);
  });

  it('access Dina could not take back is shown until the owner removes it; a shop that asked is offered with its scopes; a failed attempt says why', async () => {
    const box = pageNode();
    const sent: [string, string, unknown][] = [];
    const started: unknown[][] = [];
    const page = await consoleFunctions(['loadLinks', 'linkCard', 'linkOutcome'], {
      call: (method: string, path: string, body: unknown) => {
        sent.push([method, path, body]);
        if (path === '/v1/owner/ucp/links')
          return Promise.resolve({
            status: 200,
            body: {
              links: [],
              wanted: [{ merchant_origin: 'https://rice.example', merchant_host: 'rice.example', scopes: ['a:b'], at: 1 }],
              unrevoked: [{ merchant_origin: 'https://old.example', merchant_host: 'old.example', since: 1 }],
              failed: [{ merchant_origin: 'https://tea.example', merchant_host: 'tea.example', outcome: 'denied', at: 1 }],
            },
          });
        if (path === '/v1/owner/ucp/settings') return Promise.resolve({ status: 200, body: { merchants: [] } });
        return Promise.resolve({ status: 200, body: { dismissed: true } });
      },
      startLink: (...a: unknown[]) => started.push(a),
      confirm: () => true,
      alert: () => undefined,
      refusal: (e: string) => e,
    }, { links: box, linkLinks: pageNode() });
    (page.loadLinks as () => void)();
    await new Promise((r) => setImmediate(r));
    const text = textOf(box);
    expect(text).toContain('Dina could not cancel its access at old.example. Remove Dina from your account settings there.');
    expect(text).toContain('rice.example asks you to link your account');
    expect(text).toContain('Linking at tea.example did not finish: you said no at the shop.');
    const [unrevoked, wanted] = box.children;
    buttonOf(wanted as PageNode, 'Link').clicks.forEach((fn) => fn());
    expect(started).toEqual([['https://rice.example', ['a:b']]]);
    buttonOf(unrevoked as PageNode, 'I removed it').clicks.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    expect(sent).toContainEqual(['POST', '/v1/owner/ucp/links/dismiss', { merchant_origin: 'https://old.example' }]);
  });

  it('Link: a sign-in this node takes back is a link to click; one for the phone says so; a refusal is said in words', async () => {
    const linkLinks = pageNode();
    const alerts: string[] = [];
    let approvalsLoaded = 0;
    let answer: unknown = { started: true, opens: 'here', url: 'https://tea.example/auth/authorize?state=s', scopes: [], expires_at: 1 };
    const sent: unknown[] = [];
    const page = await consoleFunctions(['startLink', 'linkRefusal'], {
      call: (_m: string, _p: string, body: unknown) => {
        sent.push(body);
        return Promise.resolve({ status: 200, body: answer });
      },
      alert: (t: string) => alerts.push(t),
      refusal: (e: string) => e,
      loadApprovals: () => (approvalsLoaded += 1),
    }, { linkLinks });
    (page.startLink as (o: string, s: string[]) => void)('https://tea.example', ['dev.ucp.shopping.order:read']);
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([{ merchant_origin: 'https://tea.example', scopes: ['dev.ucp.shopping.order:read'] }]);
    expect(anchors(linkLinks)[0]?.attrs).toMatchObject({
      href: 'https://tea.example/auth/authorize?state=s',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    answer = { started: true, opens: 'phone', card_id: 'ucp-link-1', scopes: [], expires_at: 1 };
    (page.startLink as (o: string, s: string[]) => void)('https://tea.example', []);
    await new Promise((r) => setImmediate(r));
    expect(textOf(linkLinks)).toContain('Sent to your phone: approve the card there to sign in at tea.example.');
    expect(approvalsLoaded).toBe(1);
    answer = { started: false, reason: 'no_public_client' };
    (page.startLink as (o: string, s: string[]) => void)('https://tea.example', []);
    await new Promise((r) => setImmediate(r));
    expect(alerts).toEqual(['tea.example\'s sign-in lacks what Dina needs to link safely.']);
    answer = { started: false, reason: 'no_phone' };
    (page.startLink as (o: string, s: string[]) => void)('https://tea.example', []);
    await new Promise((r) => setImmediate(r));
    expect(alerts.at(-1)).toContain("Pair your phone as this server's node");
    answer = { started: true, opens: 'here', url: 'javascript:alert(1)', scopes: [], expires_at: 1 };
    (page.startLink as (o: string, s: string[]) => void)('https://tea.example', []);
    await new Promise((r) => setImmediate(r));
    expect(anchors(linkLinks)).toHaveLength(1);
  });

  it('a shop order waiting for a link offers it, with the scopes its challenge named', async () => {
    const box = pageNode();
    const started: unknown[][] = [];
    const page = await consoleFunctions(['loadShopOrders', 'shopOrderCard'], {
      call: () =>
        Promise.resolve({
          status: 200,
          body: {
            orders: [
              {
                merchant_origin: 'https://tea.example',
                merchant_host: 'tea.example',
                order_id: 'ord_1',
                state: 'open',
                headline: 'Link your account at tea.example to follow this order',
                summary: null,
                notes: [],
                permalink_url: 'https://tea.example/orders/ord_1',
                link_scopes: ['dev.ucp.shopping.order:read'],
              },
            ],
          },
        }),
      money: (m: string) => m,
      alert: () => undefined,
      refusal: (e: string) => e,
      startLink: (...a: unknown[]) => started.push(a),
    }, { shopOrders: box });
    (page.loadShopOrders as () => void)();
    await new Promise((r) => setImmediate(r));
    const card = box.children[0] as PageNode;
    expect(buttonsOf(card)).toEqual(['Link your account at tea.example']);
    buttonOf(card, 'Link your account at tea.example').clicks.forEach((fn) => fn());
    expect(started).toEqual([['https://tea.example', ['dev.ucp.shopping.order:read']]]);
  });

  it('the link card waits for the phone: Core’s words as text, and only “Don’t link”', async () => {
    const sent: string[] = [];
    const page = await consoleFunctions(['approvalCard', 'decideApproval', 'payloadOf'], {
      call: (_m: string, path: string) => {
        sent.push(path);
        return Promise.resolve({ status: 200, body: { task: {} } });
      },
      needPresence: () => undefined,
      loadApprovals: () => undefined,
      alert: () => undefined,
      refusal: (e: string) => e,
    });
    const card = page.approvalCard?.({
      id: 'ucp-link-1',
      description: 'Link your account at tea.example?\nDina may read your orders.\n<b>x</b>',
      payload: JSON.stringify({ type: 'ucp_link_handoff', merchant: 'https://tea.example', url: 'https://tea.example/auth' }),
    }) as PageNode;
    expect(card.children.find((c) => c.tag === 'pre')?.textContent).toContain('<b>x</b>');
    expect(textOf(card)).toContain('Approve this on your phone');
    expect(buttonsOf(card)).toEqual(["Don't link"]);
    buttonOf(card, "Don't link").clicks.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual(['/v1/workflow/tasks/ucp-link-1/cancel']);
  });
});

describe('the shopping profile and key on the console (UCP plan §3.5, §4.8)', () => {
  const textOf = (n: PageNode): string => [n.textContent, ...n.children.map(textOf)].join('\n');
  const view = (over: Record<string, unknown> = {}) => ({
    status: 'served',
    role: 'active',
    enabled: true,
    compromise_pending: false,
    pending_control: null,
    detail: null,
    key: { generation: 0, next: null, retiring: [] },
    rotation_requested: false,
    ...over,
  });
  const rig = (answers: { status: number; body: unknown }[], confirmed = true) => {
    const box = pageNode();
    const sent: [string, string, unknown][] = [];
    const presence: (() => void)[] = [];
    return consoleFunctions(
      ['loadPublication', 'renderPublication', 'publicationAct', 'publicationText', 'publicationDetail'],
      {
        call: (method: string, path: string, body: unknown) => {
          sent.push([method, path, body]);
          return Promise.resolve(answers.shift() ?? { status: 200, body: view() });
        },
        confirm: () => confirmed,
        alert: () => undefined,
        refusal: (e: string) => e,
        needPresence: (retry: () => void) => presence.push(retry),
      },
      { publication: box },
    ).then((page) => ({ page, box, sent, presence }));
  };
  const settle = () => new Promise((r) => setImmediate(r));

  it('shows the status and the ring in words, and only the actions that make sense', async () => {
    const at = Date.UTC(2026, 9, 5, 12);
    const { page, box } = await rig([
      {
        status: 200,
        body: view({
          key: { generation: 2, next: { generation: 3, signs_from: at }, retiring: [{ generation: 1, until: at }] },
        }),
      },
    ]);
    (page.loadPublication as () => void)();
    await settle();
    const text = textOf(box);
    expect(text).toContain('Shops can find your shopping profile.');
    expect(text).toContain('Key in use: number 2.');
    expect(text).toContain('New key 3 signs from');
    expect(text).toContain('Old key 1 stays listed until');
    // A rotation under way: no second one; this device holds shopping, so no "use this device".
    expect(buttonsOf(box)).toEqual(['Turn shopping off', 'My key may be compromised']);
  });

  it('rotate sends the action and shows the ring Core returns; a stood-down device offers to take shopping back', async () => {
    const { page, box, sent } = await rig([
      { status: 200, body: view() },
      { status: 200, body: view({ key: { generation: 0, next: { generation: 1, signs_from: null }, retiring: [] } }) },
    ]);
    (page.loadPublication as () => void)();
    await settle();
    expect(buttonsOf(box)).toEqual(['Rotate my shopping key', 'Turn shopping off', 'My key may be compromised']);
    buttonOf(box, 'Rotate my shopping key').clicks.forEach((fn) => fn());
    await settle();
    expect(sent).toContainEqual(['POST', '/v1/owner/ucp/publication', { action: 'rotate' }]);
    expect(textOf(box)).toContain('Dina is checking the host serves it');
    (page.renderPublication as (v: unknown) => void)(view({ role: 'stood_down', status: 'stood_down' }));
    expect(textOf(box)).toContain('Another of your devices handles shopping.');
    expect(buttonsOf(box)[0]).toBe('Use this device for shopping');
  });

  it('"my key may be compromised" only after a confirm; a presence refusal asks, then sends again', async () => {
    let confirmed = false;
    const answers = [
      { status: 200, body: view() },
      { status: 403, body: { error: 'no_user_presence' } },
      { status: 200, body: view({ key: { generation: 1, next: null, retiring: [] } }) },
    ];
    const box = pageNode();
    const sent: [string, string, unknown][] = [];
    const presence: (() => void)[] = [];
    const page = await consoleFunctions(
      ['loadPublication', 'renderPublication', 'publicationAct', 'publicationText', 'publicationDetail'],
      {
        call: (method: string, path: string, body: unknown) => {
          sent.push([method, path, body]);
          return Promise.resolve(answers.shift() ?? { status: 500, body: {} });
        },
        confirm: () => confirmed,
        alert: () => undefined,
        refusal: (e: string) => e,
        needPresence: (retry: () => void) => presence.push(retry),
      },
      { publication: box },
    );
    (page.loadPublication as () => void)();
    await settle();
    buttonOf(box, 'My key may be compromised').clicks.forEach((fn) => fn());
    await settle();
    expect(sent.filter(([m]) => m === 'POST')).toEqual([]);
    confirmed = true;
    buttonOf(box, 'My key may be compromised').clicks.forEach((fn) => fn());
    await settle();
    expect(presence).toHaveLength(1);
    presence[0]?.();
    await settle();
    expect(sent.filter(([m]) => m === 'POST')).toEqual([
      ['POST', '/v1/owner/ucp/publication', { action: 'compromised' }],
      ['POST', '/v1/owner/ucp/publication', { action: 'compromised' }],
    ]);
    expect(textOf(box)).toContain('Key in use: number 1.');
  });

  it('a refused control is said as refused, with the reason, and offered again', async () => {
    const { page, box } = await rig([]);
    (page.renderPublication as (v: unknown) => void)(
      view({ status: 'refused', enabled: false, pending_control: 'pause', detail: 'invalid' }),
    );
    expect(textOf(box)).toContain('refused to turn shopping off: your profile is still served');
    expect(textOf(box)).toContain("The host could not check this Dina's signature.");
    expect(buttonsOf(box)).toContain('Turn shopping off');
    (page.renderPublication as (v: unknown) => void)(
      view({ status: 'refused', compromise_pending: true, pending_control: 'retire', detail: 'label_owned' }),
    );
    expect(textOf(box)).toContain('refused to retire your key');
    expect(textOf(box)).not.toContain('keeps trying');
    expect(buttonsOf(box)).toContain('My key may be compromised');
  });

  it('a node without shopping says so', async () => {
    const { page, box } = await rig([{ status: 503, body: { error: 'ucp_unavailable' } }]);
    (page.loadPublication as () => void)();
    await settle();
    expect(box.textContent).toBe('Shopping is not switched on for this node.');
  });
});

describe('the A2A card key on the console (UCP plan §4.8)', () => {
  const textOf = (n: PageNode): string => [n.textContent, ...n.children.map(textOf)].join('\n');
  const settle = () => new Promise((r) => setImmediate(r));
  const page = (answers: { status: number; body: unknown }[]) => {
    const box = pageNode();
    const sent: [string, string, unknown][] = [];
    const presence: (() => void)[] = [];
    return consoleFunctions(
      ['loadCardKey', 'renderCardKey', 'rotateCardKey'],
      {
        call: (method: string, path: string, body: unknown) => {
          sent.push([method, path, body]);
          return Promise.resolve(answers.shift() ?? { status: 500, body: {} });
        },
        clear: (n: PageNode) => {
          n.textContent = '';
        },
        alert: () => undefined,
        a2aRefusal: (r: { status: number }) => `refused ${r.status}`,
        needPresence: (retry: () => void) => presence.push(retry),
      },
      { a2aCardKey: box },
    ).then((fns) => ({ fns, box, sent, presence }));
  };

  it('shows the key in use and offers a rotation; a presence refusal asks, then rotates; mid-rotation offers none', async () => {
    const { fns, box, sent, presence } = await page([
      { status: 200, body: { generation: 0, next: null, retiring: [] } },
      { status: 403, body: { error: 'no_user_presence' } },
      { status: 200, body: { generation: 0, next: { generation: 1, signs_from: null }, retiring: [] } },
    ]);
    (fns.loadCardKey as () => void)();
    await settle();
    expect(textOf(box)).toContain('Card key in use: number 0.');
    buttonOf(box, 'Rotate the card key').clicks.forEach((fn) => fn());
    await settle();
    expect(presence).toHaveLength(1);
    presence[0]?.();
    await settle();
    expect(sent.filter(([m]) => m === 'POST')).toEqual([
      ['POST', '/v1/owner/a2a/card-key', { action: 'rotate' }],
      ['POST', '/v1/owner/a2a/card-key', { action: 'rotate' }],
    ]);
    expect(textOf(box)).toContain('New key 1 is listed; it signs once the gateway serves it.');
    expect(buttonsOf(box)).toEqual([]);
  });

  it('a node still reading its DID document says so; a node with no card says so', async () => {
    const reading = await page([{ status: 200, body: { generation: null, next: null, retiring: [] } }]);
    (reading.fns.loadCardKey as () => void)();
    await settle();
    expect(reading.box.textContent).toMatch(/reading which card key is in use/);
    const none = await page([{ status: 503, body: { error: 'card_unconfigured' } }]);
    (none.fns.loadCardKey as () => void)();
    await settle();
    expect(none.box.textContent).toBe('This node serves no agent card.');
  });
});

describe('the UCP order notice card on the console (UCP plan §3.14)', () => {
  const noticeTask = (permalink: string) => ({
    id: 'ucp-order-notice-1',
    description: 'A delivery attempt failed on your order at tea.example. <b>x</b>',
    payload: JSON.stringify({ type: 'ucp_order_notice', merchant_host: 'tea.example', permalink_url: permalink }),
  });
  const linkOf = (box: PageNode): PageNode | undefined => {
    const find = (n: PageNode): PageNode | undefined =>
      n.tag === 'a' ? n : n.children.map(find).find((x) => x !== undefined);
    return find(box);
  };

  it('shows Core’s words as text, links the shop’s order page, and offers only "Seen"', async () => {
    const sent: string[] = [];
    const page = await consoleFunctions(['approvalCard', 'decideApproval', 'payloadOf'], {
      call: (_m: string, path: string) => {
        sent.push(path);
        return Promise.resolve({ status: 200, body: { task: {} } });
      },
      needPresence: () => undefined,
      loadApprovals: () => undefined,
      alert: () => undefined,
      refusal: (e: string) => e,
    });
    const card = page.approvalCard?.(noticeTask('https://tea.example/orders/ord_1')) as PageNode;
    expect(card.children.find((c) => c.tag === 'strong')?.textContent).toContain('<b>x</b>');
    expect(linkOf(card)?.attrs).toMatchObject({
      href: 'https://tea.example/orders/ord_1',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(linkOf(card)?.textContent).toBe('Track or return at tea.example');
    expect(buttonsOf(card)).toEqual(['Seen']);
    buttonOf(card, 'Seen').clicks.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual(['/v1/workflow/tasks/ucp-order-notice-1/approve']);
    const plain = page.approvalCard?.(noticeTask('http://tea.example/orders/ord_1')) as PageNode;
    expect(linkOf(plain)).toBeUndefined();
  });
});

describe('the UCP checkout cards on the console (UCP plan §3.7)', () => {
  const handoffTask = (url: string) => ({
    id: 'ucp-checkout-handoff-1',
    description: 'Review and pay at shop.example\n2 each × Sencha — EUR 56.00\n<img src=x onerror=alert(1)>',
    payload: JSON.stringify({ type: 'ucp_checkout_handoff', handoff: { url } }),
  });
  const linkOf = (box: PageNode): PageNode | undefined => {
    const find = (n: PageNode): PageNode | undefined =>
      n.tag === 'a' ? n : n.children.map(find).find((x) => x !== undefined);
    return find(box);
  };

  it('shows Core’s text as text; a yes asks for presence when it is due, then leaves the merchant’s link to tap', async () => {
    const answers = [
      { status: 403, body: { error: 'no_user_presence' } },
      { status: 200, body: { task: {} } },
    ];
    const sent: { method: string; path: string }[] = [];
    let retry: (() => void) | null = null;
    const links = pageNode();
    const page = await consoleFunctions(
      ['approvalCard', 'decideApproval', 'payloadOf', 'showHandoffLink'],
      {
        call: (method: string, path: string) => {
          sent.push({ method, path });
          return Promise.resolve(answers.shift());
        },
        needPresence: (fn: () => void) => {
          retry = fn;
        },
        loadApprovals: () => undefined,
        alert: () => undefined,
        refusal: (e: string) => e,
      },
      { handoffLinks: links },
    );
    const card = page.approvalCard?.(handoffTask('https://shop.example/checkout/chk_1')) as PageNode;
    expect(card.children.find((c) => c.tag === 'pre')?.textContent).toContain('<img src=x onerror=alert(1)>');
    buttonOf(card, "Approve and get the merchant's link").clicks.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    expect(linkOf(links)).toBeUndefined();
    (retry as unknown as () => void)();
    await new Promise((r) => setImmediate(r));
    expect(sent.map((s) => s.path)).toEqual([
      '/v1/workflow/tasks/ucp-checkout-handoff-1/approve',
      '/v1/workflow/tasks/ucp-checkout-handoff-1/approve',
    ]);
    const link = linkOf(links);
    expect(link?.attrs).toMatchObject({
      href: 'https://shop.example/checkout/chk_1',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(link?.textContent).toBe("Open shop.example's checkout");
  });

  it('never offers a link that is not https; the start card shows Core’s text and its own buttons', async () => {
    const links = pageNode();
    const page = await consoleFunctions(
      ['approvalCard', 'decideApproval', 'payloadOf', 'showHandoffLink'],
      {
        call: () => Promise.resolve({ status: 200, body: {} }),
        needPresence: () => undefined,
        loadApprovals: () => undefined,
        alert: () => undefined,
        refusal: (e: string) => e,
      },
      { handoffLinks: links },
    );
    const card = page.approvalCard?.(handoffTask('javascript:alert(1)')) as PageNode;
    buttonOf(card, "Approve and get the merchant's link").clicks.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    expect(linkOf(links)).toBeUndefined();
    const start = page.approvalCard?.({
      id: 'ucp-checkout-start-1',
      description: 'Start checkout at shop.example?\nNo personal data is sent.',
      payload: JSON.stringify({ type: 'ucp_checkout_start' }),
    }) as PageNode;
    expect(start.children.find((c) => c.tag === 'pre')?.textContent).toContain('No personal data is sent.');
    expect(buttonOf(start, 'Start checkout')).toBeTruthy();
    expect(buttonOf(start, "Don't start")).toBeTruthy();
  });
});

describe('the console script', () => {
  it('declares each top-level function once: a second declaration would silently replace the first', async () => {
    const app = await makeApp(true);
    try {
      const script = (await app.inject({ method: 'GET', url: '/owner' })).body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
      const names = [...script.matchAll(/^ {2}function (\w+)\(/gm)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(20);
      expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
