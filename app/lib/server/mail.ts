import "server-only";

/**
 * Plain-text email through your own SMTP server. Off unless JVINU_SMTP_URL is set:
 *
 *   JVINU_SMTP_URL=smtps://user:password@smtp.example.com:465   (or smtp://…:587, upgraded with STARTTLS)
 *   JVINU_MAIL_FROM="Cloud storage <storage@example.com>"
 *
 * Text only, so nothing a recipient's name or a reason contains can become markup.
 */
export type Mail = { to: string; subject: string; text: string };

const EMAIL = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,255}\.[^\s@<>",;]{2,}$/;

export function mailConfigured(): boolean {
  return Boolean(process.env.JVINU_SMTP_URL?.trim() && process.env.JVINU_MAIL_FROM?.trim());
}

const holder = globalThis as unknown as { __jvinuMail?: { url: string; send: (mail: Mail) => Promise<void> } };

/** Tests and previews swap the transport for a recorder. */
export function setMailerForTests(send: ((mail: Mail) => Promise<void>) | null) {
  holder.__jvinuMail = send ? { url: "test", send } : undefined;
}

async function transport(): Promise<((mail: Mail) => Promise<void>) | null> {
  if (holder.__jvinuMail?.url === "test") return holder.__jvinuMail.send;
  const url = process.env.JVINU_SMTP_URL?.trim();
  const from = process.env.JVINU_MAIL_FROM?.trim();
  if (!url || !from) return null;
  if (holder.__jvinuMail?.url !== url) {
    const nodemailer = (await import("nodemailer")).default;
    const parsed = new URL(url);
    const secure = parsed.protocol === "smtps:";
    if (!secure && parsed.protocol !== "smtp:") throw new Error("JVINU_SMTP_URL must start with smtp:// or smtps://.");
    const transporter = nodemailer.createTransport({
      host: parsed.hostname,
      port: Number(parsed.port) || (secure ? 465 : 587),
      secure,
      // Never send credentials or mail over an unencrypted connection: smtp:// must upgrade.
      requireTLS: !secure,
      tls: { minVersion: "TLSv1.2" },
      auth: parsed.username ? { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } : undefined,
    });
    holder.__jvinuMail = {
      url,
      send: async (mail) => {
        await transporter.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
      },
    };
  }
  return holder.__jvinuMail.send;
}

/** Sends one email. Never throws: returns whether it went. A bad address is refused here. */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!EMAIL.test(mail.to) || mail.to.length > 254) {
    console.warn(`[mail] not sending "${mail.subject}": "${mail.to.slice(0, 80)}" isn't a usable address`);
    return false;
  }
  try {
    const send = await transport();
    if (!send) return false;
    await send({ ...mail, subject: mail.subject.replace(/[\r\n]+/g, " ").slice(0, 200) });
    return true;
  } catch (error) {
    console.error(`[mail] couldn't send "${mail.subject}" to ${mail.to}:`, (error as Error).message);
    return false;
  }
}
