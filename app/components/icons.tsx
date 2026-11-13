import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Glyph({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20.5 20.5-3.9-3.9" />
  </Glyph>
);

export const ChevronRight = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m9 5 7 7-7 7" />
  </Glyph>
);

export const ChevronDown = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m5 9 7 7 7-7" />
  </Glyph>
);

export const ChevronUpDown = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m8 10 4-4 4 4" />
    <path d="m8 14 4 4 4-4" />
  </Glyph>
);

export const UploadIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 16V4" />
    <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Glyph>
);

export const PlusIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 5v14M5 12h14" />
  </Glyph>
);

export const GridIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.6" />
    <rect x="13" y="4" width="7" height="7" rx="1.6" />
    <rect x="4" y="13" width="7" height="7" rx="1.6" />
    <rect x="13" y="13" width="7" height="7" rx="1.6" />
  </Glyph>
);

export const ListIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </Glyph>
);

export const StarIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m12 4 2.3 4.9 5.2.7-3.8 3.7.9 5.3-4.6-2.6-4.6 2.6.9-5.3L4.5 9.6l5.2-.7Z" />
  </Glyph>
);

export const ClockIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 1.8" />
  </Glyph>
);

export const LinkIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M10 13.5a3.5 3.5 0 0 0 5 .3l2.8-2.8a3.5 3.5 0 0 0-5-5L11.5 7.3" />
    <path d="M14 10.5a3.5 3.5 0 0 0-5-.3L6.2 13a3.5 3.5 0 0 0 5 5l1.3-1.3" />
  </Glyph>
);

export const SettingsIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.5a1.5 1.5 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.5 1.5 0 0 0-2.5 1v.2a2 2 0 1 1-4 0V20a1.5 1.5 0 0 0-2.5-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.5 1.5 0 0 0 4 13.6H4a2 2 0 1 1 0-4h.1A1.5 1.5 0 0 0 5.2 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.5 1.5 0 0 0 2.5-1.1V3a2 2 0 1 1 4 0v.1a1.5 1.5 0 0 0 2.5 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a2 2 0 1 1 0 4H20a1.5 1.5 0 0 0-1.4.9Z" />
  </Glyph>
);

export const LockIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 1 1 7 0v2.5" />
  </Glyph>
);

/** jvinu encryption: the connection's files are encrypted with a passphrase. */
export const KeyIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="7.5" cy="15.5" r="4" />
    <path d="m10.4 12.6 9.1-9.1M16 7l2.5 2.5M18.5 4.5 21 7" />
  </Glyph>
);

export const CloseIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Glyph>
);

export const DownloadIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 4v12" />
    <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
    <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Glyph>
);

export const ShareIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="6.5" cy="12" r="2.5" />
    <circle cx="17.5" cy="6.5" r="2.5" />
    <circle cx="17.5" cy="17.5" r="2.5" />
    <path d="m8.8 10.8 6.4-3.1M8.8 13.2l6.4 3.1" />
  </Glyph>
);

export const ExternalIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M14 5h5v5" />
    <path d="M19 5l-7.5 7.5" />
    <path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
  </Glyph>
);

export const MenuIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Glyph>
);

export const MoreIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Glyph>
);

export const BucketIcon = (p: IconProps) => (
  <Glyph {...p}>
    <ellipse cx="12" cy="6.2" rx="7.5" ry="2.8" />
    <path d="M4.5 6.2v11.6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6.2" />
    <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
  </Glyph>
);

export const FolderIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.1a2 2 0 0 1 1.5.7l1 1.2h7.4a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
  </Glyph>
);

export const ImageIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="4" y="5" width="16" height="14" rx="2.2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m5 17 4.2-4.2a1.6 1.6 0 0 1 2.3 0L19 20" />
  </Glyph>
);

export const VectorIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.5" y="3.5" width="4" height="4" rx="1" />
    <rect x="16.5" y="3.5" width="4" height="4" rx="1" />
    <rect x="3.5" y="16.5" width="4" height="4" rx="1" />
    <rect x="16.5" y="16.5" width="4" height="4" rx="1" />
    <path d="M7.5 5.5h9M5.5 7.5v9M18.5 7.5v9M7.5 18.5h9" />
  </Glyph>
);

export const VideoIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3" y="5.5" width="13" height="13" rx="2.4" />
    <path d="m16 11.5 4.3-2.8a.6.6 0 0 1 .95.5v5.6a.6.6 0 0 1-.95.5L16 12.5Z" />
  </Glyph>
);

export const AudioIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M9 17.5V6l9-1.8v11.3" />
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="15.5" cy="15.5" r="2.5" />
  </Glyph>
);

export const DocumentIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
    <path d="M13.5 3.5V9H19" />
    <path d="M8.5 13.5h7M8.5 16.5h4.5" />
  </Glyph>
);

export const ArchiveIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.6" />
    <path d="M5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9" />
    <path d="M10.5 13h3" />
  </Glyph>
);

export const CodeIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m8.5 8.5-4 3.5 4 3.5" />
    <path d="m15.5 8.5 4 3.5-4 3.5" />
    <path d="m13.5 5.5-3 13" />
  </Glyph>
);

export const DataIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2.2" />
    <path d="M4 9.5h16M4 14.5h16M9.5 9.5V20" />
  </Glyph>
);

export const CheckIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Glyph>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4.5 12h15" />
    <path d="m14 6.5 5.5 5.5-5.5 5.5" />
  </Glyph>
);

export const TrashIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4.5 6.5h15" />
    <path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5" />
    <path d="M6.5 6.5V19a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5" />
    <path d="M10.5 10.5v6M13.5 10.5v6" />
  </Glyph>
);

export const SignOutIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10" />
    <path d="M14.5 8.5 18.5 12l-4 3.5" />
    <path d="M18.5 12h-9" />
  </Glyph>
);

export const SignInIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" />
    <path d="m9.5 8.5 4 3.5-4 3.5" />
    <path d="M13.5 12h-9" />
  </Glyph>
);

export const UserIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 19.5a7 7 0 0 1 14 0" />
  </Glyph>
);

export const BellIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15Z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Glyph>
);

export const ChartIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4.5 19.5h15" />
    <rect x="6" y="11" width="3" height="6" rx="0.8" />
    <rect x="10.5" y="6.5" width="3" height="10.5" rx="0.8" />
    <rect x="15" y="13.5" width="3" height="3.5" rx="0.8" />
  </Glyph>
);

export const CloudIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M7.5 18.5h9.5a4 4 0 0 0 .4-7.98A5.5 5.5 0 0 0 6.9 9.6 4.5 4.5 0 0 0 7.5 18.5Z" />
  </Glyph>
);

export const SunIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </Glyph>
);

export const MoonIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" />
  </Glyph>
);

export const DisplayIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </Glyph>
);

export const RefreshIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Glyph>
);

export const InfoIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5" />
    <path d="M12 7.6h.01" />
  </Glyph>
);

export const ArrowLeftIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M19.5 12h-15" />
    <path d="m10 6.5-5.5 5.5 5.5 5.5" />
  </Glyph>
);

export const ArrowUpIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 19.5v-15" />
    <path d="m6.5 10 5.5-5.5 5.5 5.5" />
  </Glyph>
);

export const TableIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" />
  </Glyph>
);

export const WarningIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M10.3 4.3 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4.5M12 17h.01" />
  </Glyph>
);

export const PinIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
    <path d="M12 14v6" />
  </Glyph>
);

export const NoteIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M5 4.5h14v10l-5 5H5Z" />
    <path d="M14 19.5v-5h5M8.5 9h7M8.5 12.5h4" />
  </Glyph>
);

export const PulseIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
  </Glyph>
);

export const CompareIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.5" y="4.5" width="7" height="15" rx="1.5" />
    <rect x="13.5" y="4.5" width="7" height="15" rx="1.5" />
    <path d="M6 9h2M6 12h2M16 9h2M16 15h2" />
  </Glyph>
);

export const SqlIcon = (p: IconProps) => (
  <Glyph {...p}>
    <ellipse cx="12" cy="6" rx="7.5" ry="2.5" />
    <path d="M4.5 6v12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6" />
    <path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
  </Glyph>
);

export const TagIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3.5 12.5V4.5h8l9 9-8 8-9-9Z" />
    <circle cx="8" cy="9" r="1.3" />
  </Glyph>
);

export const RobotIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="4.5" y="8" width="15" height="11" rx="3" />
    <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5" />
  </Glyph>
);

export const HistoryIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3.5 12A8.5 8.5 0 1 0 6 6L3.5 8.5" />
    <path d="M3.5 4.5v4h4" />
    <path d="M12 8v4l2.8 1.8" />
  </Glyph>
);

export const CookieIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M20.5 12.5a8.5 8.5 0 1 1-9-9 3 3 0 0 0 3.5 3.5 3 3 0 0 0 3 3 2.5 2.5 0 0 0 2.5 2.5Z" />
    <path d="M8.5 9.5h.01M8 14.5h.01M12.5 16h.01M15.5 13.5h.01" />
  </Glyph>
);

export const XrayIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M3.5 12h17" />
    <path d="M8.5 9v6M12 8v8M15.5 9.5v5" />
  </Glyph>
);
