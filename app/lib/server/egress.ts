import "server-only";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { BlockList, isIP } from "node:net";
import { promisify } from "node:util";

/**
 * Where this server never connects. A custom endpoint may name any host (an emulator on
 * localhost, a NAS on the LAN), but not a link-local address: that's where cloud metadata
 * services hand out the machine's own credentials (169.254.169.254 on AWS, Azure, Google
 * Cloud and Oracle). Checked twice: when an endpoint is saved, and for every address a
 * hostname resolves to when a connection is made, so DNS can't point a harmless-looking
 * name there.
 */
const BLOCKED = new BlockList();
BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local: AWS/Azure/GCP/OCI metadata, ECS task credentials
BLOCKED.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud metadata
BLOCKED.addSubnet("fe80::", 10, "ipv6"); // link-local
BLOCKED.addAddress("fd00:ec2::254", "ipv6"); // AWS metadata over IPv6

/** Names that only ever mean a metadata service. */
const BLOCKED_NAMES = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal"]);

/** The IPv4 address a NAT64 one carries ("64:ff9b::a9fe:a9fe" → "169.254.169.254"); IPv4-mapped ones BlockList handles itself. */
function nat64(address: string): string | null {
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const match = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!match) return null;
  const value = parseInt(match[1], 16) * 65536 + parseInt(match[2], 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function forbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family !== 6) return false;
  const embedded = nat64(address);
  return embedded ? BLOCKED.check(embedded, "ipv4") : BLOCKED.check(address, "ipv6");
}

/** A hostname (from a URL) that no endpoint may use. */
export function forbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  return BLOCKED_NAMES.has(host) || forbiddenAddress(host);
}

type Address = string | dns.LookupAddress[];
type Callback = (error: NodeJS.ErrnoException | null, address?: Address, family?: number) => void;

const GUARDED = Symbol.for("jvinu.egress.guarded");

function refusal(hostname: string, address: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Not connecting to ${hostname}: it resolves to ${address}, a link-local address where cloud metadata services live.`), {
    code: "EJVINUBLOCKED",
  });
}

/**
 * Checks every address a hostname resolves to before anything connects to it. Installed
 * once at startup, process-wide: every SDK's sockets look hosts up through dns.lookup.
 */
export function guardLookups(): void {
  const original = dns.lookup as unknown as ((hostname: string, options: unknown, callback: Callback) => void) & { [GUARDED]?: true };
  if (original[GUARDED]) return;

  const lookup = (hostname: string, options: unknown, callback?: Callback) => {
    const done = (typeof options === "function" ? options : callback) as Callback;
    original.call(dns, hostname, typeof options === "function" ? {} : options, (error, address, family) => {
      if (error) return done(error);
      const all = Array.isArray(address) ? address.map((entry) => entry.address) : [address ?? ""];
      const blocked = all.find(forbiddenAddress);
      if (blocked) return done(refusal(hostname, blocked));
      done(null, address, family);
    });
  };
  Object.assign(lookup, {
    [GUARDED]: true,
    [promisify.custom]: (hostname: string, options?: unknown) =>
      new Promise((resolve, reject) =>
        lookup(hostname, options ?? {}, (error, address, family) =>
          error ? reject(error) : resolve(Array.isArray(address) ? address : { address, family }),
        ),
      ),
  });
  dns.lookup = lookup as unknown as typeof dns.lookup;

  const promised = dns.promises.lookup.bind(dns.promises);
  dns.promises.lookup = (async (hostname: string, options?: dns.LookupOptions) => {
    const result = await promised(hostname, options ?? {});
    const all = Array.isArray(result) ? result.map((entry) => entry.address) : [result.address];
    const blocked = all.find(forbiddenAddress);
    if (blocked) throw refusal(hostname, blocked);
    return result;
  }) as typeof dns.promises.lookup;

  // `import { lookup } from "node:dns"` sees the guarded one too.
  syncBuiltinESMExports();
}
