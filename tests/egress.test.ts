/**
 * Endpoints may point anywhere a person can reach — localhost emulators, a NAS on the LAN —
 * but never at a cloud metadata service, however the address is written or resolved.
 */
import dns from "node:dns";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { forbiddenAddress, forbiddenHost, guardLookups } from "../app/lib/server/egress";
import { cleanEndpoint } from "../app/lib/server/http";

describe("egress", () => {
  it("knows metadata addresses in every form", () => {
    for (const address of ["169.254.169.254", "169.254.170.2", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "fe80::1", "fd00:ec2::254", "100.100.100.200"]) {
      expect(forbiddenAddress(address), address).toBe(true);
    }
    for (const address of ["127.0.0.1", "::1", "10.0.0.5", "172.17.0.2", "192.168.1.10", "8.8.8.8", "2606:4700::1111", "not an address"]) {
      expect(forbiddenAddress(address), address).toBe(false);
    }
  });

  it("refuses metadata names and addresses as endpoints, and keeps everything else", () => {
    for (const host of ["metadata.google.internal", "METADATA.google.internal.", "metadata", "[::ffff:a9fe:a9fe]", "169.254.169.254"]) {
      expect(forbiddenHost(host), host).toBe(true);
    }
    for (const host of ["localhost", "floci", "host.docker.internal", "minio.lan", "s3.eu-west-1.amazonaws.com"]) {
      expect(forbiddenHost(host), host).toBe(false);
    }
    // The URL parser turns decimal, hex and octal spellings into the dotted address first.
    for (const endpoint of ["http://169.254.169.254", "http://2852039166/", "http://0xa9fea9fe", "http://0251.0376.0251.0376", "http://[::ffff:169.254.169.254]:4566", "http://metadata.google.internal"]) {
      expect(cleanEndpoint(endpoint), endpoint).toBeNull();
    }
    expect(cleanEndpoint("http://localhost:4566")).toBe("http://localhost:4566");
    expect(cleanEndpoint("http://minio:9000/")).toBe("http://minio:9000");
  });

  it("refuses names that resolve to a metadata address, as connections are made", async () => {
    guardLookups();
    guardLookups(); // once is enough; a second call changes nothing
    // An IP literal resolves to itself, offline: the same path a rebinding name would take.
    await expect(promisify(dns.lookup)("169.254.169.254")).rejects.toMatchObject({ code: "EJVINUBLOCKED" });
    await expect(dns.promises.lookup("169.254.169.254")).rejects.toMatchObject({ code: "EJVINUBLOCKED" });
    await expect(dns.promises.lookup("169.254.169.254", { all: true })).rejects.toMatchObject({ code: "EJVINUBLOCKED" });
    const blocked = await new Promise<NodeJS.ErrnoException | null>((resolve) => dns.lookup("169.254.169.254", { all: true }, (error) => resolve(error)));
    expect(blocked?.code).toBe("EJVINUBLOCKED");
    await expect(promisify(dns.lookup)("127.0.0.1")).resolves.toMatchObject({ address: "127.0.0.1" });
    await expect(dns.promises.lookup("localhost")).resolves.toBeTruthy();
  });
});
