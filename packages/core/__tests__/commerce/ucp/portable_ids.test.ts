/**
 * Every UCP id comes from `ids.ts` (`newUcpId`): the phone's Hermes runtime
 * has no `crypto.randomUUID`, and a call to it fails only on the phone, which
 * Node tests never show (dual review R1-3: checkout dispatch keys).
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const DIR = path.join(__dirname, '../../../src/commerce/ucp');

it('no UCP source calls crypto.randomUUID outside ids.ts', () => {
  const offenders = readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && f !== 'ids.ts')
    .filter((f) =>
      /\bcrypto\.randomUUID\b/.test(
        readFileSync(path.join(DIR, f), 'utf8').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''),
      ),
    );
  expect(offenders).toEqual([]);
});
