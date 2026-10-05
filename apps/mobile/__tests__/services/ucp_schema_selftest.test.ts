/**
 * The on-device schema self-test, run under Node: proves every case's
 * expected answer, so a FAIL on the device is the device's difference.
 */
import { runUcpSchemaSelfTest } from '../../src/services/ucp_schema_selftest';

it('every case passes under Node', () => {
  const cases = runUcpSchemaSelfTest();
  expect(cases.length).toBeGreaterThanOrEqual(14);
  expect(cases.filter((c) => !c.pass).map((c) => c.name)).toEqual([]);
});
