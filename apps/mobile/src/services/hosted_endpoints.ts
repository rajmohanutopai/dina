/**
 * Mobile hosted-endpoint resolution with Expo-safe env reads.
 *
 * WHY THIS WRAPPER EXISTS — a release-build footgun:
 * `@dina/home-node`'s `resolveMobileHostedDinaEndpoints()` reads the env via a
 * DYNAMIC lookup (`env[key]` over `process.env`). Expo's babel transform only
 * inlines `process.env.EXPO_PUBLIC_*` when each var is written as a STATIC
 * member access; a dynamic lookup is left untouched and resolves to `undefined`
 * in a release bundle. So on a production build the package silently fell back
 * to its TEST defaults (test-pds / test-appview / test-mailbox) for the handle
 * picker, AppView, MsgBox, and PLC — while statically-read sites (e.g.
 * `provision.ts`'s createAccount endpoint) correctly resolved to prod. The
 * mismatch (a `…test-pds` handle sent to the prod PDS) is what failed onboarding
 * on the first TestFlight build with `UnsupportedDomain`.
 *
 * THE FIX: read every `EXPO_PUBLIC_*` here, as a STATIC member access, in APP
 * code (where the inline is guaranteed), and hand the resolver a plain object.
 * Every mobile call site uses `mobileHostedEndpoints()` instead of calling
 * `resolveMobileHostedDinaEndpoints()` with no args. Same class of bug the
 * comment in `ai/credits.ts` documents.
 */
import { resolveMobileHostedDinaEndpoints, type HostedDinaEndpoints } from '@dina/home-node';

/**
 * Resolve the hosted Dina endpoints (PDS / AppView / MsgBox / PLC) for the
 * mobile app, reading the `EXPO_PUBLIC_*` vars statically so they inline into a
 * release build instead of falling back to the test defaults.
 */
export function mobileHostedEndpoints(): HostedDinaEndpoints {
  return resolveMobileHostedDinaEndpoints({
    EXPO_PUBLIC_DINA_ENDPOINT_MODE: process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE,
    EXPO_PUBLIC_DINA_MSGBOX_URL: process.env.EXPO_PUBLIC_DINA_MSGBOX_URL,
    EXPO_PUBLIC_DINA_PDS_URL: process.env.EXPO_PUBLIC_DINA_PDS_URL,
    EXPO_PUBLIC_DINA_APPVIEW_URL: process.env.EXPO_PUBLIC_DINA_APPVIEW_URL,
    EXPO_PUBLIC_DINA_PLC_URL: process.env.EXPO_PUBLIC_DINA_PLC_URL,
  });
}
