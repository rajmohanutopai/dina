     The managed deployment uses stateful Docker volumes in deploy/managed/infra/docker-compose.infra.yml:97, but I found no automated backup, point-in-time recovery, or restore-testing path.

     Recommendation:
      - Use managed PostgreSQL with automated backup and point-in-time recovery.
      - Keep Dina’s application and protocol layers portable.
      - Maintain encrypted exports and periodically test restoration.
      - Treat PDS source records and identity-related state as irreplaceable, even if portions of AppView data can be rebuilt.

     This is the clearest area where buying a managed product is preferable. Managed databases provide operational guarantees such as automated backups and point-in-time recovery
     (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html) that are expensive to reproduce correctly.

  4. Replace the hand-written Bash parser

     apps/home-node-lite/core-server/src/gate/bash_classifier.ts:1 is approximately 950 lines of custom shell tokenization and classification. Dina’s risk taxonomy should remain custom, but shell grammar should
     not.

     Recommendation:
      - Parse commands using the Tree-sitter Bash parser (https://github.com/tree-sitter/tree-sitter/wiki/List-of-parsers).
      - Classify the resulting AST using Dina’s existing rules.
      - Fail closed on parse errors, command substitutions, unsupported redirections, dynamic evaluation, and incomplete syntax.

     Tree-sitter explicitly exposes error and missing syntax nodes (https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html). It does not make shell execution safe by itself, but it removes a
     large class of parser discrepancies.

  Important Library Replacements

  5. Use one canonical JSON implementation

     Canonicalization is independently implemented in:
      - packages/protocol/src/plugins/digests.ts:50
      - apps/home-node-lite/core-server/src/appview/schema_hash.ts:50
      - apps/home-node-lite/core-server/src/gate/permit.ts:77
      - apps/home-node-lite/core-server/src/identity/did_doc_proof.ts:147

     Differences around Unicode ordering, unsupported values, arrays, and cross-language behavior can break signatures and hashes.

     Recommendation:
      - Standardize on an RFC 8785 JSON Canonicalization Scheme (https://www.rfc-editor.org/rfc/rfc8785.html) implementation.
      - Expose it from @dina/protocol.
      - Run the same official vectors in TypeScript and Python.
      - Remove the local copies.

  6. Use Ajv for standard JSON Schema behavior

     packages/protocol/src/plugins/validate.ts:1 contains approximately 1,900 lines and includes a custom JSON Schema validator.

     Dina-specific checks should remain custom: capability restrictions, consent behavior, secret fields, resource limits, and security categories. Standard schema semantics should use Ajv
     (https://ajv.js.org/json-schema.html) in strict mode (https://ajv.js.org/strict-mode.html).

     If React Native dependency size is a concern, Ajv can generate standalone validators during the build. Do not replace the whole validation file, only the commodity JSON Schema portion.

  7. Adopt official ATProto libraries behind an adapter

     Session management, record CRUD, account creation, handle resolution, DID handling, and PLC operations are substantially custom in:
      - packages/brain/src/pds/publisher.ts:140
      - packages/brain/src/pds/account.ts:127
      - apps/home-node-lite/core-server/src/appview/session_manager.ts:1

     Recommendation:
      - Introduce an ATProto infrastructure adapter using official packages from the ATProto repository (https://github.com/bluesky-social/atproto).
      - Use official lexicon/XRPC handling where compatible.
      - Keep Dina-specific repository proofs, service records, PeerLens semantics, and authority binding.

     This should be a staged migration rather than a rewrite, especially where React Native compatibility or bundle size matters.

  Before Scaling

  8. Use OpenTelemetry for metrics

     apps/home-node-lite/core-server/src/metrics/registry.ts:92 and apps/home-node-lite/core-server/src/metrics/exporter.ts:55 manually implement counters, histogram buckets, labels, escaping, and Prometheus
     output.

     Replace that machinery with OpenTelemetry metrics (https://opentelemetry.io/docs/concepts/signals/metrics/). Keep Home Node telemetry local and opt-in; standardizing instrumentation does not require exporting
     private data.

  9. Use shared rate limiting before multiple AppView instances

     appview/src/ingester/rate-limiter.ts:15 is explicitly per-process. That is acceptable for a single-instance technical preview.

     Before horizontal scaling, use managed Redis/Valkey or an infrastructure gateway. Otherwise each instance multiplies the effective limit and restart clears all counters.

  10. Generate API clients

     Dina has OpenAPI bundling but still maintains several hand-written HTTP clients. Generate request types and clients from OpenAPI and ATProto lexicons. Keep domain adapters around generated clients so
     generated transport details do not leak throughout the codebase.
