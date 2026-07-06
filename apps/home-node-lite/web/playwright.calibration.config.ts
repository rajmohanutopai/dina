/**
 * Judge-calibration config — the gate that runs BEFORE any judged
 * scenario (docs/E2E_TESTING.md §4.1). It proves the Gemini judge
 * classifies the golden set correctly (good/bad answers, Anti-Her, leak,
 * injection). No stack is needed — the calibration only calls Gemini — so
 * there is no webServer here.
 *
 * Run: GEMINI_API_KEY=… npm run -w @dina/home-node-lite-web-e2e test:e2e:calibration
 */

import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: path.resolve(__dirname, '__e2e__'),
  testMatch: '**/judge.calibration.spec.ts',
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
