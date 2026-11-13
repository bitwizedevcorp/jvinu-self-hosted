import { storageDisk } from "@/app/lib/server/bundled-storage";
import { guardConnection } from "@/app/lib/server/guard";
import { fail, handle } from "@/app/lib/server/http";
import { planDisk } from "@/app/lib/server/storage-plan";

/**
 * Used and free space: the volume behind bundled storage, or a paid plan's quota.
 * Other clouds don't say.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/disk">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  if (!guarded.connection.managed) return fail("Disk space is only known for managed storage.", 404);
  try {
    const disk = guarded.connection.managed === "cloud-storage" ? await planDisk() : await storageDisk();
    if (!disk) return fail("The storage server didn't report its disk.", 503);
    return Response.json(disk);
  } catch (error) {
    return handle(error);
  }
}
