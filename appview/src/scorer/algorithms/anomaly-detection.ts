import { CONSTANTS } from '@/config/constants.js'

export interface CoordinationInput {
  attestations: {
    authorDid: string
    subjectId: string
    recordCreatedAt: Date
    sentiment: string
  }[]
  windowHours: number
}

export interface CoordinationResult {
  isCoordinated: boolean
  clusterSize: number
  involvedDids: string[]
  subjectId: string
  windowStart: Date
  windowEnd: Date
}

export function detectCoordination(input: CoordinationInput): CoordinationResult[] {
  const { attestations, windowHours } = input
  const results: CoordinationResult[] = []

  // Group by subject
  const bySubject = new Map<string, typeof attestations>()
  for (const a of attestations) {
    const list = bySubject.get(a.subjectId) ?? []
    list.push(a)
    bySubject.set(a.subjectId, list)
  }

  for (const [subjectId, subjectAtts] of bySubject) {
    // Sort by time
    const sorted = [...subjectAtts].sort((a, b) => a.recordCreatedAt.getTime() - b.recordCreatedAt.getTime())

    // Sliding window
    const windowMs = windowHours * 60 * 60 * 1000
    for (let i = 0; i < sorted.length; i++) {
      const windowStart = sorted[i].recordCreatedAt
      const windowEnd = new Date(windowStart.getTime() + windowMs)

      const inWindow = sorted.filter(a =>
        a.recordCreatedAt >= windowStart && a.recordCreatedAt <= windowEnd
      )

      const uniqueDids = new Set(inWindow.map(a => a.authorDid))

      if (uniqueDids.size >= CONSTANTS.SYBIL_MIN_CLUSTER_SIZE) {
        // Check if predominantly same sentiment (coordination signal)
        const sentiments = inWindow.map(a => a.sentiment)
        const dominant = mode(sentiments)
        const dominantRatio = sentiments.filter(s => s === dominant).length / sentiments.length

        if (dominantRatio >= 0.8) {
          results.push({
            isCoordinated: true,
            clusterSize: uniqueDids.size,
            involvedDids: [...uniqueDids],
            subjectId,
            windowStart,
            windowEnd,
          })
        }
      }
    }
  }

  return deduplicateResults(results)
}

export interface SybilClusterInput {
  edges: { fromDid: string; toDid: string }[]
  quarantinedDids: string[]
}

export interface SybilClusterResult {
  clusterDids: string[]
  confidence: number
  reason: string
}

export function detectSybilClusters(input: SybilClusterInput): SybilClusterResult[] {
  const results: SybilClusterResult[] = []

  // Build adjacency from quarantined DIDs
  const adjacency = new Map<string, Set<string>>()
  for (const edge of input.edges) {
    if (!adjacency.has(edge.fromDid)) adjacency.set(edge.fromDid, new Set())
    if (!adjacency.has(edge.toDid)) adjacency.set(edge.toDid, new Set())
    adjacency.get(edge.fromDid)!.add(edge.toDid)
    adjacency.get(edge.toDid)!.add(edge.fromDid)
  }

  // Find clusters of quarantined DIDs that vouch for each other
  const visited = new Set<string>()
  for (const did of input.quarantinedDids) {
    if (visited.has(did)) continue

    const cluster = new Set<string>()
    const queue = [did]

    while (queue.length > 0) {
      const current = queue.pop()!
      if (visited.has(current)) continue
      visited.add(current)

      if (input.quarantinedDids.includes(current)) {
        cluster.add(current)
        const neighbors = adjacency.get(current) ?? new Set()
        for (const n of neighbors) {
          if (!visited.has(n)) queue.push(n)
        }
      }
    }

    if (cluster.size >= CONSTANTS.SYBIL_MIN_CLUSTER_SIZE) {
      results.push({
        clusterDids: [...cluster],
        confidence: Math.min(0.95, 0.5 + cluster.size * 0.1),
        reason: `Cluster of ${cluster.size} mutually-connected quarantined DIDs`,
      })
    }
  }

  return results
}

function mode(arr: string[]): string {
  const counts = new Map<string, number>()
  for (const s of arr) {
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  let maxCount = 0
  let maxVal = arr[0]
  for (const [val, count] of counts) {
    if (count > maxCount) { maxCount = count; maxVal = val }
  }
  return maxVal
}

function deduplicateResults(results: CoordinationResult[]): CoordinationResult[] {
  const seen = new Set<string>()
  return results.filter(r => {
    const key = `${r.subjectId}:${r.involvedDids.sort().join(',')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
