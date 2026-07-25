#!/usr/bin/env node
/**
 * Offline Home Node .dina archive utility.
 *
 * This intentionally has no HTTP surface. The installer stops the managed
 * containers, mounts the Core vault plus a private exchange directory, and
 * invokes this entry point inside the pinned Core image. The archive passphrase
 * is read from a mode-0600 file, never argv or environment.
 */

import fs from 'node:fs';

import { createArchive, importArchive, verifyArchive } from '@dina/core';
import { pino } from 'pino';

import { initializeStorage } from './init';

const VAULT_DIR = process.env.DINA_VAULT_DIR ?? '/var/lib/dina';
const MASTER_SEED_FILE = `${VAULT_DIR}/keyfile`;
const REQUEST_MAGIC = Buffer.from('DARC');
const MAX_PASSPHRASE_BYTES = 64 * 1024;

type Operation = 'export' | 'import' | 'verify';

function operationFromArgv(argv: string[]): { operation: Operation; force: boolean } {
  const [operation, ...rest] = argv;
  if (operation !== 'export' && operation !== 'import' && operation !== 'verify') {
    throw new Error('archive_tool: expected export, import, or verify');
  }
  const force = rest.includes('--force');
  if (rest.some((arg) => arg !== '--force')) {
    throw new Error('archive_tool: unsupported argument');
  }
  if (force && operation !== 'import') {
    throw new Error('archive_tool: --force is valid only for import');
  }
  return { operation, force };
}

function readSecretFile(file: string, label: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`archive_tool: ${label} must be a regular file`);
  }
  return fs.readFileSync(file);
}

function readRequest(): { passphrase: string; passphraseBytes: Buffer; archive: Uint8Array } {
  const input = fs.readFileSync(0);
  if (input.length < 8 || !input.subarray(0, 4).equals(REQUEST_MAGIC)) {
    input.fill(0);
    throw new Error('archive_tool: invalid stdin request');
  }
  const passphraseLength = input.readUInt32BE(4);
  if (
    passphraseLength === 0 ||
    passphraseLength > MAX_PASSPHRASE_BYTES ||
    8 + passphraseLength > input.length
  ) {
    input.fill(0);
    throw new Error('archive_tool: invalid passphrase length');
  }
  const passphraseBytes = Buffer.from(input.subarray(8, 8 + passphraseLength));
  let passphrase: string;
  try {
    passphrase = new TextDecoder('utf-8', { fatal: true }).decode(passphraseBytes);
  } catch {
    input.fill(0);
    passphraseBytes.fill(0);
    throw new Error('archive_tool: passphrase is not valid UTF-8');
  }
  const archive = new Uint8Array(input.subarray(8 + passphraseLength));
  input.fill(0);
  if (passphrase.includes('\u0000')) {
    passphraseBytes.fill(0);
    archive.fill(0);
    throw new Error('archive_tool: passphrase must not contain NUL');
  }
  return { passphrase, passphraseBytes, archive };
}

async function run(): Promise<void> {
  const { operation, force } = operationFromArgv(process.argv.slice(2));
  const { passphrase, passphraseBytes, archive } = readRequest();

  if (operation === 'verify') {
    try {
      if (!(await verifyArchive(archive, passphrase))) {
        throw new Error('archive_tool: archive verification failed');
      }
      return;
    } finally {
      archive.fill(0);
      passphraseBytes.fill(0);
    }
  }

  const seed = readSecretFile(MASTER_SEED_FILE, 'master seed');
  if (seed.length !== 32) {
    passphraseBytes.fill(0);
    archive.fill(0);
    const actualLength = seed.length;
    seed.fill(0);
    throw new Error(`archive_tool: master seed must be 32 bytes, got ${actualLength}`);
  }

  const logger = pino({ level: 'silent' });
  let storage: Awaited<ReturnType<typeof initializeStorage>> | undefined;
  try {
    storage = await initializeStorage(new Uint8Array(seed), VAULT_DIR, logger);
    if (operation === 'export') {
      const output = await createArchive(passphrase);
      process.stdout.write(Buffer.from(output));
      return;
    }
    await importArchive(archive, passphrase, { force });
  } finally {
    seed.fill(0);
    passphraseBytes.fill(0);
    archive.fill(0);
    await storage?.provider.closeAll();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

export { operationFromArgv };
