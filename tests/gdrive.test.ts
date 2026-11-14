import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  driveAccessOf,
  driveFolder,
  driveListedName,
  driveQuote,
  exchangeDriveCode,
  GDRIVE_READONLY_SCOPE,
  GDRIVE_SCOPE,
  googleDriveDriver,
} from "@/app/lib/server/drivers/gdrive";
import { createGoogleDriveMock, DOC, FOLDER, MOCK_DRIVE } from "./gdrive-mock";

/**
 * The Google Drive driver against the in-memory stand-in for Google's APIs (tests/gdrive-mock.ts),
 * paging two items at a time so same-named items land on different pages. The shared contract
 * runs over it too, in tests/drivers.contract.test.ts.
 */
const google = createGoogleDriveMock({ pageSize: 2 });
const add = google.add;

const driver = (root = "/") => googleDriveDriver({ root, ...MOCK_DRIVE });
const text = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer()).toString();

beforeAll(() => google.install());
afterAll(() => google.uninstall());

function reset() {
  google.clear();
  const work = add("Work", "root", FOLDER);
  add("notes.txt", work.id, "text/plain", "hello drive");
  add("Plan", work.id, DOC);
  add("a/b.txt", work.id, "text/plain", "slash in a name"); // a path can't name this
  add("dup.txt", work.id, "text/plain", "first");
  add("dup.txt", work.id, "text/plain", "second");
  add("it's.txt", work.id, "text/plain", "quoted");
  const sub = add("Sub", work.id, FOLDER);
  add("deep.csv", sub.id, "text/csv", "a,b\n1,2\n");
}
afterEach(reset);

describe("Google Drive paths", () => {
  it("normalises folder roots and refuses dot segments", () => {
    expect(driveFolder("/")).toBe("/");
    expect(driveFolder("Work/Sub/")).toBe("/Work/Sub");
    expect(driveFolder("/Work/../Private")).toBeNull();
  });

  it("escapes names inside a Drive query", () => {
    expect(driveQuote(`it's`)).toBe(`'it\\'s'`);
    expect(driveQuote(`a\\b`)).toBe(`'a\\\\b'`);
  });

  it("lists Google documents as PDFs and leaves out what a path can't name", () => {
    expect(driveListedName({ name: "Plan", mimeType: DOC })).toBe("Plan.pdf");
    expect(driveListedName({ name: "Form", mimeType: "application/vnd.google-apps.form" })).toBeNull();
    expect(driveListedName({ name: "a/b", mimeType: "text/plain" })).toBeNull();
    expect(driveListedName({ name: "..", mimeType: FOLDER })).toBeNull();
  });
});

describe("Google Drive driver", () => {
  reset();

  it("verifies a folder root and lists it like a bucket", async () => {
    const work = driver("/Work");
    await expect(work.verify()).resolves.toEqual({});
    const listing = await work.list("");
    expect(listing.folders).toEqual(["Sub/"]);
    expect(listing.files.map((file) => file.key).sort()).toEqual(["Plan.pdf", "dup.txt", "it's.txt", "notes.txt"]);
    await expect(driver("/Missing").verify()).rejects.toMatchObject({ status: 404 });
  });

  it("reads files, byte ranges and Google documents", async () => {
    const work = driver("/Work");
    expect(await text((await work.read("notes.txt")).stream)).toBe("hello drive");
    const part = await work.read("notes.txt", { start: 6, end: 10 });
    expect(await text(part.stream)).toBe("drive");
    expect(part.range).toEqual({ start: 6, end: 10 });
    const doc = await work.read("Plan.pdf");
    expect(doc.contentType).toBe("application/pdf");
    expect(await text(doc.stream)).toBe("%PDF export of Plan");
    expect(await text((await work.read("dup.txt")).stream)).toBe("first");
    expect(await text((await work.read("it's.txt")).stream)).toBe("quoted");
    expect(await text((await driver("/").read("Work/Sub/deep.csv")).stream)).toBe("a,b\n1,2\n");
    await expect(work.read("nothing.txt")).rejects.toMatchObject({ status: 404 });
  });

  it("lists each path once, as it opens, even when duplicates fall on different pages", async () => {
    // Created in this order, two to a page: every duplicate pair straddles a page boundary.
    const shelf = add("Shelf", "root", FOLDER);
    add("filler-1.txt", shelf.id, "text/plain", "1");
    const olderTwin = add("Twin", shelf.id, FOLDER);
    const newerTwin = add("Twin", shelf.id, FOLDER);
    add("inside-older.txt", olderTwin.id, "text/plain", "reachable");
    add("inside-newer.txt", newerTwin.id, "text/plain", "hidden behind the older folder");
    add("Report", shelf.id, DOC); // listed as Report.pdf, unless a stored Report.pdf exists
    add("filler-2.txt", shelf.id, "text/plain", "2");
    add("Report.pdf", shelf.id, "application/pdf", "stored pdf");
    add("same.txt", shelf.id, "text/plain", "older");
    add("filler-3.txt", shelf.id, "text/plain", "3");
    add("same.txt", shelf.id, "text/plain", "newer");

    const d = driver("/Shelf");
    const listing = await d.list("");
    const keys = [...listing.folders, ...listing.files.map((file) => file.key)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(listing.folders).toEqual(["Twin/"]);
    expect(listing.files.map((file) => file.key).sort()).toEqual(["Report.pdf", "filler-1.txt", "filler-2.txt", "filler-3.txt", "same.txt"]);
    // The stored PDF wins over the Google document, and is a real file with a known size.
    const report = listing.files.find((file) => file.key === "Report.pdf")!;
    expect(report.sizeUnknown).toBeUndefined();
    expect(report.size).toBe("stored pdf".length);
    expect(await text((await d.read("Report.pdf")).stream)).toBe("stored pdf");
    expect(await text((await d.read("same.txt")).stream)).toBe("older");

    // Walking the tree sees only what paths reach: the older Twin's contents, once each.
    const { files } = await d.inventory("");
    expect(files.map((file) => file.key).sort()).toEqual([
      "Report.pdf",
      "Twin/inside-older.txt",
      "filler-1.txt",
      "filler-2.txt",
      "filler-3.txt",
      "same.txt",
    ]);
    for (const file of files) await expect(d.read(file.key)).resolves.toBeDefined();
    expect((await d.stats("")).objects).toBe(6);
    expect((await d.listKeys("", 100)).keys).not.toContain("Twin/inside-newer.txt");
  });

  it("refuses a page token it didn't hand out", async () => {
    await expect(driver("/Work").list("", "https://graph.example/elsewhere")).rejects.toMatchObject({ status: 400 });
  });

  it("finds an exact file for SQL, and says when a size isn't known", async () => {
    const work = driver("/Work");
    expect(await work.findFile("notes.txt")).toMatchObject({ key: "notes.txt", size: "hello drive".length });
    expect(await driver("/").findFile("Work/Sub/deep.csv")).toMatchObject({ key: "Work/Sub/deep.csv" });
    // A Google document has no size until it's exported: flagged, not passed off as empty.
    expect(await work.findFile("Plan.pdf")).toMatchObject({ key: "Plan.pdf", size: 0, sizeUnknown: true });
    expect(await work.findFile("Sub")).toBeNull();
    expect(await work.findFile("missing.csv")).toBeNull();
  });

  it("keeps '.pdf' on a renamed or copied Google document, so its new key still opens", async () => {
    const work = driver("/Work");
    await expect(work.rename!("Plan.pdf", "Notes")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Notes\.pdf/) });
    await expect(work.copy("Plan.pdf", "Sub/Notes")).rejects.toMatchObject({ status: 400 });
    await work.rename!("Plan.pdf", "Notes.pdf");
    expect(await work.findFile("Notes.pdf")).toMatchObject({ key: "Notes.pdf", sizeUnknown: true });
    expect((await work.list("")).files.map((file) => file.key)).toContain("Notes.pdf");
  });

  it("finds the wanted item among same-named ones on later pages", async () => {
    // Two pages of two: what a path opens comes after items of other types with its name.
    const mix = add("Mix", "root", FOLDER);
    add("Twin", mix.id, FOLDER);
    add("Twin", mix.id, DOC);
    add("Twin", mix.id, "text/plain", "the stored file");
    add("Box", mix.id, "text/plain", "a file named Box");
    add("Box", mix.id, "text/plain", "another");
    const box = add("Box", mix.id, FOLDER);
    add("inside.txt", box.id, "text/plain", "in the folder");
    const d = driver("/Mix");
    expect(await text((await d.read("Twin")).stream)).toBe("the stored file");
    expect(await text((await d.read("Box/inside.txt")).stream)).toBe("in the folder");
    expect((await d.list("Box/")).files.map((file) => file.key)).toEqual(["Box/inside.txt"]);
  });

  it("says a folder is too big to list rather than showing part of it as the whole", async () => {
    google.setPageSize(1);
    try {
      const huge = add("Huge", "root", FOLDER);
      for (let i = 0; i < 101; i++) add(`f${i}.txt`, huge.id, "text/plain", "x");
      // 100 Drive pages is the cap; at one item a page, 101 items go past it.
      await expect(driver("/Huge").list("")).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/more than/) });
    } finally {
      google.setPageSize(2);
    }
  });

  it("walks folders for listKeys and stats", async () => {
    const work = driver("/Work");
    const { keys } = await work.listKeys("", 100);
    expect(keys).toContain("Sub/deep.csv");
    const stats = await work.stats("");
    // notes, Plan.pdf, dup (once), it's, Sub/deep.csv: "a/b.txt" has no path, so it isn't counted.
    expect(stats.objects).toBe(5);
  });

  it("uploads into new folders, copies, renames and deletes to the bin", async () => {
    const work = driver("/Work");
    await work.upload("New/inner/upload.txt", new Response("uploaded bytes").body!, undefined, "text/plain");
    expect(await text((await work.read("New/inner/upload.txt")).stream)).toBe("uploaded bytes");
    await work.copy("notes.txt", "Sub/notes-copy.txt");
    expect(await text((await work.read("Sub/notes-copy.txt")).stream)).toBe("hello drive");
    await expect(work.copy("notes.txt", "Sub/notes-copy.txt")).rejects.toMatchObject({ status: 409 });
    await work.rename!("Sub/notes-copy.txt", "moved.txt");
    expect(await text((await work.read("moved.txt")).stream)).toBe("hello drive");
    const { failed } = await work.remove(["moved.txt", "already-gone.txt"]);
    expect(failed).toEqual([]);
    await expect(work.read("moved.txt")).rejects.toMatchObject({ status: 404 });
  });

  it("reads the access Google granted, not the access that was asked for", () => {
    expect(driveAccessOf(`openid ${GDRIVE_SCOPE}`)).toBe("full");
    expect(driveAccessOf(GDRIVE_READONLY_SCOPE)).toBe("read");
    expect(driveAccessOf(`${GDRIVE_READONLY_SCOPE} ${GDRIVE_SCOPE}`)).toBe("full");
    expect(driveAccessOf("https://www.googleapis.com/auth/drive.file")).toBeNull();
    expect(driveAccessOf("")).toBeNull();
  });

  it("trades a sign-in code for a refresh token and says when access is read-only", async () => {
    const sign = { clientId: "3-abc.apps.googleusercontent.com", clientSecret: "secret-3", verifier: "v".repeat(43), redirectUri: "http://localhost:3000/connect/google-drive" };
    await expect(exchangeDriveCode({ ...sign, code: "code-full" })).resolves.toEqual({ refreshToken: "refresh-1", readOnlyAccess: false });
    await expect(exchangeDriveCode({ ...sign, code: "code-read" })).resolves.toEqual({ refreshToken: "refresh-read", readOnlyAccess: true });
    await expect(exchangeDriveCode({ ...sign, code: "code-unknown" })).rejects.toMatchObject({ status: 400 });
  });

  it("says why a write fails on a Drive connected with read-only access", async () => {
    const reader = googleDriveDriver({
      root: "/Work",
      clientId: "1-abc.apps.googleusercontent.com",
      clientSecret: "secret-1",
      refreshToken: "refresh-read",
      readOnlyAccess: true,
    });
    expect(await text((await reader.read("notes.txt")).stream)).toBe("hello drive");
    await expect(reader.copy("notes.txt", "copy.txt")).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/read-only access/) });
  });

  it("asks for a reconnect when the refresh token stops working", async () => {
    const broken = googleDriveDriver({ root: "/", clientId: "2-x.apps.googleusercontent.com", clientSecret: "s", refreshToken: "revoked" });
    await expect(broken.list("")).rejects.toMatchObject({ status: 401 });
  });
});
