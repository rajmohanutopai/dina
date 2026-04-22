/**
 * PII scrub route — scrub text, return rehydration tokens.
 */

import type { CoreRouter } from '../router';
import { scrubPII } from '../../pii/patterns';

export function registerPIIRoutes(router: CoreRouter): void {
  router.post('/v1/pii/scrub', async (req) => {
    const body = (req.body as { text?: unknown } | undefined) ?? {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (text === '') {
      return { status: 400, body: { error: 'text is required' } };
    }
    const result = scrubPII(text);
    return {
      status: 200,
      body: {
        scrubbed: result.scrubbed,
        entities: result.entities.map((e) => ({
          token: e.token,
          type: e.type,
          start: e.start,
          end: e.end,
        })),
        entityCount: result.entities.length,
      },
    };
  });
}
