import { inventoryOf } from "@/app/lib/server/inventory";
import { guardConnection } from "@/app/lib/server/guard";
import { cleanPrefix, fail, handle } from "@/app/lib/server/http";
import { describeFile, type PreviewKind } from "@/app/lib/storage";

type Bucket = { objects: number; bytes: number };
export type Analytics = {
  prefix: string;
  scannedAt: string;
  /** True when the scan stopped at the cap: totals are a lower bound. */
  truncated: boolean;
  objects: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
  byClass: ({ storageClass: string | null } & Bucket)[];
  byKind: ({ kind: PreviewKind } & Bucket)[];
  byFolder: ({ folder: string } & Bucket)[];
  /** Last 12 months by last-modified date, oldest first ("2026-03"). */
  byMonth: ({ month: string } & Bucket)[];
  largest: { key: string; size: number; lastModified: string | null; storageClass: string | null }[];
};

const add = (map: Map<string, Bucket>, key: string, bytes: number) => {
  const entry = map.get(key) ?? { objects: 0, bytes: 0 };
  entry.objects += 1;
  entry.bytes += bytes;
  map.set(key, entry);
};
const ranked = (map: Map<string, Bucket>) => [...map].sort((a, b) => b[1].bytes - a[1].bytes);

/** Size, composition and growth of a bucket (or folder): one flat listing, summarised. */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/analytics">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const params = new URL(request.url).searchParams;
  const prefix = cleanPrefix(params.get("prefix"));
  if (prefix === null) return fail("Invalid prefix.", 400);

  try {
    const { files, truncated } = await inventoryOf(guarded.connection, prefix, params.get("refresh") === "1");
    const byClass = new Map<string, Bucket>();
    const byKind = new Map<string, Bucket>();
    const byFolder = new Map<string, Bucket>();
    const byMonth = new Map<string, Bucket>();
    let bytes = 0;
    let oldest: string | null = null;
    let newest: string | null = null;

    for (const file of files) {
      bytes += file.size;
      add(byClass, file.storageClass ?? "", file.size);
      add(byKind, describeFile(file.key.split("/").pop() ?? "").preview, file.size);
      const rest = file.key.slice(prefix.length);
      add(byFolder, rest.includes("/") ? `${rest.slice(0, rest.indexOf("/"))}/` : "", file.size);
      if (file.lastModified) {
        add(byMonth, file.lastModified.slice(0, 7), file.size);
        if (!oldest || file.lastModified < oldest) oldest = file.lastModified;
        if (!newest || file.lastModified > newest) newest = file.lastModified;
      }
    }

    const months: string[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }

    const body: Analytics = {
      prefix,
      scannedAt: new Date().toISOString(),
      truncated,
      objects: files.length,
      bytes,
      oldest,
      newest,
      byClass: ranked(byClass).map(([key, value]) => ({ storageClass: key || null, ...value })),
      byKind: ranked(byKind).map(([key, value]) => ({ kind: key as PreviewKind, ...value })),
      // The ten biggest folders; files directly in the prefix show as "".
      byFolder: ranked(byFolder)
        .slice(0, 10)
        .map(([key, value]) => ({ folder: key, ...value })),
      byMonth: months.map((month) => ({ month, ...(byMonth.get(month) ?? { objects: 0, bytes: 0 }) })),
      largest: [...files]
        .sort((a, b) => b.size - a.size)
        .slice(0, 10)
        .map(({ key, size, lastModified, storageClass }) => ({ key, size, lastModified, storageClass })),
    };
    return Response.json(body);
  } catch (error) {
    return handle(error);
  }
}
