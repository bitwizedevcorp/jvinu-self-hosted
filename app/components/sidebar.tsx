"use client";

import { useState } from "react";
import type { DiskStatus } from "../lib/remote";
import {
  findPreset,
  formatBytes,
  type Provider,
  type ProviderId,
  type Scope,
  type StorageNode,
} from "../lib/storage";
import { AccountMenu, type SignedInUser } from "./account-menu";
import { ConnectionMenu } from "./connection-menu";
import { useListing } from "../lib/queries";
import { FileGlyph } from "./file-glyph";
import { Wordmark } from "./wordmark";
import { BucketSymbol, FolderSymbol } from "./symbols";
import {
  ChevronRight,
  ClockIcon,
  LinkIcon,
  KeyIcon,
  LockIcon,
  PlusIcon,
  PinIcon,
  StarIcon,
} from "./icons";

type Mark = { label: string; from: string; to: string };

/** Used space on bundled storage: amber from 85 %, red from 95 % (uploads stop there). */
function DiskMeter({ disk }: { disk: DiskStatus }) {
  const percent = Math.round(disk.ratio * 100);
  const fill = disk.level === "full" ? "bg-danger" : disk.level === "warn" ? "bg-warning" : "bg-accent";
  return (
    <div className="mb-1 ml-[26px] px-2.5 pb-1">
      <div
        role="meter"
        aria-label="Storage disk used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% used, ${formatBytes(disk.available)} free`}
        className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div className={`bar-grow h-full rounded-full ${fill}`} style={{ width: `${Math.max(2, percent)}%` }} />
      </div>
      <p className={`tnum mt-1 text-[11px] ${disk.level === "ok" ? "text-ink-faint" : "font-medium text-ink"}`}>
        {formatBytes(disk.available)} free of {formatBytes(disk.total)} · {percent}%
      </p>
    </div>
  );
}

/** Muted gradients for connections whose preset we no longer recognise. */
const FALLBACK_GRADIENTS = [
  { from: "#5c7f63", to: "#3a5a42" },
  { from: "#5a648f", to: "#3b4470" },
  { from: "#49807d", to: "#2c5f5c" },
  { from: "#8a6f4e", to: "#654f33" },
  { from: "#7d5a74", to: "#573b52" },
];

function markFor(provider: Provider): Mark {
  const preset = findPreset(provider.presetId ?? provider.id);
  if (preset) return preset.mark;

  const initials =
    provider.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "?";
  let hash = 0;
  for (const char of provider.id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return { label: initials, ...FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length] };
}

function ProviderMark({ provider }: { provider: Provider }) {
  const mark = markFor(provider);
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-[9px] font-bold tracking-tight text-white"
      style={{ backgroundImage: `linear-gradient(140deg, ${mark.from}, ${mark.to})` }}
    >
      {mark.label}
    </span>
  );
}

function SectionLabel({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">{children}</p>
      {aside}
    </div>
  );
}

/**
 * Read-only as one quiet line with a switch, shown when a connection is open. On, nothing
 * can be uploaded, renamed or deleted from here; the row's lock shows it while closed.
 */
function ReadOnlySwitch({ name, readOnly, onChange }: { name: string; readOnly: boolean; onChange: (readOnly: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={readOnly}
      aria-label={`Read-only for ${name}`}
      title={readOnly ? "Nothing can be uploaded, renamed or deleted" : "Turn on to stop uploads, renames and deletes"}
      onClick={() => onChange(!readOnly)}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
    >
      <LockIcon size={13} className={readOnly ? "text-warning" : "text-ink-faint"} />
      <span className="flex-1">Read-only</span>
      <span
        aria-hidden="true"
        className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors ${readOnly ? "bg-accent-fill" : "bg-line-strong"}`}
      >
        <span
          className={`absolute top-[2px] size-[14px] rounded-full bg-white shadow-card transition-[left] ${readOnly ? "left-[14px]" : "left-[2px]"}`}
        />
      </span>
    </button>
  );
}

/** What the sidebar needs to draw a bucket's folders and files as a lazily listed tree. */
export type FolderTreeModel = {
  isExpanded: (bucketId: string, path: string[]) => boolean;
  onToggle: (bucketId: string, path: string[]) => void;
  onOpen: (bucketId: string, path: string[]) => void;
  /** Show a file: open its folder and select it. */
  onOpenFile: (node: StorageNode) => void;
  /** Folder on screen, when the main view is a bucket. */
  activePath: string[] | null;
  /** The object in the inspector, highlighted when its row is in the tree. */
  selectedId: string | null;
};

/** Loopback and Floci hosts read as "local"; real clouds show their region. */
const isLocalEndpoint = (endpoint?: string) => {
  if (!endpoint) return false;
  const host = new URL(endpoint).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".floci.io") || host.endsWith(".localhost");
};

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((seg, i) => seg === b[i]);
const MAX_TREE_CHILDREN = 50;

function Disclosure({
  expanded,
  label,
  onClick,
  inverted = false,
}: {
  expanded: boolean;
  label: string;
  onClick: () => void;
  inverted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      className={`flex size-5 shrink-0 items-center justify-center rounded transition ${
        inverted ? "text-white/80 hover:bg-white/20" : "text-ink-faint hover:bg-surface-sunken hover:text-ink"
      }`}
    >
      <ChevronRight size={12} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
    </button>
  );
}

function FolderRow({
  tree,
  bucketId,
  folder,
  path,
  depth,
  activeBucketId,
}: {
  tree: FolderTreeModel;
  bucketId: string;
  folder: StorageNode;
  path: string[];
  depth: number;
  activeBucketId: string;
}) {
  const folderPath = [...path, folder.name];
  const expanded = tree.isExpanded(bucketId, folderPath);
  // Reads the cache only: a folder already listed and found empty has nothing to expand.
  const sub = useListing(bucketId, folderPath, false).nodes;
  const leaf = Array.isArray(sub) && sub.length === 0;
  const active = bucketId === activeBucketId && tree.activePath !== null && samePath(tree.activePath, folderPath);
  return (
    <li role="treeitem" aria-expanded={leaf ? undefined : expanded} aria-selected={active}>
      <div
        className={`spring flex items-center gap-1 rounded-md py-1 pr-2 transition-colors ${
          active ? "bg-accent-fill text-white" : "text-ink hover:bg-surface-sunken"
        }`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {leaf ? (
          <span className="size-5 shrink-0" aria-hidden="true" />
        ) : (
          <Disclosure expanded={expanded} label={folder.name} inverted={active} onClick={() => tree.onToggle(bucketId, folderPath)} />
        )}
        <button
          type="button"
          onClick={() => tree.onOpen(bucketId, folderPath)}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <FolderSymbol size={17} open={expanded && !leaf} inverted={active} />
          <span className={`truncate text-[12.5px] ${active ? "font-medium" : ""}`}>{folder.name}</span>
        </button>
      </div>
      {expanded && !leaf ? (
        <FolderBranch tree={tree} bucketId={bucketId} path={folderPath} depth={depth + 1} activeBucketId={activeBucketId} />
      ) : null}
    </li>
  );
}

function FolderBranch({
  tree,
  bucketId,
  path,
  depth,
  activeBucketId,
}: {
  tree: FolderTreeModel;
  bucketId: string;
  path: string[];
  depth: number;
  activeBucketId: string;
}) {
  // Each open level lists itself, through the same cache as the main view.
  const listing = useListing(bucketId, path);
  const children = listing.nodes;
  const indent = { paddingLeft: 8 + depth * 14 };

  if (listing.isError) {
    return (
      <p className="py-1 text-[12px] text-danger" style={indent}>
        Couldn&rsquo;t list
      </p>
    );
  }
  if (children === undefined) {
    return (
      <p className="py-1 text-[12px] text-ink-faint" style={indent} role="status">
        Listing…
      </p>
    );
  }
  const byName = (a: StorageNode, b: StorageNode) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const folders = children.filter((child) => child.kind === "folder").sort(byName);
  // Files follow their folder's subfolders, as in Finder's list view; one cap for both.
  const files = children
    .filter((child) => child.kind === "file")
    .sort(byName)
    .slice(0, Math.max(0, MAX_TREE_CHILDREN - folders.length));
  const hidden = children.length - Math.min(folders.length, MAX_TREE_CHILDREN) - files.length;
  if (!folders.length && !files.length) {
    return (
      <p className="py-1 text-[12px] text-ink-faint" style={indent}>
        Empty
      </p>
    );
  }

  return (
    <ul role="group" className="tree-in">
      {folders.slice(0, MAX_TREE_CHILDREN).map((folder) => (
        <FolderRow key={folder.id} tree={tree} bucketId={bucketId} folder={folder} path={path} depth={depth} activeBucketId={activeBucketId} />
      ))}
      {files.map((file) => {
        const active = file.id === tree.selectedId;
        return (
          <li key={file.id} role="treeitem" aria-selected={active}>
            <button
              type="button"
              onClick={() => tree.onOpenFile(file)}
              title={file.name}
              className={`spring flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors ${
                active ? "bg-accent-fill text-white" : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
              }`}
              style={{ paddingLeft: 4 + depth * 14 + 24 }}
            >
              <FileGlyph preview={file.preview} size={17} radius={5} onTint={active} />
              <span className="truncate text-[12.5px]">{file.name}</span>
            </button>
          </li>
        );
      })}
      {hidden > 0 ? (
        <li className="py-1 text-[12px] text-ink-faint" style={indent}>
          {hidden.toLocaleString("en-US")} more — open the folder to see them
        </li>
      ) : null}
    </ul>
  );
}

/** Measured on the last listing call to the bucket on screen — not an estimate. */
export type ConnectionHealth = {
  name: string;
  /** Endpoint host, or the AWS region. */
  target: string;
  ok: boolean;
  /** Round-trip time of that call, including this app's server hop. */
  ms: number | null;
  message?: string;
};

function QuickLink({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`spring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors ${
        active
          ? "bg-accent-fill font-medium text-white"
          : "text-ink hover:bg-surface-sunken"
      }`}
    >
      <span className={active ? "text-white" : "text-accent"}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count ? (
        <span
          className={`tnum rounded-full px-1.5 text-[11px] font-semibold ${
            active ? "bg-white/25 text-white" : "bg-surface-sunken text-ink-muted"
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function Sidebar({
  providers,
  openProviders,
  onToggleProvider,
  onAddProvider,
  onDeleteProvider,
  scope,
  onScopeChange,
  activeBucketId,
  onBucketSelect,
  starredCount,
  teamCount = 0,
  sharedCount,
  user,
  onSignOut,
  onToggleReadOnly,
  onOpenSettings,
  tree,
  disks = {},
}: {
  providers: Provider[];
  openProviders: ProviderId[];
  onToggleProvider: (id: ProviderId) => void;
  onAddProvider: () => void;
  onDeleteProvider: (id: ProviderId) => void;
  scope: Scope;
  onScopeChange: (scope: Exclude<Scope, "bucket">) => void;
  activeBucketId: string;
  onBucketSelect: (bucketId: string) => void;
  starredCount: number;
  /** Pins shared with everyone on this server. */
  teamCount?: number;
  sharedCount: number;
  user: SignedInUser;
  onSignOut: () => void;
  onToggleReadOnly: (id: ProviderId) => void;
  /** Encryption at rest, share bucket, public URL. */
  onOpenSettings: (id: ProviderId) => void;
  tree: FolderTreeModel;
  /** Disk status per connection, for bundled storage. */
  disks?: Record<ProviderId, DiskStatus>;
}) {
  const [confirmId, setConfirmId] = useState<ProviderId | null>(null);

  return (
    <aside className="material flex h-full w-[260px] shrink-0 flex-col border-r border-line">
      <div className="flex items-center px-4 pb-4 pt-4">
        <Wordmark className="text-[15px] text-ink" />
      </div>

      <nav className="scroll-quiet flex-1 overflow-y-auto px-3 pb-4 pt-3">
        <SectionLabel
          aside={
            <span className="tnum text-[11px] font-medium text-ink-faint">
              {providers.length} connected
            </span>
          }
        >
          Storage Locations
        </SectionLabel>
        <ul className="space-y-0.5">
          {providers.map((provider) => {
            const open = openProviders.includes(provider.id);
            return (
              <li key={provider.id}>
                <div className="flex items-center gap-0.5 rounded-xl pr-1 transition-colors hover:bg-surface/70">
                  <button
                    type="button"
                    onClick={() => onToggleProvider(provider.id)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-2 pl-2.5 pr-1 text-left"
                  >
                    <ProviderMark provider={provider} />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span title={provider.name} className="truncate text-[14px] font-medium text-ink">
                        {provider.name}
                      </span>
                      {provider.encrypted ? (
                        <span title="Encrypted with a passphrase (rclone crypt)" className="shrink-0 text-success">
                          <KeyIcon size={12} />
                          <span className="sr-only">, encrypted</span>
                        </span>
                      ) : null}
                    </span>
                    {provider.readOnly ? (
                      <span title="Read-only: nothing can be changed here" className="shrink-0 text-warning">
                        <LockIcon size={13} />
                        <span className="sr-only">, read-only</span>
                      </span>
                    ) : null}
                    <ChevronRight
                      size={15}
                      className={`shrink-0 text-ink-faint transition-transform ${open ? "rotate-90" : ""}`}
                    />
                  </button>
                  {/* Settings, read-only and disconnect: one button that's always there, never over the name. */}
                  {user.role === "admin" ? (
                  <ConnectionMenu
                    name={provider.name}
                    readOnly={Boolean(provider.readOnly)}
                    managed={Boolean(provider.managed)}
                    onSettings={() => onOpenSettings(provider.id)}
                    onToggleReadOnly={() => onToggleReadOnly(provider.id)}
                    onDisconnect={() => setConfirmId(provider.id)}
                  />
                  ) : null}
                </div>

                {disks[provider.id] ? <DiskMeter disk={disks[provider.id]} /> : null}

                {confirmId === provider.id ? (
                  <div className="mb-1 ml-[26px] mt-1 rounded-xl border border-accent-ring bg-accent-soft/50 px-3 py-2.5">
                    <p className="text-[12.5px] leading-relaxed text-ink">
                      Disconnect <span className="font-semibold">{provider.name}</span>?{" "}
                      Its saved keys are erased from this server. Nothing in the bucket changes.
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-muted transition hover:bg-surface hover:text-ink"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmId(null);
                          onDeleteProvider(provider.id);
                        }}
                        className="rounded-lg bg-accent px-2.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-accent-hover"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                ) : null}

                {open ? (
                  <div className="mb-1 ml-[26px] border-l border-line pl-2.5 pt-0.5">
                    {provider.managed ? (
                      <p className="truncate px-2.5 pb-1 text-[11px] text-ink-faint">Managed by this server</p>
                    ) : provider.accessKeyHint ? (
                      <p className="truncate px-2.5 pb-1 font-mono text-[11px] text-ink-faint">
                        {provider.endpoint ? `${new URL(provider.endpoint).host} · ` : ""}
                        {provider.accessKeyHint}
                      </p>
                    ) : null}
                    {user.role === "admin" ? (
                    <ReadOnlySwitch
                      name={provider.name}
                      readOnly={Boolean(provider.readOnly)}
                      onChange={(value) => {
                        if (value !== Boolean(provider.readOnly)) onToggleReadOnly(provider.id);
                      }}
                    />
                    ) : null}
                    {provider.buckets.length === 0 ? (
                      <p className="px-2.5 py-1.5 text-[12.5px] text-ink-faint">No buckets yet</p>
                    ) : null}
                    <ul className="space-y-0.5" role="tree" aria-label={`${provider.name} buckets and folders`}>
                    {provider.buckets.map((bucket) => {
                      const here = scope === "bucket" && bucket.id === activeBucketId;
                      // Filled only at the bucket root; inside a folder the folder row takes it.
                      const active = here && (tree.activePath?.length ?? 0) === 0;
                      const expanded = tree.isExpanded(bucket.id, []);
                      return (
                        <li key={bucket.id} role="treeitem" aria-expanded={expanded} aria-selected={active}>
                          <div
                            className={`spring flex w-full items-center gap-1 rounded-lg py-1.5 pl-1 pr-2.5 transition-colors ${
                              active
                                ? "bg-accent-fill font-medium text-white shadow-card"
                                : here
                                  ? "font-medium text-ink hover:bg-surface-sunken"
                                  : "text-ink hover:bg-surface-sunken"
                            }`}
                          >
                            <Disclosure
                              expanded={expanded}
                              label={bucket.name}
                              inverted={active}
                              onClick={() => tree.onToggle(bucket.id, [])}
                            />
                            <button
                              type="button"
                              onClick={() => onBucketSelect(bucket.id)}
                              aria-current={active ? "page" : undefined}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <BucketSymbol size={17} inverted={active} />
                              {/* Where it lives goes in the tooltip: the name gets the room. */}
                              <span
                                className="flex-1 truncate text-[13px]"
                                title={`${bucket.name} · ${isLocalEndpoint(provider.endpoint) ? "local" : bucket.region || provider.accessKeyHint}`}
                              >
                                {bucket.name}
                              </span>
                            </button>
                          </div>
                          {expanded ? (
                            <FolderBranch
                              tree={tree}
                              bucketId={bucket.id}
                              path={[]}
                              depth={0}
                              activeBucketId={scope === "bucket" ? activeBucketId : ""}
                            />
                          ) : null}
                        </li>
                      );
                    })}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {user.role === "admin" ? (
        <button
          type="button"
          onClick={onAddProvider}
          className="spring mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-[13px] font-medium text-accent-strong transition hover:bg-accent-soft active:scale-[0.98]"
        >
          <PlusIcon size={14} />
          Connect Provider
        </button>
        ) : null}

        <div className="pt-5">
          <SectionLabel>Quick Access</SectionLabel>
          <div className="space-y-0.5">
            <QuickLink
              icon={<StarIcon size={16} />}
              label="Starred"
              count={starredCount}
              active={scope === "starred"}
              onClick={() => onScopeChange("starred")}
            />
            <QuickLink
              icon={<PinIcon size={16} />}
              label="Team pins"
              count={teamCount}
              active={scope === "team"}
              onClick={() => onScopeChange("team")}
            />
            <QuickLink
              icon={<ClockIcon size={16} />}
              label="Recent"
              active={scope === "recent"}
              onClick={() => onScopeChange("recent")}
            />
            <QuickLink
              icon={<LinkIcon size={16} />}
              label="Shared links"
              count={sharedCount}
              active={scope === "shared"}
              onClick={() => onScopeChange("shared")}
            />
          </div>
        </div>

      </nav>

      <div className="px-3 pb-4">
        <AccountMenu user={user} onSignOut={onSignOut} />
      </div>
    </aside>
  );
}
