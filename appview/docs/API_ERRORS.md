# AppView API Errors — Wire-Format Contract

> **Audience:** clients consuming the AppView xRPC API
> (mobile, third-party indexers, federated AppView ports).
>
> **Status:** stable — once a client ships against this surface, the
> shape + enum names below cannot change without a major version bump.

## Error response shape

Every non-2xx response carries a JSON body with this shape:

```json
{
  "error": "ErrorName",
  "message": "Optional human-readable detail."
}
```

- `error` is a **machine-readable enum identifier** (PascalCase, no
  punctuation). Clients pattern-match on this field. **Never localized.**
- `message` is an optional, human-readable string for logs and dev UI.
  May contain dynamic content. **Never pattern-match on `message`.**

This follows the AT Protocol convention (xRPC errors carry `error` +
`message`; the error name is the machine contract).

## Defined error names

| HTTP | `error` | When |
|---|---|---|
| 400 | `InvalidRequest` | Malformed JSON, schema validation failure, invalid cursor, etc. |
| 401 | `AuthRequired` | Missing or invalid bearer token on protected endpoints. |
| 403 | `Forbidden` | Authenticated but lacks permission. |
| 404 | `NotFound` | Endpoint or resource unknown. |
| 429 | `TooManyRequests` | Rate limit exceeded. |
| 500 | `InternalServerError` | Unhandled exception on the server. |
| 503 | `ServiceUnavailable` | Upstream dependency (Postgres, etc.) unreachable. |

New error names may be added in additive releases. Clients should
treat unknown `error` values as a generic failure (display the
`message`, fall back to retry/abort based on HTTP status class).

## Notes on adding new errors

1. Pick a PascalCase identifier without punctuation.
2. Add it to this table.
3. Use it consistently — never reuse an identifier for a different
   condition.
4. If the new error needs structured detail beyond `message`, add a
   typed sibling field (e.g. `retryAfter: number`) — DON'T overload
   `message` with structured content.

## Band enums in successful responses

The trust band labels in API responses (`subjectGet`, `search`, etc.)
are also machine-readable enums and follow the same stability rules:

```
'high' | 'moderate' | 'low' | 'very-low' | 'unrated'
```

These are **lowercase kebab-case** by historical convention. They are
**never localized** in the wire format — clients map them to display
strings client-side. Adding a new band requires the same major-bump
discipline as adding a new error name.

## Reserved enum names

To keep room for future extensions, the following identifiers are
reserved (NOT currently in use, but should not be repurposed by
clients):

- Errors: `Conflict`, `PayloadTooLarge`, `UnsupportedMediaType`,
  `ExpiredToken`, `RevokedToken`, `MaintenanceMode`.
- Bands: `pending`, `verified` (reserved for a future scoring tier).
