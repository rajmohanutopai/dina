/**
 * An agent's `dina ask` reads through Core, which decides every persona and
 * raises the owner's card. The phone hands the ask loop a hand-listed client, so
 * a method missing from that list drops the agent to the deny-all guard: no data
 * leaks, but no card appears and the agent can never read anything. Found on the
 * simulator by MRS-07.
 */

import { lazyCoreClient } from '../../src/services/boot_capabilities';

// What `asAgentReadClient` in @dina/brain's agentic_ask requires.
const AGENT_READ = [
  'agentPersonaAccessCheck',
  'agentPersonaAccessRequest',
  'vaultQuery',
  'vaultGet',
  'vaultList',
  'vaultItemsForPerson',
  'memoryToC',
] as const;

describe('the ask loop’s Core client on the phone', () => {
  it.each(AGENT_READ)('has %s, or agents fall to the deny-all guard', (method) => {
    expect(typeof (lazyCoreClient() as unknown as Record<string, unknown>)[method]).toBe(
      'function',
    );
  });

  it.each(AGENT_READ)('%s fails closed before boot', async (method) => {
    const call = (lazyCoreClient() as unknown as Record<string, () => Promise<unknown>>)[method];
    await expect(call?.()).rejects.toThrow(/not booted/);
  });
});
