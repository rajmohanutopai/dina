/**
 * BRAIN-P2-W05 tests — `/service_deny <taskId> [reason]` command parsing.
 */

import { parseCommand, getAvailableCommands } from '../../src/chat/command_parser';

describe('/service_deny command parsing', () => {
  it('parses /service_deny with just a taskId (no reason)', () => {
    const cmd = parseCommand('/service_deny approval-u1');
    expect(cmd.intent).toBe('service_deny');
    expect(cmd.taskId).toBe('approval-u1');
    expect(cmd.payload).toBe('');
    expect(cmd.explicit).toBe(true);
    expect(cmd.originalText).toBe('/service_deny approval-u1');
  });

  it('parses /service_deny with a multi-word reason', () => {
    const cmd = parseCommand('/service_deny approval-u1 stale data from yesterday');
    expect(cmd.intent).toBe('service_deny');
    expect(cmd.taskId).toBe('approval-u1');
    expect(cmd.payload).toBe('stale data from yesterday');
  });

  it('preserves internal whitespace in the reason', () => {
    const cmd = parseCommand('/service_deny approval-u1    spaced   out   text  ');
    expect(cmd.intent).toBe('service_deny');
    expect(cmd.taskId).toBe('approval-u1');
    expect(cmd.payload).toBe('spaced   out   text');
  });

  it('is case-insensitive for the /service_deny verb', () => {
    const cmd = parseCommand('/SERVICE_DENY approval-u1 nope');
    expect(cmd.intent).toBe('service_deny');
    expect(cmd.taskId).toBe('approval-u1');
    expect(cmd.payload).toBe('nope');
  });

  it('bare /service_deny with no taskId → chat fallback', () => {
    const cmd = parseCommand('/service_deny');
    expect(cmd.intent).toBe('chat');
    expect(cmd.taskId).toBeUndefined();
  });

  it('/service_deny with only whitespace → chat fallback', () => {
    const cmd = parseCommand('/service_deny    ');
    expect(cmd.intent).toBe('chat');
  });

  it('rejects task ids with shell-injection-shaped characters', () => {
    for (const bad of [
      'approval;rm',
      'approval$(x)',
      'approval/../x',
      'approval@x',
      'approval#x',
    ]) {
      const cmd = parseCommand(`/service_deny ${bad} reason`);
      expect(cmd.intent).toBe('chat');
    }
  });

  it('reason is trimmed of surrounding whitespace', () => {
    const cmd = parseCommand('/service_deny approval-u1    reason here   ');
    expect(cmd.payload).toBe('reason here');
  });

  it('getAvailableCommands advertises /service_deny', () => {
    const cmds = getAvailableCommands();
    const deny = cmds.find((c) => c.command.startsWith('/service_deny'));
    expect(deny).toBeDefined();
    expect(deny?.description).toMatch(/deny/i);
  });

  it('does not regress /service_approve parsing (adjacent command)', () => {
    const cmd = parseCommand('/service_approve approval-u1');
    expect(cmd.intent).toBe('service_approve');
    expect(cmd.payload).toBe('');
  });
});
