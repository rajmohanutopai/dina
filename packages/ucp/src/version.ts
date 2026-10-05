/**
 * The one UCP version Dina speaks (UCP plan S20): v2026-08-25. A merchant that
 * offers only an older version gets its web page instead.
 */

export const UCP_VERSION = '2026-08-25';

export const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Where the spec, schemas and service descriptions for Dina's version live. */
export const UCP_BASE = `https://ucp.dev/${UCP_VERSION}`;
