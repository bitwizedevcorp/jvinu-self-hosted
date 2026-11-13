"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { LockIcon, MoreIcon, SettingsIcon, TrashIcon } from "./icons";

function MenuItem({ icon, children, onClick, danger = false }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] font-medium outline-none transition-colors ${
        danger ? "text-danger hover:bg-danger/10 focus-visible:bg-danger/10" : "text-ink hover:bg-surface-sunken focus-visible:bg-surface-sunken"
      }`}
    >
      <span className={danger ? "" : "text-ink-faint"}>{icon}</span>
      {children}
    </button>
  );
}

/**
 * A connection's actions in the sidebar, behind one button that's always there (so it never
 * sits on top of the name): its settings, read-only on or off, and disconnecting.
 */
export function ConnectionMenu({
  name,
  readOnly,
  managed,
  onSettings,
  onToggleReadOnly,
  onDisconnect,
}: {
  name: string;
  readOnly: boolean;
  /** Bundled storage belongs to the server: it can't be disconnected. */
  managed: boolean;
  onSettings: () => void;
  onToggleReadOnly: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    wrapper.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    function outside(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  // Arrows move through the items and Esc closes, without reaching the file list's own keys.
  function keys(event: React.KeyboardEvent) {
    if (!open) return;
    const items = [...(wrapper.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapper} className="relative shrink-0" onKeyDown={keys}>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Settings and actions for ${name}`}
        title="Settings and actions"
        className={`flex size-6 items-center justify-center rounded-md transition hover:bg-canvas-deep hover:text-ink ${
          open ? "bg-canvas-deep text-ink" : "text-ink-faint"
        }`}
      >
        <MoreIcon size={15} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={name}
          className="material-thick pop-in absolute right-0 top-[calc(100%+4px)] z-30 w-[210px] origin-top-right rounded-2xl border border-line p-1.5 shadow-pop"
        >
          <MenuItem icon={<SettingsIcon size={15} />} onClick={() => choose(onSettings)}>
            Settings
          </MenuItem>
          <MenuItem icon={<LockIcon size={15} />} onClick={() => choose(onToggleReadOnly)}>
            <span className="flex-1">{readOnly ? "Allow changes" : "Make read-only"}</span>
            {readOnly ? <span className="text-[11px] font-medium text-ink-faint">On</span> : null}
          </MenuItem>
          {managed ? null : (
            <>
              <div className="my-1 h-px bg-line" />
              <MenuItem danger icon={<TrashIcon size={15} />} onClick={() => choose(onDisconnect)}>
                Disconnect bucket…
              </MenuItem>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
