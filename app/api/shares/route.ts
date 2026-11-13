import { requireUser } from "@/app/lib/server/auth";
import { handle } from "@/app/lib/server/http";
import { getCopy, sweepCopies } from "@/app/lib/server/share-copies";
import { listShareLinks, purgeEndedLinks, shareView } from "@/app/lib/server/shares";

/** GET → this person's share links, newest first, with their counts and state. */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  try {
    // Links that ended a month ago have nothing left to show.
    await purgeEndedLinks();
    // Copies whose links have ended go too (the regular sweep would get there within minutes).
    void sweepCopies().catch(() => {});
    const links = await listShareLinks(user.id);
    const views = await Promise.all(
      links.map(async ({ link, token }) => {
        const copy = link.copyId ? await getCopy(link.copyId) : undefined;
        return shareView(link, token, copy ? { connectionId: copy.targetConnectionId, status: copy.status } : null);
      }),
    );
    return Response.json({ links: views });
  } catch (error) {
    return handle(error);
  }
}
