#!/usr/bin/env node

import fs from 'node:fs';
import readline from 'node:readline';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: log_hygiene_mnemonic_scan.mjs <logfile>');
  process.exit(2);
}

const words = new Set(wordlist);
const validLengths = [24, 21, 18, 15, 12];
const input = fs.createReadStream(file, { encoding: 'utf8' });
input.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 2;
});

const lines = readline.createInterface({ input, crlfDelay: Infinity });
let lineNumber = 0;

for await (const line of lines) {
  lineNumber += 1;
  const tokens = line.toLowerCase().match(/[a-z]+/g) ?? [];
  let run = [];
  let found = false;

  for (const token of tokens) {
    if (!words.has(token)) {
      run = [];
      continue;
    }

    run.push(token);
    if (run.length > 24) run.shift();
    for (const length of validLengths) {
      if (run.length >= length && validateMnemonic(run.slice(-length).join(' '), wordlist)) {
        console.log(lineNumber);
        found = true;
        break;
      }
    }
    if (found) break;
  }
}
