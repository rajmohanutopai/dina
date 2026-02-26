import http from 'node:http'
import { URL } from 'node:url'
import { createDb } from '@/db/connection.js'
import { resolve, ResolveParams } from '@/api/xrpc/resolve.js'
import { search, SearchParams } from '@/api/xrpc/search.js'
import { getGraph, GetGraphParams } from '@/api/xrpc/get-graph.js'
import { getProfile, GetProfileParams } from '@/api/xrpc/get-profile.js'
import { getAttestations, GetAttestationsParams } from '@/api/xrpc/get-attestations.js'
import { logger } from '@/shared/utils/logger.js'

const db = createDb()
const port = Number(process.env.PORT ?? 3000)

const ROUTES: Record<string, { params: any; handler: (db: any, params: any) => Promise<any> }> = {
  'com.dina.reputation.resolve': { params: ResolveParams, handler: resolve },
  'com.dina.reputation.search': { params: SearchParams, handler: search },
  'com.dina.reputation.getGraph': { params: GetGraphParams, handler: getGraph },
  'com.dina.reputation.getProfile': { params: GetProfileParams, handler: getProfile },
  'com.dina.reputation.getAttestations': { params: GetAttestationsParams, handler: getAttestations },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  // XRPC dispatch: /xrpc/{methodId}
  if (url.pathname.startsWith('/xrpc/')) {
    const methodId = url.pathname.slice('/xrpc/'.length)
    const route = ROUTES[methodId]

    if (!route) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'InvalidRequest', message: `Unknown method: ${methodId}` }))
      return
    }

    try {
      const queryParams = Object.fromEntries(url.searchParams.entries())
      const parsed = route.params.parse(queryParams)
      const result = await route.handler(db, parsed)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err: any) {
      if (err?.name === 'ZodError') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'InvalidRequest', message: err.message }))
      } else {
        logger.error({ err, method: methodId }, 'XRPC handler error')
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'InternalServerError' }))
      }
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'NotFound' }))
})

server.listen(port, () => {
  logger.info({ port }, 'AppView web server listening')
})
