/**
 * Re-export shim — `plc_update.ts` was promoted to `@dina/core`
 * (`packages/core/src/identity/plc_update.ts`) so mobile onboarding
 * can import the same generic PLC update composer without crossing
 * the apps/ boundary. This file remains as a shim so existing
 * call-sites + tests in `apps/home-node-lite/` keep working without
 * an import-path edit.
 */

export {
  buildUpdateOperation,
  updateDIDPLC,
  secp256k1ToDidKeyMultibase,
  buildSigningKeyRotation,
} from '@dina/core';
export type {
  PLCUpdateParams,
  PLCUpdateResult,
  SigningKeyRotationParams,
} from '@dina/core';
