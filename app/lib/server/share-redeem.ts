import "server-only";
import { LINK_VISITOR, recordActivity } from "./activity";
import { StorageUserError } from "./drivers/types";
import { checkPassword, openLink, overLimit, refusal, type Refusal } from "./share-access";
import { servedFromCopy, shareDriverFor } from "./share-copies";
import { startDownload, type Delivery } from "./share-serve";
import type { ShareLink } from "./shares";

export type Redemption = { refused: Refusal } | { link: ShareLink; delivery: Delivery };
export type Viewing = { refused: Refusal } | { link: ShareLink; protected: boolean };

/**
 * What opening a share link's page may show, without counting a download (link previews in
 * chat apps open pages too): the page-view limits, then whether the link still works, and
 * whether it asks for a password. The steps before the password, in the same order as below.
 */
export async function viewLink(token: string, headers: Headers): Promise<Viewing> {
  const busy = overLimit("page", token, headers);
  if (busy) return { refused: busy };
  const opened = await openLink(token);
  if ("code" in opened) return { refused: opened };
  return { link: opened.link, protected: Boolean(opened.passwordHash) };
}

/**
 * Turns a share link into one download, or says why not — every check in its order:
 *
 * 1. the per-address, per-link and overall download limits;
 * 2. the link exists and still works (not expired, used up or revoked);
 * 3. the password, when it has one, with backoff for wrong guesses;
 * 4. the connection is still there;
 * 5. the bytes, from the share bucket's copy once it's ready — the original until then, or
 *    if the copy has gone — counting one download only once the file is known to be there;
 * 6. the download goes in the connection's history.
 *
 * A file that's gone reads as "gone"; losing the race for the last download, as "used up".
 * The caller turns the answer into a response: a redirect, the bytes, or the refusal.
 */
export async function redeemLink(token: string, password: string | null, headers: Headers): Promise<Redemption> {
  const busy = overLimit("download", token, headers);
  if (busy) return { refused: busy };
  const opened = await openLink(token);
  if ("code" in opened) return { refused: opened };
  const { link, passwordHash } = opened;
  const wrong = await checkPassword(link, passwordHash, password, headers);
  if (wrong) return { refused: wrong };

  const original = await shareDriverFor(link.connectionId);
  if (!original) return { refused: refusal("gone") };
  let delivery: Delivery;
  try {
    const copy = await servedFromCopy(link);
    delivery = copy
      ? await startDownload(link, copy.driver, copy.key).catch((error) => {
          if (error instanceof StorageUserError && error.status === 404) return startDownload(link, original);
          throw error;
        })
      : await startDownload(link, original);
  } catch (error) {
    if (error instanceof StorageUserError && error.status === 404) return { refused: refusal("gone") };
    if (error instanceof StorageUserError && error.status === 410) return { refused: refusal("used-up") };
    throw error;
  }
  await recordActivity({ connectionId: link.connectionId, actor: LINK_VISITOR, action: "link-downloaded", target: link.key, detail: { linkId: link.id } });
  return { link, delivery };
}
