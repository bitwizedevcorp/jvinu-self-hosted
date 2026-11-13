"use client";

import { formatBytes, formatDate, type StorageNode } from "../lib/storage";
import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { thumbUrlFor } from "../lib/remote";
import { FileGlyph, TINTS } from "./file-glyph";
import { InfoIcon, StarIcon } from "./icons";
import { useVirtualList } from "./use-virtual-list";

/** The tile's picture: a thumbnail for images (fading in over the glyph), else the glyph. */
function TileArt({ node }: { node: StorageNode }) {
  const [state, setState] = useState<"loading" | "shown" | "failed">("loading");
  const src = thumbUrlFor(node);
  return (
    <div className="relative flex aspect-4/3 items-center justify-center overflow-hidden rounded-xl" style={{ backgroundColor: TINTS[node.preview].bg }}>
      <FileGlyph preview={node.preview} size={46} radius={14} onTint />
      {src && state !== "failed" ? (
        // eslint-disable-next-line @next/next/no-img-element -- already resized and cached by our server
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setState("shown")}
          onError={() => setState("failed")}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${state === "shown" ? "opacity-100" : "opacity-0"}`}
        />
      ) : null}
    </div>
  );
}

/** Columns at the same breakpoints as before virtualizing: 2, then 3 from sm, 4 from xl. */
function subscribeWidth(callback: () => void) {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}
const columnsNow = () => (window.matchMedia("(min-width: 1280px)").matches ? 4 : window.matchMedia("(min-width: 640px)").matches ? 3 : 2);

export function FileGrid({
  nodes,
  selectedId,
  onSelect,
  onOpen,
  onOpenLocation,
  onInspect,
  checked,
  onCheck,
  starred,
  onToggleStar,
  showPath = false,
  scrollRef,
  fresh,
}: {
  /** The element that scrolls the grid; only rows near its viewport are rendered. */
  scrollRef: RefObject<HTMLElement | null>;
  nodes: StorageNode[];
  selectedId: string | null;
  onSelect: (node: StorageNode) => void;
  onOpen: (node: StorageNode) => void;
  onOpenLocation: (node: StorageNode) => void;
  /** Show a folder in the inspector without entering it. */
  onInspect: (node: StorageNode) => void;
  checked: Set<string>;
  onCheck: (node: StorageNode, range: boolean) => void;
  starred: Set<string>;
  onToggleStar: (id: string) => void;
  showPath?: boolean;
  /** Live folder: objects that appeared while watching, highlighted for a while. */
  fresh?: Set<string>;
}) {
  const focusId = nodes.some((node) => node.id === selectedId) ? selectedId : nodes[0]?.id;
  const columns = useSyncExternalStore(subscribeWidth, columnsNow, () => 4);
  const rows = Math.ceil(nodes.length / columns);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndex = selectedId ? nodes.findIndex((node) => node.id === selectedId) : -1;
  const { virtualizer, items, paddingTop, paddingBottom } = useVirtualList({
    count: rows,
    scrollRef,
    anchorRef: listRef,
    estimateSize: showPath ? 236 : 216,
    getItemKey: (row) => nodes[row * columns]?.id ?? String(row),
    focusIndex: selectedIndex >= 0 ? Math.floor(selectedIndex / columns) : -1,
    focusSelector: selectedIndex >= 0 ? `[data-node-id="${CSS.escape(nodes[selectedIndex].id)}"]` : null,
  });

  return (
    <div ref={listRef} role="list" className="px-4 pt-4" style={{ paddingTop: 16 + paddingTop, paddingBottom: paddingBottom + 4 }}>
      {items.map(({ index: row }) => (
        <div
          key={row}
          role="presentation"
          data-index={row}
          ref={virtualizer.measureElement}
          className="grid gap-3 pb-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {nodes.slice(row * columns, row * columns + columns).map((node, offset) => {
            const index = row * columns + offset;
        const selected = node.id === selectedId;
        const isChecked = checked.has(node.id);
        const isStarred = starred.has(node.id);
        const isFolder = node.kind === "folder";
        return (
          <div
            key={node.id}
            role="listitem"
            className={`${index < 16 ? "row-in " : ""}group relative`}
            style={{ "--i": Math.min(index, 16) } as React.CSSProperties}
          >
            <div
              role="button"
              data-node-id={node.id}
              tabIndex={node.id === focusId ? 0 : -1}
              data-fresh={fresh?.has(node.id) ? "" : undefined}
              aria-current={selected ? "true" : undefined}
              aria-label={isFolder ? `Open folder ${node.name}` : node.name}
              // Single click opens folders: on narrow screens selecting a folder
              // would raise the detail overlay over the card before a second click.
              onClick={() => (isFolder ? onOpen(node) : onSelect(node))}
              onFocus={(event) => {
                if (!selected && event.currentTarget.matches(":focus-visible")) onSelect(node);
              }}
              className={`spring flex h-full cursor-pointer flex-col gap-3 rounded-2xl border p-3 transition ${
                selected || isChecked
                  ? "border-accent bg-accent-soft shadow-[0_0_0_3px_var(--accent-soft)]"
                  : "border-line bg-surface-raised/60 hover:-translate-y-px hover:border-line-strong hover:shadow-card"
              }`}
            >
              <TileArt node={node} />
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-ink">
                  {isFolder ? `${node.name}/` : node.name}
                </p>
                <p className="tnum mt-0.5 truncate text-[11.5px] text-ink-faint">
                  {isFolder ? "Folder" : formatBytes(node.size)} · {formatDate(node.modified)}
                </p>
              </div>
            </div>

            {showPath ? (
              <button
                type="button"
                onClick={() => onOpenLocation(node)}
                title="Go to this location"
                className="mt-1 block max-w-full truncate px-1 text-left font-mono text-[11px] text-ink-faint underline-offset-2 hover:text-accent-strong hover:underline"
              >
                {node.path.length ? `${node.path.join("/")}/` : "/"}
              </button>
            ) : null}

            <label
              className={`absolute bottom-[4.25rem] left-2 z-10 flex size-8 cursor-pointer items-center justify-center rounded-full bg-surface-raised/90 backdrop-blur transition ${
                isChecked || checked.size ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              }`}
            >
              <input
                type="checkbox"
                aria-label={`Select ${node.name}`}
                checked={isChecked}
                onChange={(event) => onCheck(node, (event.nativeEvent as MouseEvent).shiftKey)}
                className="size-4 cursor-pointer accent-[var(--accent-fill)]"
              />
            </label>

            {isFolder ? (
              <button
                type="button"
                aria-label={`Show details for ${node.name}`}
                title="Details"
                onClick={() => onInspect(node)}
                className={`absolute left-2 top-2 z-10 flex size-9 items-center justify-center rounded-full bg-surface-raised/90 backdrop-blur transition ${
                  selected
                    ? "text-accent-strong opacity-100"
                    : "text-ink-faint opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                }`}
              >
                <InfoIcon size={15} />
              </button>
            ) : null}

            <button
              type="button"
              aria-label={isStarred ? `Unstar ${node.name}` : `Star ${node.name}`}
              aria-pressed={isStarred}
              onClick={() => onToggleStar(node.id)}
              className={`absolute right-2 top-2 z-10 flex size-9 items-center justify-center rounded-full bg-surface-raised/90 backdrop-blur transition ${
                isStarred
                  ? "text-warning opacity-100"
                  : "text-ink-faint opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              }`}
            >
              <StarIcon size={15} fill={isStarred ? "currentColor" : "none"} />
            </button>
          </div>
        );
          })}
        </div>
      ))}
    </div>
  );
}
