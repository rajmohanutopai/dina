/**
 * The xRPC method table — DATA, not a server.
 *
 * It lived inside `server.ts`, which calls `server.listen` at module scope, so
 * importing the table meant starting an HTTP listener. Nothing could test the
 * real registration, and the query-string defect that made `identifier` and
 * `category` unsupplyable sat behind exactly that: the only test available read
 * the server's SOURCE and asserted a substring.
 *
 * A route is a validator plus a handler. Both are pure with respect to the
 * transport, so the table belongs beside them rather than inside the process
 * that happens to expose them.
 */

import { resolve, ResolveParams } from '@/api/xrpc/resolve.js'
import { search, SearchParams } from '@/api/xrpc/search.js'
import { getGraph, GetGraphParams } from '@/api/xrpc/get-graph.js'
import { getProfile, GetProfileParams } from '@/api/xrpc/get-profile.js'
import { getAttestations, GetAttestationsParams } from '@/api/xrpc/get-attestations.js'
import { serviceSearch, ServiceSearchParams } from '@/api/xrpc/service-search.js'
import {
  searchCommerceCatalog,
  CommerceCatalogSearchParams,
} from '@/api/xrpc/commerce-catalog-search.js'
import {
  CommerceSupplierDimensionsParams,
  getSupplierDimensions,
} from '@/api/xrpc/commerce-review-dimensions.js'
import { searchCapabilities, SearchCapabilitiesParams } from '@/api/xrpc/search-capabilities.js'
import { catalogCapabilities, CatalogCapabilitiesParams } from '@/api/xrpc/catalog-capabilities.js'
import { serviceIsDiscoverable, ServiceIsDiscoverableParams } from '@/api/xrpc/service-is-discoverable.js'
import { serviceGetByUri, ServiceGetByUriParams } from '@/api/xrpc/service-get-by-uri.js'
import { attestationStatus, AttestationStatusParams } from '@/api/xrpc/attestation-status.js'
import { cosigList, CosigListParams } from '@/api/xrpc/cosig-list.js'
import { networkFeed, NetworkFeedParams } from '@/api/xrpc/network-feed.js'
import { subjectGet, SubjectGetParams } from '@/api/xrpc/subject-get.js'
import { getAlternatives, GetAlternativesParams } from '@/api/xrpc/get-alternatives.js'
import { getNegativeSpace, GetNegativeSpaceParams } from '@/api/xrpc/get-negative-space.js'

export interface XrpcRoute {
  /** A zod schema, or anything with a throwing `parse`. */
  params: { parse: (value: unknown) => unknown }
  handler: (db: any, params: any) => Promise<unknown>
}

export const XRPC_ROUTES: Record<string, XrpcRoute> = {
  'com.dinakernel.peerlens.resolve': { params: ResolveParams, handler: resolve },
  'com.dinakernel.peerlens.search': { params: SearchParams, handler: search },
  'com.dinakernel.peerlens.getGraph': { params: GetGraphParams, handler: getGraph },
  'com.dinakernel.peerlens.getProfile': { params: GetProfileParams, handler: getProfile },
  'com.dinakernel.peerlens.getAttestations': { params: GetAttestationsParams, handler: getAttestations },
  'com.dinakernel.service.search': { params: ServiceSearchParams, handler: serviceSearch },
  'com.dinakernel.service.searchCapabilities': { params: SearchCapabilitiesParams, handler: searchCapabilities },
  'com.dinakernel.catalog.capabilities': { params: CatalogCapabilitiesParams, handler: catalogCapabilities },
  'com.dinakernel.service.isDiscoverable': { params: ServiceIsDiscoverableParams, handler: serviceIsDiscoverable },
  'com.dinakernel.service.getByUri': { params: ServiceGetByUriParams, handler: serviceGetByUri },
  'com.dinakernel.peerlens.attestationStatus': { params: AttestationStatusParams, handler: attestationStatus },
  'com.dinakernel.peerlens.cosigList': { params: CosigListParams, handler: cosigList },
  'com.dinakernel.peerlens.networkFeed': { params: NetworkFeedParams, handler: networkFeed },
  'com.dinakernel.peerlens.subjectGet': { params: SubjectGetParams, handler: subjectGet },
  'com.dinakernel.peerlens.getAlternatives': { params: GetAlternativesParams, handler: getAlternatives },
  'com.dinakernel.peerlens.getNegativeSpace': { params: GetNegativeSpaceParams, handler: getNegativeSpace },
  // §10.5 catalog discovery. The evaluation instant is supplied here rather
  // than read inside the query, so freshness is deterministic in tests and the
  // whole page is scored against ONE clock reading — a query that re-read the
  // clock per row could drop a candidate mid-page for a millisecond.
  'com.dinakernel.commerce.searchCatalog': {
    params: CommerceCatalogSearchParams,
    handler: (db: any, params: any) => searchCommerceCatalog(db, params, new Date().toISOString()),
  },
  // §14.4 review dimensions. Reports per dimension and computes NO score: an
  // extractor's confidence and a trust weight tunable in one place is the
  // coupling §10.6 says to avoid, so the caller does the weighing.
  'com.dinakernel.commerce.getSupplierDimensions': {
    params: CommerceSupplierDimensionsParams,
    handler: getSupplierDimensions,
  },
}
