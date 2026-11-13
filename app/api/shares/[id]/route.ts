import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { requireUser } from "@/app/lib/server/auth";
import { fail, handle } from "@/app/lib/server/http";
import { getCopy, sweepCopies } from "@/app/lib/server/share-copies";
import { getShareLink, revokeShareLink, shareView } from "@/app/lib/server/shares";

/** DELETE → revokes the link at once. It stays listed, as revoked, until it's purged. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/shares/[id]">) {
  const user = await requireUser(request, { mutating: true });
  if (user instanceof Response) return user;
  try {
    const { id } = await ctx.params;
    const wasLive = (await getShareLink(id))?.link.revokedAt === null;
    const link = await revokeShareLink(id, user.id);
    if (!link) return fail("No such link.", 404);
    if (wasLive && link.revokedAt) {
      await recordActivity({ connectionId: link.connectionId, actor: actorOf(user), action: "unshared", target: link.key, detail: { linkId: link.id } });
    }
    // Its copy in the share bucket goes now, unless another link still uses it.
    await sweepCopies().catch((error) => console.error("[shares] sweep after revoke failed", error));
    const token = (await getShareLink(id))?.token ?? null;
    const copy = link.copyId ? await getCopy(link.copyId) : undefined;
    return Response.json({ link: shareView(link, token, copy ? { connectionId: copy.targetConnectionId, status: copy.status } : null) });
  } catch (error) {
    return handle(error);
  }
}
