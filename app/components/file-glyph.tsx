import type { PreviewKind } from "../lib/storage";
import {
  ArchiveIcon,
  AudioIcon,
  CodeIcon,
  DataIcon,
  DocumentIcon,
  FolderIcon,
  ImageIcon,
  VectorIcon,
  VideoIcon,
} from "./icons";

type Tint = { bg: string; fg: string };

/**
 * Apple system colours. Backgrounds are translucent so one value reads on the
 * light and the dark material alike; the glyph keeps the full-strength colour.
 */
export const TINTS: Record<PreviewKind, Tint> = {
  folder: { bg: "rgb(10 132 255 / 0.15)", fg: "#1f8bff" },
  image: { bg: "rgb(255 149 0 / 0.16)", fg: "#f08a00" },
  vector: { bg: "rgb(175 82 222 / 0.16)", fg: "#a84fd8" },
  video: { bg: "rgb(255 45 85 / 0.14)", fg: "#f2335a" },
  audio: { bg: "rgb(88 86 214 / 0.16)", fg: "#6563e0" },
  document: { bg: "rgb(255 59 48 / 0.13)", fg: "#f0443a" },
  archive: { bg: "rgb(162 132 94 / 0.18)", fg: "#a2845e" },
  code: { bg: "rgb(48 176 199 / 0.16)", fg: "#2aa5bb" },
  data: { bg: "rgb(52 199 89 / 0.15)", fg: "#2fb352" },
};

const GLYPHS: Record<PreviewKind, (p: { size?: number }) => React.ReactElement> = {
  folder: FolderIcon,
  image: ImageIcon,
  vector: VectorIcon,
  video: VideoIcon,
  audio: AudioIcon,
  document: DocumentIcon,
  archive: ArchiveIcon,
  code: CodeIcon,
  data: DataIcon,
};

export function FileGlyph({
  preview,
  size = 38,
  radius = 12,
  onTint = false,
}: {
  preview: PreviewKind;
  size?: number;
  radius?: number;
  /** Sitting on a tile already painted in this tint: lift the chip off it. */
  onTint?: boolean;
}) {
  const tint = TINTS[preview];
  const Glyph = GLYPHS[preview];
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: onTint ? "var(--surface-raised)" : tint.bg,
        color: tint.fg,
        boxShadow: onTint ? "0 1px 2px rgb(0 0 0 / 0.12)" : undefined,
      }}
    >
      <Glyph size={Math.round(size * 0.5)} />
    </span>
  );
}
