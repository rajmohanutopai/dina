export interface ParsedAtUri {
  did: string
  collection: string
  rkey: string
}

export function parseAtUri(uri: string): ParsedAtUri {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!match) throw new Error(`Invalid AT URI: ${uri}`)
  return { did: match[1], collection: match[2], rkey: match[3] }
}

export function constructAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}
