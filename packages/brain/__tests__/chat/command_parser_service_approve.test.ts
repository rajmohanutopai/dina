/**
 * BRAIN-P2-W01 tests — `/service_approve <taskId>` command parsing.
 */

import { parseCommand, getAvailableCommands } from '../../src/chat/command_parser';

describe('/service_approve command parsing', () => {
  it('parses /service_approve with a canonical task id', () => {
    const cmd = parseCommand('/service_approve approval-abc123');
    expect(cmd.intent).toBe('service_approve');
    expect(cmd.taskId).toBe('approval-abc123');
    expect(cmd.payload).toBe('');
    expect(cmd.explicit).toBe(true);
    expect(cmd.originalText).toBe('/service_approve approval-abc123');
  });

  it('is case-insensitive for the /service_approve verb', () => {
    const cmd = parseCommand('/SERVICE_APPROVE approval-u1');
    expect(cmd.intent).toBe('service_approve');
    expect(cmd.taskId).toBe('approval-u1');
  });

  it('drops trailing text after the taskId (operator notes)', () => {
    const cmd = parseCommand('/service_approve approval-u1 looks fine to me');
    expect(cmd.intent).toBe('service_approve');
    expect(cmd.taskId).toBe('approval-u1');
    // Trailing text is intentionally discarded — operator chatter, not args.
    expect(cmd.payload).toBe('');
  });

  it('accepts dotted + hyphenated ids (matches ServiceHandler conventions)', () => {
    for (const id of ['approval-a.b.c', 'svc-exec-from-approval-u1', 'sq-test-1', '42task']) {
      const cmd = parseCommand(`/service_approve ${id}`);
      expect(cmd.intent).toBe('service_approve');
      expect(cmd.taskId).toBe(id);
    }
  });

  it('bare /service_approve with no taskId → chat fallback', () => {
    const cmd = parseCommand('/service_approve');
    expect(cmd.intent).toBe('chat');
    expect(cmd.taskId).toBeUndefined();
  });

  it('/service_approve with only whitespace → chat fallback', () => {
    const cmd = parseCommand('/service_approve    ');
    expect(cmd.intent).toBe('chat');
  });

  it('rejects task ids with shell-injection-shaped characters', () => {
    for (const bad of [
      'approval;rm',
      'approval$(x)',
      'approval/../x',
      'approval\\x',
      'approval@x',
      'approval#x',
      'approval x', // (legal but space splits — the token `approval` stays valid)
    ]) {
      const cmd = parseCommand(`/service_approve ${bad}`);
      // `approval x` — first token `approval` IS valid; the bad char cases
      // all produce `chat`. We assert either (a) the invalid char cases fall
      // back to chat, or (b) the space case produces intent service_approve
      // with taskId=`approval`.
      if (bad === 'approval x') {
        expect(cmd.intent).toBe('service_approve');
        expect(cmd.taskId).toBe('approval');
      } else {
        expect(cmd.intent).toBe('chat');
      }
    }
  });

  it('getAvailableCommands advertises /service_approve', () => {
    const cmds = getAvailableCommands();
    const approve = cmds.find((c) => c.command.startsWith('/service_approve'));
    expect(approve).toBeDefined();
    expect(approve?.description).toMatch(/approv/i);
  });

  it('does not regress /service parsing (adjacent command)', () => {
    const cmd = parseCommand('/service eta_query hi');
    expect(cmd.intent).toBe('service');
    expect(cmd.capability).toBe('eta_query');
    // Service command doesn't carry a taskId.
    expect(cmd.taskId).toBeUndefined();
  });
});
