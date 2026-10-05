/**
 * The mock merchant as the official UCP conformance suite tests it (UCP plan
 * §3.19 step 2, U2.8). Run:
 *
 *   npx tsx packages/test-harness/src/ucp_merchant/conformance_server.ts <conformance repo>
 *
 * It serves REST (and MCP) over TLS with the test certificate, seeded from the
 * suite's own `test_data/flower_shop/products.csv` (one variant per product,
 * under the product's id, as the suite names items), with `gardenias` out of
 * stock, and prints the server URL. The suite runs against it with
 * `SSL_CERT_FILE` pointing at the test certificate.
 *
 * The mock is a buyer's test double: it never completes a checkout, holds no
 * payment, discounts, orders or webhooks, so only the suite's tests of
 * discovery, idempotency, and the checkout lifecycle up to cancel apply.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { mockProduct } from './catalog';
import { startMockMerchant } from './server';

const FIXTURES = path.join(__dirname, '../../../net-socket-node/__tests__/fixtures');

async function main(): Promise<void> {
  const repo = process.argv[2];
  if (repo === undefined) throw new Error('usage: conformance_server.ts <conformance repo>');
  const csv = readFileSync(path.join(repo, 'test_data/flower_shop/products.csv'), 'utf8');
  const products = csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .map(([id, title, price]) =>
      mockProduct({
        id: id as string,
        title: title as string,
        description: title as string,
        currency: 'USD',
        variants: [{ id: id as string, title: title as string, price: Number(price) }],
      }),
    );
  const merchant = await startMockMerchant({
    host: 'localhost',
    cert: readFileSync(path.join(FIXTURES, 'localhost.cert.pem'), 'utf8'),
    key: readFileSync(path.join(FIXTURES, 'localhost.key.pem'), 'utf8'),
    products: () => products,
    transports: ['rest', 'mcp'],
    carts: true,
    checkouts: true,
    acceptHttpProfile: true,
    shipping: true,
    emptyPayment: true,
    outOfStock: (id) => id === 'gardenias',
  });
  process.stdout.write(`${merchant.origin}\n`);
}

void main();
