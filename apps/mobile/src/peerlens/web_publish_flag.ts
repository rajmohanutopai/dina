/**
 * PeerLens review-PUBLISH availability flag (web thin-client, design D6 §5/§7).
 *
 * PeerLens READ/SEARCH work on the web thin client (they go through AppView,
 * which is already a remote service). PUBLISH does NOT: the durable publish-job
 * worker/drainer + the PDS-publish path + the error classifier currently live
 * MOBILE-side (`apps/mobile/src/peerlens/review_publish_worker.ts` et al.), and
 * the design's D6 makes web publish a SERVER-SIDE build (a submit route + worker
 * + PDS wiring + status projection on the brain-server) — not a thin proxy.
 *
 * Until that server build lands, the design's sanctioned fallback (§5, D6, §7
 * phase 4) is to **hide the write CTA on web behind a flag** while read/search
 * stay live. This is that flag. It is `true` on native (unchanged) and `false`
 * on web; flip the web case to `true` once the server-side publish path ships.
 *
 * NB: this is NOT a `.web.ts` swap — a single `Platform.OS` constant keeps the
 * gate greppable and one-line-flippable, and native is byte-for-byte unchanged.
 */

import { Platform } from 'react-native';

/** True where review PUBLISH is available (native today; web once the
 *  server-side publish worker — D6 — ships). Read/search are unaffected. */
export const PEERLENS_WRITE_ENABLED: boolean = Platform.OS !== 'web';
