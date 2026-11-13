"use client";

import { useQueries, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SCOPE_LABELS,
  formatBytes,
  nodesAt,
  searchBucket,
  sortNodes,
  summarize,
  QUICK_FILTERS,
  matchesFilter,
  type QuickFilter,
  bucketIdOf,
  type Bucket,
  type ProviderId,
  type Scope,
  type SortKey,
  type SortState,
  type StorageNode,
  type ViewMode,
} from "../lib/storage";
import {
  api,
  bucketIdFor,
  connectionToProvider,
  fileNode,
  keyOf,
  metaOf,
  prefixOf,
  savedNode,
  searchToNodes,
  type SavedItem,
  type OperationItem,
  type DiskStatus,
  type Job,
  type OperationRequest,
  type RemoteConnection,
  type RemoteListing,
  type ShareLink,
} from "../lib/remote";
import { LAKE_LABELS, type LakeRoot, type TableChange } from "../lib/data-types";
import { AddProviderDialog, type ConnectValues } from "./add-provider-dialog";
import { DeleteDialog, DestinationDialog, RenameDialog } from "./operation-dialogs";
import type { SignedInUser } from "./account-menu";
import { AnalyticsDialog } from "./analytics-dialog";
import { XrayDialog } from "./xray-dialog";
import { HistoryDialog } from "./history-dialog";
import { ConnectionSettingsDialog } from "./connection-settings-dialog";
import { connectionIdOf, keys, useAllListedNodes, useHealth, useListing } from "../lib/queries";
import { useDebounced } from "../lib/use-debounced";
import { JobsTray } from "./jobs-tray";
import { jobOutcome, useJobs, withTableCheck, type JobMeta } from "./use-jobs";
import { ThemeSync } from "./theme";
import { DetailPanel } from "./detail-panel";
import { DataPreviewDialog } from "./data-preview-dialog";
import { QuickLook } from "./quick-look";
import { FolderNoteCard, FolderReadme, readmeOf } from "./folder-header";
import { SqlConsole, starterQuery } from "./sql-console";
import { MetadataDialog } from "./metadata-dialog";
import { CompareDialog } from "./compare-dialog";
import { LakeBanner, LakeTableDialog, TableChangeDialog } from "./lake-table";
import { ShareDialog } from "./share-dialog";
import { ZipDialog, type ZipRequest } from "./zip-dialog";
import { SharedLinksView } from "./shared-links-view";
import { FileGrid } from "./file-grid";
import { FileTable } from "./file-table";
import { Sidebar, type ConnectionHealth, type FolderTreeModel } from "./sidebar";
import { Wordmark } from "./wordmark";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  BellIcon,
  BucketIcon,
  CheckIcon,
  ChevronRight,
  ClockIcon,
  CloseIcon,
  FolderIcon,
  ChartIcon,
  XrayIcon,
  GridIcon,
  HistoryIcon,
  InfoIcon,
  LinkIcon,
  LockIcon,
  ListIcon,
  MenuIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  CompareIcon,
  NoteIcon,
  PinIcon,
  PulseIcon,
  SqlIcon,
  StarIcon,
  UploadIcon,
} from "./icons";
import { profileOf } from "../lib/providers";

/** Platform-correct shortcut hint, without a hydration mismatch. */
const subscribeToNothing = () => () => {};
const readModifier = () => (/Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "Ctrl ");
const serverModifier = () => "⌘";

type Location = { scope: Scope; bucketId: string; path: string[] };

/** "on localhost:4577", "in eu-west-1", or "on Azure" when a cloud has no region to show. */
function whereIs(connection: { endpoint?: string; region: string; presetId: string }): string {
  if (connection.endpoint) return `on ${new URL(connection.endpoint).host}`;
  if (connection.region) return `in ${connection.region}`;
  return profileOf(connection.presetId)?.where ?? "";
}

function targetOf(connection: { endpoint?: string; region: string; presetId: string }): string {
  if (connection.endpoint) return new URL(connection.endpoint).host;
  if (connection.region) return connection.region;
  return profileOf(connection.presetId)?.service ?? "cloud";
}

/** ?bucket=<connection>/<bucket>&prefix=a/b/  or  ?view=starred */
function urlFor(location: Location): string {
  const params = new URLSearchParams();
  if (location.scope !== "bucket") params.set("view", location.scope);
  else if (location.bucketId) {
    params.set("bucket", location.bucketId);
    if (location.path.length) params.set("prefix", `${location.path.join("/")}/`);
  }
  const query = params.toString();
  return query ? `?${query}` : window.location.pathname;
}

function parseLocation(search: string): Location | null {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "starred" || view === "team" || view === "recent" || view === "shared") {
    return { scope: view, bucketId: "", path: [] };
  }
  const bucketId = params.get("bucket");
  if (!bucketId) return null;
  const prefix = params.get("prefix") ?? "";
  const path = prefix.split("/").filter(Boolean);
  return { scope: "bucket", bucketId, path };
}

/** Stands in for "no bucket" so the view model never branches on undefined. */
const NO_BUCKET: Bucket = { id: "", name: "", title: "", region: "", nodes: [], remote: { connectionId: "" } };

const SCOPE_ICONS = {
  starred: StarIcon,
  team: PinIcon,
  recent: ClockIcon,
  shared: LinkIcon,
} as const;

type Dialog =
  | { kind: "rename"; node: StorageNode }
  | { kind: "move" | "copy"; nodes: StorageNode[] }
  | { kind: "delete"; nodes: StorageNode[] }
  | { kind: "metadata"; nodes: StorageNode[] }
  | null;

type UploadItem = { id: string; name: string; size: number; loaded: number; status: "queued" | "uploading" | "done" | "error"; error?: string };

/** A file to upload and where it goes, relative to the current folder ("photos/a.jpg"). */
type PickedFile = { file: File; path: string };

/** Most files one drop or pick may queue; past that, upload folder by folder. */
const MAX_BATCH = 5_000;
/** OS clutter that nobody means to upload. */
const JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** From a file input: plain files, or a picked folder (each file knows its relative path). */
function pickedFromList(list: FileList): PickedFile[] {
  return Array.from(list)
    .filter((file) => !JUNK.has(file.name))
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/** From a drop: files and whole folders, walked recursively. */
async function pickedFromDrop(transfer: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(transfer.items)
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  // No entry API: just the top-level files.
  if (!entries.length) return pickedFromList(transfer.files);

  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, base: string): Promise<void> => {
    if (out.length > MAX_BATCH || JUNK.has(entry.name)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: base + entry.name });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands out a batch at a time; an empty batch means done.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${base}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}

const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

const BULK_BUTTON =
  "spring rounded-full border border-line-strong bg-surface-raised px-3 py-1.5 text-[12.5px] font-semibold text-ink transition hover:bg-surface-sunken active:scale-[0.97]";

/** Fetches the next page when it scrolls into view; a button for keyboards and slow scrollers. */
function LoadMore({ onLoad }: { onLoad: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useEffectEvent(onLoad);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && load(), {
      rootMargin: "300px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="flex justify-center py-4">
      <button
        type="button"
        onClick={onLoad}
        className="rounded-full border border-line-strong px-4 py-1.5 text-[12.5px] font-medium text-accent-strong transition hover:bg-accent-soft"
      >
        Load more
      </button>
    </div>
  );
}

function UploadTray({
  uploads,
  onCancel,
  onDismiss,
}: {
  uploads: UploadItem[];
  onCancel: (id: string) => void;
  onDismiss: () => void;
}) {
  const active = uploads.filter((item) => item.status === "uploading" || item.status === "queued").length;
  const failed = uploads.filter((item) => item.status === "error").length;
  return (
    <section
      aria-label="Uploads"
      className="material-thick tray-in fixed bottom-5 right-5 z-40 w-[min(340px,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-line shadow-pop"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="flex-1 text-[13px] font-semibold text-ink" aria-live="polite">
          {active ? `Uploading ${active} file${active === 1 ? "" : "s"}…` : failed ? `${failed} upload${failed === 1 ? "" : "s"} failed` : "Uploads complete"}
        </h2>
        {active ? null : (
          <button type="button" onClick={onDismiss} aria-label="Dismiss uploads" className="rounded-full p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink">
            <CloseIcon size={14} />
          </button>
        )}
      </header>
      <ul className="scroll-quiet max-h-60 overflow-y-auto">
        {uploads.map((item) => {
          const percent = item.size ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : item.status === "done" ? 100 : 0;
          return (
            <li key={item.id} className="border-b border-line px-4 py-2.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{item.name}</span>
                <span className="tnum shrink-0 text-[11.5px] text-ink-faint">
                  {item.status === "error" ? "Failed" : item.status === "done" ? formatBytes(item.size) : `${percent}%`}
                </span>
                {item.status === "uploading" || item.status === "queued" ? (
                  <button type="button" onClick={() => onCancel(item.id)} aria-label={`Cancel ${item.name}`} className="rounded-full p-0.5 text-ink-faint hover:text-danger">
                    <CloseIcon size={12} />
                  </button>
                ) : null}
              </div>
              {item.status === "error" ? (
                <p className="mt-1 text-[11.5px] text-danger">{item.error}</p>
              ) : (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${item.name} upload`}>
                  <div
                    className={`h-full rounded-full transition-[width] ${item.status === "done" ? "bg-success" : "bg-accent"}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** How often a live folder re-lists. */
const LIVE_INTERVAL_MS = 5_000;

/** The smaller toolbar buttons: tools for the open folder. */
const TOOL_BUTTON =
  "material spring inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-[13px] font-semibold text-ink shadow-card transition hover:bg-surface-raised active:scale-[0.97] aria-pressed:border-accent aria-pressed:bg-accent-soft";

/** The confirm button after a table warning reads "<verb> anyway". */
const TABLE_VERBS: Record<OperationRequest["op"], string> = { delete: "Delete", move: "Move", copy: "Copy", rename: "Rename", metadata: "Update" };

export function StorageExplorer({ user }: { user: SignedInUser }) {
  const [scope, setScope] = useState<Scope>("bucket");
  const [bucketId, setBucketId] = useState("");
  const [path, setPath] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("list");
  const [filter, setFilter] = useState<QuickFilter>("all");
  const [bellOpen, setBellOpen] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: "name", dir: "asc" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Stars, shared links and recent files, saved per user on the server. */
  const queryClient = useQueryClient();
  const itemsQuery = useQuery({ queryKey: keys.items, queryFn: api.items });
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  /** Saved items live in the query cache; this writes there, optimistically. */
  const setItems = (update: SavedItem[] | ((current: SavedItem[]) => SavedItem[])) =>
    queryClient.setQueryData<SavedItem[]>(keys.items, (current) =>
      typeof update === "function" ? update(current ?? []) : update,
    );
  /** Live S3 connections. Credentials stay server-side; this is the public view. */
  const connectionsQuery = useQuery({ queryKey: keys.connections, queryFn: api.list });
  const connections = useMemo(() => connectionsQuery.data ?? [], [connectionsQuery.data]);
  const setConnections = (update: (current: RemoteConnection[]) => RemoteConnection[]) =>
    queryClient.setQueryData<RemoteConnection[]>(keys.connections, (current) => update(current ?? []));
  const connectionsLoaded = !connectionsQuery.isPending;
  /** Every object listed so far, from every cached folder level. */
  const remoteNodes = useAllListedNodes();
  /** Position in this tab's history, and how far forward it reaches — drives Back / Forward. */
  const [navIndex, setNavIndex] = useState(0);
  const [navTop, setNavTop] = useState(0);
  /** Expanded levels in the sidebar tree, as "<bucketId>|<prefix>". */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** Last listing call per connection: did it answer, and how fast. */
  const health = useHealth();
  const [openProviders, setOpenProviders] = useState<ProviderId[]>([]);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  /** Bulk selection (checkboxes) — separate from the single object in the inspector. */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const checkAnchor = useRef<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadCancels = useRef(new Map<string, () => void>());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** Disk space behind bundled storage, by connection id. */

  /** Background copies, moves, renames and deletes started here (or still running). */
  const { jobs, follow, followById: followJob, dismissFinished } = useJobs(finishJob);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [xrayOpen, setXrayOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** The connection whose settings dialog is open. */
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const modifier = useSyncExternalStore(subscribeToNothing, readModifier, serverModifier);

  const searchRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  /** Scrolls the file list; the table and grid render only the rows in view. */
  const listScrollRef = useRef<HTMLDivElement>(null);
  const folderUploadRef = useRef<HTMLInputElement>(null);
  /** Files dragged over the window; a counter because enter/leave fire per child element. */
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const providers = useMemo(() => connections.map(connectionToProvider), [connections]);

  /** Any connected bucket by id, holding the objects listed from it so far. */
  function resolveBucket(id: string): Bucket {
    const base = providers.flatMap((provider) => provider.buckets).find((item) => item.id === id);
    if (!base) return { ...NO_BUCKET, id };
    return { ...base, nodes: remoteNodes.filter((node) => bucketIdOf(node.id) === id) };
  }

  const baseBucket =
    providers.flatMap((provider) => provider.buckets).find((item) => item.id === bucketId) ?? NO_BUCKET;
  const bucket: Bucket = useMemo(
    () => ({ ...baseBucket, nodes: remoteNodes.filter((node) => bucketIdOf(node.id) === baseBucket.id) }),
    [baseBucket, remoteNodes],
  );
  const hasBucket = baseBucket !== NO_BUCKET;
  const activeConnection = connections.find((connection) => connection.id === bucket.remote.connectionId);

  // Bundled storage's disk: on load, then every minute (and after uploads, below).
  const managedConnections = connections.filter((connection) => connection.managed);
  const diskQueries = useQueries({
    queries: managedConnections.map((connection) => ({
      queryKey: keys.disk(connection.id),
      queryFn: () => api.disk(connection.id),
      refetchInterval: 60_000,
    })),
  });
  const disks: Record<string, DiskStatus> = {};
  managedConnections.forEach((connection, index) => {
    const disk = diskQueries[index]?.data;
    if (disk) disks[connection.id] = disk;
  });
  const refreshDisks = () => queryClient.invalidateQueries({ queryKey: ["disk"] });
  const activeDisk = activeConnection?.managed ? disks[activeConnection.id] : undefined;
  const diskFull = activeDisk?.level === "full";


  const searching = query.trim().length > 0;

  // Saved items → nodes and id sets. An item is shown only while its connection exists.
  const bucketIdByConnection = useMemo(
    () => new Map(connections.map((connection) => [connection.id, bucketIdFor(connection)])),
    [connections],
  );
  const saved = useMemo(() => {
    const nodes = new Map<string, StorageNode>();
    const ids: Record<SavedItem["kind"], string[]> = { star: [], shared: [], recent: [], team: [] };
    for (const item of items) {
      const target = bucketIdByConnection.get(item.connectionId);
      if (!target) continue;
      const node = savedNode(target, item);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      if (!ids[item.kind].includes(node.id)) ids[item.kind].push(node.id);
    }
    return { nodes, starred: new Set(ids.star), shared: new Set(ids.shared), recent: ids.recent, team: new Set(ids.team) };
  }, [items, bucketIdByConnection]);
  const starred = saved.starred;

  /** The server's answer for the current search: the whole bucket, not just opened folders. */
  const searchConnection = bucket.remote?.connectionId;
  // Typing pauses for a moment before the bucket is scanned.
  const needle = useDebounced(query.trim(), 250);
  const searchQuery = useQuery({
    queryKey: keys.search(searchConnection ?? "", needle),
    queryFn: () => api.search(searchConnection!, needle),
    enabled: scope === "bucket" && Boolean(needle) && Boolean(searchConnection),
  });
  // Only the answer for what's typed now counts; until it arrives, local matches show.
  const settled = needle === query.trim() && Boolean(needle);
  // Built once per answer: selection compares nodes by identity, so they must be stable.
  const searchData = searchQuery.data;
  const searchError = searchQuery.error?.message;
  const foundHere = useMemo(
    () =>
      !settled
        ? null
        : searchData
          ? { nodes: searchToNodes(bucket.id, searchData), total: searchData.total, truncated: searchData.truncated }
          : searchError
            ? { error: searchError }
            : null,
    [settled, searchData, searchError, bucket.id],
  );
  const foundNodes = foundHere && "nodes" in foundHere ? foundHere.nodes : null;

  // Saved items and search hits can lie in folders nobody opened; they're selectable all
  // the same. A freshly listed node wins over a remembered one.
  const lookup = useMemo(
    () => new Map([...saved.nodes.values(), ...(foundNodes ?? []), ...remoteNodes].map((node) => [node.id, node])),
    [saved.nodes, foundNodes, remoteNodes],
  );

  const nodes = useMemo(() => {
    let source: StorageNode[];
    if (scope === "bucket") {
      // The server's results once they arrive; until then, matches among what's loaded.
      source = searching ? (foundNodes ?? searchBucket(bucket, query)) : nodesAt(bucket, path);
    } else if (scope === "recent") {
      source = saved.recent.map((id) => lookup.get(id)).filter((node): node is StorageNode => !!node);
    } else if (scope === "starred") {
      source = [...starred].map((id) => lookup.get(id)).filter((node): node is StorageNode => !!node);
    } else if (scope === "team") {
      source = [...saved.team].map((id) => lookup.get(id)).filter((node): node is StorageNode => !!node);
    } else {
      source = []; // Shared links are listed by their own view
    }

    if (scope !== "bucket" && searching) {
      const needle = query.trim().toLowerCase();
      source = source.filter((node) => node.name.toLowerCase().includes(needle));
    }
    if (filter !== "all") source = source.filter((node) => matchesFilter(node, filter, starred));
    // Recent keeps the order things were opened in; that order is the point of it.
    return scope === "recent" ? source : sortNodes(source, sort);
  }, [scope, searching, bucket, query, path, lookup, starred, sort, filter, foundNodes, saved.recent, saved.team]);

  const selectedNode = selectedId ? (lookup.get(selectedId) ?? null) : null;
  // Keep the last inspected object on screen while the docked inspector collapses.
  const [shownNode, setShownNode] = useState<StorageNode | null>(selectedNode);
  if (selectedNode && selectedNode !== shownNode) setShownNode(selectedNode);
  const starredCount = starred.size;
  // Share links this app serves: the sidebar counts the ones that still work.
  const sharesQuery = useQuery({ queryKey: keys.shares, queryFn: api.shares, staleTime: 60_000 });
  const sharedCount = sharesQuery.data?.filter((link) => link.state === "active").length ?? 0;
  const [shareFor, setShareFor] = useState<StorageNode | null>(null);
  const [zipFor, setZipFor] = useState<{ connection: RemoteConnection; request: ZipRequest } | null>(null);
  // Data files and lake tables: the preview, a table's details, and the pause before a
  // change that would break a table.
  const [dataPreview, setDataPreview] = useState<{ connectionId: string; key: string } | null>(null);
  // Space bar on a file: Quick Look, full size.
  const [quickLookId, setQuickLookId] = useState<string | null>(null);
  const [tableFor, setTableFor] = useState<LakeRoot | null>(null);
  const [tablePrompt, setTablePrompt] = useState<{ changes: TableChange[]; verb: string; proceed: () => void } | null>(null);
  // The Delta, Iceberg or Hudi table the open folder is, or sits in.
  const tableConnection = bucket.remote?.connectionId ?? "";
  const tablePrefix = prefixOf(path);
  const tableQuery = useQuery({
    queryKey: ["lake-table", tableConnection, tablePrefix],
    queryFn: () => api.table(tableConnection, tablePrefix),
    enabled: hasBucket && scope === "bucket" && Boolean(tableConnection),
    staleTime: 60_000,
    retry: false,
  });
  const currentTable: LakeRoot | null = hasBucket && scope === "bucket" ? (tableQuery.data?.table ?? null) : null;
  // Writing the open folder's note: which folder, so moving elsewhere closes the editor.
  const [noteEditingFor, setNoteEditingFor] = useState<string | null>(null);
  // The SQL console, with the query it opened with.
  const [sqlStart, setSqlStart] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const folderId = `${tableConnection}|${tablePrefix}`;
  // A listing only knows the level it fetched, so folder sizes aren't guessed at.
  const summary = useMemo(() => summarize(nodes, []), [nodes]);

  /* ---- Live folder: re-list every few seconds and mark what's new -------- */
  const [live, setLive] = useState(false);
  // What appeared, and when, in the folder being watched.
  const [fresh, setFresh] = useState<{ folder: string; at: Map<string, number> }>(() => ({ folder: "", at: new Map() }));

  /* ---- Live bucket listing ------------------------------------------- */
  const mainListing = useListing(bucket.id, path, hasBucket && scope === "bucket");
  const listingKey = hasBucket && scope === "bucket" ? `${bucket.id}|${prefixOf(path)}` : null;
  const listingLoading = Boolean(listingKey) && mainListing.isPending;
  const listing = !listingKey
    ? undefined
    : mainListing.isError
      ? { status: "error" as const, message: mainListing.error.message }
      : mainListing.data
        ? { status: "ok" as const, nextToken: mainListing.hasNextPage ? "more" : undefined }
        : undefined;

  // While live, the open folder re-lists every 5 seconds (not while the tab is hidden), and
  // anything that wasn't there before is marked new.
  useEffect(() => {
    if (!live || !listingKey) return;
    const folder = listingKey;
    const queryKey = keys.listing(bucket.id, prefixOf(path));
    const idsNow = () => {
      const data = queryClient.getQueryData<InfiniteData<RemoteListing>>(queryKey);
      if (!data) return null;
      const ids = new Set<string>();
      for (const page of data.pages) {
        for (const file of page.files) ids.add(`${bucket.id}:${file.key}`);
        for (const prefix of page.folders) ids.add(`${bucket.id}:${prefix.replace(/\/$/, "")}`);
      }
      return ids;
    };
    let known = idsNow();
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      await queryClient.refetchQueries({ queryKey, type: "active" });
      const now = idsNow();
      if (!now) return;
      if (!known) {
        known = now;
        return;
      }
      const seen = known;
      const arrived = [...now].filter((id) => !seen.has(id));
      known = new Set([...seen, ...now]);
      if (!arrived.length) return;
      const at = Date.now();
      setFresh((current) => ({
        folder,
        at: new Map([...(current.folder === folder ? current.at : []), ...arrived.map((id) => [id, at] as [string, number])]),
      }));
    }, LIVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [live, listingKey, bucket.id, path, queryClient]);

  // The highlight fades after a minute.
  const freshCount = fresh.at.size;
  useEffect(() => {
    if (!freshCount) return;
    const timer = window.setInterval(() => {
      setFresh((current) => {
        const cutoff = Date.now() - 60_000;
        const kept = [...current.at].filter(([, at]) => at > cutoff);
        return kept.length === current.at.size ? current : { folder: current.folder, at: new Map(kept) };
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [freshCount]);
  const freshIds = useMemo(() => new Set(live && fresh.folder === listingKey ? fresh.at.keys() : []), [live, fresh, listingKey]);

  function loadMore() {
    if (mainListing.hasNextPage && !mainListing.isFetchingNextPage) void mainListing.fetchNextPage();
  }

  const tree: FolderTreeModel = {
    isExpanded: (targetBucketId, at) => expanded.has(`${targetBucketId}|${prefixOf(at)}`),
    onToggle: (targetBucketId, at) => {
      const key = `${targetBucketId}|${prefixOf(at)}`;
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    onOpen: (targetBucketId, at) => openFolder(targetBucketId, at),
    onOpenFile: (node) => {
      setNavOpen(false);
      openLocation(node);
    },
    activePath: scope === "bucket" ? path : null,
    selectedId,
  };

  /** A folder's direct children once that level has been listed; undefined while it hasn't. */
  function contentsOf(folder: StorageNode | null): StorageNode[] | undefined {
    if (!folder || folder.kind !== "folder") return undefined;
    const inside = [...folder.path, folder.name];
    if (!queryClient.getQueryData(keys.listing(bucketIdOf(folder.id), prefixOf(inside)))) return undefined;
    return remoteNodes.filter(
      (node) => bucketIdOf(node.id) === bucketIdOf(folder.id) && node.path.join("/") === inside.join("/"),
    );
  }

  // However a folder gets selected (click on ⓘ, arrow keys), list what's in it for the inspector.
  const selectedFolder = selectedNode?.kind === "folder" ? selectedNode : null;
  useListing(
    selectedFolder ? bucketIdOf(selectedFolder.id) : "",
    selectedFolder ? [...selectedFolder.path, selectedFolder.name] : [],
    Boolean(selectedFolder),
  );

  /** Re-list the folder on screen from its first page. */
  function refreshListing() {
    if (!listingKey) return;
    void queryClient.resetQueries({ queryKey: keys.listing(bucket.id, prefixOf(path)) });
  }

  // Saved connections come back from the encrypted cookie on every visit.
  const restoreConnections = useEffectEvent((list: RemoteConnection[]) => {
    if (!list.length) return;
    const fromUrl = parseLocation(window.location.search);
    const home: Location = { scope: "bucket", bucketId: bucketIdFor(list[0]), path: [] };
    const location: Location = !fromUrl
      ? home
      : fromUrl.scope !== "bucket"
        ? { ...fromUrl, bucketId: home.bucketId }
        : list.some((connection) => bucketIdFor(connection) === fromUrl.bucketId)
          ? fromUrl
          : home;
    const owner = list.find((connection) => bucketIdFor(connection) === location.bucketId) ?? list[0];
    setOpenProviders((open) => [owner.id, ...open]);
    navigate(location, "replace");
  });

  // Back / Forward: the URL is the source of truth for where you are.
  const onPopState = useEffectEvent((event: PopStateEvent) => {
    const location = parseLocation(window.location.search);
    const fallback = connections[0];
    const home: Location = { scope: "bucket", bucketId: fallback ? bucketIdFor(fallback) : "", path: [] };
    applyLocation(
      !location
        ? home
        : location.scope !== "bucket"
          ? // Quick-access views keep whichever bucket was last on screen behind them.
            { ...location, bucketId: bucketId || home.bucketId, path }
          : connections.some((connection) => bucketIdFor(connection) === location.bucketId)
            ? location
            : home,
    );
    const idx = (event.state as { jvinuIdx?: number } | null)?.jvinuIdx;
    setNavIndex(typeof idx === "number" ? idx : 0);
  });

  useEffect(() => {
    const handler = (event: PopStateEvent) => onPopState(event);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Where to start, once the connections first arrive (the URL may name a deep folder).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !connectionsQuery.data) return;
    restored.current = true;
    restoreConnections(connectionsQuery.data);
  }, [connectionsQuery.data]);
  // Most likely JVINU_SECRET is missing on the server: say so rather than hang.
  const connectionsError = connectionsQuery.error?.message;

  const crossBucket = scope !== "bucket" || searching;

  useEffect(() => {
    if (creatingFolder) folderInputRef.current?.focus();
  }, [creatingFolder]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Reads the latest state on every key press without re-binding the listener.
  const onWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (addProviderOpen || dialog || quickLookId || dataPreview || tableFor || tablePrompt || sqlStart !== null || compareOpen) return;
    const target = event.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }

    if (event.key === "ArrowUp" && (event.metaKey || event.altKey) && !typing) {
      event.preventDefault();
      goUp();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !typing && nodes.length) {
      event.preventDefault();
      onCheckAll(true);
      return;
    }

    if (event.key === "Escape") {
      if (typing) {
        target?.blur();
        return;
      }
      // One Esc, one dismissal: the drawer, then the bulk selection, then the inspector.
      if (navOpen) {
        setNavOpen(false);
        return;
      }
      if (checked.size) {
        setChecked(new Set());
        return;
      }
      setSelectedId(null);
      return;
    }

    if (typing) return;
    // Only drive the listing from a row or from nowhere in particular — never
    // hijack arrows or Enter while a sidebar control or button has focus.
    const rowId = target?.dataset?.nodeId;
    if (!rowId && target !== document.body) return;

    if (event.key === " ") {
      const node = lookup.get(rowId ?? selectedId ?? "");
      if (!node || node.kind !== "file") return;
      event.preventDefault();
      setSelectedId(node.id);
      setQuickLookId(node.id);
      return;
    }

    if (event.key === "Enter") {
      const node = lookup.get(rowId ?? selectedId ?? "");
      if (!node) return;
      event.preventDefault();
      openNode(node);
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!nodes.length) return;

    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const current = nodes.findIndex((node) => node.id === (rowId ?? selectedId));
    const next = current === -1 ? (step === 1 ? 0 : nodes.length - 1) : current + step;
    const clamped = Math.max(0, Math.min(nodes.length - 1, next));
    setSelectedId(nodes[clamped].id);
    // Move focus with the selection so the highlighted row is the one that
    // Enter opens, and bring it into view.
    const row = document.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(nodes[clamped].id)}"]`,
    );
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => onWindowKeyDown(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /** Put the view somewhere, without touching history. */
  function applyLocation(location: Location) {
    setChecked(new Set());
    checkAnchor.current = null;
    if (location.scope === "bucket" && location.bucketId) {
      setExpanded((current) => {
        const next = new Set(current);
        for (let depth = 0; depth <= location.path.length; depth++) {
          next.add(`${location.bucketId}|${prefixOf(location.path.slice(0, depth))}`);
        }
        return next;
      });
    }
    setScope(location.scope);
    setBucketId(location.bucketId);
    setPath(location.path);
    setQuery("");
    setSelectedId(null);
    setCreatingFolder(false);
  }

  /** Every move goes through here, so Back, Forward and reload all know where you were. */
  function navigate(location: Location, mode: "push" | "replace" = "push") {
    applyLocation(location);
    const url = urlFor(location);
    // Re-opening where you already are shouldn't stack duplicate history entries.
    if (mode === "replace" || url === (window.location.search || window.location.pathname)) {
      window.history.replaceState({ jvinuIdx: navIndex }, "", url);
      return;
    }
    const next = navIndex + 1;
    window.history.pushState({ jvinuIdx: next }, "", url);
    setNavIndex(next);
    setNavTop(next);
  }

  function goTo(nextPath: string[]) {
    navigate({ scope: "bucket", bucketId, path: nextPath });
  }

  function goUp() {
    if (scope === "bucket" && path.length) goTo(path.slice(0, -1));
  }

  function openBucket(nextBucketId: string, mode: "push" | "replace" = "push") {
    setNavOpen(false);
    navigate({ scope: "bucket", bucketId: nextBucketId, path: [] }, mode);
  }

  function openFolder(targetBucketId: string, folderPath: string[]) {
    setNavOpen(false);
    navigate({ scope: "bucket", bucketId: targetBucketId, path: folderPath });
  }

  function openScope(nextScope: Exclude<Scope, "bucket">) {
    setNavOpen(false);
    navigate({ scope: nextScope, bucketId, path });
  }

  function openNode(node: StorageNode) {
    if (node.kind !== "folder") {
      setSelectedId(node.id);
      return;
    }
    navigate({ scope: "bucket", bucketId: bucketIdOf(node.id), path: [...node.path, node.name] });
  }

  /** A key in a bucket, from a link: a folder opens, a file is selected in its folder. */
  function openKeyIn(targetBucketId: string, key: string) {
    const parts = key.replace(/\/$/, "").split("/").filter(Boolean);
    if (key.endsWith("/") || !key) navigate({ scope: "bucket", bucketId: targetBucketId, path: parts });
    else {
      navigate({ scope: "bucket", bucketId: targetBucketId, path: parts.slice(0, -1) });
      setSelectedId(`${targetBucketId}:${key}`);
    }
  }

  function openLocation(node: StorageNode) {
    navigate({ scope: "bucket", bucketId: bucketIdOf(node.id), path: node.path });
    setSelectedId(node.id);
  }

  /** Inspect a folder without entering it. */
  function inspectFolder(node: StorageNode) {
    // Selecting it is enough: the inspector's listing query fetches its contents.
    setSelectedId(node.id);
  }

  function changeSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" || key === "type" ? "asc" : "desc" },
    );
  }

  async function signOut() {
    await api.logout().catch(() => {});
    // A full page load on purpose: it drops all in-memory state, CSRF token included.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }

  /* ---- Selection, operations, read-only ------------------------------------------ */

  const readOnly = Boolean(activeConnection?.readOnly);
  const canDrop = scope === "bucket" && hasBucket && !readOnly && !diskFull;

  // A file dropped anywhere else (sidebar, dialogs) would make the browser open it and
  // leave the app; swallow those.
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  function onCheck(node: StorageNode, range: boolean) {
    setChecked((current) => {
      const next = new Set(current);
      const anchorIndex = checkAnchor.current ? nodes.findIndex((item) => item.id === checkAnchor.current) : -1;
      const index = nodes.findIndex((item) => item.id === node.id);
      if (range && anchorIndex !== -1 && index !== -1) {
        // Shift-click: everything between the last click and this one takes this one's state.
        const on = !current.has(node.id);
        for (let i = Math.min(anchorIndex, index); i <= Math.max(anchorIndex, index); i++) {
          if (on) next.add(nodes[i].id);
          else next.delete(nodes[i].id);
        }
      } else if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
    checkAnchor.current = node.id;
  }

  function onCheckAll(all: boolean) {
    setChecked(all ? new Set(nodes.map((node) => node.id)) : new Set());
    checkAnchor.current = null;
  }

  const checkedNodes = nodes.filter((node) => checked.has(node.id));
  const itemsOf = (list: StorageNode[]): OperationItem[] => list.map((node) => ({ key: keyOf(node), kind: node.kind }));

  /**
   * After a change, re-list this bucket from scratch: cheaper than tracking every key.
   * Folders on screen re-list at once; the rest drop their stale copy and list when next shown.
   */
  function invalidateBucket(targetBucketId: string) {
    void queryClient.resetQueries({ queryKey: keys.bucketListings(targetBucketId) });
    void queryClient.invalidateQueries({ queryKey: keys.connectionSearches(connectionIdOf(targetBucketId)) });
    void queryClient.invalidateQueries({ queryKey: ["lake-table", connectionIdOf(targetBucketId)] });
    setChecked(new Set());
  }

  /**
   * Starts the operation as a background job. Quick problems (a name clash, moving a folder
   * into itself) throw with the server's message, so the open dialog can show it; the rest
   * is followed in the tasks tray. One that touches a data-lake table asks first.
   */
  function runOperation(request: OperationRequest, verb: string) {
    const targetBucket = bucket;
    return withTableCheck(
      async (acknowledgeTables) => {
        const job = await api.operation(targetBucket.remote.connectionId, request, acknowledgeTables);
        follow(job, { bucketId: targetBucket.id, verb });
        if (request.op !== "copy" && request.op !== "metadata") setSelectedId(null);
        setChecked(new Set());
      },
      TABLE_VERBS[request.op],
      setTablePrompt,
      setToast,
    );
  }

  /** A copy to another connection started: follow it, and re-list the other side when it ends. */
  function followTransfer(job: Job, targetConnectionId: string) {
    const target = connections.find((connection) => connection.id === targetConnectionId);
    follow(job, { bucketId: target ? bucketIdFor(target) : "", verb: "Copied" });
    setChecked(new Set());
  }

  /** Copies the selection into a folder on another connection, pausing first if that's inside a table. */
  function runTransfer(items: OperationItem[], targetConnectionId: string, destination: string) {
    return withTableCheck(
      async (acknowledgeTables) => {
        const { job } = await api.transfer(bucket.remote.connectionId, { targetConnectionId, items, destination, acknowledgeTables });
        followTransfer(job, targetConnectionId);
      },
      "Copy",
      setTablePrompt,
      setToast,
    );
  }

  /** A job ended: re-list what it touched and say how it went. */
  function finishJob(job: Job, meta: JobMeta | undefined) {
    if (job.op === "share-copy") {
      void queryClient.invalidateQueries({ queryKey: keys.shares });
      const bucketConnection = connections.find((connection) => connection.settings.shareTarget);
      if (bucketConnection) invalidateBucket(bucketIdFor(bucketConnection));
      setToast(
        job.status === "done"
          ? "Copied to the share bucket — the link now serves the copy"
          : `${job.status === "cancelled" ? "Copy cancelled" : (job.error ?? "The copy failed")} — the link serves the original`,
      );
      return;
    }
    const touched = connections.find((connection) => connection.id === job.connectionId);
    invalidateBucket(meta?.bucketId ?? (touched ? bucketIdFor(touched) : ""));
    void queryClient.invalidateQueries({ queryKey: keys.items });
    refreshDisks();
    setToast(jobOutcome(job, meta?.verb));
  }

  function openAction(action: "rename" | "move" | "copy" | "delete" | "metadata", target: StorageNode[]) {
    if (!target.length || readOnly) return;
    if (action === "rename") setDialog({ kind: "rename", node: target[0] });
    else if (action === "delete") setDialog({ kind: "delete", nodes: target });
    else if (action === "metadata") setDialog({ kind: "metadata", nodes: target });
    else setDialog({ kind: action, nodes: target });
  }

  async function toggleReadOnly(id: ProviderId) {
    const connection = connections.find((item) => item.id === id);
    if (!connection) return;
    try {
      const updated = await api.update(id, { readOnly: !connection.readOnly });
      setConnections((current) => current.map((item) => (item.id === id ? updated : item)));
      setToast(updated.readOnly ? `${updated.name} is now read-only` : `Changes allowed on ${updated.name}`);
    } catch (error) {
      setToast((error as Error).message);
    }
  }

  function toggleProvider(id: ProviderId) {
    setOpenProviders((open) =>
      open.includes(id) ? open.filter((item) => item !== id) : [...open, id],
    );
  }

  /** Throws with a readable message; the dialog shows it and stays open. */
  async function connectProvider(values: ConnectValues) {
    // The dialog already speaks the server's field names for the chosen cloud.
    const { readOnly: readOnlyFlag, providerEncryption, encrypt, ...fields } = values;
    const connection = await api.create({
      ...fields,
      readOnly: readOnlyFlag === "true",
      providerEncryption: providerEncryption === "true",
      encrypt: encrypt === "true",
    });
    setConnections((current) => [...current, connection]);
    setOpenProviders((open) => [...open, connection.id]);
    setAddProviderOpen(false);
    // From the empty "nothing connected" screen there's nothing worth going Back to.
    openBucket(bucketIdFor(connection), hasBucket ? "push" : "replace");
    setToast(`${connection.name} connected — ${connection.bucket} ${whereIs(connection)}`);
  }

  function leaveIfShowing(target: { buckets: { id: string }[] }, remaining: { buckets: { id: string }[] }[]) {
    if (!target.buckets.some((item) => item.id === bucketId)) return;
    const fallback = remaining.flatMap((provider) => provider.buckets)[0];
    navigate({ scope: "bucket", bucketId: fallback ? fallback.id : "", path: [] }, "replace");
  }

  function deleteProvider(id: ProviderId) {
    const target = providers.find((provider) => provider.id === id);
    if (!target) return;
    const remaining = providers.filter((provider) => provider.id !== id);

    api
      .remove(id)
      .then(() => {
        setConnections((current) => current.filter((connection) => connection.id !== id));
        queryClient.removeQueries({ queryKey: keys.bucketListings(bucketIdFor(target as unknown as RemoteConnection)) });
        queryClient.removeQueries({ queryKey: keys.connectionSearches(id) });
        setOpenProviders((open) => open.filter((openId) => openId !== id));
        leaveIfShowing(target, remaining);
        setToast(`${target.name} disconnected — its keys were removed from this browser`);
      })
      .catch((error: Error) => setToast(error.message));
  }

  /** The connection and key a node belongs to, for saving it. */
  function addressOf(node: StorageNode) {
    const owner = connections.find((connection) => bucketIdFor(connection) === bucketIdOf(node.id));
    return owner ? { connectionId: owner.id, key: keyOf(node), owner } : null;
  }

  /**
   * Save or forget an item: on screen at once, on the server in the background — and
   * put back if the server refuses.
   */
  function saveItem(kind: SavedItem["kind"], node: StorageNode, on: boolean, extra: Partial<SavedItem["meta"]> = {}) {
    const address = addressOf(node);
    if (!address) return;
    const { connectionId, key } = address;
    const same = (item: SavedItem) => item.kind === kind && item.connectionId === connectionId && item.key === key;
    const before = items;
    const item: SavedItem = { kind, connectionId, key, meta: { ...metaOf(node), ...extra }, at: new Date().toISOString() };
    setItems((current) => (on ? [item, ...current.filter((other) => !same(other))] : current.filter((other) => !same(other))));
    api.setItem({ kind, connectionId, key, on, meta: item.meta }).catch(() => {
      setItems(before);
      setToast(on ? "Couldn't save that — try again" : "Couldn't remove that — try again");
    });
  }

  function toggleStar(id: string) {
    const node = lookup.get(id);
    if (node) saveItem("star", node, !starred.has(id));
  }

  function toggleTeamPin(id: string) {
    const node = lookup.get(id);
    if (!node) return;
    const on = !saved.team.has(id);
    saveItem("team", node, on);
    setToast(on ? `Pinned “${node.name}” for the team` : `Unpinned “${node.name}”`);
  }

  function openShare(id: string) {
    const node = lookup.get(id);
    if (node && addressOf(node)) setShareFor(node);
  }

  /** One download for several files or folders, from one connection. */
  function openZip(targets: StorageNode[]) {
    const owners = targets.map((node) => addressOf(node)?.owner);
    const owner = owners[0];
    if (!owner || owners.some((item) => item?.id !== owner.id)) {
      setToast("Choose files from one connection at a time to zip them");
      return;
    }
    const items = targets.map((node) => ({ key: keyOf(node), kind: node.kind }));
    // Paths in the archive start at the folder everything was picked in.
    const parentOf = (key: string) => key.slice(0, key.replace(/\/$/, "").lastIndexOf("/") + 1);
    let base = parentOf(items[0].key);
    for (const item of items) while (!item.key.startsWith(base)) base = parentOf(base);
    const single = targets.length === 1 ? targets[0].name : null;
    const folderName = base ? base.replace(/\/$/, "").split("/").pop()! : owner.bucket.split("/").filter(Boolean).pop() || owner.name;
    setZipFor({ connection: owner, request: { items, base, name: single ?? folderName } });
  }

  /** A shared file, shown in its folder. */
  function revealLink(link: ShareLink) {
    const target = bucketIdByConnection.get(link.connectionId);
    if (!target) {
      setToast("That file's connection has been removed");
      return;
    }
    openLocation(fileNode(target, { key: link.key, size: link.size ?? 0, lastModified: null, etag: null, storageClass: null }));
  }

  // A file that stays open in the inspector for a moment counts as recently opened —
  // arrowing past it doesn't.
  const recordRecent = useEffectEvent((node: StorageNode) => saveItem("recent", node, true));
  useEffect(() => {
    if (!selectedId) return;
    const node = lookup.get(selectedId);
    if (!node || node.kind !== "file") return;
    const timer = window.setTimeout(() => recordRecent(node), 1200);
    return () => window.clearTimeout(timer);
    // Only a change of selection restarts the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function handleUpload(list: PickedFile[], acknowledgeTables = false) {
    if (!list.length || readOnly) return;
    if (currentTable && !acknowledgeTables) {
      const name = currentTable.root.replace(/\/$/, "").split("/").pop() || "/";
      setTablePrompt({
        changes: [
          {
            key: prefixOf(path),
            table: currentTable,
            relation: "into",
            message: `This folder is inside the ${LAKE_LABELS[currentTable.format]} “${name}”. Files added here aren't part of the table, and the next VACUUM may delete them.`,
          },
        ],
        verb: "Upload",
        proceed: () => handleUpload(list, true),
      });
      return;
    }
    if (diskFull) {
      setToast(`${activeConnection?.name ?? "This storage"} is full — free up space to upload`);
      return;
    }
    if (list.length > MAX_BATCH) {
      setToast(`That's over ${MAX_BATCH.toLocaleString("en-US")} files — upload it a folder at a time`);
      return;
    }
    const target = bucket;
    const at = path;
    const batch = list.map(({ file, path: relative }, index) => ({
      file,
      relative,
      item: {
        id: `${Date.now()}-${index}-${relative}`,
        name: relative,
        size: file.size,
        loaded: 0,
        status: "queued" as UploadItem["status"],
      },
    }));
    setScope("bucket");
    setQuery("");
    setUploads((current) => [...current.filter((item) => item.status === "uploading" || item.status === "queued"), ...batch.map((b) => b.item)]);

    const patch = (id: string, change: Partial<UploadItem>) =>
      setUploads((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));

    // Three at a time: enough to fill the pipe without starving the page.
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const { file, relative, item } = batch[next++];
        patch(item.id, { status: "uploading" });
        const transfer = api.upload(
          target.remote.connectionId,
          `${prefixOf(at)}${relative}`,
          file,
          (loaded) => patch(item.id, { loaded }),
          acknowledgeTables,
        );
        uploadCancels.current.set(item.id, transfer.cancel);
        try {
          await transfer.done;
          patch(item.id, { status: "done", loaded: file.size });
        } catch (error) {
          patch(item.id, { status: "error", error: (error as Error).message });
        } finally {
          uploadCancels.current.delete(item.id);
        }
      }
    };
    void Promise.all([worker(), worker(), worker()]).then(() => {
      refreshDisks();
      // The server noted each upload as recent.
      void queryClient.invalidateQueries({ queryKey: keys.items });
      void queryClient.invalidateQueries({ queryKey: keys.connectionSearches(target.remote.connectionId) });
      // This folder and any it gained below — dropped folders land as subfolders.
      const under = prefixOf(at);
      void queryClient.invalidateQueries({
        predicate: (cached) =>
          cached.queryKey[0] === "listing" && cached.queryKey[1] === target.id && String(cached.queryKey[2]).startsWith(under),
      });
    });
  }

  function commitFolder() {
    const name = folderName.trim().replace(/\/+$/, "");
    if (!name) {
      setCreatingFolder(false);
      return;
    }
    setFolderName("");
    setCreatingFolder(false);

    api
        .folder(bucket.remote.connectionId, prefixOf(path), name)
        .then(() => {
          refreshListing();
          setToast(`Folder “${name}” created`);
        })
        .catch((error: Error) => setToast(`Couldn't create the folder — ${error.message}`));
  }

  const connectionHealth: ConnectionHealth | null = (() => {
    const measured = activeConnection ? health[activeConnection.id] : undefined;
    if (!activeConnection || !measured) return null;
    return {
      name: activeConnection.name,
      target: targetOf(activeConnection),
      ...measured,
    };
  })();

  const scopeIcon = scope === "bucket" ? null : SCOPE_ICONS[scope];
  const heading = scope === "bucket" ? bucket.title : SCOPE_LABELS[scope];

  const sidebar = (
    <Sidebar
      providers={providers}
      openProviders={openProviders}
      onToggleProvider={toggleProvider}
      onAddProvider={() => setAddProviderOpen(true)}
      onDeleteProvider={deleteProvider}
      scope={scope}
      onScopeChange={openScope}
      activeBucketId={bucketId}
      onBucketSelect={openBucket}
      starredCount={starredCount}
      teamCount={saved.team.size}
      sharedCount={sharedCount}
      user={user}
      onSignOut={signOut}
      onToggleReadOnly={toggleReadOnly}
      onOpenSettings={(id) => setSettingsFor(id)}
      tree={tree}
      disks={disks}
    />
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <ThemeSync />
      <div className="hidden lg:block">{sidebar}</div>

      {/* Mobile navigation drawer */}
      {navOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fade-in absolute inset-0 bg-black/25 backdrop-blur-[3px]"
          />
          <div className="drawer-in absolute inset-y-0 left-0 shadow-pop">{sidebar}</div>
        </div>
      ) : null}

      <main
        className="relative flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6"
        onDragEnter={(event) => {
          if (!hasFiles(event) || !canDrop) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = canDrop ? "copy" : "none";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!canDrop) {
            setToast(
              readOnly
                ? `${activeConnection?.name ?? "This connection"} is read-only`
                : diskFull
                  ? "Storage is full — free up space to upload"
                  : "Open a bucket to upload into it",
            );
            return;
          }
          void pickedFromDrop(event.dataTransfer).then(handleUpload, () =>
            setToast("Couldn't read what was dropped — try the Upload buttons"),
          );
        }}
      >
        {dragging ? (
          <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-3xl border-2 border-dashed border-accent bg-accent-soft/80 backdrop-blur-[2px]">
            <div className="text-center">
              <UploadIcon size={30} className="mx-auto text-accent-strong" />
              <p className="mt-2 text-[16px] font-semibold text-ink">Drop to upload</p>
              <p className="mt-0.5 text-[13px] text-ink-muted">
                Files and folders go into {[bucket.title, ...path].join(" / ")}
              </p>
            </div>
          </div>
        ) : null}
        {providers.length === 0 && !connectionsLoaded ? (
          <div className="flex flex-1 items-center justify-center" role="status">
            <RefreshIcon size={22} className="animate-spin text-ink-faint" />
            <span className="sr-only">Loading saved connections…</span>
          </div>
        ) : providers.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
            <Wordmark withTagline className="text-[34px] text-ink" />
            <div>
              <p className="text-[16px] font-semibold text-ink">No storage connected</p>
              <p className="mx-auto mt-1 max-w-[42ch] text-[13.5px] leading-relaxed text-ink-muted">
                Connect an Amazon S3 bucket — or a local emulator such as Floci, LocalStack or
                MinIO — to start browsing.
              </p>
            </div>
            {user.role === "admin" ? (
            <button
              type="button"
              onClick={() => setAddProviderOpen(true)}
              className="spring inline-flex items-center gap-2 rounded-full bg-accent-fill px-4 py-2 text-[14px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.97]"
            >
              <PlusIcon size={17} />
              Connect provider
            </button>
            ) : (
              <p className="text-[13px] text-ink-muted">Ask an admin of this server to connect storage.</p>
            )}
          </div>
        ) : (
          <>
          {/* Search */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation"
              className="material flex size-10 shrink-0 items-center justify-center rounded-full border border-line text-ink-muted shadow-card lg:hidden"
            >
              <MenuIcon size={18} />
            </button>

            <div className="relative flex min-w-0 flex-1 items-center">
              <SearchIcon
                size={16}
                className="pointer-events-none absolute left-3.5 z-10 text-ink-faint"
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedId(null);
                }}
                type="search"
                placeholder={
                  scope === "bucket"
                    ? "Search this bucket — name, prefix, or type…"
                    : `Search ${SCOPE_LABELS[scope].toLowerCase()} by name…`
                }
                aria-label={
                  scope === "bucket"
                    ? `Search ${bucket.name} by name, prefix, or type`
                    : `Search ${SCOPE_LABELS[scope].toLowerCase()} by name`
                }
                className="material h-10 w-full rounded-full border border-line pl-10 pr-16 text-[14px] text-ink shadow-card outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 flex size-7 items-center justify-center rounded-full text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
                >
                  <CloseIcon size={16} />
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-2.5 hidden rounded-md border border-line bg-surface-sunken px-1.5 py-0.5 font-sans text-[11px] font-medium text-ink-faint sm:block">
                  {modifier}K
                </kbd>
              )}
            </div>

            {connectionHealth ? (
              <span
                className="hidden shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-raised/60 px-2.5 py-1 text-[12px] font-medium text-ink-muted md:flex"
                title={connectionHealth.message ?? `Last listing answered in ${connectionHealth.ms} ms`}
              >
                <span className="relative flex size-2" aria-hidden="true">
                  {connectionHealth.ok ? <span className="pulse-dot absolute inset-0 rounded-full bg-success/50" /> : null}
                  <span className={`relative size-2 rounded-full ${connectionHealth.ok ? "bg-success" : "bg-danger"}`} />
                </span>
                <span className="tnum">
                  {connectionHealth.ok ? `${connectionHealth.target} · ${connectionHealth.ms} ms` : "Unreachable"}
                </span>
              </span>
            ) : null}

            <div
              className="relative"
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !bellOpen) return;
                event.stopPropagation();
                setBellOpen(false);
              }}
            >
              <button
                type="button"
                onClick={() => setBellOpen((open) => !open)}
                onBlur={(event) => {
                  if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setBellOpen(false);
                }}
                aria-label="Notifications"
                aria-expanded={bellOpen}
                className="material spring flex size-10 shrink-0 items-center justify-center rounded-full border border-line text-ink-muted shadow-card transition hover:text-ink active:scale-[0.95]"
              >
                <BellIcon size={17} />
              </button>
              {bellOpen ? (
                <div className="material-thick absolute right-0 top-[calc(100%+0.5rem)] z-30 w-64 rounded-xl border border-line p-4 text-center shadow-pop">
                  <p className="text-[13px] font-semibold text-ink">You&rsquo;re all caught up</p>
                  <p className="mt-0.5 text-[12px] text-ink-muted">No new notifications.</p>
                </div>
              ) : null}
            </div>
          </div>

          {/* Path bar + title */}
          <div className="pt-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="History">
                {(
                  [
                    { label: "Back", icon: <ArrowLeftIcon size={14} />, enabled: navIndex > 0, run: () => window.history.back() },
                    {
                      label: "Forward",
                      icon: <ArrowLeftIcon size={14} className="rotate-180" />,
                      enabled: navIndex < navTop,
                      run: () => window.history.forward(),
                    },
                    {
                      label: `Up to the enclosing folder (${modifier.trim() === "⌘" ? "⌘↑" : "Alt+↑"})`,
                      icon: <ArrowUpIcon size={14} />,
                      enabled: scope === "bucket" && path.length > 0,
                      run: goUp,
                    },
                  ] as const
                ).map((control) => (
                  <button
                    key={control.label}
                    type="button"
                    onClick={control.run}
                    disabled={!control.enabled}
                    aria-label={control.label}
                    title={control.label}
                    className="spring flex size-7 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface-sunken hover:text-ink active:scale-[0.92] disabled:pointer-events-none disabled:opacity-35"
                  >
                    {control.icon}
                  </button>
                ))}
              </div>
              <div className="min-w-0 flex-1">
              {scope === "bucket" && searching ? (
                <p className="text-[13px] text-ink-muted" aria-live="polite">
                  {!foundHere
                    ? "Searching all of"
                    : "error" in foundHere
                      ? `Search failed (${foundHere.error}) — showing matches in opened folders of`
                      : foundHere.total > foundHere.nodes.filter((node) => node.kind === "file").length
                        ? `First ${foundHere.nodes.filter((node) => node.kind === "file").length.toLocaleString("en-US")} of ${foundHere.total.toLocaleString("en-US")} matching files in`
                        : `${foundHere.total.toLocaleString("en-US")} matching file${foundHere.total === 1 ? "" : "s"} in`}{" "}
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="font-medium text-accent-strong hover:underline hover:underline-offset-2"
                  >
                    {bucket.name}
                  </button>
                  {foundHere && "truncated" in foundHere && foundHere.truncated ? " — the first 100,000 objects were searched." : "."}
                </p>
              ) : scope === "bucket" ? (
                <nav aria-label="Breadcrumb" className="-ml-2 flex flex-wrap items-center text-[13px]">
                  <button
                    type="button"
                    onClick={() => goTo([])}
                    className={`spring flex items-center gap-1.5 rounded-md px-2 py-1.5 transition hover:bg-surface-sunken ${
                      path.length ? "text-ink-muted" : "font-semibold text-ink"
                    }`}
                  >
                    <FolderIcon size={15} className="text-accent" />
                    {bucket.name}
                  </button>
                  {path.map((segment, index) => (
                    <span key={`${segment}-${index}`} className="flex items-center">
                      <ChevronRight size={13} className="text-ink-faint" />
                      <button
                        type="button"
                        onClick={() => goTo(path.slice(0, index + 1))}
                        className={`spring rounded-md px-2 py-1.5 transition hover:bg-surface-sunken ${
                          index === path.length - 1 ? "font-semibold text-ink" : "text-ink-muted"
                        }`}
                      >
                        {segment}
                      </button>
                    </span>
                  ))}
                </nav>
              ) : (
                <p className="text-[13px] text-ink-muted">
                  {scope === "recent"
                    ? "Files you opened or uploaded, newest first."
                    : scope === "starred"
                      ? "Objects you pinned for quick access."
                      : scope === "team"
                        ? "Pinned for everyone on this server — the files and folders your team keeps coming back to."
                      : "Links you've shared: how often each was downloaded, and a way to turn it off."}
                </p>
              )}
              </div>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="flex min-w-0 items-center gap-2.5 text-[26px] font-bold leading-tight tracking-[-0.022em] text-ink">
                {scopeIcon ? (
                  <span className="text-accent">{scopeIcon({ size: 24 })}</span>
                ) : (
                  <BucketIcon size={24} className="shrink-0 text-accent" />
                )}
                <span className="truncate">{heading}</span>
              </h1>
              {scope === "bucket" && activeConnection ? (
                <span className="rounded-full bg-surface-sunken px-2.5 py-1 text-[12px] font-medium text-ink-muted">
                  {targetOf(activeConnection)}
                </span>
              ) : null}
              {scope === "bucket" && readOnly ? (
                <span className="flex items-center gap-1 rounded-full bg-warning/15 px-2.5 py-1 text-[12px] font-semibold text-ink">
                  <LockIcon size={12} />
                  Read-only
                </span>
              ) : null}
            </div>
          </div>

          {scope === "bucket" && activeDisk && activeDisk.level !== "ok" ? (
            <div
              role={activeDisk.level === "full" ? "alert" : "status"}
              className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] text-ink ${
                activeDisk.level === "full" ? "border-danger/30 bg-danger/10" : "border-warning/40 bg-warning/10"
              }`}
            >
              <InfoIcon size={16} className={`mt-px shrink-0 ${activeDisk.level === "full" ? "text-danger" : "text-warning"}`} />
              <p>
                <span className="font-semibold">
                  {activeConnection?.name} is {Math.floor(activeDisk.ratio * 100)}% full
                </span>{" "}
                — {formatBytes(activeDisk.available)} free of {formatBytes(activeDisk.total)}.{" "}
                {activeDisk.level === "full"
                  ? "Uploads and copies are paused until you delete something."
                  : `Uploads stop at ${Math.round(activeDisk.blockAt * 100)}%; delete what you don't need, or move it to another provider.`}
              </p>
            </div>
          ) : null}

          {/* Toolbar */}
          {scope === "shared" ? null : (
          <div className="flex flex-wrap items-center gap-2">
            {scope === "bucket" && !readOnly ? (
              <>
                <input
                  ref={uploadRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files) handleUpload(pickedFromList(event.target.files));
                    event.target.value = "";
                  }}
                />
                <input
                  ref={folderUploadRef}
                  type="file"
                  className="hidden"
                  // Not in React's types yet; every current browser supports picking a folder.
                  {...{ webkitdirectory: "" }}
                  onChange={(event) => {
                    if (event.target.files) handleUpload(pickedFromList(event.target.files));
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => uploadRef.current?.click()}
                  disabled={diskFull}
                  title={diskFull ? "Storage is full" : undefined}
                  className="spring inline-flex items-center gap-1.5 rounded-full bg-accent-fill px-4 py-2 text-[13.5px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
                >
                  <UploadIcon size={15} />
                  Upload
                </button>
                <button
                  type="button"
                  onClick={() => folderUploadRef.current?.click()}
                  disabled={diskFull}
                  title="Upload a whole folder, keeping its subfolders"
                  className="material spring inline-flex items-center gap-1.5 rounded-full border border-line-strong px-4 py-2 text-[13.5px] font-semibold text-ink shadow-card transition hover:bg-surface-raised active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderIcon size={15} />
                  Upload Folder
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // A folder made under an active search would be filtered out of view.
                    setQuery("");
                    setCreatingFolder(true);
                  }}
                  className="material spring inline-flex items-center gap-1.5 rounded-full border border-line-strong px-4 py-2 text-[13.5px] font-semibold text-ink shadow-card transition hover:bg-surface-raised active:scale-[0.97]"
                >
                  <PlusIcon size={15} />
                  New Folder
                </button>
              </>
            ) : null}

            {bucket.remote && scope === "bucket" && activeConnection ? (
              <button
                type="button"
                onClick={() => setAnalyticsOpen(true)}
                title="Size, cost per month and what's taking space"
                className={`material spring ${view === "grid" ? "" : "ml-auto "}inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-[13px] font-semibold text-ink shadow-card transition hover:bg-surface-raised active:scale-[0.97]`}
              >
                <ChartIcon size={15} className="text-accent-strong" />
                Analytics
              </button>
            ) : null}

            {bucket.remote && scope === "bucket" && activeConnection ? (
              <button
                type="button"
                onClick={() => setXrayOpen(true)}
                title="Hidden waste, public files and leaked secrets"
                className="material spring inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-[13px] font-semibold text-ink shadow-card transition hover:bg-surface-raised active:scale-[0.97]"
              >
                <XrayIcon size={15} className="text-accent-strong" />
                X-Ray
              </button>
            ) : null}

            {bucket.remote && scope === "bucket" && hasBucket ? (
              <button
                type="button"
                onClick={() => setLive((value) => !value)}
                aria-pressed={live}
                title={live ? "Stop watching this folder" : "Watch this folder: it re-lists every 5 seconds and marks new files"}
                className={TOOL_BUTTON}
              >
                {live ? <span className="live-dot size-2 rounded-full bg-success" aria-hidden="true" /> : <PulseIcon size={15} className="text-accent-strong" />}
                {live ? `Live${freshIds.size ? ` · ${freshIds.size} new` : ""}` : "Live"}
              </button>
            ) : null}

            {bucket.remote && scope === "bucket" && activeConnection ? (
              <button
                type="button"
                onClick={() =>
                  setSqlStart(
                    (currentTable
                      ? `-- This folder is a ${LAKE_LABELS[currentTable.format]}: its data files include older versions of the table,\n-- so totals here may not match what Spark or Databricks report.\n`
                      : "") + starterQuery(tablePrefix, nodes),
                  )
                }
                title="Query files in this bucket with SQL"
                className={TOOL_BUTTON}
              >
                <SqlIcon size={15} className="text-accent-strong" />
                SQL
              </button>
            ) : null}

            {bucket.remote && scope === "bucket" && activeConnection ? (
              <button type="button" onClick={() => setCompareOpen(true)} title="Compare this folder with another — here or on another cloud" className={TOOL_BUTTON}>
                <CompareIcon size={15} className="text-accent-strong" />
                <span className="hidden lg:inline">Compare</span>
              </button>
            ) : null}

            {bucket.remote && scope === "bucket" && hasBucket ? (
              <button
                type="button"
                onClick={() => setNoteEditingFor(folderId)}
                title="Leave a note on this folder for everyone who opens it"
                className={TOOL_BUTTON}
              >
                <NoteIcon size={15} className="text-accent-strong" />
                <span className="hidden lg:inline">Note</span>
              </button>
            ) : null}

            {bucket.remote && scope === "bucket" && activeConnection ? (
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                aria-label="History"
                title="Who changed what here, and when"
                className={TOOL_BUTTON}
              >
                <HistoryIcon size={15} className="text-accent-strong" />
                <span className="hidden lg:inline">History</span>
              </button>
            ) : null}

            {bucket.remote && scope === "bucket" ? (
              <button
                type="button"
                onClick={refreshListing}
                disabled={listingLoading}
                aria-label="Refresh listing"
                title="Refresh from S3"
                className={`material spring ${view === "grid" || activeConnection ? "" : "ml-auto "}flex size-9 items-center justify-center rounded-full border border-line text-ink-muted shadow-card transition hover:text-ink active:scale-[0.95] disabled:opacity-50`}
              >
                <RefreshIcon size={15} className={listingLoading ? "animate-spin" : ""} />
              </button>
            ) : null}

            {view === "grid" ? (
              <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-muted">
                <span className="hidden sm:inline">Sort</span>
                <select
                  value={`${sort.key}:${sort.dir}`}
                  onChange={(event) => {
                    const [key, dir] = event.target.value.split(":") as [SortKey, "asc" | "desc"];
                    setSort({ key, dir });
                  }}
                  className="material h-9 cursor-pointer rounded-full border border-line px-3 text-[13px] font-medium text-ink shadow-card outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
                >
                  <option value="name:asc">Name A–Z</option>
                  <option value="name:desc">Name Z–A</option>
                  <option value="modified:desc">Newest first</option>
                  <option value="modified:asc">Oldest first</option>
                  <option value="size:desc">Largest first</option>
                  <option value="size:asc">Smallest first</option>
                  <option value="type:asc">Type</option>
                </select>
              </label>
            ) : null}

            <div className={`${view === "grid" || (bucket.remote && scope === "bucket") ? "" : "ml-auto "}flex items-center gap-0.5 rounded-lg bg-surface-sunken p-0.5`}>
              {(
                [
                  ["grid", GridIcon, "Grid view"],
                  ["list", ListIcon, "List view"],
                ] as const
              ).map(([mode, Icon, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  aria-label={label}
                  aria-pressed={view === mode}
                  className={`spring flex h-8 w-10 items-center justify-center rounded-md transition active:scale-[0.95] ${
                    view === mode
                      ? "bg-surface-raised text-accent shadow-card"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  <Icon size={16} />
                </button>
              ))}
            </div>
          </div>
          )}

          {checked.size ? (
            <div
              role="toolbar"
              aria-label="Selected items"
              className="material-thick flex flex-wrap items-center gap-2 rounded-2xl border border-accent-ring px-3 py-2 shadow-card"
            >
              <span className="tnum px-1 text-[13px] font-semibold text-ink">
                {checkedNodes.length} selected
              </span>
              <span className="flex-1" />
              <button type="button" onClick={() => openZip(checkedNodes)} className={BULK_BUTTON}>
                Download zip
              </button>
              {readOnly ? (
                <span className="text-[12.5px] text-ink-muted">Read-only — changes are turned off</span>
              ) : (
                <>
                  <button type="button" onClick={() => openAction("copy", checkedNodes)} className={BULK_BUTTON}>
                    Copy to…
                  </button>
                  <button type="button" onClick={() => openAction("move", checkedNodes)} className={BULK_BUTTON}>
                    Move to…
                  </button>
                  {checkedNodes.length === 1 ? (
                    <button type="button" onClick={() => openAction("rename", checkedNodes)} className={BULK_BUTTON}>
                      Rename
                    </button>
                  ) : null}
                  <button type="button" onClick={() => openAction("metadata", checkedNodes)} className={BULK_BUTTON}>
                    Metadata…
                  </button>
                  <button type="button" onClick={() => openAction("delete", checkedNodes)} className={`${BULK_BUTTON} text-danger`}>
                    Delete
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => onCheckAll(false)}
                aria-label="Clear selection"
                className="flex size-8 items-center justify-center rounded-full text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
              >
                <CloseIcon size={15} />
              </button>
            </div>
          ) : null}

          {/* Quick filters */}
          {scope === "shared" ? null : (
          <div role="radiogroup" aria-label="Filter objects" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {QUICK_FILTERS.map((item) => {
              const active = filter === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setFilter(item.id);
                    setSelectedId(null);
                  }}
                  className={`spring shrink-0 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition active:scale-[0.95] ${
                    active
                      ? "border-transparent bg-ink text-canvas"
                      : "border-line bg-surface-raised/60 text-ink-muted hover:bg-surface-raised hover:text-ink"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          )}

          {currentTable && !searching ? (
            <LakeBanner table={currentTable} prefix={tablePrefix} onDetails={() => setTableFor(currentTable)} />
          ) : null}

          {scope === "bucket" && hasBucket && !searching ? (
            <FolderNoteCard
              connectionId={tableConnection}
              prefix={tablePrefix}
              editing={noteEditingFor === folderId}
              onEditingChange={(editing) => setNoteEditingFor(editing ? folderId : null)}
              onNotify={setToast}
            />
          ) : null}
          {scope === "bucket" && hasBucket && !searching && readmeOf(nodes) ? (
            <FolderReadme
              key={readmeOf(nodes)!.id}
              connectionId={tableConnection}
              node={readmeOf(nodes)!}
              onOpenKey={(key) => openKeyIn(bucket.id, key)}
            />
          ) : null}

          {/* Listing */}
          <section className="material flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line shadow-panel">
            {creatingFolder ? (
              <div className="flex items-center gap-3 border-b border-line bg-accent-soft px-5 py-3">
                <FolderIcon size={18} className="shrink-0 text-accent" />
                <input
                  ref={folderInputRef}
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitFolder();
                    if (event.key === "Escape") {
                      setCreatingFolder(false);
                      setFolderName("");
                    }
                  }}
                  placeholder="Folder name"
                  aria-label="New folder name"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[14px] outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
                />
                <button
                  type="button"
                  onClick={commitFolder}
                  className="spring inline-flex items-center gap-1.5 rounded-full bg-accent-fill px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.97]"
                >
                  <CheckIcon size={14} />
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreatingFolder(false);
                    setFolderName("");
                  }}
                  className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-muted hover:bg-surface-sunken"
                >
                  Cancel
                </button>
              </div>
            ) : null}

            <div ref={listScrollRef} className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
              {scope === "shared" ? (
                <div className="p-3">
                  <SharedLinksView connections={connections} query={query} onReveal={revealLink} onNotify={setToast} />
                </div>
              ) : listingLoading ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-16 text-center" role="status">
                  <RefreshIcon size={22} className="animate-spin text-ink-faint" />
                  <p className="text-[13.5px] text-ink-muted">
                    Listing {`${[bucket.name, ...path].join("/")}/`}…
                  </p>
                </div>
              ) : listing?.status === "error" ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-16 text-center" role="alert">
                  <p className="text-[15px] font-semibold text-ink">Couldn&rsquo;t list this folder</p>
                  <p className="max-w-[42ch] text-[13.5px] text-ink-muted">{listing.message}</p>
                  <button
                    type="button"
                    onClick={refreshListing}
                    className="spring mt-1 rounded-full border border-line-strong px-3.5 py-1.5 text-[13px] font-medium text-accent-strong transition hover:bg-accent-soft active:scale-[0.97]"
                  >
                    Try again
                  </button>
                </div>
              ) : nodes.length === 0 && scope === "bucket" && searching && !foundHere ? (
                // The server is still searching the whole bucket: not "no matches" yet.
                <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-16 text-center" role="status">
                  <RefreshIcon size={22} className="animate-spin text-ink-faint" />
                  <p className="text-[13.5px] text-ink-muted">Searching all of {bucket.name}…</p>
                </div>
              ) : nodes.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-16 text-center">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-surface-sunken text-ink-faint">
                    <SearchIcon size={22} />
                  </span>
                  <p className="text-[15px] font-semibold text-ink">
                    {filter !== "all"
                      ? `Nothing here matches “${QUICK_FILTERS.find((item) => item.id === filter)?.label}”`
                      : searching
                      ? `No objects match “${query.trim()}”`
                      : scope !== "bucket"
                        ? `Nothing in ${SCOPE_LABELS[scope]} yet`
                        : path.length
                          ? "This folder is empty"
                          : "This bucket is empty"}
                  </p>
                  <p className="max-w-[34ch] text-[13.5px] text-ink-muted">
                    {searching
                      ? "Try a different name, extension, or path fragment."
                      : scope === "starred"
                        ? "Star an object from any bucket and it will be collected here."
                        : scope === "team"
                          ? "Pin a file or folder from its inspector and everyone here sees it."
                        : scope === "recent"
                          ? "Files you open or upload will show up here."
                          : "Upload objects or create a folder to get started."}
                  </p>
                  {filter !== "all" ? (
                    <button
                      type="button"
                      onClick={() => setFilter("all")}
                      className="spring mt-1 rounded-full border border-line-strong px-3.5 py-1.5 text-[13px] font-medium text-accent-strong transition hover:bg-accent-soft active:scale-[0.97]"
                    >
                      Show all files
                    </button>
                  ) : null}
                </div>
              ) : view === "list" ? (
                <FileTable
                  scrollRef={listScrollRef}
                  nodes={nodes}
                  checked={checked}
                  onCheck={onCheck}
                  onCheckAll={onCheckAll}
                  selectedId={selectedId}
                  onSelect={(node) => setSelectedId(node.id)}
                  onOpen={openNode}
                  onOpenLocation={openLocation}
                  onInspect={inspectFolder}
                  sort={sort}
                  onSortChange={changeSort}
                  starred={starred}
                  onToggleStar={toggleStar}
                  showPath={crossBucket}
                  fresh={freshIds}
                />
              ) : (
                <FileGrid
                  scrollRef={listScrollRef}
                  nodes={nodes}
                  checked={checked}
                  onCheck={onCheck}
                  selectedId={selectedId}
                  onSelect={(node) => setSelectedId(node.id)}
                  onOpen={openNode}
                  onOpenLocation={openLocation}
                  onInspect={inspectFolder}
                  starred={starred}
                  onToggleStar={toggleStar}
                  showPath={crossBucket}
                  fresh={freshIds}
                />
              )}
              {listing?.status === "ok" && listing.nextToken && !searching ? (
                <LoadMore onLoad={loadMore} />
              ) : null}
            </div>

            {scope === "shared" ? null : (
            <footer className="flex items-center justify-between gap-4 border-t border-line bg-surface-sunken px-5 py-2">
              <p className="tnum text-[12.5px] text-ink-muted">
                {summary.files} object{summary.files === 1 ? "" : "s"}
                {summary.folders
                  ? ` · ${summary.folders} folder${summary.folders === 1 ? "" : "s"}`
                  : ""}{" "}
                · {formatBytes(summary.bytes)}
                {listing?.status === "ok" && listing.nextToken ? " so far — more below" : ""}
              </p>
              <p className="hidden text-[12.5px] text-ink-faint sm:block">
                {selectedNode
                  ? `Selected: ${selectedNode.name}`
                  : "↑ ↓ to browse · Enter to open a folder"}
              </p>
            </footer>
            )}
          </section>
          </>
        )}
      </main>

      {/* Quick Look inspector — docked on wide screens, width animates open and shut */}
      <div
        className={`spring hidden shrink-0 overflow-hidden transition-[width] duration-300 xl:block ${
          selectedNode && providers.length ? "w-[374px]" : "w-0"
        }`}
        aria-hidden={selectedNode ? undefined : true}
        inert={!selectedNode}
      >
        <div className="h-full w-[374px] py-4 pr-6">
          {shownNode ? (
            <DetailPanel
              node={shownNode}
              onClose={() => setSelectedId(null)}
              starred={starred.has(shownNode.id)}
              onToggleStar={() => toggleStar(shownNode.id)}
              teamPinned={saved.team.has(shownNode.id)}
              onToggleTeamPin={() => toggleTeamPin(shownNode.id)}
              onShare={() => openShare(shownNode.id)}
              onZip={() => openZip([shownNode])}
              onQuickLook={() => setQuickLookId(shownNode.id)}
              onPreviewData={() =>
                setDataPreview({ connectionId: resolveBucket(bucketIdOf(shownNode.id)).remote.connectionId, key: keyOf(shownNode) })
              }
              bucket={resolveBucket(bucketIdOf(shownNode.id))}
              connection={connections.find((c) => shownNode.id.startsWith(`${c.id}/`))}
              folderContents={contentsOf(shownNode)}
              onOpenNode={openNode}
              onSelectNode={(child) => setSelectedId(child.id)}
              onAction={(action, node) => openAction(action, [node])}
              onNotify={setToast}
            />
          ) : null}
        </div>
      </div>

      {/* Detail panel — overlay below xl */}
      {selectedNode ? (
        <div className="fixed inset-0 z-40 xl:hidden">
          <button
            type="button"
            aria-label="Close details"
            onClick={() => setSelectedId(null)}
            className="absolute inset-0 bg-black/25 backdrop-blur-[3px]"
          />
          <div className="absolute inset-y-0 right-0 w-full max-w-[380px] p-3">
            <DetailPanel
              node={selectedNode}
              onClose={() => setSelectedId(null)}
              starred={starred.has(selectedNode.id)}
              onToggleStar={() => toggleStar(selectedNode.id)}
              teamPinned={saved.team.has(selectedNode.id)}
              onToggleTeamPin={() => toggleTeamPin(selectedNode.id)}
              onShare={() => openShare(selectedNode.id)}
              onZip={() => openZip([selectedNode])}
              onQuickLook={() => setQuickLookId(selectedNode.id)}
              onPreviewData={() =>
                setDataPreview({ connectionId: resolveBucket(bucketIdOf(selectedNode.id)).remote.connectionId, key: keyOf(selectedNode) })
              }
              bucket={resolveBucket(bucketIdOf(selectedNode.id))}
              connection={connections.find((c) => selectedNode.id.startsWith(`${c.id}/`))}
              folderContents={contentsOf(selectedNode)}
              onOpenNode={openNode}
              onSelectNode={(child) => setSelectedId(child.id)}
              onAction={(action, node) => openAction(action, [node])}
              onNotify={setToast}
            />
          </div>
        </div>
      ) : null}

      {shareFor && addressOf(shareFor) ? (
        <ShareDialog
          key={shareFor.id}
          node={shareFor}
          connection={addressOf(shareFor)!.owner}
          connections={connections}
          onClose={() => setShareFor(null)}
          onNotify={setToast}
          onJob={followJob}
        />
      ) : null}

      {compareOpen && activeConnection ? (
        <CompareDialog
          connections={connections}
          left={{ connectionId: activeConnection.id, prefix: tablePrefix }}
          onClose={() => setCompareOpen(false)}
          onJob={followTransfer}
        />
      ) : null}
      {sqlStart !== null && activeConnection ? (
        <SqlConsole
          connection={activeConnection}
          connections={connections}
          initialSql={sqlStart}
          onClose={() => setSqlStart(null)}
          onSaved={(connectionId) => {
            const target = connections.find((connection) => connection.id === connectionId);
            if (target) invalidateBucket(bucketIdFor(target));
          }}
        />
      ) : null}
      {quickLookId && lookup.get(quickLookId) ? (
        <QuickLook
          node={lookup.get(quickLookId)!}
          connectionId={resolveBucket(bucketIdOf(quickLookId)).remote.connectionId}
          files={nodes.filter((node) => node.kind === "file")}
          onNavigate={(node) => {
            setSelectedId(node.id);
            setQuickLookId(node.id);
          }}
          onClose={() => setQuickLookId(null)}
          onOpenKey={(key) => {
            setQuickLookId(null);
            openKeyIn(bucketIdOf(quickLookId), key);
          }}
        />
      ) : null}
      <DataPreviewDialog
        connectionId={dataPreview?.connectionId ?? ""}
        objectKey={dataPreview?.key ?? null}
        onClose={() => setDataPreview(null)}
      />
      <LakeTableDialog connectionId={tableConnection} table={tableFor} onClose={() => setTableFor(null)} />
      <TableChangeDialog
        changes={tablePrompt?.changes ?? null}
        verb={tablePrompt?.verb ?? ""}
        onConfirm={() => {
          const proceed = tablePrompt?.proceed;
          setTablePrompt(null);
          proceed?.();
        }}
        onCancel={() => setTablePrompt(null)}
      />

      {zipFor ? (
        <ZipDialog connection={zipFor.connection} request={zipFor.request} onClose={() => setZipFor(null)} onNotify={setToast} />
      ) : null}

      {dialog?.kind === "rename" ? (
        <RenameDialog
          key={dialog.node.id}
          open
          currentName={dialog.node.name}
          isFolder={dialog.node.kind === "folder"}
          onClose={() => setDialog(null)}
          onRename={(name) =>
            runOperation({ op: "rename", items: [itemsOf([dialog.node])[0]], name }, "Renamed")
          }
        />
      ) : null}
      {dialog?.kind === "move" || dialog?.kind === "copy" ? (
        <DestinationDialog
          key={`${dialog.kind}-${dialog.nodes.map((node) => node.id).join(",")}`}
          open
          mode={dialog.kind}
          count={dialog.nodes.length}
          connectionId={bucket.remote.connectionId}
          bucketName={bucket.name}
          startPath={path}
          onClose={() => setDialog(null)}
          targets={
            dialog.kind === "copy"
              ? connections.filter((connection) => !connection.readOnly).map(({ id, name, bucket: target }) => ({ id, name, bucket: target }))
              : undefined
          }
          onConfirm={(destination, targetConnectionId) =>
            targetConnectionId !== bucket.remote.connectionId
              ? runTransfer(itemsOf(dialog.nodes), targetConnectionId, destination)
              : runOperation({ op: dialog.kind, items: itemsOf(dialog.nodes), destination }, dialog.kind === "move" ? "Moved" : "Copied")
          }
        />
      ) : null}
      {dialog?.kind === "metadata" ? (
        <MetadataDialog
          key={`metadata-${dialog.nodes.map((node) => node.id).join(",")}`}
          connectionId={bucket.remote.connectionId}
          nodes={dialog.nodes}
          onClose={() => setDialog(null)}
          onSubmit={(change) => runOperation({ op: "metadata", items: itemsOf(dialog.nodes), change }, "Updated")}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog
          key={`delete-${dialog.nodes.map((node) => node.id).join(",")}`}
          open
          names={dialog.nodes.map((node) => (node.kind === "folder" ? `${node.name}/` : node.name))}
          folderCount={dialog.nodes.filter((node) => node.kind === "folder").length}
          onClose={() => setDialog(null)}
          onDelete={() => runOperation({ op: "delete", items: itemsOf(dialog.nodes) }, "Deleted")}
        />
      ) : null}

      <AddProviderDialog
        open={addProviderOpen}
        onClose={() => setAddProviderOpen(false)}
        onConnect={connectProvider}
        existingNames={providers.map((provider) => provider.name)}
      />

      {settingsFor && connections.some((connection) => connection.id === settingsFor) ? (
        <ConnectionSettingsDialog
          connection={connections.find((connection) => connection.id === settingsFor)!}
          connections={connections}
          onClose={() => setSettingsFor(null)}
          onChange={(updated) =>
            setConnections((current) =>
              current.map((item) =>
                item.id === updated.id
                  ? updated
                  : // There's one share bucket: the server unmarked the old one as well.
                    updated.settings.shareTarget && item.settings.shareTarget
                    ? { ...item, settings: { ...item.settings, shareTarget: undefined } }
                    : item,
              ),
            )
          }
        />
      ) : null}

      {xrayOpen && activeConnection ? (
        <XrayDialog
          open
          onClose={() => setXrayOpen(false)}
          connection={activeConnection}
          onOpenFile={(key) => {
            const parts = key.split("/");
            navigate({ scope: "bucket", bucketId: bucket.id, path: parts.slice(0, -1) });
            setSelectedId(`${bucket.id}:${key}`);
          }}
        />
      ) : null}

      {analyticsOpen && activeConnection ? (
        <AnalyticsDialog
          open
          onClose={() => setAnalyticsOpen(false)}
          connection={activeConnection}
          bucketName={bucket.title}
          path={path}
          disk={activeDisk}
          onConnectionChange={(updated) =>
            setConnections((current) => current.map((item) => (item.id === updated.id ? updated : item)))
          }
          onOpenFile={(key) => {
            const parts = key.split("/");
            navigate({ scope: "bucket", bucketId: bucket.id, path: parts.slice(0, -1) });
            setSelectedId(`${bucket.id}:${key}`);
          }}
        />
      ) : null}

      {historyOpen && activeConnection ? (
        <HistoryDialog
          open
          onClose={() => setHistoryOpen(false)}
          connection={activeConnection}
          bucketName={bucket.title}
          path={path}
          onOpen={(key) => {
            const parts = key.replace(/\/$/, "").split("/").filter(Boolean);
            if (!key || key.endsWith("/")) {
              navigate({ scope: "bucket", bucketId: bucket.id, path: parts });
            } else {
              navigate({ scope: "bucket", bucketId: bucket.id, path: parts.slice(0, -1) });
              setSelectedId(`${bucket.id}:${key}`);
            }
          }}
        />
      ) : null}

      {jobs.length ? (
        <JobsTray
          jobs={jobs}
          raised={uploads.length > 0}
          onCancel={(id) => {
            api.cancelJob(id).catch((error: Error) => setToast(error.message));
          }}
          onDismiss={dismissFinished}
        />
      ) : null}

      {uploads.length ? (
        <UploadTray
          uploads={uploads}
          onCancel={(id) => uploadCancels.current.get(id)?.()}
          onDismiss={() => setUploads((current) => current.filter((item) => item.status === "uploading" || item.status === "queued"))}
        />
      ) : null}

      {/* Always mounted: a live region inserted together with its text is often not announced. */}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-10 left-1/2 z-50 -translate-x-1/2">
        {(toast ?? connectionsError) ? (
          <div key={toast ?? connectionsError} className="material-thick toast-in rounded-full border border-line px-4 py-2 text-[13px] font-medium text-ink shadow-pop">
            {toast ?? connectionsError}
          </div>
        ) : null}
      </div>
    </div>
  );
}
