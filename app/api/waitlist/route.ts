import { requireUser } from "@/app/lib/server/auth";
import { fail, readJson, tooLarge } from "@/app/lib/server/http";
import { forwardToWaitlist, SIZES, waitlistUrl, type WaitlistEntry } from "@/app/lib/server/waitlist";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Join the cloud-backup waitlist: validated here, forwarded by the server. */
export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true });
  if (user instanceof Response) return user;
  const url = waitlistUrl();
  if (!url) return fail("The waitlist isn't available on this server.", 404);

  let body: { email?: unknown; size?: unknown; note?: unknown };
  try {
    body = await readJson(request, 16 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!EMAIL.test(email) || email.length > 254) return fail("Enter a valid email address.", 400);
  const size = SIZES.find((option) => option === body.size);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  const entry: WaitlistEntry = { email, size, note: note || undefined };

  if (!(await forwardToWaitlist(url, entry))) return fail("Couldn't reach the waitlist just now. Try again later.", 502);
  return Response.json({ ok: true });
}
