/**
 * `service_query_execution` payload codec — the single
 * builder/parser every hop uses (handler → claim → approval hop →
 * runner → Response Bridge). Pins the WIRE SHAPE (the Python
 * dina-agent reads this JSON) and the parse normalization, so a field
 * added to the payload either goes through the codec or fails here.
 */

import {
  SERVICE_QUERY_EXECUTION_TYPE,
  buildServiceQueryExecutionPayload,
  parseServiceQueryExecutionPayload,
  parseServiceExecutionSchemaSnapshot,
} from '../src/types/service_execution';

const SNAPSHOT = {
  params: { type: 'object' },
  result: { type: 'object', required: ['status'] },
  schema_hash: 'ab'.repeat(32),
};

describe('buildServiceQueryExecutionPayload — wire shape', () => {
  it('execution variant: always-present fields, no approval-only extras', () => {
    const wire = buildServiceQueryExecutionPayload({
      from_did: 'did:plc:req',
      query_id: 'q-1',
      capability: 'appointment_availability',
      params: { service: 'haircut' },
      ttl_seconds: 120,
      service_name: "Alonso's Salon",
    });
    expect(wire).toEqual({
      type: 'service_query_execution',
      from_did: 'did:plc:req',
      query_id: 'q-1',
      capability: 'appointment_availability',
      params: { service: 'haircut' },
      ttl_seconds: 120,
      service_name: "Alonso's Salon",
      schema_hash: '',
      mcp_tool: '',
    });
  });

  it('approval variant carries mcp_server + snapshot + uri + operator_approved', () => {
    const wire = buildServiceQueryExecutionPayload({
      from_did: 'did:plc:req',
      query_id: 'q-2',
      capability: 'eta_query',
      params: { route_id: '42' },
      ttl_seconds: 60,
      service_name: 'Bus 42',
      schema_hash: 'h1',
      mcp_tool: 'get_eta',
      mcp_server: 'transit',
      schema_snapshot: SNAPSHOT,
      service_uri: 'at://did:plc:x/com.dinakernel.service.profile/self',
      operator_approved: true,
    });
    expect(wire.mcp_server).toBe('transit');
    expect(wire.schema_snapshot).toEqual(SNAPSHOT);
    expect(wire.service_uri).toBe('at://did:plc:x/com.dinakernel.service.profile/self');
    expect(wire.operator_approved).toBe(true);
  });

  it('empty-string optionals are NOT emitted as conditional fields', () => {
    const wire = buildServiceQueryExecutionPayload({
      from_did: 'd',
      query_id: 'q',
      capability: 'c',
      params: {},
      mcp_server: '',
      service_uri: '',
    });
    expect('mcp_server' in wire).toBe(false);
    expect('service_uri' in wire).toBe(false);
    expect('operator_approved' in wire).toBe(false);
    // ttl defaults like the legacy builder did.
    expect(wire.ttl_seconds).toBe(60);
  });
});

describe('parseServiceQueryExecutionPayload', () => {
  it('round-trips a full build (with ""→undefined normalization)', () => {
    const wire = buildServiceQueryExecutionPayload({
      from_did: 'did:plc:req',
      query_id: 'q-3',
      capability: 'appointment_book',
      params: { time: '4:30 PM' },
      ttl_seconds: 300,
      service_name: "Alonso's Salon",
      schema_snapshot: SNAPSHOT,
      service_uri: 'at://did:plc:x/com.dinakernel.service.profile/alonso-s-salon',
      operator_approved: true,
    });
    const parsed = parseServiceQueryExecutionPayload(JSON.stringify(wire));
    expect(parsed).toEqual({
      type: SERVICE_QUERY_EXECUTION_TYPE,
      from_did: 'did:plc:req',
      query_id: 'q-3',
      capability: 'appointment_book',
      params: { time: '4:30 PM' },
      ttl_seconds: 300,
      service_name: "Alonso's Salon",
      schema_hash: undefined, // wire '' → undefined
      mcp_tool: undefined, // wire '' → undefined
      mcp_server: undefined,
      schema_snapshot: SNAPSHOT,
      service_uri: 'at://did:plc:x/com.dinakernel.service.profile/alonso-s-salon',
      operator_approved: true,
    });
  });

  it('returns null for other payload types (foreign delegations are not ours)', () => {
    expect(
      parseServiceQueryExecutionPayload(
        JSON.stringify({ type: 'free_form_task', description: 'buy milk' }),
      ),
    ).toBeNull();
  });

  it('returns null when identity fields are missing/empty (bridge could never answer)', () => {
    for (const broken of [
      { type: SERVICE_QUERY_EXECUTION_TYPE, query_id: 'q', capability: 'c' },
      { type: SERVICE_QUERY_EXECUTION_TYPE, from_did: '', query_id: 'q', capability: 'c' },
      { type: SERVICE_QUERY_EXECUTION_TYPE, from_did: 'd', query_id: 'q', capability: '' },
    ]) {
      expect(parseServiceQueryExecutionPayload(JSON.stringify(broken))).toBeNull();
    }
  });

  it('tolerates malformed JSON / non-objects', () => {
    expect(parseServiceQueryExecutionPayload('{not json')).toBeNull();
    expect(parseServiceQueryExecutionPayload(null)).toBeNull();
    expect(parseServiceQueryExecutionPayload(42)).toBeNull();
    expect(parseServiceQueryExecutionPayload([1, 2])).toBeNull();
  });

  it('degrades a malformed snapshot to undefined (registry fallback downstream)', () => {
    expect(parseServiceExecutionSchemaSnapshot({ params: {}, result: null, schema_hash: 'x' })).toBeUndefined();
    expect(parseServiceExecutionSchemaSnapshot('nope')).toBeUndefined();
    expect(parseServiceExecutionSchemaSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
  });

  it('operator_approved is true or absent — never a truthy coercion', () => {
    const wire = {
      type: SERVICE_QUERY_EXECUTION_TYPE,
      from_did: 'd',
      query_id: 'q',
      capability: 'c',
      params: {},
      operator_approved: 'yes',
    };
    expect(parseServiceQueryExecutionPayload(wire)?.operator_approved).toBeUndefined();
  });
});
