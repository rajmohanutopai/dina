/**
 * Resolve one xRPC call to a status and a body. No HTTP, no sockets.
 *
 * WHY IT IS SEPARATE. This is the part with rules in it — is the method known,
 * do the parameters validate, what does a handler failure mean — and it was
 * written inline inside a request callback in a module that starts listening
 * on import. None of it could be exercised without a server and a port, so
 * none of it was.
 *
 * The cost of that showed up as a real defect: the parameter object was built
 * with `Object.fromEntries(searchParams.entries())`, which silently dropped
 * every repeated key, and the two array-typed fields on catalog search could
 * therefore never be supplied. Free text still worked, so the endpoint looked
 * healthy while its strongest signals answered 400.
 *
 * The transport keeps what is genuinely transport: client IP, rate limits,
 * namespace kill-switches, writing bytes.
 */

import { queryToRecord } from '@/web/xrpc-query.js'

import type { XrpcRoute } from '@/web/xrpc-routes.js'

export interface XrpcOutcome {
  status: number
  body: unknown
}

/**
 * A ZodError, recognised WITHOUT importing zod.
 *
 * The dispatch does not care which validation library a route uses — it cares
 * that a validator refused, which is a 400, versus a handler throwing, which
 * is a 500. Naming the library here would make the transport depend on a
 * route's private choice.
 */
function isValidationError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ZodError'
  )
}

export async function dispatchXrpc(args: {
  routes: Record<string, XrpcRoute>
  db: unknown
  methodId: string
  searchParams: URLSearchParams
  /** Where a handler failure is reported. Never the caller's business. */
  onError?: (err: unknown, methodId: string) => void
}): Promise<XrpcOutcome> {
  const route = args.routes[args.methodId]
  if (route === undefined) {
    return {
      status: 400,
      body: { error: 'InvalidRequest', message: `Unknown method: ${args.methodId}` },
    }
  }

  let parsed: unknown
  try {
    parsed = route.params.parse(queryToRecord(args.searchParams))
  } catch (err) {
    if (isValidationError(err)) {
      return {
        status: 400,
        body: { error: 'InvalidRequest', message: (err as Error).message },
      }
    }
    // A validator that threw something else is a fault in the validator, not
    // a bad request — telling the caller their input was wrong would send them
    // to fix something that is not broken.
    args.onError?.(err, args.methodId)
    return { status: 500, body: { error: 'InternalServerError' } }
  }

  try {
    return { status: 200, body: await route.handler(args.db, parsed) }
  } catch (err) {
    // The REASON stays on this side. A handler's error can name a table, a
    // query or a connection string, and none of that is the caller's.
    args.onError?.(err, args.methodId)
    return { status: 500, body: { error: 'InternalServerError' } }
  }
}
