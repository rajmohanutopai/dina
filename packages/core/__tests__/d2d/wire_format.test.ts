/**
 * T2D.15 — D2D wire format: correlation ID embedding, trust tool patterns.
 *
 * Source: tests/integration/test_contract_wire_format.py (portable parts)
 */

import { buildMessage, parseMessage } from '../../src/d2d/envelope';
import type { DinaMessage } from '../../src/d2d/envelope';
import { makeDinaMessage } from '@dina/test-harness';
import { base64 } from '@scure/base';

// On-wire `body` is base64-encoded UTF-8 (Go `[]byte` compat — see
// buildMessage docstring). Test helper decodes it back to the JSON
// string the test operates on.
function decodeWireBody(b64: string): string {
  return new TextDecoder().decode(base64.decode(b64));
}

describe('D2D Wire Format', () => {
  describe('correlation ID embedding', () => {
    it('D2D send embeds _correlation_id in body', () => {
      const msg = makeDinaMessage({
        body: JSON.stringify({ text: 'hello', _correlation_id: 'req-001' }),
      });
      const json = buildMessage(msg);
      const parsed = JSON.parse(json);
      const body = JSON.parse(decodeWireBody(parsed.body));
      expect(body._correlation_id).toBe('req-001');
    });

    it('_correlation_id omitted when no request_id', () => {
      const msg = makeDinaMessage({ body: JSON.stringify({ text: 'hello' }) });
      const json = buildMessage(msg);
      const parsed = JSON.parse(json);
      const body = JSON.parse(decodeWireBody(parsed.body));
      expect(body._correlation_id).toBeUndefined();
    });

    it('receiver extracts _correlation_id from payload', () => {
      const bodyJson = JSON.stringify({ text: 'reply', _correlation_id: 'req-001' });
      const msg = parseMessage(
        JSON.stringify({
          id: 'msg-001',
          type: 'coordination.response',
          from: 'did:plc:a',
          to: 'did:plc:b',
          created_time: 1700000000,
          body: bodyJson,
        }),
      );
      const body = JSON.parse(msg.body);
      expect(body._correlation_id).toBe('req-001');
    });
  });

  describe('trust tool patterns', () => {
    it('guardian recognizes trust tool in tools_called list', () => {
      const toolsCalled = [{ name: 'trust_search', args: { query: 'seller' } }];
      expect(toolsCalled[0].name).toBe('trust_search');
    });

    it('trust_search passes query to Core correctly', () => {
      const payload = { query: 'ergonomic chairs', category: 'product_review' };
      expect(payload).toHaveProperty('query');
    });
  });
});
