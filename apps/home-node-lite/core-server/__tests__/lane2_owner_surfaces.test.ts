/**
 * An outside agent's call under review, on the owner's surfaces (notes M2:
 * "Core writes the owner's card words once ... The server console and the
 * phone show those words as they are; a phone decision binds to
 * post_hash"). The console draws the card from its payload as text only; a
 * phone answer for a mirror bound to another hash decides nothing.
 */

import Fastify from 'fastify';

import {
  InMemoryWorkflowRepository,
  WorkflowService,
  createCoreRouter,
  getWorkflowService,
  inboundReviewDisplay,
  remoteApprovalProposalId,
  setWorkflowService,
  type CoreRequest,
} from '@dina/core';
import { resetKVStore } from '@dina/core/kv';

import { runPhoneApprovalSyncTick, type PhoneApprovalClient } from '../src/approval/phone_approval_sync';
import { registerOwnerConsoleRoute } from '../src/server/owner_console';

const NOW = Date.now();
const HOSTILE = '<img src=x onerror=alert(1)>';

function reviewPayload(postHash: string) {
  const fields = {
    client_name: `Acme ${HOSTILE}`,
    skill: 'appointment_book@clinic',
    action_class: 'booking' as const,
    params: { slot: '9am', note: `<script>alert(1)</script>‮evil` },
    service_name: 'Dr. Lee',
  };
  return {
    type: 'a2a_inbound_review',
    operation_id: 'op-1',
    client_id: 'ac_1',
    ...fields,
    post_hash: postHash,
    display: inboundReviewDisplay({ ...fields, proof: { kind: 'bearer' } }),
  };
}

describe('the server console draws an inbound review card from its payload', () => {
  // Extra X-6 (the console)
  it('shows Core’s words as text, with the client’s hostile name and params inert', async () => {
    const app = Fastify({ logger: false });
    registerOwnerConsoleRoute(app as never, { enabled: true });
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/owner' })).body;
    await app.close();
    const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
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
    interface FakeNode {
      tag: string;
      className: string;
      textContent: string;
      children: FakeNode[];
      attrs: Record<string, string>;
      listeners: string[];
    }
    const document = {
      createElement: (tag: string) => {
        const node = {
          tag,
          className: '',
          textContent: '',
          children: [] as FakeNode[],
          attrs: {} as Record<string, string>,
          listeners: [] as string[],
          appendChild(c: FakeNode) {
            node.children.push(c);
          },
          setAttribute(k: string, v: string) {
            node.attrs[k] = v;
          },
          addEventListener(kind: string) {
            node.listeners.push(kind);
          },
        };
        return node;
      },
    };
    const approvalCard = new Function(
      'document',
      `${source('el')}\n${source('btn')}\n${source('payloadOf')}\n${source('approvalCard')}\nreturn approvalCard;`,
    )(document) as (task: { id: string; payload: string; description: string }) => FakeNode;
    const payload = reviewPayload('d'.repeat(64));
    const card = approvalCard({ id: 'a2a-in-review-op-1', payload: JSON.stringify(payload), description: 'A2A call' });
    const [title, detail, row] = card.children;
    // The words are Core's, exactly as Core wrote them.
    expect(title?.textContent).toBe(payload.display.title);
    expect(detail?.tag).toBe('pre');
    expect(detail?.textContent).toBe(payload.display.detail);
    // Core spelled the invisible character out; the console shows it so.
    expect(detail?.textContent).toContain('\\u202e');
    expect(detail?.textContent).not.toContain('‮');
    // Text only: no node carries markup or an attribute a remote chose.
    for (const node of [title, detail]) {
      expect(node?.attrs).toEqual({});
      expect(node?.children).toEqual([]);
    }
    expect(row?.children.map((b) => [b.tag, b.textContent, b.listeners])).toEqual([
      ['button', 'Allow', ['click']],
      ['button', 'Refuse', ['click']],
    ]);
  });
});

describe('a phone decision binds to the card’s post_hash', () => {
  const PHONE = 'did:key:z6MkLaneTwoPhone';
  const router = createCoreRouter();

  beforeEach(() => {
    resetKVStore();
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  });
  afterEach(() => {
    setWorkflowService(null);
    resetKVStore();
  });

  /** The paired phone: Core's own remote-approval routes, reached as the phone device. */
  const phone: PhoneApprovalClient = {
    did: PHONE,
    request: async (method, path, body) => {
      const out = await router.handle({
        method,
        path,
        query: {},
        headers: {},
        body,
        rawBody: new Uint8Array(),
        params: {},
        trustedInProcess: true,
        callerType: 'device',
        callerDID: PHONE,
      } as unknown as CoreRequest);
      return { status: out.status, body: out.body };
    },
  };

  function card(id: string, postHash: string): void {
    getWorkflowService()?.create({
      id,
      kind: 'approval',
      description: 'A2A call under review',
      payload: JSON.stringify({ ...reviewPayload(postHash), params: { slot: '9am' }, display: inboundReviewDisplay({ client_name: 'Acme', skill: 'appointment_book@clinic', action_class: 'booking', params: { slot: '9am' }, service_name: 'Dr. Lee', proof: { kind: 'bearer' } }) }),
      expiresAtSec: Math.floor(NOW / 1000) + 600,
      origin: 'system',
      initialState: 'pending_approval',
    });
  }

  /** What the server would propose for its pending cards, captured without reaching the phone. */
  async function proposalBodies(): Promise<Record<string, unknown>[]> {
    const bodies: Record<string, unknown>[] = [];
    await runPhoneApprovalSyncTick({
      client: {
        did: PHONE,
        request: async (_method, _path, body) => {
          bodies.push(body as Record<string, unknown>);
          return { status: 503, body: {} };
        },
      },
      nowMs: NOW,
    });
    return bodies;
  }

  // Extra X-6 (the phone)
  it('a yes on the phone for a mirror bound to another hash is refused, and the card stays pending', async () => {
    card('a2a-in-review-x', 'd'.repeat(64));
    const [wanted] = await proposalBodies();
    expect(wanted?.source_payload_hash).toBe('d'.repeat(64));
    // The phone holds a mirror of this card with every field the same but the hash, and its owner said yes.
    const forged = await phone.request('POST', '/v1/agent/approval-sync/v1/proposals', { ...wanted, source_payload_hash: 'e'.repeat(64) });
    expect(forged.status).toBe(201);
    getWorkflowService()?.approve(remoteApprovalProposalId(PHONE, 'a2a-in-review-x:w1'));
    const tick = await runPhoneApprovalSyncTick({ client: phone, nowMs: NOW });
    expect(tick.approved).toBe(0);
    expect(getWorkflowService()?.store().getById('a2a-in-review-x')?.status).toBe('pending_approval');
  });

  // Extra X-6 (the phone, control)
  it('a yes on the phone for the mirror the server proposed decides the card', async () => {
    card('a2a-in-review-y', 'f'.repeat(64));
    expect((await runPhoneApprovalSyncTick({ client: phone, nowMs: NOW })).pending).toBe(1);
    getWorkflowService()?.approve(remoteApprovalProposalId(PHONE, 'a2a-in-review-y:w1'));
    expect((await runPhoneApprovalSyncTick({ client: phone, nowMs: NOW })).approved).toBe(1);
    expect(getWorkflowService()?.store().getById('a2a-in-review-y')?.status).toBe('queued');
  });
});
