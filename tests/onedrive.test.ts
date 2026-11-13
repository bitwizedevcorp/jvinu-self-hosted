/**
 * What's particular to OneDrive, beyond the shared driver contract: real folders, upload
 * sessions, background copies, the device-code sign-in and rotating refresh tokens. Runs
 * against the in-process Graph mock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  oneDriveAccount,
  oneDriveDriver,
  oneDriveFolder,
  oneDriveTenant,
  redeemOneDriveSignIn,
  startOneDriveSignIn,
} from "../app/lib/server/drivers/onedrive";
import type { StorageDriver } from "../app/lib/server/drivers/types";
import { runOperation } from "../app/lib/server/operations";
import { MOCK_CLIENT_ID, MOCK_REFRESH_TOKEN, MOCK_TENANT, MOCK_USER_CODE, startOneDriveMock } from "./onedrive-mock";

const mock = await startOneDriveMock();
const APP = { endpoint: mock.url, clientId: MOCK_CLIENT_ID, tenant: MOCK_TENANT };
const oneDrive = (root: string, refreshToken = MOCK_REFRESH_TOKEN) => oneDriveDriver({ root, ...APP, refreshToken });

const text = (value: string) => new TextEncoder().encode(value);

function streamOf(bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

async function readAll(driver: StorageDriver, key: string): Promise<Buffer> {
  const { stream } = await driver.read(key);
  return Buffer.from(await new Response(stream).arrayBuffer());
}

describe("onedrive specifics", () => {
  const root = `/jvinu-onedrive-${Date.now().toString(36)}`;
  const driver = oneDrive(root);

  beforeAll(() => oneDrive("/").write(`${root.slice(1)}/`, new Uint8Array(0)));
  afterAll(async () => {
    await oneDrive("/").remove([`${root.slice(1)}/`]);
    mock.close();
  });

  it("normalises folder paths and tenants", () => {
    expect(oneDriveFolder("")).toBe("/");
    expect(oneDriveFolder("Photos/2024/")).toBe("/Photos/2024");
    expect(oneDriveFolder("/a//b")).toBe("/a/b");
    expect(oneDriveFolder("/a/../b")).toBeNull();
    expect(oneDriveFolder("/a/b:c")).toBeNull();
    expect(oneDriveFolder("/trailing. ")).toBeNull();
    expect(oneDriveTenant("")).toBe("common");
    expect(oneDriveTenant(" contoso.onmicrosoft.com ")).toBe("contoso.onmicrosoft.com");
    expect(oneDriveTenant("no/slashes")).toBeNull();
  });

  it("makes nested folders, and keeps names with awkward characters", async () => {
    await driver.write("deep/er/est/", new Uint8Array(0));
    await driver.write("deep/er/est/50% off #1 (final).txt", text("sale"));
    expect((await driver.list("deep/er/est/")).files.map((file) => file.key)).toEqual(["deep/er/est/50% off #1 (final).txt"]);
    expect((await readAll(driver, "deep/er/est/50% off #1 (final).txt")).toString()).toBe("sale");
  });

  it("moves a folder as one tree, leaving nothing behind", async () => {
    await driver.write("album/one.jpg", text("1"));
    await driver.write("album/nested/two.jpg", text("22"));
    await driver.write("album/empty/", new Uint8Array(0));
    const result = await runOperation(driver, { op: "rename", items: [{ key: "album/", kind: "folder" }], name: "trip" });
    expect(result).toMatchObject({ done: 1, failed: [] });
    expect((await driver.list("")).folders.sort()).toEqual(["deep/", "trip/"]);
    expect([...(await driver.listKeys("trip/", 100)).keys].sort()).toEqual(["trip/empty/", "trip/nested/two.jpg", "trip/one.jpg"]);
  });

  it("copies a folder in the background, and won't copy over one that exists", async () => {
    await expect(
      runOperation(driver, { op: "copy", items: [{ key: "trip/", kind: "folder" }], destination: "backup/" }),
    ).resolves.toMatchObject({ done: 1, failed: [] });
    expect((await readAll(driver, "backup/trip/nested/two.jpg")).toString()).toBe("22");
    await expect(
      runOperation(driver, { op: "copy", items: [{ key: "trip/", kind: "folder" }], destination: "backup/" }),
    ).rejects.toMatchObject({ status: 409 });
    // Past the app's own check, OneDrive reports the clash through the copy monitor.
    await expect(driver.copy("trip/one.jpg", "backup/trip/one.jpg")).rejects.toMatchObject({ status: 409 });
  });

  it("moves a file into another folder, creating it", async () => {
    await driver.rename!("trip/one.jpg", "sorted/2026/one.jpg");
    expect((await readAll(driver, "sorted/2026/one.jpg")).toString()).toBe("1");
    expect((await driver.listKeys("trip/one.jpg", 5)).keys).toEqual([]);
  });

  it("deletes a whole folder in one call", async () => {
    await expect(runOperation(driver, { op: "delete", items: [{ key: "backup/", kind: "folder" }] })).resolves.toMatchObject({
      done: 1,
      failed: [],
    });
    expect((await driver.list("")).folders.sort()).toEqual(["deep/", "sorted/", "trip/"]);
  });

  it("uploads in a session when the file spans several chunks", async () => {
    const bytes = new Uint8Array(23 * 1024 * 1024 + 5).map((_, i) => (i * 7) % 253);
    await driver.upload("big/video.mp4", streamOf(bytes, 1024 * 1024 + 3), bytes.length, "video/mp4");
    const { stream, size, contentType } = await driver.read("big/video.mp4");
    const back = Buffer.from(await new Response(stream).arrayBuffer());
    expect(size).toBe(bytes.length);
    expect(contentType).toBe("video/mp4");
    expect(back.equals(Buffer.from(bytes))).toBe(true);
  });

  it("cancels the session when an upload ends early", async () => {
    const bytes = new Uint8Array(12 * 1024 * 1024);
    const before = mock.stats.sessionsCancelled;
    await expect(driver.upload("big/short.bin", streamOf(bytes, 1024 * 1024), bytes.length + 1000)).rejects.toMatchObject({ status: 400 });
    expect(mock.stats.sessionsCancelled).toBe(before + 1);
    expect((await driver.listKeys("big/short.bin", 5)).keys).toEqual([]);
  });

  it("uploads an empty file", async () => {
    await driver.upload("big/empty.txt", streamOf(new Uint8Array(0)), 0);
    expect((await readAll(driver, "big/empty.txt")).length).toBe(0);
  });

  it("only follows page tokens back to Graph", async () => {
    await expect(driver.list("", "https://example.com/v1.0/me/drive/root/children")).rejects.toMatchObject({ status: 400 });
  });

  it("signs in with a device code, and a retry reuses the token", async () => {
    const signIn = await startOneDriveSignIn(APP);
    expect(signIn.userCode).toBe(MOCK_USER_CODE);
    expect(signIn.verificationUri).toMatch(/^https:\/\/microsoft\.com\//);
    const quick = { waitMs: 0, intervalMs: 1 };
    await expect(redeemOneDriveSignIn(APP, signIn.deviceCode, quick)).rejects.toThrow(/still waiting/);
    mock.answerDeviceCode("approve");
    const refreshToken = await redeemOneDriveSignIn(APP, signIn.deviceCode, quick);
    expect(refreshToken).toBe(MOCK_REFRESH_TOKEN);
    await expect(redeemOneDriveSignIn(APP, signIn.deviceCode, quick)).resolves.toBe(refreshToken);
    await expect(oneDriveAccount({ ...APP, refreshToken })).resolves.toBe("mock@example.com");
  });

  it("explains a declined sign-in, a used code and an unknown app", async () => {
    const quick = { waitMs: 0, intervalMs: 1 };
    const declined = await startOneDriveSignIn(APP);
    mock.answerDeviceCode("decline");
    await expect(redeemOneDriveSignIn(APP, declined.deviceCode, quick)).rejects.toThrow(/declined/);
    await expect(redeemOneDriveSignIn(APP, "device-never-issued", quick)).rejects.toThrow(/expired/);
    await expect(startOneDriveSignIn({ ...APP, clientId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/app registration/);
  });

  it("hands back the rotated refresh token so it can be saved", async () => {
    const saved: string[] = [];
    const rotating = oneDriveDriver({ root, ...APP, refreshToken: "mock-refresh-900", onRotate: (token) => void saved.push(token) });
    await rotating.verify();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^mock-refresh-\d+$/);
    // The saved token is what the connection holds next time: no second refresh needed.
    const before = mock.stats.refreshes;
    await oneDrive(root, saved[0]).verify();
    expect(mock.stats.refreshes).toBe(before);
  });

  it("explains a revoked refresh token", async () => {
    await expect(oneDrive(root, "revoked").verify()).rejects.toMatchObject({ status: 401 });
  });

  it("rides out throttling", async () => {
    const keys = Array.from({ length: 45 }, (_, i) => `busy/${String(i).padStart(2, "0")}.txt`);
    await Promise.all(keys.map((key) => driver.write(key, text(key))));
    expect(mock.stats.throttled).toBeGreaterThan(0);
    expect((await driver.listKeys("busy/", 100)).keys.sort()).toEqual(keys);
  });
});
