/**
 * `/ask` → installed plugins (PLUGIN_ARCHITECTURE §6): the two tools the
 * agentic loop gets. Pinned against a fake Core client: the listing is passed
 * through untouched (snake_case, as the model reads it); `invoke_plugin` is
 * TERMINAL, sends only install/capability/params/categories, relays Core's two
 * successful answers (card, dispatched) in the owner's words and THROWS a
 * refusal (so the loop continues), logs metadata only, and refuses malformed
 * args before Core is asked.
 */

import { createInvokePluginTool, createListPluginCapabilitiesTool } from '../../src/reasoning/plugin_tools';

import type { PluginToolCoreClient } from '../../src/reasoning/plugin_tools';
import type { InvokePluginToolResult, PluginToolCapability } from '@dina/core';

const CAP: PluginToolCapability = {
  install_id: 'pli_in',
  plugin_id: 'com.dinakernel.country.in',
  plugin_display_name: 'Country pack — India',
  capability_id: 'com.dinakernel.country.in.upi-payment-status',
  display_name: 'Check whether a UPI payment settled',
  action_class: 'read',
  privacy_class: 'regulated',
  params_schema: { type: 'object', required: ['utr'], properties: { utr: { type: 'string' } } },
  data_scope_categories: ['payment'],
};

function fakeCore(result: InvokePluginToolResult, caps: PluginToolCapability[] = [CAP]) {
  const invoke = jest.fn(async () => result);
  const list = jest.fn(async () => caps);
  const core: PluginToolCoreClient = { listPluginToolCapabilities: list, invokePluginTool: invoke };
  return { core, invoke, list };
}

describe('list_plugin_capabilities', () => {
  it('hands the model exactly what Core lists, and logs only the count', async () => {
    const { core, list } = fakeCore({ ok: false, code: 'x', message: 'x' });
    const events: Record<string, unknown>[] = [];
    const tool = createListPluginCapabilitiesTool({ core, logger: (e) => events.push(e) });
    expect(tool.name).toBe('list_plugin_capabilities');
    expect(tool.terminal).toBeUndefined();
    await expect(tool.execute({})).resolves.toEqual({ capabilities: [CAP] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ event: 'plugin_capabilities_listed', count: 1 }]);
  });

  it('an empty install set is an empty list, not an error', async () => {
    const { core } = fakeCore({ ok: false, code: 'x', message: 'x' }, []);
    await expect(createListPluginCapabilitiesTool({ core }).execute({})).resolves.toEqual({ capabilities: [] });
  });
});

describe('invoke_plugin', () => {
  const ARGS = {
    install_id: 'pli_in',
    capability_id: CAP.capability_id,
    params: { utr: '314159265358' },
    param_categories: ['payment'],
  };

  it('is terminal and sends ONLY install, capability, params and categories — no dispatch metadata', async () => {
    const { core, invoke } = fakeCore({
      ok: true,
      mode: 'approval_required',
      taskId: 'plgx_1',
      executionId: 'plgx_1',
      card: { riskLevel: 'HIGH', reasons: ['High-risk action'], paramsText: '{"utr":"314159265358"}' },
    });
    const tool = createInvokePluginTool({ core });
    expect(tool.terminal).toBe(true);
    const out = (await tool.execute({ ...ARGS, resource: 'sneaky', value: 9, idempotency_key: 'k' })) as {
      status: string;
      task_id: string;
      note: string;
    };
    expect(invoke).toHaveBeenCalledWith({
      installId: 'pli_in',
      capabilityId: CAP.capability_id,
      params: { utr: '314159265358' },
      paramCategories: ['payment'],
    });
    expect(out.status).toBe('approval_required');
    expect(out.task_id).toBe('plgx_1');
    // The owner is pointed at the card, in plain words, with Core's level.
    expect(out.note).toMatch(/Activity → Needs action/);
    expect(out.note).toMatch(/high risk/);
    expect(out.note).toMatch(/Nothing runs until you approve/);
  });

  it('a grant-silenced dispatch says so and names the task', async () => {
    const { core } = fakeCore({ ok: true, mode: 'dispatched', taskId: 'plgx_2', executionId: 'plgx_2', grantId: 'g1' });
    const out = (await createInvokePluginTool({ core }).execute(ARGS)) as { status: string; task_id: string; note: string };
    expect(out).toMatchObject({ status: 'dispatched', task_id: 'plgx_2' });
    expect(out.note).toMatch(/standing approval/);
  });

  it("Core's refusal is thrown with its typed code — a terminal tool's VALUE would end the turn with nothing said", async () => {
    const { core } = fakeCore({ ok: false, code: 'params_invalid', message: 'params violate the consented params_schema' });
    await expect(createInvokePluginTool({ core }).execute(ARGS)).rejects.toThrow(
      /invoke_plugin refused \(params_invalid\): params violate/,
    );
  });

  it('an ACCEPTED ask whose reply could not be read ends the turn pointing at Activity — it is never re-asked as a refusal', async () => {
    const { core } = fakeCore({
      ok: false,
      code: 'response_malformed',
      message: 'Core accepted the ask (HTTP 202) but its reply could not be read.',
    });
    const out = (await createInvokePluginTool({ core }).execute(ARGS)) as { status: string; task_id: string; note: string };
    expect(out.status).toBe('approval_required');
    expect(out.task_id).toBe('');
    expect(out.note).toMatch(/could not be read/);
    expect(out.note).toMatch(/before asking again/);
  });

  it('refuses malformed args before Core is asked, and never logs the params', async () => {
    const { core, invoke } = fakeCore({ ok: true, mode: 'dispatched', taskId: 't', executionId: 't' });
    const events: Record<string, unknown>[] = [];
    const tool = createInvokePluginTool({ core, logger: (e) => events.push(e) });
    await expect(tool.execute({ ...ARGS, install_id: '' })).rejects.toThrow(/install_id and capability_id/);
    await expect(tool.execute({ ...ARGS, params: 'not an object' })).rejects.toThrow(/params must be an object/);
    await expect(tool.execute({ ...ARGS, params: [1, 2] })).rejects.toThrow(/params must be an object/);
    // The classification the caller sent is the one Core judges (§11.5): a
    // mistyped list is refused, never quietly narrowed to "unclassified".
    await expect(tool.execute({ ...ARGS, param_categories: 'payment' })).rejects.toThrow(/param_categories must be an array of strings/);
    await expect(tool.execute({ ...ARGS, param_categories: ['payment', 42] })).rejects.toThrow(/param_categories must be an array of strings/);
    expect(invoke).not.toHaveBeenCalled();
    // An explicitly EMPTY classification is allowed through — Core cards unclassified params.
    await tool.execute({ ...ARGS, param_categories: [] });
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ paramCategories: [] }));
    expect(JSON.stringify(events)).not.toContain('314159265358');
    expect(events.at(-1)).toEqual({ event: 'plugin_invoked', capability_id: CAP.capability_id, outcome: 'dispatched' });
    // A refusal is logged by its code before it is thrown.
    const refusing = fakeCore({ ok: false, code: 'blocked', message: 'payment class' });
    const refusedEvents: Record<string, unknown>[] = [];
    await expect(createInvokePluginTool({ core: refusing.core, logger: (e) => refusedEvents.push(e) }).execute(ARGS)).rejects.toThrow();
    expect(refusedEvents.at(-1)).toEqual({ event: 'plugin_invoked', capability_id: CAP.capability_id, outcome: 'refused:blocked' });
  });
});
