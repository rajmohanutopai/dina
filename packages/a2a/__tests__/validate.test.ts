import {
  isIsoUtcTimestamp,
  parseSendMessageResult,
  validateAgentCardShape,
  validateMessage,
  validatePart,
  validateTask,
} from '../src';

const message = (over: Record<string, unknown> = {}) => ({
  messageId: 'm1',
  role: 'ROLE_AGENT',
  parts: [{ text: 'hi' }],
  ...over,
});

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  status: { state: 'TASK_STATE_COMPLETED' },
  ...over,
});

describe('Part (oneof text | raw | url | data)', () => {
  it.each([
    [{ text: 'a' }],
    [{ raw: 'AQID' }],
    [{ url: 'https://x' }],
    [{ data: { a: 1 } }],
    [{ data: [1] }],
  ])('accepts %p', (part) => expect(validatePart(part)).toBeNull());

  it.each([
    [{}, 'part_content_not_exactly_one'],
    [{ text: 'a', data: {} }, 'part_content_not_exactly_one'],
    [{ text: 1 }, 'part_text_not_string'],
    [{ text: 'a', metadata: [] }, 'part_metadata_not_object'],
    [{ text: 'a', mediaType: 1 }, 'part_media_type_not_string'],
  ])('refuses %p', (part, reason) => expect(validatePart(part)).toBe(reason));
});

describe('Message', () => {
  it('accepts a minimal message', () => expect(validateMessage(message())).toBeNull());

  it.each([
    [{ messageId: '' }, 'message_id_invalid'],
    [{ messageId: 'x'.repeat(257) }, 'message_id_invalid'],
    [{ role: 'ROLE_UNSPECIFIED' }, 'message_role_invalid'],
    [{ role: 'agent' }, 'message_role_invalid'],
    [{ parts: [] }, 'parts_required'],
    [{ taskId: '' }, 'message_task_id_invalid'],
    [{ extensions: [1] }, 'message_extensions_invalid'],
  ])('refuses %p', (over, reason) => expect(validateMessage(message(over))).toBe(reason));

  it('ignores unknown members (spec §5.7)', () => {
    expect(validateMessage(message({ futureField: { x: 1 } }))).toBeNull();
  });
});

describe('Task', () => {
  it('accepts a completed task with artifacts and history', () => {
    expect(
      validateTask(
        task({
          contextId: 'c',
          artifacts: [{ artifactId: 'a', parts: [{ text: 'x' }] }],
          history: [message()],
          status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-02T10:00:00.123Z' },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [{ id: '' }, 'task_id_invalid'],
    [{ status: { state: 'COMPLETED' } }, 'status_state_invalid'],
    [
      { status: { state: 'TASK_STATE_WORKING', timestamp: '2026-10-02 10:00' } },
      'status_timestamp_invalid',
    ],
    [{ artifacts: [{ artifactId: 'a', parts: [] }] }, 'artifact_parts_required'],
    [{ history: [{ messageId: 'm' }] }, 'history_message_role_invalid'],
  ])('refuses %p', (over, reason) => expect(validateTask(task(over))).toBe(reason));
});

describe('timestamps (spec §5.6.1)', () => {
  it.each([
    ['2026-10-02T10:00:00Z', true],
    ['2026-10-02T10:00:00.1Z', true],
    ['2025-04-17T17:47:09.680794Z', true],
    ['2026-10-02T10:00:00+00:00', false],
    ['2026-02-30T00:00:00Z', false],
    ['2026-13-01T00:00:00Z', false],
    ['not a time', false],
  ])('%s → %p', (value, ok) => expect(isIsoUtcTimestamp(value)).toBe(ok));
});

describe('SendMessageResponse (oneof task | message)', () => {
  it('reads a task', () => {
    expect(parseSendMessageResult({ task: task() })).toEqual({ kind: 'task', task: task() });
  });

  it('reads a bare message answer (design §6.4)', () => {
    expect(parseSendMessageResult({ message: message() })).toEqual({
      kind: 'message',
      message: message(),
    });
  });

  it.each([
    [{}, 'response_payload_not_exactly_one'],
    [{ task: task(), message: message() }, 'response_payload_not_exactly_one'],
    [{ task: { id: 't' } }, 'status_not_object'],
  ])('refuses %p', (value, error) => expect(parseSendMessageResult(value)).toEqual({ error }));
});

export const validCard = () => ({
  name: 'Agent',
  description: 'Does things',
  supportedInterfaces: [
    { url: 'https://a.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  version: '1',
  capabilities: { streaming: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 's1', name: 'S', description: 'd', tags: ['t'] }],
});

describe('Agent Card shape', () => {
  it('accepts a minimal valid card', () => expect(validateAgentCardShape(validCard())).toBeNull());

  it.each([
    ['no name', { name: undefined }, 'card_name_required'],
    ['no interfaces', { supportedInterfaces: [] }, 'card_supported_interfaces_required'],
    [
      'an interface without a version',
      { supportedInterfaces: [{ url: 'u', protocolBinding: 'JSONRPC' }] },
      'card_interface_version_required',
    ],
    ['no capabilities', { capabilities: undefined }, 'card_capabilities_required'],
    [
      'a non-boolean flag',
      { capabilities: { streaming: 'yes' } },
      'card_capabilities_streaming_invalid',
    ],
    ['no skills', { skills: [] }, 'card_skills_required'],
    [
      'a skill with no tags',
      { skills: [{ id: 's', name: 'n', description: 'd', tags: [] }] },
      'card_skill_tags_required',
    ],
    [
      'non-string examples',
      { skills: [{ id: 's', name: 'n', description: 'd', tags: ['t'], examples: [{}] }] },
      'card_skill_examples_invalid',
    ],
    ['no input modes', { defaultInputModes: [] }, 'card_default_input_modes_required'],
    ['a malformed signature', { signatures: [{ protected: 'x' }] }, 'card_signature_invalid'],
  ])('refuses %s', (_name, over, reason) => {
    const card = Object.fromEntries(
      Object.entries({ ...validCard(), ...over }).filter(([, v]) => v !== undefined),
    );
    expect(validateAgentCardShape(card)).toBe(reason);
  });
});
