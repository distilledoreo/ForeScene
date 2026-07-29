import type { CanonicalAutorigTopology } from './topology';

const topologyCache = new Map<string, CanonicalAutorigTopology>();
const MAX_TOPOLOGY_CACHE = 8;

/** Cache a built topology by its topology hash (adjacency + components reuse). */
export function cacheCanonicalTopology(topology: CanonicalAutorigTopology): CanonicalAutorigTopology {
  if (topologyCache.has(topology.topologyHash)) {
    topologyCache.delete(topology.topologyHash);
  }
  topologyCache.set(topology.topologyHash, topology);
  while (topologyCache.size > MAX_TOPOLOGY_CACHE) {
    const oldest = topologyCache.keys().next().value;
    if (oldest == null) break;
    topologyCache.delete(oldest);
  }
  return topology;
}

export function getCachedCanonicalTopology(topologyHash: string): CanonicalAutorigTopology | undefined {
  const hit = topologyCache.get(topologyHash);
  if (!hit) return undefined;
  // Refresh LRU order.
  topologyCache.delete(topologyHash);
  topologyCache.set(topologyHash, hit);
  return hit;
}

export function clearCanonicalTopologyCache(): void {
  topologyCache.clear();
}
