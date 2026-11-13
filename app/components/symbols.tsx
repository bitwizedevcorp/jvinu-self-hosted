/**
 * Filled, two-tone symbols for the folder trees, after macOS Finder's: a folder that's
 * open in the tree shows open, and a bucket reads as a drive. Flat fills only (no
 * gradient ids), so any number can share a page. `inverted` is for the selected row.
 */
type SymbolProps = { size?: number; className?: string; inverted?: boolean };

const FOLDER = {
  back: "#3d8ff0",
  front: "#6cb4fb",
  shine: "#a9d4ff",
  paper: "#f4f8ff",
};

export function FolderSymbol({ size = 16, className = "", inverted = false, open = false }: SymbolProps & { open?: boolean }) {
  const back = inverted ? "rgb(255 255 255 / 0.55)" : FOLDER.back;
  const front = inverted ? "#ffffff" : FOLDER.front;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={`shrink-0 ${className}`}>
      {/* Back panel with its tab */}
      <path
        d="M2.5 6.6a2.1 2.1 0 0 1 2.1-2.1h4.3a2 2 0 0 1 1.5.66l1.15 1.24h7.85a2.1 2.1 0 0 1 2.1 2.1v9.4a2.1 2.1 0 0 1-2.1 2.1H4.6a2.1 2.1 0 0 1-2.1-2.1Z"
        fill={back}
      />
      {open ? (
        <>
          {/* A sheet inside, then the front panel tipped forward */}
          <rect x="5" y="7.6" width="13.5" height="7" rx="0.9" fill={inverted ? "rgb(255 255 255 / 0.85)" : FOLDER.paper} />
          <path
            d="M5.5 10.2h16.2a.95.95 0 0 1 .9 1.24l-2.05 6.6a2.1 2.1 0 0 1-2 1.46H4.6a2.1 2.1 0 0 1-2.1-2.1v-.9l2.1-5.66a.95.95 0 0 1 .9-.64Z"
            fill={front}
          />
        </>
      ) : (
        <>
          <path
            d="M2.5 9.7a1.6 1.6 0 0 1 1.6-1.6h15.8a1.6 1.6 0 0 1 1.6 1.6v7.7a2.1 2.1 0 0 1-2.1 2.1H4.6a2.1 2.1 0 0 1-2.1-2.1Z"
            fill={front}
          />
          {/* The lip's highlight */}
          {inverted ? null : <path d="M4.1 8.1h15.8a1.6 1.6 0 0 1 1.6 1.6v.35H2.5v-.35a1.6 1.6 0 0 1 1.6-1.6Z" fill={FOLDER.shine} />}
        </>
      )}
    </svg>
  );
}

/** A bucket as a drive: a silver enclosure with a status light. */
export function BucketSymbol({ size = 16, className = "", inverted = false }: SymbolProps) {
  const body = inverted ? "#ffffff" : "#a7a7b0";
  const top = inverted ? "rgb(255 255 255 / 0.7)" : "#d4d4db";
  const seam = inverted ? "rgb(0 113 227 / 0.35)" : "#8a8a94";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect x="2.5" y="5" width="19" height="14" rx="3" fill={body} />
      <path d="M5.5 5h13a3 3 0 0 1 3 3v1.2h-19V8a3 3 0 0 1 3-3Z" fill={top} />
      <rect x="2.5" y="12.6" width="19" height="0.9" fill={seam} />
      <circle cx="17.6" cy="16.1" r="1.15" fill={inverted ? "#0071e3" : "#34c759"} />
      <rect x="5.4" y="15.5" width="7" height="1.2" rx="0.6" fill={seam} />
    </svg>
  );
}
