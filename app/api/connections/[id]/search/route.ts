import { guardConnection } from "@/app/lib/server/guard";
import { cleanPrefix, fail, handle } from "@/app/lib/server/http";
import { inventoryOf } from "@/app/lib/server/inventory";
import { describeFile } from "@/app/lib/storage";

const MAX_FILES = 500;
const MAX_FOLDERS = 100;

/**
 * Search a whole bucket (or folder) by name, path or type — over the server's flat listing,
 * not just the folders the browser has opened.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/search">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const params = new URL(request.url).searchParams;
  const prefix = cleanPrefix(params.get("prefix"));
  if (prefix === null) return fail("Invalid prefix.", 400);
  const needle = (params.get("q") ?? "").trim().toLowerCase();
  if (!needle || needle.length > 200) return fail("Search for 1–200 characters.", 400);

  try {
    const { files, truncated } = await inventoryOf(guarded.connection, prefix);
    const matches: typeof files = [];
    let total = 0;
    const folders = new Set<string>();
    for (const file of files) {
      const rest = file.key.slice(prefix.length);
      const name = rest.split("/").pop() ?? rest;
      // Folders on the way to every file: matched by their own name.
      const parts = rest.split("/").slice(0, -1);
      for (let depth = 1; depth <= parts.length && folders.size < MAX_FOLDERS; depth++) {
        if (parts[depth - 1].toLowerCase().includes(needle)) folders.add(`${prefix}${parts.slice(0, depth).join("/")}/`);
      }
      if (rest.toLowerCase().includes(needle) || describeFile(name).type.toLowerCase().includes(needle)) {
        total += 1;
        if (matches.length < MAX_FILES) matches.push(file);
      }
    }
    return Response.json({ files: matches, folders: [...folders], total, truncated });
  } catch (error) {
    return handle(error);
  }
}
