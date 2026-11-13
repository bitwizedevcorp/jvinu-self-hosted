import { LOGO_TRANSFORM, LOGO_VIEWBOX, MARK_PATHS, NAME_PATHS } from "./brand";

/**
 * The jvinu logo: the mark and the name, as one drawing in the text colour, sized by the
 * font size (1.2em tall). "jvinu" is Lojban for "view".
 */
export function Wordmark({
  withTagline = false,
  className = "",
}: {
  withTagline?: boolean;
  className?: string;
}) {
  const logo = (
    <svg viewBox={LOGO_VIEWBOX} className="h-[1.2em] w-auto shrink-0" role="img" aria-label="jvinu">
      <g transform={LOGO_TRANSFORM} fill="currentColor">
        {[...MARK_PATHS, ...NAME_PATHS].map((d, index) => (
          <path key={index} d={d} />
        ))}
      </g>
    </svg>
  );
  if (!withTagline) return <span className={`inline-flex items-center leading-none ${className}`}>{logo}</span>;
  // The tagline sits under the name, never across it.
  return (
    <span className={`inline-flex flex-col items-center leading-none ${className}`}>
      {logo}
      <span className="mt-[0.4em] text-[0.4em] font-medium tracking-[0.02em] text-ink-muted">your data, in view</span>
    </span>
  );
}
