/**
 * HOSTED_DINA §4 — the cell's own page. The page script runs here against a
 * small fake DOM: the browser is paired as soon as the words appear (the owner
 * code lives five minutes, and writing down 24 words can take longer), and a
 * failed pairing still leaves the way back to ChatGPT and a way to connect
 * the browser later with the passphrase.
 */

import { webcrypto } from 'node:crypto';

import { renderGatePage } from '../src/cell/gate_pages';

import type { GateState } from '../src/cell/gate';

const FRONT_DOOR = 'https://dot.test';
const BACK = `${FRONT_DOOR}/link/done?request=r1`;
const WORDS = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

const script = (state: GateState): string => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(renderGatePage(state, FRONT_DOOR));
  if (m === null) throw new Error('no page script');
  return m[1] ?? '';
};

class FakeNode {
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  textContent = '';
  className = '';
  value = '';
  disabled = false;
  private listeners: Record<string, () => void> = {};
  constructor(readonly tag: string) {}
  get firstChild(): FakeNode | undefined {
    return this.children[0];
  }
  get lastChild(): FakeNode | undefined {
    return this.children[this.children.length - 1];
  }
  appendChild(c: FakeNode): FakeNode {
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeNode): FakeNode {
    this.children = this.children.filter((n) => n !== c);
    return c;
  }
  insertBefore(c: FakeNode, ref: FakeNode | undefined): FakeNode {
    const at = ref === undefined ? -1 : this.children.indexOf(ref);
    if (at < 0) this.children.push(c);
    else this.children.splice(at, 0, c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === 'value') this.value = v;
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners[type] = fn;
  }
  click(): void {
    this.listeners.click?.();
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())].join(' ');
  }
}

function runPage(state: GateState, pairStatus: number) {
  const view = new FakeNode('main');
  const msg = new FakeNode('p');
  const find = (id: string): FakeNode | null =>
    [...view.all(), ...msg.all()].find((n) => n.attrs.id === id) ?? null;
  const document = {
    getElementById: (id: string) => (id === 'view' ? view : id === 'msg' ? msg : find(id)),
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { textContent: text }),
  };
  const calls: string[] = [];
  const fetch = async (path: string) => {
    calls.push(path);
    const reply = (status: number, body: unknown) => ({ status, json: async () => body });
    if (path === '/cell/setup') return reply(200, { words: WORDS, owner_device_code: 'code-1' });
    if (path === '/v1/pair/complete') return reply(pairStatus, {});
    return reply(404, {});
  };
  const location = {
    hash: `#ticket=t1&return=${encodeURIComponent(BACK)}`,
    pathname: '/',
    assign: jest.fn(),
    reload: jest.fn(),
  };
  // No IndexedDB in this fake: a pairing that gets that far fails there.
  const indexedDB = {
    open: () => {
      throw new Error('no IndexedDB here');
    },
  };
  new Function('document', 'location', 'history', 'fetch', 'crypto', 'indexedDB', script(state))(
    document,
    location,
    { replaceState: () => undefined },
    fetch,
    webcrypto,
    indexedDB,
  );
  return { view, msg, find, calls, location };
}

const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setImmediate(r));
  expect(until()).toBe(true);
};

const node = (n: FakeNode | null, id: string): FakeNode => {
  if (n === null) throw new Error(`no element #${id}`);
  return n;
};

const button = (view: FakeNode, text: string): FakeNode => {
  const b = view.all().find((n) => n.tag === 'button' && n.textContent === text);
  if (b === undefined) throw new Error(`no button "${text}"`);
  return b;
};

describe('the cell page script', () => {
  it('parses in every state', () => {
    for (const s of ['new', 'locked', 'starting', 'failed', 'unlocked'] as const) {
      expect(() => new Function(script(s))).not.toThrow();
    }
  });

  it('pairs when the words appear; a failed pairing keeps the way back and a way to connect later', async () => {
    const page = runPage('new', 404);
    const byId = (id: string): FakeNode => node(page.find(id), id);
    byId('pass').value = 'a long enough passphrase';
    byId('pass2').value = 'a long enough passphrase';
    byId('go').click();
    await settle(() => page.find('done') !== null);
    // Pairing starts before the person confirms the words.
    await settle(() => page.calls.includes('/v1/pair/complete'));

    // Confirm the two words the page asks for.
    const asked = page.view
      .all()
      .filter((n) => n.tag === 'label')
      .map((l) => Number(/Word (\d+)/.exec(l.text())?.[1]));
    const word = (i: number): string => WORDS[(asked[i] ?? 0) - 1] ?? '';
    byId('w1').value = word(0);
    byId('w2').value = word(1);
    byId('done').click();
    await settle(() => page.view.text().includes('Your Dina is ready'));

    expect(page.view.text()).toContain('could not become its owner key');
    button(page.view, 'Back to ChatGPT').click();
    expect(page.location.assign).toHaveBeenLastCalledWith(BACK);
    // The gate's own page, which offers the passphrase connection (and sends
    // a paired browser on to /owner).
    button(page.view, 'Open my Dina page').click();
    expect(page.location.assign).toHaveBeenLastCalledWith('/');
  });
});
