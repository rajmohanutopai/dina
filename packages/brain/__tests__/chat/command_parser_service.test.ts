/**
 * BRAIN-P1-W01 tests — `/service <capability> <text>` command parsing.
 */

import { parseCommand, getAvailableCommands } from '../../src/chat/command_parser';

describe('/service command parsing', () => {
  it('parses /service with a capability and free text', () => {
    const cmd = parseCommand('/service eta_query when will you reach me?');
    expect(cmd.intent).toBe('service');
    expect(cmd.capability).toBe('eta_query');
    expect(cmd.payload).toBe('when will you reach me?');
    expect(cmd.explicit).toBe(true);
    expect(cmd.originalText).toBe('/service eta_query when will you reach me?');
  });

  it('parses /service with no free text (bare probe)', () => {
    const cmd = parseCommand('/service eta_query');
    expect(cmd.intent).toBe('service');
    expect(cmd.capability).toBe('eta_query');
    expect(cmd.payload).toBe('');
  });

  it('accepts dotted capability names (NSID-style)', () => {
    const cmd = parseCommand('/service transit.bus query text');
    expect(cmd.intent).toBe('service');
    expect(cmd.capability).toBe('transit.bus');
    expect(cmd.payload).toBe('query text');
  });

  it('accepts hyphens and digits in capability', () => {
    const cmd = parseCommand('/service route-42 status');
    expect(cmd.intent).toBe('service');
    expect(cmd.capability).toBe('route-42');
  });

  it('collapses extra whitespace in payload', () => {
    const cmd = parseCommand('/service eta_query    lots   of   spaces   ');
    expect(cmd.payload).toBe('lots   of   spaces');
  });

  it('is case-insensitive for the /service verb', () => {
    const cmd = parseCommand('/SERVICE eta_query hello');
    expect(cmd.intent).toBe('service');
    expect(cmd.capability).toBe('eta_query');
  });

  it('bare /service with no capability → chat fallback', () => {
    const cmd = parseCommand('/service');
    expect(cmd.intent).toBe('chat');
    expect(cmd.capability).toBeUndefined();
  });

  it('/service with only whitespace payload → chat fallback', () => {
    const cmd = parseCommand('/service    ');
    expect(cmd.intent).toBe('chat');
  });

  it('rejects capability names that start with a digit', () => {
    const cmd = parseCommand('/service 42query hello');
    expect(cmd.intent).toBe('chat');
  });

  it('rejects capability names with special characters (injection guard)', () => {
    // NB: whitespace is a token separator, not a character — `eta query` parses
    // as capability `eta` + payload `query text`. These cases exercise chars
    // that make the first token invalid as an identifier.
    for (const bad of [
      'eta$query',
      'eta;query',
      'eta/query',
      'eta@query',
      'eta!query',
      'eta,query',
    ]) {
      const cmd = parseCommand(`/service ${bad} text`);
      expect(cmd.intent).toBe('chat');
    }
  });

  it('getAvailableCommands advertises /service', () => {
    const cmds = getAvailableCommands();
    const svc = cmds.find((c) => c.command.startsWith('/service'));
    expect(svc).toBeDefined();
    expect(svc?.description).toMatch(/public service/i);
  });

  it('preserves previously working /remember behaviour (no regression)', () => {
    const cmd = parseCommand('/remember something');
    expect(cmd.intent).toBe('remember');
    expect(cmd.payload).toBe('something');
  });
});
