#!/usr/bin/env node
/**
 * Release guard (P2.6) — fail the build if a secret-like `EXPO_PUBLIC_*` env
 * var is set.
 *
 * Expo inlines every `EXPO_PUBLIC_*` value into the production JS bundle, so
 * any secret leaked through that prefix (a PDS password, a test-inject token,
 * a provider API key, a dev/debug flag) ships to every client and is trivially
 * extractable from the app binary. CI/release should run this BEFORE
 * `expo export`/EAS build so a mis-set secret fails fast instead of shipping.
 *
 * Public config (URLs, public DIDs, feature toggles) is fine under
 * `EXPO_PUBLIC_*`; only secret-shaped names are flagged. A genuine secret must
 * be read server-side (a non-`EXPO_PUBLIC_` var) and never bundled.
 *
 * Usage: `node scripts/check-expo-public-env.mjs` (exit 1 on offenders).
 */

const DANGEROUS =
  /(SECRET|TOKEN|PASSWORD|PASSPHRASE|API_?KEY|PRIVATE|MNEMONIC|SEED|PDS_|TEST_INJECT|DINA_DEV|DEV_MODE)/i;

// Known-public names that collide with the broad patterns above. A plain
// endpoint URL is public config — it ships in the bundle by design. Keep
// this list EXACT names only (no patterns), so a future
// EXPO_PUBLIC_DINA_PDS_PASSWORD still fails the build.
const ALLOWED = new Set(['EXPO_PUBLIC_DINA_PDS_URL']);

const offenders = Object.keys(process.env)
  .filter((k) => k.startsWith('EXPO_PUBLIC_'))
  .filter((k) => !ALLOWED.has(k))
  .filter((k) => DANGEROUS.test(k))
  .sort();

if (offenders.length > 0) {
  console.error(
    '[release-guard] FAIL: secret-like EXPO_PUBLIC_* env vars are set — these inline\n' +
      'into the public JS bundle and ship to every client:\n',
  );
  for (const k of offenders) console.error(`  - ${k}`);
  console.error(
    '\nUnset them before a production build, or rename to a non-EXPO_PUBLIC_ server-only\n' +
      'variable. Public config (URLs, DIDs, toggles) may keep the EXPO_PUBLIC_ prefix.',
  );
  process.exit(1);
}

console.log('[release-guard] OK: no secret-like EXPO_PUBLIC_* env vars present.');
