/**
 * Approval inbox — shared hook + actionable cards, rendered INLINE in the
 * Activity tab.
 *
 * The standalone Approvals screen merged into Activity
 * (`app/notifications.tsx`): the "Needs action" filter renders the
 * ACTIONABLE pending-approval cards (Deny / Approve Once / Approve right
 * there), and "All" shows the read-only resolved cards alongside
 * notifications. This suite pins the behaviours that moved out of the old
 * standalone screen + its live-refresh test:
 *
 *   1. Needs-action renders the actionable cards (correct testIDs).
 *   2. Approve / Approve-Once fire the right hook calls (scope semantics).
 *   3. Deny fires the deny hook (through the confirm dialog).
 *   4. Live-refresh: an `appended` approval event re-fetches; a
 *      non-approval append does NOT; back-to-back events coalesce.
 *   5. Resolved cards render under the "All" filter.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

import {
  appendNotification,
  resetNotifications,
} from '../../../../packages/brain/src/notifications/inbox';
import NotificationsScreen from '../../app/notifications';
import { supportsAllow24h } from '../../src/components/approval_inbox';
import {
  resetInboxCoreClient,
  setInboxCoreClient,
  type InboxCoreClient,
  type InboxEntry,
} from '../../src/hooks/useServiceInbox';

import type { WorkflowTask } from '@dina/core';

// Activity uses `useRouter` (notification-row taps) + `useLocalSearchParams`
// (the `?filter=` deep-link tab); stub both so rendering doesn't crash.
const pushed: string[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (path: string): void => void pushed.push(path) }),
  useLocalSearchParams: () => ({}),
}));

// `storage/init` touches native side effects (op-sqlite); stub to no-ops so
// the staging-approve branch doesn't try to open a real DB.
jest.mock('../../src/storage/init', () => ({
  openPersonaDB: jest.fn(),
  isPersistenceReady: (): boolean => true,
}));

// (pending + seven resolved-history states, incl. PLG-31 #14 outcome_unknown)
// × two kinds (approval tasks, and delegation tasks that may carry a plugin
// invocation — §15.5) = 16 listWorkflowTasks calls per load.
const CALLS_PER_LOAD = 16;

function pendingTask(
  id: string,
  createdAt: number,
  overrides: Partial<{ payloadType: string; riskLevel: string }> = {},
): WorkflowTask {
  const { payloadType = 'intent_validation', riskLevel = 'MODERATE' } = overrides;
  return {
    id,
    kind: 'approval',
    status: 'pending_approval',
    priority: 'normal',
    description: `intent ${id}`,
    payload: JSON.stringify({
      type: payloadType,
      action: 'send_email',
      target: 'HR',
      agent_did: 'did:key:zAgentTest',
      risk_level: riskLevel,
    }),
    result_summary: '',
    policy: '',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function resolvedTask(id: string, updatedAt: number): WorkflowTask {
  return {
    id,
    kind: 'approval',
    status: 'completed',
    priority: 'normal',
    description: `intent ${id}`,
    payload: JSON.stringify({
      type: 'intent_validation',
      action: 'send_email',
      target: 'HR',
      agent_did: 'did:key:zAgentTest',
      risk_level: 'MODERATE',
    }),
    result_summary: '',
    policy: '',
    created_at: updatedAt - 10,
    updated_at: updatedAt,
  };
}

/**
 * Stub Core client. `listWorkflowTasks` returns `pending` for the
 * pending-state query and `resolved` for `state==='completed'` (one of the
 * six resolved-history states); every other resolved state returns [].
 */
function stubClient(opts: { pending?: WorkflowTask[]; resolvedCompleted?: WorkflowTask[] }): {
  client: InboxCoreClient;
  setPending: (next: WorkflowTask[]) => void;
  listCalls: { value: number };
  approve: jest.Mock;
  cancel: jest.Mock;
} {
  let pending = opts.pending ?? [];
  const resolvedCompleted = opts.resolvedCompleted ?? [];
  const listCalls = { value: 0 };
  const approve = jest.fn(async () => pending[0] ?? resolvedCompleted[0]);
  const cancel = jest.fn(async () => pending[0] ?? resolvedCompleted[0]);
  const client: InboxCoreClient = {
    async listWorkflowTasks(query) {
      listCalls.value++;
      // Core filters by kind AND state; a delegation never answers an
      // approval-kind query and vice versa (§15.5 reads both kinds).
      const byKind = (tasks: WorkflowTask[]): WorkflowTask[] => tasks.filter((t) => t.kind === query?.kind);
      if (query?.state === 'pending_approval') return byKind(pending);
      if (query?.state === 'completed') return byKind(resolvedCompleted);
      return [];
    },
    approveWorkflowTask: approve,
    cancelWorkflowTask: cancel,
    getWorkflowTask: jest.fn(async () => null),
    sendServiceRespond: jest.fn(),
  };
  return {
    client,
    setPending: (next) => {
      pending = next;
    },
    listCalls,
    approve,
    cancel,
  };
}

beforeEach(() => {
  pushed.length = 0;
  resetInboxCoreClient();
  resetNotifications();
});

describe('Approval inbox inline in Activity — fail-soft when not ready', () => {
  it('does NOT blanket Activity with an error banner when the inbox client is unavailable', async () => {
    // No inbox client wired (beforeEach reset it) → listPendingApprovals
    // throws InboxNotConfiguredError. Regression: the merged Activity tab
    // used to render a screen-wide "Couldn't load approvals" banner in that
    // case, blocking notifications/reminders. It must now degrade soft.
    appendNotification({
      id: 'n-soft-1',
      kind: 'reminder',
      title: 'Dentist appointment',
      body: 'Tomorrow 9am',
    });

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(screen.getByTestId('filter-unread')).toBeTruthy());

    // No blocking error banner on the default (Unread) view…
    expect(screen.queryByText(/load approvals/i)).toBeNull();
    // …and the notification still renders (Activity isn't broken).
    expect(screen.getByText('Dentist appointment')).toBeTruthy();

    // Even on the Needs action filter it shows the empty state, not a banner.
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    expect(screen.queryByText(/load approvals/i)).toBeNull();
  });
});

describe('Approval inbox inline in Activity — Needs action', () => {
  it('renders the actionable approval cards (Deny / Approve Once / Approve)', async () => {
    const stub = stubClient({ pending: [pendingTask('t-1', 1_000)] });
    setInboxCoreClient(stub.client);

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    expect(screen.getByTestId('approvals-deny-t-1')).toBeTruthy();
    // MODERATE intent supports session scope → the 3-button shape.
    expect(screen.getByTestId('approvals-approve-once-t-1')).toBeTruthy();
    expect(screen.getByTestId('approvals-approve-t-1')).toBeTruthy();
  });

  it('PLG-31 #2: an agent persona-access card offers Deny + Approve only (no session-scope Approve Once)', async () => {
    // agent_persona_access parses to kind='vault_read' WITH an accessMode set —
    // a persona-access grant is not session-scopable, so the "Approve Once"
    // (single vs session) choice must not appear. Contrast the intent card above,
    // whose accessMode is undefined and DOES offer the 3-button shape.
    const agentAccessTask: WorkflowTask = {
      id: 'pa-1',
      kind: 'approval',
      status: 'pending_approval',
      priority: 'normal',
      description: 'Agent requests read access to "health"',
      payload: JSON.stringify({
        type: 'agent_persona_access',
        agent_did: 'did:key:zAgentTest',
        persona: 'health',
        mode: 'read',
        scope: 'a private question',
      }),
      result_summary: '',
      policy: '',
      created_at: 1_000,
      updated_at: 1_000,
    };
    const stub = stubClient({ pending: [agentAccessTask] });
    setInboxCoreClient(stub.client);

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    expect(screen.getByTestId('approvals-deny-pa-1')).toBeTruthy();
    expect(screen.getByTestId('approvals-approve-pa-1')).toBeTruthy();
    // No session-scope choice for a persona-access grant.
    expect(screen.queryByTestId('approvals-approve-once-pa-1')).toBeNull();
  });

  it('Approve grants session scope; Approve Once grants single', async () => {
    const stub = stubClient({ pending: [pendingTask('t-1', 1_000)] });
    setInboxCoreClient(stub.client);

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-approve-t-1'));
    });
    expect(stub.approve).toHaveBeenCalledWith('t-1', { scope: 'session' });

    // Re-add the card (the approve optimistically removed it) and Approve Once.
    stub.setPending([pendingTask('t-2', 2_000)]);
    appendApprovalRefresh();
    await waitFor(() => expect(screen.queryByTestId('approvals-approve-once-t-2')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-approve-once-t-2'));
    });
    expect(stub.approve).toHaveBeenCalledWith('t-2', { scope: 'single' });
  });

  it('Deny routes through the confirm dialog then fires the deny hook', async () => {
    const stub = stubClient({ pending: [pendingTask('t-1', 1_000)] });
    setInboxCoreClient(stub.client);

    // Intercept Alert.alert and immediately invoke the destructive
    // "Deny" button's onPress so the deny actually executes.
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const deny = (buttons ?? []).find((b) => b.text === 'Deny');
      void deny?.onPress?.();
    });

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-deny-t-1'));
    });
    // intent_validation deny → plain cancel (no service.respond peer).
    expect(stub.cancel).toHaveBeenCalledWith('t-1', 'denied_by_operator');
    alertSpy.mockRestore();
  });
});

function disclosureReviewTask(id: string, createdAt: number): WorkflowTask {
  return {
    id,
    kind: 'approval',
    status: 'pending_approval',
    priority: 'normal',
    description: 'Tell Mike about a household dietary need?',
    payload: JSON.stringify({
      type: 'disclosure_review',
      execution_task_id: 'exec-1',
      context: {
        taskId: 'exec-1',
        fromDID: 'did:plc:mike',
        queryId: 'q-1',
        capability: 'availability_coordination',
        ttlSeconds: 120,
        serviceName: "The Millers' Dina",
      },
      disclosures: [{ kind: 'dietary', text: 'someone in the household is gluten-free', about: 'household' }],
    }),
    result_summary: '',
    policy: '',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('Approval inbox inline in Activity — a refused decision is shown on the card', () => {
  it("Core's refusal reason lands on the card instead of vanishing (an Alert is a no-op on the web)", async () => {
    const stub = stubClient({ pending: [disclosureReviewTask('disclosure-review-exec-1', 1_000)] });
    stub.cancel.mockRejectedValueOnce(
      new Error('inbox: 403 {"error":"access_denied","reason":"brain cannot decide a household disclosure; owner decision required"}'),
    );
    setInboxCoreClient(stub.client);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      void (buttons ?? []).find((b) => b.text === 'Deny')?.onPress?.();
    });
    try {
      const screen = render(<NotificationsScreen />);
      await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
      fireEvent.press(screen.getByTestId('filter-needs_action'));
      await act(async () => {
        fireEvent.press(screen.getByTestId('approvals-deny-disclosure-review-exec-1'));
      });
      await waitFor(() => expect(screen.getByTestId('approvals-error-disclosure-review-exec-1')).toBeTruthy());
      expect(screen.getByTestId('approvals-error-disclosure-review-exec-1').props.children).toMatch(/owner decision required/);
      // The card stays: the decision did not land.
      expect(screen.getByTestId('approvals-deny-disclosure-review-exec-1')).toBeTruthy();
      // Only Alert.alert's confirm dialog was raised — never an error alert.
      expect(alertSpy.mock.calls.map((c) => c[0])).not.toContain('Error');
    } finally {
      alertSpy.mockRestore();
    }
  });
});

describe('Approval inbox inline in Activity — a carded plugin invocation (§15.5)', () => {
  function pluginTask(id: string, status: WorkflowTask['status'] = 'pending_approval'): WorkflowTask {
    return {
      id,
      kind: 'delegation',
      status,
      priority: 'normal',
      description: 'plugin invocation com.dinakernel.country.in.eway-bill',
      // Core's card facts — the level and reason the phone renders.
      policy: JSON.stringify({
        type: 'plugin_invocation_card',
        risk_level: 'HIGH',
        reasons: ['High-risk action — requires explicit user approval with explanation'],
        // A regulated write: no grant can ever silence it.
        grant_can_silence: false,
        // §11 — what Dina's own projection attached beyond the params.
        context: { categories: ['address', 'business_registry'], item_count: 4 },
      }),
      payload: JSON.stringify({
        type: 'plugin_invocation',
        install_id: 'pli_in',
        capability_id: 'com.dinakernel.country.in.eway-bill',
        params: { delivery_note_digest: 'd'.repeat(64), consignor_gstin: '27AAPFU0939F1ZV', value: { currency: 'INR', minor_units: '1000000' } },
        context: [],
        manifest_cid: 'bafy',
        approved_scope_hash: 'a'.repeat(64),
        schema_snapshot: null,
        config_revision: 1,
        execution_id: id,
        idempotency_key: id,
        action_class: 'write',
        effects_idempotency: 'supported',
        authorization_kind: 'card',
      }),
      result_summary: '',
      created_at: 1_000,
      updated_at: 1_000,
    };
  }

  it('renders Dina-owned chrome off the pinned envelope: capability, why, effect, the EXACT params — and Deny / Approve only', async () => {
    const stub = stubClient({ pending: [pluginTask('plgx_9')] });
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    expect(screen.getByText('Plugin action approval')).toBeTruthy();
    expect(screen.getByTestId('approvals-plugin-capability-plgx_9')).toHaveTextContent('com.dinakernel.country.in.eway-bill');
    expect(screen.getByTestId('approvals-plugin-why-plgx_9')).toHaveTextContent(/High-risk action/);
    // Nothing the plugin wrote (display names) reaches the card's chrome.
    expect(screen.queryByText(/Country pack — India/)).toBeNull();
    expect(screen.queryByText(/Generate an e-way bill/)).toBeNull();
    expect(screen.getByTestId('approvals-plugin-effect-plgx_9')).toHaveTextContent(/external action may occur/);
    expect(screen.getByTestId('approvals-plugin-effect-plgx_9')).toHaveTextContent(/retry .* is safe/);
    // WYSIWYG: the literal outbound params, unclipped.
    expect(screen.getByTestId('approvals-plugin-params-plgx_9')).toHaveTextContent(/27AAPFU0939F1ZV/);
    expect(screen.getByTestId('approvals-plugin-params-plgx_9')).toHaveTextContent(/1000000/);
    // §11 — the owner is told what Dina attached, in counts and categories.
    // The facts themselves are above in the params, and a second copy here is
    // what would make the card the leak.
    const context = screen.getByTestId('approvals-plugin-context-plgx_9');
    expect(context).toHaveTextContent(/attached 4 details/);
    expect(context).toHaveTextContent(/business registry/);
    expect(context).not.toHaveTextContent(/27AAPFU0939F1ZV/);
    // A plugin effect is approved ONCE on the card; no session-scope shape.
    expect(screen.getByTestId('approvals-deny-plgx_9')).toBeTruthy();
    expect(screen.getByTestId('approvals-approve-plgx_9')).toBeTruthy();
    expect(screen.queryByTestId('approvals-approve-once-plgx_9')).toBeNull();
  });

  it('Approve sends a plain approve (once); Deny cancels the task — the runner never sees it', async () => {
    const stub = stubClient({ pending: [pluginTask('plgx_9')] });
    setInboxCoreClient(stub.client);
    // A plugin effect is a single-confirmation flow: the dialog names the
    // capability; press whichever verb it offers.
    const titles: string[] = [];
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((title, _m, buttons) => {
      titles.push(String(title));
      const go = (buttons ?? []).find((b) => b.text === 'Approve' || b.text === 'Deny');
      void go?.onPress?.();
    });
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-approve-plgx_9'));
    });
    expect(stub.approve).toHaveBeenCalledWith('plgx_9', undefined);
    expect(titles[0]).toBe('Approve "com.dinakernel.country.in.eway-bill"?');

    stub.setPending([pluginTask('plgx_10')]);
    appendApprovalRefresh();
    await waitFor(() => expect(screen.queryByTestId('approvals-deny-plgx_10')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-deny-plgx_10'));
    });
    expect(stub.cancel).toHaveBeenCalledWith('plgx_10', 'denied_by_operator');
    expect(stub.client.sendServiceRespond).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('"Allow 24h" appears only where Core says a grant can silence the capability — never on a regulated one — and asks for a 24 h window grant', async () => {
    const moderateRead: WorkflowTask = {
      ...pluginTask('plgx_read'),
      policy: JSON.stringify({ type: 'plugin_invocation_card', risk_level: 'MODERATE', reasons: ['Moderate-risk action'], grant_can_silence: true }),
      payload: JSON.stringify({
        ...JSON.parse(pluginTask('plgx_read').payload),
        capability_id: 'com.dinakernel.country.in.gstin-validate',
        action_class: 'read',
      }),
    };
    const stub = stubClient({ pending: [moderateRead, pluginTask('plgx_high')] });
    setInboxCoreClient(stub.client);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      void (buttons ?? []).find((b) => b.text === 'Approve')?.onPress?.();
    });
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    // The regulated write cards every time (Core: grant_can_silence false); a window would be a false promise.
    expect(screen.queryByTestId('approvals-allow-24h-plgx_high')).toBeNull();
    expect(screen.getByTestId('approvals-allow-24h-plgx_read')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-allow-24h-plgx_read'));
    });
    expect(stub.approve).toHaveBeenCalledWith('plgx_read', { pluginGrant: { type: 'window', hours: 24 } });
    alertSpy.mockRestore();
  });

  it('a resolved plugin row still names the capability and its action class, and shows the validated answer in Dina’s chrome', async () => {
    const done: WorkflowTask = {
      ...pluginTask('plgx_done', 'completed'),
      result: JSON.stringify({ eway_bill_no: 'EWB-4471', valid_until: '2026-09-20', memo: '<a href="x">click</a>' }),
    };
    const stub = stubClient({ resolvedCompleted: [done] });
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-all'));
    await waitFor(() => expect(screen.getByTestId('approvals-resolved-plugin-capability-plgx_done')).toBeTruthy());
    expect(screen.getByTestId('approvals-resolved-plugin-capability-plgx_done')).toHaveTextContent('com.dinakernel.country.in.eway-bill');
    expect(screen.getByText(/Plugin action approval · write/)).toBeTruthy();
    // §15.6 — the answer's fields as label: value lines; text stays text (no link, no layout).
    const result = screen.getByTestId('approvals-resolved-plugin-result-plgx_done');
    expect(result).toHaveTextContent(/eway_bill_no: EWB-4471/);
    expect(result).toHaveTextContent(/valid_until: 2026-09-20/);
    expect(result).toHaveTextContent(/memo: <a href="x">click<\/a>/);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('§15.6 — with a pinned card TEMPLATE the answer renders through it, in Dina’s chrome and with no exits', async () => {
    const base = pluginTask('plgx_card', 'completed');
    const payload = {
      ...(JSON.parse(base.payload) as Record<string, unknown>),
      card_snapshot: {
        version: 1,
        blocks: [
          { kind: 'title', text: 'E-way bill', icon: 'document' },
          { kind: 'stat', value: '{eway_bill_no}', caption: 'bill number' },
          { kind: 'keyValue', label: 'Valid until', value: '{valid_until}' },
          // Neither survives an untrusted render: trust chrome is Dina's, and
          // a plugin answer has no outbound exit (§11).
          { kind: 'badge', text: 'Verified by the department' },
          { kind: 'link', label: 'Download', url: 'https://example.test/bill', action: 'open_url' },
        ],
      },
    };
    const done: WorkflowTask = {
      ...base,
      payload: JSON.stringify(payload),
      result: JSON.stringify({ eway_bill_no: 'EWB-4471', valid_until: '2026-09-20' }),
    };
    const stub = stubClient({ resolvedCompleted: [done] });
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-all'));
    await waitFor(() => expect(screen.getByTestId('approvals-resolved-plugin-result-plgx_card')).toBeTruthy());

    const result = screen.getByTestId('approvals-resolved-plugin-result-plgx_card');
    // The publisher's labels, the runner's values — and no raw field names,
    // which is the whole difference from the `label: value` floor.
    expect(result).toHaveTextContent(/E-way bill/);
    expect(result).toHaveTextContent(/EWB-4471/);
    expect(result).toHaveTextContent(/Valid until/);
    expect(result).toHaveTextContent(/2026-09-20/);
    expect(result).not.toHaveTextContent(/eway_bill_no:/);
    expect(result).not.toHaveTextContent(/Verified by the department/);
    expect(result).not.toHaveTextContent(/example\.test/);
  });
});

describe('Approval inbox inline in Activity — live refresh (R-M6-I2)', () => {
  it('refetches when an approval-kind notification is appended', async () => {
    const stub = stubClient({ pending: [pendingTask('t-1', 1_000)] });
    setInboxCoreClient(stub.client);
    render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));

    stub.setPending([pendingTask('t-1', 1_000), pendingTask('t-2', 2_000)]);
    await act(async () => {
      appendNotification({
        kind: 'approval',
        title: 'Agent action approval',
        body: 'transfer_money',
        sourceId: 't-2',
      });
    });
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD * 2));
  });

  it('does NOT refetch when a non-approval kind is appended', async () => {
    const stub = stubClient({ pending: [] });
    setInboxCoreClient(stub.client);
    render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));

    await act(async () => {
      appendNotification({ kind: 'reminder', title: 'Take meds', body: '', sourceId: 'rm-1' });
      appendNotification({ kind: 'nudge', title: 'Briefing', body: '', sourceId: 'nd-1' });
    });
    expect(stub.listCalls.value).toBe(CALLS_PER_LOAD);
  });

  it('coalesces overlapping events while a refetch is in flight', async () => {
    let release: (() => void) | null = null;
    const slowFetch = new Promise<void>((r) => {
      release = r;
    });
    let listCalls = 0;
    const client: InboxCoreClient = {
      async listWorkflowTasks() {
        listCalls++;
        if (listCalls <= CALLS_PER_LOAD) return [];
        await slowFetch;
        return [];
      },
      approveWorkflowTask: jest.fn(),
      cancelWorkflowTask: jest.fn(),
      getWorkflowTask: jest.fn(),
      sendServiceRespond: jest.fn(),
    };
    setInboxCoreClient(client);
    render(<NotificationsScreen />);
    await waitFor(() => expect(listCalls).toBe(CALLS_PER_LOAD));

    await act(async () => {
      appendNotification({ kind: 'approval', title: 'a', body: '', sourceId: 's1' });
    });
    await act(async () => {
      appendNotification({ kind: 'approval', title: 'b', body: '', sourceId: 's2' });
      appendNotification({ kind: 'approval', title: 'c', body: '', sourceId: 's3' });
    });
    await act(async () => {
      release?.();
    });
    // initial load + one coalesced refetch (without the ref guard: four loads).
    await waitFor(() => expect(listCalls).toBe(CALLS_PER_LOAD * 2));
  });
});

describe('Approval inbox inline in Activity — All filter shows resolved cards', () => {
  it('renders the read-only resolved card under the All filter', async () => {
    const stub = stubClient({
      pending: [],
      resolvedCompleted: [resolvedTask('done-1', 5_000)],
    });
    setInboxCoreClient(stub.client);

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-all'));

    // Resolved intent card shows the outcome badge + headline. Read-only:
    // no action buttons on a resolved card.
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Agent action approval')).toBeTruthy();
    expect(screen.queryByTestId('approvals-approve-done-1')).toBeNull();
  });
});

/**
 * Fire an approval-kind notification to nudge the inbox live-refresh — used
 * to re-pull the pending list after an optimistic remove in a test.
 */
function appendApprovalRefresh(): void {
  act(() => {
    appendNotification({ kind: 'approval', title: 'refresh', body: '', sourceId: 'refresh' });
  });
}

describe('supportsAllow24h (§15.5 — where Core says a grant can silence)', () => {
  const effect = { actionClass: 'read', retryIdempotent: true, installId: 'pli' };
  const base: InboxEntry = {
    id: 'x',
    kind: 'plugin_invocation',
    capability: 'com.acme.read',
    serviceName: 'Plugin action',
    description: '',
    requesterDID: '',
    paramsPreview: '',
    riskLevel: 'MODERATE',
    grantCanSilence: true,
    effect,
    createdAt: 0,
  };
  it("follows Core's word, not the class or the level: a HIGH write a grant can silence may be allowed; a regulated read may not; other kinds never", () => {
    expect(supportsAllow24h(base)).toBe(true);
    // §8: a HIGH capability cards its first invocations, then a standing approval silences it.
    expect(supportsAllow24h({ ...base, riskLevel: 'HIGH', effect: { ...effect, actionClass: 'write' } })).toBe(true);
    // A regulated/sensitive capability or persona scope: Core says no grant ever silences.
    expect(supportsAllow24h({ ...base, grantCanSilence: false })).toBe(false);
    // No Core card facts at all → the phone offers nothing it cannot back.
    expect(supportsAllow24h({ ...base, grantCanSilence: undefined })).toBe(false);
    expect(supportsAllow24h({ ...base, kind: 'intent_validation' })).toBe(false);
  });
});
