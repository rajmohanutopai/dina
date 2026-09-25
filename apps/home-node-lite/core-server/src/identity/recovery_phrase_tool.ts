#!/usr/bin/env node
/**
 * Print a security-mode node's recovery phrase, offline (JIFFY review item 11).
 *
 * A first boot with `DINA_UNLOCK_PASSPHRASE` writes the seed only wrapped and
 * no phrase file. The operator runs this once, on the node, to see the words
 * and record them offline:
 *
 *   DINA_UNLOCK_PASSPHRASE=… npx tsx src/identity/recovery_phrase_tool.ts <vault_dir>
 *
 * The phrase goes to stdout for the operator's terminal and nowhere else: no
 * logger, no file. A wrong passphrase fails without printing anything.
 */

import { recoveryPhraseFromWrapped } from './master_seed';

async function main(): Promise<void> {
  const vaultDir = process.argv[2] ?? process.env.DINA_VAULT_DIR ?? '';
  const passphrase = process.env.DINA_UNLOCK_PASSPHRASE ?? '';
  if (vaultDir === '' || passphrase === '') {
    process.stderr.write('usage: DINA_UNLOCK_PASSPHRASE=… recovery_phrase_tool.ts <vault_dir>\n');
    process.exit(2);
  }
  try {
    process.stdout.write(`${await recoveryPhraseFromWrapped(vaultDir, passphrase)}\n`);
  } catch {
    process.stderr.write('could not unwrap the seed: wrong passphrase or no wrapped seed\n');
    process.exit(1);
  }
}

void main();
