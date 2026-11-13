"use client";

import { notifyManager, QueryClient, useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { api, listingToNodes, prefixOf, type RemoteListing } from "./remote";
import type { StorageNode } from "./storage";

/**
 * Server data for the dashboard, through TanStack Query: one cache for every folder level,
 * search, saved items, disk status and the inspector's previews — so two views of the same
 * folder share one request, and a write refreshes what it touched by key.
 */
export const keys = {
  connections: ["connections"] as const,
  items: ["items"] as const,
  /** One folder level of one bucket; ["listing", bucketId] covers a whole bucket. */
  listing: (bucketId: string, prefix: string) => ["listing", bucketId, prefix] as const,
  bucketListings: (bucketId: string) => ["listing", bucketId] as const,
  search: (connectionId: string, query: string) => ["search", connectionId, query] as const,
  connectionSearches: (connectionId: string) => ["search", connectionId] as const,
  disk: (connectionId: string) => ["disk", connectionId] as const,
  xray: (connectionId: string) => ["xray", connectionId] as const,
  analytics: (connectionId: string, prefix: string) => ["analytics", connectionId, prefix] as const,
  url: (connectionId: string, key: string) => ["url", connectionId, key] as const,
  stats: (connectionId: string, key: string) => ["stats", connectionId, key] as const,
  text: (connectionId: string, key: string) => ["text", connectionId, key] as const,
  head: (connectionId: string, key: string) => ["head", connectionId, key] as const,
  shares: ["shares"] as const,
  /** A connection's history; ["activity", connectionId] covers every folder's. */
  activity: (connectionId: string, prefix: string) => ["activity", connectionId, prefix] as const,
};

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Listings are cheap to keep and costly to repeat (each is a cloud API call).
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/* ---- Connection health: measured on every listing call -------------------------- */

export type Health = { ok: boolean; ms: number | null; message?: string };
const health = new Map<string, Health>();
let healthSnapshot: Record<string, Health> = {};
const healthListeners = new Set<() => void>();

function recordHealth(connectionId: string, value: Health) {
  health.set(connectionId, value);
  healthSnapshot = Object.fromEntries(health);
  for (const listener of healthListeners) listener();
}

/** The last listing call per connection: did it answer, and how fast. */
export function useHealth(): Record<string, Health> {
  return useSyncExternalStore(
    (listener) => {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    () => healthSnapshot,
    () => healthSnapshot,
  );
}

/* ---- Folder listings ------------------------------------------------------------ */

/** Bucket ids are "<connectionId>/<bucket>". */
export const connectionIdOf = (bucketId: string) => bucketId.slice(0, bucketId.indexOf("/"));

/**
 * One folder level, page by page (1,000 entries a page; `fetchNextPage` follows the
 * continuation token). With `enabled: false` it only reads what's already cached.
 */
export function useListing(bucketId: string, path: string[], enabled = true) {
  const prefix = prefixOf(path);
  const connectionId = connectionIdOf(bucketId);
  const query = useInfiniteQuery({
    queryKey: keys.listing(bucketId, prefix),
    queryFn: async ({ pageParam }) => {
      const started = performance.now();
      try {
        const page = await api.objects(connectionId, prefix, pageParam);
        recordHealth(connectionId, { ok: true, ms: Math.round(performance.now() - started) });
        return page;
      } catch (error) {
        recordHealth(connectionId, { ok: false, ms: null, message: (error as Error).message });
        throw error;
      }
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: RemoteListing) => last.nextToken,
    enabled: enabled && Boolean(connectionId),
  });
  const nodes = useMemo(
    () => (query.data ? query.data.pages.flatMap((page) => listingToNodes(bucketId, path, page)) : undefined),
    // `path` is fully described by the query's data; bucketId names the nodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.data, bucketId],
  );
  return { ...query, nodes };
}

const NO_NODES: StorageNode[] = [];

/**
 * Every node in every cached listing — what search-as-you-type and selection can find
 * without another request. Recomputed only when a listing actually changes.
 */
export function useAllListedNodes(): StorageNode[] {
  const client = useQueryClient();
  const memo = useRef<{ signature: string; nodes: StorageNode[] }>({ signature: "", nodes: NO_NODES });
  // The cache announces a new query while the component asking for it is still rendering
  // (a sidebar folder being opened, say). Passing that straight to React would update this
  // component mid-render; batchCalls hands it over afterwards, as TanStack's own hooks do.
  const subscribe = useCallback((listener: () => void) => client.getQueryCache().subscribe(notifyManager.batchCalls(listener)), [client]);
  const snapshot = useCallback(() => {
    // Only listings that have arrived: one still loading has no nodes to add.
    const queries = client.getQueryCache().findAll({ queryKey: ["listing"] }).filter((query) => query.state.data !== undefined);
    const signature = queries.map((query) => `${query.queryHash}@${query.state.dataUpdatedAt}`).join("|");
    if (signature === memo.current.signature) return memo.current.nodes;
    const nodes: StorageNode[] = [];
    for (const query of queries) {
      const data = query.state.data as InfiniteData<RemoteListing> | undefined;
      if (!data) continue;
      const bucketId = query.queryKey[1] as string;
      for (const page of data.pages) nodes.push(...listingToNodes(bucketId, [], page));
    }
    memo.current = { signature, nodes };
    return nodes;
  }, [client]);
  return useSyncExternalStore(subscribe, snapshot, () => NO_NODES);
}
