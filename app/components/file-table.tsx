"use client";

import {
  formatBytes,
  formatDate,
  type SortKey,
  type SortState,
  type StorageNode,
} from "../lib/storage";
import { useRef, type RefObject } from "react";
import { FileGlyph } from "./file-glyph";
import { useVirtualList } from "./use-virtual-list";
import { ChevronUpDown, InfoIcon, StarIcon } from "./icons";

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  // Type steps aside at xl, where the docked detail panel would otherwise
  // squeeze the Name column to ~120px; the glyph already carries the kind.
  { key: "type", label: "Type", className: "hidden md:table-cell xl:hidden 2xl:table-cell w-[150px]" },
  { key: "size", label: "Size", className: "hidden sm:table-cell w-[110px]" },
  { key: "modified", label: "Modified", className: "w-[130px]" },
];

function SortButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group inline-flex items-center gap-1 uppercase tracking-[0.06em] transition-colors ${
        active ? "text-ink" : "text-ink-muted hover:text-ink"
      }`}
    >
      {label}
      <ChevronUpDown
        size={13}
        className={`transition ${
          active
            ? `text-accent-strong ${dir === "desc" ? "rotate-180" : ""}`
            : "text-ink-faint opacity-0 group-hover:opacity-100"
        }`}
      />
    </button>
  );
}

export function FileTable({
  nodes,
  selectedId,
  onSelect,
  onOpen,
  onOpenLocation,
  onInspect,
  checked,
  onCheck,
  onCheckAll,
  sort,
  onSortChange,
  starred,
  onToggleStar,
  showPath = false,
  scrollRef,
  fresh,
}: {
  /** The element that scrolls the list; only rows near its viewport are rendered. */
  scrollRef: RefObject<HTMLElement | null>;
  nodes: StorageNode[];
  selectedId: string | null;
  onSelect: (node: StorageNode) => void;
  onOpen: (node: StorageNode) => void;
  onOpenLocation: (node: StorageNode) => void;
  /** Show a folder in the inspector without entering it. */
  onInspect: (node: StorageNode) => void;
  /** Multi-select for bulk actions — separate from the one row shown in the inspector. */
  checked: Set<string>;
  onCheck: (node: StorageNode, range: boolean) => void;
  onCheckAll: (all: boolean) => void;
  sort: SortState;
  onSortChange: (key: SortKey) => void;
  starred: Set<string>;
  onToggleStar: (id: string) => void;
  showPath?: boolean;
  /** Live folder: objects that appeared while watching, highlighted for a while. */
  fresh?: Set<string>;
}) {
  const focusId = nodes.some((node) => node.id === selectedId) ? selectedId : nodes[0]?.id;
  const checkedHere = nodes.filter((node) => checked.has(node.id)).length;
  const allChecked = nodes.length > 0 && checkedHere === nodes.length;
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const selectedIndex = selectedId ? nodes.findIndex((node) => node.id === selectedId) : -1;
  const { virtualizer, items, paddingTop, paddingBottom } = useVirtualList({
    count: nodes.length,
    scrollRef,
    anchorRef: bodyRef,
    estimateSize: showPath ? 76 : 61,
    getItemKey: (index) => nodes[index].id,
    focusIndex: selectedIndex,
    focusSelector: selectedIndex >= 0 ? `[data-node-id="${CSS.escape(nodes[selectedIndex].id)}"]` : null,
  });

  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead>
        <tr className="text-[11px] font-semibold">
          <th scope="col" className="sticky top-0 z-10 w-[44px] bg-surface-raised/85 py-2.5 pl-4 backdrop-blur-xl shadow-[inset_0_-1px_0_var(--color-line)]">
            <input
              type="checkbox"
              aria-label={allChecked ? "Deselect all" : "Select all"}
              checked={allChecked}
              ref={(input) => {
                if (input) input.indeterminate = checkedHere > 0 && !allChecked;
              }}
              onChange={() => onCheckAll(!allChecked)}
              className="size-4 cursor-pointer accent-[var(--accent-fill)]"
            />
          </th>
          <th
            scope="col"
            className="sticky top-0 z-10 bg-surface-raised/85 px-3 py-2.5 backdrop-blur-xl font-medium shadow-[inset_0_-1px_0_var(--color-line)]"
          >
            <SortButton
              label="Name"
              active={sort.key === "name"}
              dir={sort.dir}
              onClick={() => onSortChange("name")}
            />
          </th>
          {COLUMNS.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={`sticky top-0 z-10 bg-surface-raised/85 px-3 py-2.5 backdrop-blur-xl font-medium shadow-[inset_0_-1px_0_var(--color-line)] ${column.className}`}
            >
              <SortButton
                label={column.label}
                active={sort.key === column.key}
                dir={sort.dir}
                onClick={() => onSortChange(column.key)}
              />
            </th>
          ))}
          <th
            scope="col"
            className="sticky top-0 z-10 w-[92px] bg-surface-raised/85 px-3 py-2.5 backdrop-blur-xl shadow-[inset_0_-1px_0_var(--color-line)]"
          >
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody ref={bodyRef}>
        {paddingTop > 0 ? (
          <tr aria-hidden="true">
            <td colSpan={6} style={{ height: paddingTop, padding: 0 }} />
          </tr>
        ) : null}
        {items.map(({ index }) => {
          const node = nodes[index];
          const selected = node.id === selectedId;
          const isChecked = checked.has(node.id);
          const isStarred = starred.has(node.id);
          const isFolder = node.kind === "folder";
          return (
            <tr
              key={node.id}
              data-node-id={node.id}
              data-index={index}
              data-fresh={fresh?.has(node.id) ? "" : undefined}
              ref={virtualizer.measureElement}
              // The entrance cascade plays for the first screenful only, not while scrolling.
              data-still={index >= 16 ? "" : undefined}
              style={{ "--i": Math.min(index, 16) } as React.CSSProperties}
              // Roving tab stop: the list is one Tab stop, arrows move within it.
              tabIndex={node.id === focusId ? 0 : -1}
              aria-current={selected ? "true" : undefined}
              aria-label={isFolder ? `Folder ${node.name}` : undefined}
              // Folders open on a single click — the same gesture as the grid, and
              // the only one that works on touch, where double-click doesn't exist.
              onClick={() => (isFolder ? onOpen(node) : onSelect(node))}
              onFocus={(event) => {
                // Keyboard focus selects; mouse focus waits for the click.
                if (!selected && event.currentTarget.matches(":focus-visible")) onSelect(node);
              }}
              className={`spring group relative cursor-pointer border-b border-line transition-[background-color,transform,box-shadow] last:border-b-0 focus-visible:outline-offset-[-3px] ${
                selected
                  ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent-ring),0_0_0_3px_var(--accent-soft)]"
                  : isChecked
                    ? "bg-accent-soft/60"
                    : "hover:-translate-y-px hover:bg-surface-raised hover:shadow-card"
              }`}
            >
              <td className="py-3 pl-4" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${node.name}`}
                  checked={isChecked}
                  onChange={(event) => onCheck(node, (event.nativeEvent as MouseEvent).shiftKey)}
                  className="size-4 cursor-pointer accent-[var(--accent-fill)]"
                />
              </td>
              <td className="relative px-3 py-3">
                {selected ? (
                  <span className="absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r-full bg-accent shadow-[0_0_8px_var(--accent)]" />
                ) : null}
                <div className="flex min-w-0 items-center gap-3">
                  <FileGlyph preview={node.preview} />
                  <div className="min-w-0">
                    <span className="block truncate text-[14.5px] font-medium text-ink group-hover:text-ink">
                      {isFolder ? `${node.name}/` : node.name}
                    </span>
                    {/* Size moves under the name when its column is hidden. */}
                    <span className="tnum mt-0.5 block truncate text-[12px] text-ink-faint sm:hidden">
                      {isFolder ? "Folder" : formatBytes(node.size)}
                    </span>
                    {showPath ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenLocation(node);
                        }}
                        title="Go to this location"
                        className="mt-0.5 block max-w-full truncate text-left font-mono text-[11px] text-ink-faint underline-offset-2 hover:text-accent-strong hover:underline"
                      >
                        {node.path.length ? `${node.path.join("/")}/` : "/"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </td>
              <td className="hidden px-3 py-3 text-[13px] text-ink-muted md:table-cell xl:hidden 2xl:table-cell">
                <span className="block truncate">{node.type}</span>
              </td>
              <td className="tnum hidden px-3 py-3 text-[13px] text-ink-muted sm:table-cell">
                {formatBytes(node.size)}
              </td>
              <td className="tnum px-3 py-3 text-[13px] text-ink-muted">
                {formatDate(node.modified)}
              </td>
              <td className="px-2 py-3">
                <div className="flex items-center justify-end gap-0.5">
                {isFolder ? (
                  <button
                    type="button"
                    aria-label={`Show details for ${node.name}`}
                    title="Details"
                    onClick={(event) => {
                      event.stopPropagation();
                      onInspect(node);
                    }}
                    className={`flex size-9 items-center justify-center rounded-lg transition hover:bg-canvas-deep hover:text-ink ${
                      selected
                        ? "text-accent-strong"
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
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleStar(node.id);
                  }}
                  className={`flex size-9 items-center justify-center rounded-lg transition hover:bg-canvas-deep ${
                    isStarred
                      ? "text-warning"
                      : "text-ink-faint opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  }`}
                >
                  <StarIcon size={15} fill={isStarred ? "currentColor" : "none"} />
                </button>
                </div>
              </td>
            </tr>
          );
        })}
        {paddingBottom > 0 ? (
          <tr aria-hidden="true">
            <td colSpan={6} style={{ height: paddingBottom, padding: 0 }} />
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
