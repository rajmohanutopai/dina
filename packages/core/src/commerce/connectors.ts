import {
  catalogRowsFromRecords,
  importCatalogRows,
  parseCatalogCsv,
  type CatalogImport,
  type CatalogRowSource,
} from './catalog_import';

import type { CredentialBroker } from './credential_broker';

/**
 * Catalog backends (§6.3, §6.5, §24 — WS-9.1).
 *
 * §24's acceptance is one sentence: "connector replacement does not change
 * capability semantics." A supplier who moves from a spreadsheet to their own
 * REST endpoint must publish the SAME catalog, refuse the SAME rows, and give
 * buyers the same answers — otherwise "which supplier stocks this" quietly
 * depends on which backend they chose.
 *
 * SO A CONNECTOR READS, AND DECIDES NOTHING. Each one turns its source into
 * columns and rows, and `importCatalogRows` — one function, shared — decides
 * what a catalog item is. The tempting alternative, a JSON importer beside the
 * CSV one, would pass its own tests and disagree with the other about a
 * duplicate identifier or an out-of-vocabulary unit. Nobody would notice until
 * a supplier switched.
 *
 * NO CONNECTOR EVER HOLDS A CREDENTIAL. The two networked forms name a broker
 * RESOURCE and ask the broker to perform a typed operation (§8.3). The secret
 * stays inside the broker; what comes back here is a document. That is why
 * these functions take a `CredentialBroker` rather than a token, and why a
 * missing broker is a refusal rather than an unauthenticated request.
 *
 * §6.5 IS ENFORCED HERE TOO, as `classifyConnectorChange`: selecting a backend
 * that widens the declared domains, credential resources or operations is a
 * re-consent event, never an ordinary config edit. Without that check, an
 * owner who consented to "read my spreadsheet" could be moved to "call this
 * ERP with these credentials" by a settings save.
 */

export type ConnectorKind =
  /** A CSV the owner uploaded. No network, no credential (§6.5 base pack). */
  | 'spreadsheet_upload'
  /** A hosted sheet exported as CSV. Fetched through the broker. */
  | 'spreadsheet_url'
  /** Any JSON endpoint returning catalog rows. Fetched through the broker. */
  | 'rest';

export interface ConnectorSpec {
  kind: ConnectorKind;
  /**
   * The broker resource this backend authenticates with, or null when it needs
   * none. Null on a networked kind means the endpoint is public — legal, and
   * different from "the credential is missing".
   */
  credentialResource: string | null;
  /** The broker operation to perform. Ignored by the upload kind. */
  operation: string;
}

export type ConnectorRefusal =
  /** A networked kind with no broker composed. Fails closed. */
  | 'no_broker'
  /** The upload kind reached with no file. */
  | 'no_document'
  /** The broker refused: wrong install, undeclared operation, no material. */
  | 'broker_refused'
  /** The backend answered with something that is not a list of rows. */
  | 'not_a_row_list';

export type ConnectorLoad =
  | { ok: true; import: CatalogImport }
  | { ok: false; refusal: ConnectorRefusal; error: string };

/**
 * Records from whatever a REST backend answered.
 *
 * Two shapes are accepted — a bare array and `{items: [...]}` — because both
 * are what endpoints actually return and neither is ambiguous. Anything else
 * is refused rather than searched: guessing which field holds the catalog is
 * how a connector silently publishes a page of metadata as products.
 */
function recordsFrom(result: unknown): Record<string, unknown>[] | null {
  const candidate =
    Array.isArray(result) ||
    result === null ||
    typeof result !== 'object' ||
    !('items' in (result as Record<string, unknown>))
      ? result
      : (result as { items: unknown }).items;
  if (!Array.isArray(candidate)) return null;
  const rows: Record<string, unknown>[] = [];
  for (const entry of candidate) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    rows.push(entry as Record<string, unknown>);
  }
  return rows;
}

/**
 * Read a catalog through the chosen backend.
 *
 * `document` is the uploaded CSV, present only for `spreadsheet_upload`. Every
 * other kind reaches its source through the broker, which is the only thing on
 * this node that may combine a credential with a request.
 */
export async function loadCatalogThroughConnector(args: {
  spec: ConnectorSpec;
  installId: string;
  document?: string;
  broker: CredentialBroker | null;
  defaultScheme: 'gtin' | 'sku';
  supplierDid: string;
}): Promise<ConnectorLoad> {
  const source = await readSource(args);
  if (!source.ok) return source;
  return {
    ok: true,
    import: importCatalogRows({
      source: source.source,
      defaultScheme: args.defaultScheme,
      supplierDid: args.supplierDid,
    }),
  };
}

type SourceRead =
  | { ok: true; source: CatalogRowSource }
  | { ok: false; refusal: ConnectorRefusal; error: string };

async function readSource(args: {
  spec: ConnectorSpec;
  installId: string;
  document?: string;
  broker: CredentialBroker | null;
}): Promise<SourceRead> {
  if (args.spec.kind === 'spreadsheet_upload') {
    // An empty upload is refused rather than parsed. `parseCatalogCsv` would
    // answer "expected a header row", which reads as a badly formatted file
    // when the truth is that no file arrived.
    if (args.document === undefined || args.document === '') {
      return { ok: false, refusal: 'no_document', error: 'no spreadsheet was uploaded' };
    }
    return { ok: true, source: parseCatalogCsv(args.document) };
  }

  if (args.broker === null) {
    // FAIL CLOSED. The alternative — fetching without the broker — is an
    // unauthenticated request to the supplier's own backend, which either
    // fails confusingly or succeeds against an endpoint that should have been
    // protected.
    return {
      ok: false,
      refusal: 'no_broker',
      error: 'this node has no credential broker, so a networked catalog cannot be read',
    };
  }

  const performed = await args.broker.perform({
    installId: args.installId,
    // A networked connector with no credential resource still goes through the
    // broker: the broker owns the OPERATION, and routing a public endpoint
    // around it would create a second outbound path that nothing audits.
    resource: args.spec.credentialResource ?? '',
    operation: args.spec.operation,
    // NOTHING from the catalog request travels here. The operation is fixed by
    // the manifest and the endpoint by the credential's own configuration, so
    // there is no caller-supplied field for a token to hide in.
    params: {},
  });
  if (!performed.ok) {
    return { ok: false, refusal: 'broker_refused', error: performed.error };
  }

  if (args.spec.kind === 'spreadsheet_url') {
    if (typeof performed.result !== 'string') {
      return {
        ok: false,
        refusal: 'not_a_row_list',
        error: 'a spreadsheet backend must answer with CSV text',
      };
    }
    return { ok: true, source: parseCatalogCsv(performed.result) };
  }

  const records = recordsFrom(performed.result);
  if (records === null) {
    return {
      ok: false,
      refusal: 'not_a_row_list',
      error: 'a REST backend must answer with a list of rows, or {items: [...]}',
    };
  }
  return { ok: true, source: catalogRowsFromRecords(records) };
}

/**
 * What a connector release declared it needs (§6.5).
 *
 * Three fields because §6.5 names three: "each release declares only the
 * domains, credential resources, and operations needed by that backend".
 */
export interface ConnectorDeclaration {
  domains: string[];
  credentialResources: string[];
  operations: string[];
}

export interface ConnectorWidening {
  domains: string[];
  credentialResources: string[];
  operations: string[];
}

export type ConnectorChange =
  | { kind: 'ordinary_edit' }
  | { kind: 'requires_reconsent'; widened: ConnectorWidening };

/**
 * Is moving from one backend to another a config edit or a consent event?
 *
 * §6.5: "selecting a different backend that widens those fields is a new
 * install or re-consent event, never an ordinary config edit."
 *
 * WIDENING IS THE TEST, NOT CHANGE. A supplier who swaps one ERP host for
 * another has widened nothing they consented to less of; a supplier moving
 * from a spreadsheet to an ERP has gained an outbound domain and a credential.
 * Treating every edit as a consent event would train owners to click through
 * consent screens, which is worse than not asking.
 *
 * NARROWING IS ALWAYS ORDINARY, and that is not laziness: an owner is always
 * allowed to give a plugin less. The removed authority does not linger,
 * because what the connector may actually reach is read from the CURRENT
 * declaration at every call.
 */
export function classifyConnectorChange(
  previous: ConnectorDeclaration,
  next: ConnectorDeclaration,
): ConnectorChange {
  const added = (before: string[], after: string[]): string[] => {
    const held = new Set(before);
    return [...new Set(after.filter((entry) => !held.has(entry)))].sort();
  };
  const widened: ConnectorWidening = {
    domains: added(previous.domains, next.domains),
    credentialResources: added(previous.credentialResources, next.credentialResources),
    operations: added(previous.operations, next.operations),
  };
  const widens =
    widened.domains.length > 0 ||
    widened.credentialResources.length > 0 ||
    widened.operations.length > 0;
  return widens ? { kind: 'requires_reconsent', widened } : { kind: 'ordinary_edit' };
}
