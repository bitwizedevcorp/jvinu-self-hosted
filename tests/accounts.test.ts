/**
 * Two-step sign-in (TOTP + recovery codes), the signed-in devices list, and email safety.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-accounts-"));
  process.env.JVINU_SECRET = "accounts-test-secret-0123456789abcdef0123";
  delete process.env.JVINU_DATABASE_URL;
});

const twoFactor = () => import("../app/lib/server/two-factor");

describe("TOTP", () => {
  it("matches RFC 6238's SHA-1 test vectors", async () => {
    const { base32Encode, totpAt } = await twoFactor();
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    // RFC 6238 appendix B, last six digits: T = 59, 1111111109, 1234567890, 2000000000.
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpAt(secret, Math.floor(2000000000 / 30))).toBe("279037");
  });

  it("round-trips base32 and accepts a step of clock drift, no more", async () => {
    const { base32Decode, base32Encode, matchingStep, stepOf, totpAt } = await twoFactor();
    const bytes = Buffer.from("any secret bytes!");
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    const secret = base32Encode(bytes);
    const now = Date.now();
    const step = stepOf(now);
    expect(matchingStep(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(matchingStep(secret, totpAt(secret, step + 1), now)).toBe(step + 1);
    expect(matchingStep(secret, totpAt(secret, step - 3), now)).toBeNull();
    expect(matchingStep(secret, "12345", now)).toBeNull();
  });
});

describe("two-step sign-in", () => {
  it("turns on only with a matching code, refuses replays, and spends recovery codes once", async () => {
    const tf = await twoFactor();
    expect(await tf.twoFactorEnabled()).toBe(false);
    expect(await tf.checkSecondFactor(undefined)).toBe(true); // off: nothing to check

    const { secret } = await tf.startSetup("Admin");
    expect(await tf.confirmSetup("000000")).toBeNull();
    // Confirm with the previous step's code, so the current one is still unused afterwards.
    const codes = await tf.confirmSetup(tf.totpAt(secret, tf.stepOf() - 1));
    expect(codes).toHaveLength(10);
    expect(await tf.twoFactorEnabled()).toBe(true);

    expect(await tf.checkSecondFactor(undefined)).toBe(false);
    expect(await tf.checkSecondFactor("999999")).toBe(false);
    const current = tf.totpAt(secret, tf.stepOf());
    expect(await tf.checkSecondFactor(current)).toBe(true);
    expect(await tf.checkSecondFactor(current)).toBe(false); // replayed
    expect(await tf.checkSecondFactor(tf.totpAt(secret, tf.stepOf() - 1))).toBe(false); // older than one used

    const recovery = codes![0];
    expect(await tf.checkSecondFactor(recovery.toLowerCase().replace("-", ""))).toBe(true);
    expect(await tf.checkSecondFactor(recovery)).toBe(false); // spent
    expect(await tf.recoveryCodesLeft()).toBe(9);

    process.env.JVINU_RESET_TWO_FACTOR = "1";
    await tf.resetIfAsked();
    delete process.env.JVINU_RESET_TWO_FACTOR;
    expect(await tf.twoFactorEnabled()).toBe(false);
  });
});

describe("signed-in devices", () => {
  it("names browsers, and signs out only the person's own sessions", async () => {
    const { describeDevice, endSession } = await import("../app/lib/server/auth");
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(describeDevice(null)).toBe("Unknown device");

    const { db } = await import("../app/lib/server/db");
    const database = await db();
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const insert = (id: string, user: string) =>
      database.run(
        `insert into sessions (id, user_id, user_name, provider, csrf, created_at, expires_at) values (?, ?, 'x', 'oidc', 'c', ?, ?)`,
        [id, user, now, later],
      );
    await insert("a".repeat(64), "oidc:alice");
    await insert("b".repeat(64), "oidc:bob");
    expect(await endSession("oidc:alice", "b".repeat(16))).toBe(false); // Bob's
    expect(await endSession("oidc:alice", "not-a-handle")).toBe(false);
    expect(await endSession("oidc:alice", "a".repeat(16))).toBe(true);
    expect(await database.get(`select id from sessions where user_id = 'oidc:bob'`)).toBeDefined();
  });
});

describe("email", () => {
  it("refuses addresses that could add recipients or headers", async () => {
    const { sendMail, setMailerForTests } = await import("../app/lib/server/mail");
    const sent: string[] = [];
    setMailerForTests(async (mail) => {
      sent.push(`${mail.to}|${mail.subject}`);
    });
    expect(await sendMail({ to: "ok@example.com", subject: "Hi\r\nBcc: x@evil.test", text: "t" })).toBe(true);
    expect(await sendMail({ to: "a@example.com, b@evil.test", subject: "x", text: "t" })).toBe(false);
    expect(await sendMail({ to: '"x" <a@evil.test>', subject: "x", text: "t" })).toBe(false);
    expect(await sendMail({ to: "a@example.com\r\nBcc: b@evil.test", subject: "x", text: "t" })).toBe(false);
    expect(sent).toEqual(["ok@example.com|Hi Bcc: x@evil.test"]); // the subject's line break is gone
    setMailerForTests(null);
  });
});
