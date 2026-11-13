"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/remote";
import { Avatar, avatarUrl, type SignedInUser } from "./account-menu";
import { CloseIcon } from "./icons";

const MAX_NAME = 60;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const INPUT =
  "w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[14px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring";

/**
 * The signed-in person's name, email and photo. Everything stays on this server: the photo
 * is resized there and kept in its data folder. Nothing changes until "Save".
 */
export function ProfileDialog({ user, onClose }: { user: SignedInUser; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? "");
  /** A new photo picked here (not saved yet), "remove", or null for no change. */
  const [photo, setPhoto] = useState<{ file: File; preview: string } | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  // Free the preview's object URL when it's replaced or the dialog closes.
  useEffect(() => {
    if (!photo || photo === "remove") return;
    return () => URL.revokeObjectURL(photo.preview);
  }, [photo]);

  function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith("image/")) return setError("Choose an image file: JPEG, PNG or WebP.");
    if (file.size > MAX_PHOTO_BYTES) return setError("Use an image under 8 MB.");
    setPhoto({ file, preview: URL.createObjectURL(file) });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (photo === "remove") await api.removeAvatar();
      else if (photo) await api.uploadAvatar(photo.file);
      await api.updateProfile({ name: name.trim(), email: email.trim() });
      // The page's server part reads the profile again, so the new name shows everywhere.
      router.refresh();
      ref.current?.close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save your profile.");
      setBusy(false);
    }
  }

  const shown = photo === "remove" ? null : photo ? photo.preview : user.avatar ? avatarUrl(user.avatar) : null;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby={`${id}-title`}
      style={{ width: "min(420px, calc(100vw - 2rem))" }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <form onSubmit={save} className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2 id={`${id}-title`} className="flex-1 text-[16px] font-semibold text-ink">
            Your profile
          </h2>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-4">
            <Avatar name={name.trim() || user.name} size={64} src={shown} />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded-xl border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink transition hover:bg-surface-sunken"
              >
                {shown ? "Change photo" : "Upload photo"}
              </button>
              {shown ? (
                <button
                  type="button"
                  onClick={() => setPhoto(user.avatar ? "remove" : null)}
                  className="rounded-xl px-3 py-1.5 text-[13px] font-semibold text-danger transition hover:bg-danger/10"
                >
                  Remove
                </button>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                className="sr-only"
                tabIndex={-1}
                aria-label="Photo"
                onChange={(event) => {
                  pick(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <p className="w-full text-[11.5px] text-ink-faint">Optional. Kept on this server only, as a small square.</p>
            </div>
          </div>

          <div>
            <label htmlFor={`${id}-name`} className="block text-[12.5px] font-medium text-ink">
              Name
            </label>
            <input
              id={`${id}-name`}
              required
              maxLength={MAX_NAME}
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={`${INPUT} mt-1.5`}
            />
            <p className="mt-1 text-[11.5px] text-ink-faint">Shown in the history next to what you change.</p>
          </div>

          <div>
            <label htmlFor={`${id}-email`} className="block text-[12.5px] font-medium text-ink">
              Email <span className="font-normal text-ink-faint">Optional</span>
            </label>
            <input
              id={`${id}-email`}
              type="email"
              maxLength={254}
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className={`${INPUT} mt-1.5`}
            />
            <p className="mt-1 text-[11.5px] text-ink-faint">Used for receipts if you buy storage. It doesn&rsquo;t change how you sign in.</p>
          </div>

          {error ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="rounded-xl border border-line-strong bg-surface px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="spring rounded-xl bg-accent-fill px-4 py-2 text-[13.5px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
