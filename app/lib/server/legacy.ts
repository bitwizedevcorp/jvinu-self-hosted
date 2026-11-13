import "server-only";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import type { Credentials, PresetId } from "./connections";
import { dataDir } from "./db";
import { unseal, unsealForBrowser } from "./vault";

/**
 * Before v1, connections lived in the browser: first inline in a cookie, then in a vault
 * file keyed by that cookie. Both are read once here, imported into the database, and
 * then removed.
 */
const COOKIE = "jvinu_vault";

type Ref = { v: 2; id: string; key: string };
export type LegacyConnection = {
  id: string;
  presetId: PresetId;
  name: string;
  bucket: string;
  region: string;
  endpoint?: string;
  credentials: Credentials;
  createdAt: string;
};
type InlineLegacy = Omit<LegacyConnection, "credentials"> & { accessKeyId: string; secretAccessKey: string };

export async function readLegacyConnections(): Promise<{ list: LegacyConnection[]; cleanup: () => Promise<void> } | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const ref = unseal<Ref | InlineLegacy[]>(token);
  const cleanup = async () => {
    if (ref && !Array.isArray(ref) && /^[a-f0-9]{32}$/.test(ref.id)) {
      await rm(path.join(dataDir(), "vaults", `${ref.id}.bin`), { force: true });
    }
    store.delete(COOKIE);
  };
  if (!ref) return { list: [], cleanup };
  if (Array.isArray(ref)) {
    return {
      list: ref.map(({ accessKeyId, secretAccessKey, ...rest }) => ({
        ...rest,
        presetId: "s3",
        credentials: { kind: "s3", accessKeyId, secretAccessKey },
      })),
      cleanup,
    };
  }
  try {
    const raw = await readFile(path.join(dataDir(), "vaults", `${ref.id}.bin`));
    const list = unsealForBrowser<LegacyConnection[]>(raw, ref.key);
    return { list: Array.isArray(list) ? list : [], cleanup };
  } catch {
    return { list: [], cleanup };
  }
}
