#!/usr/bin/env node
/**
 * Fills a bucket with the public demo's sample data: a README, a Delta table, an Iceberg
 * table, Parquet, CSV, JSON Lines and Avro files, and a small static site — so every
 * feature has something to show. Safe to run again: it overwrites only its own keys.
 *
 *   DEMO_S3_ENDPOINT=http://localhost:3900 DEMO_S3_BUCKET=my-files \
 *   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=garage node scripts/seed-demo.mjs
 *
 * Without DEMO_S3_ENDPOINT it talks to Amazon S3 itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bucket = process.env.DEMO_S3_BUCKET;
if (!bucket) {
  console.error("Set DEMO_S3_BUCKET (and DEMO_S3_ENDPOINT for anything but Amazon S3).");
  process.exit(1);
}
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.DEMO_S3_ENDPOINT || undefined,
  forcePathStyle: Boolean(process.env.DEMO_S3_ENDPOINT),
});

const TYPES = {
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".parquet": "application/vnd.apache.parquet",
  ".avro": "application/avro",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function put(key, body) {
  const type = TYPES[path.extname(key)] ?? "application/octet-stream";
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: type }));
  console.log("  ", key);
}

async function folder(dir, prefix) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "__pycache__") continue;
    if (statSync(full).isDirectory()) await folder(full, `${prefix}${name}/`);
    else await put(prefix + name, readFileSync(full));
  }
}

// A year of daily sales, by country, as CSV per month: something worth a GROUP BY.
function salesCsv(month) {
  const countries = ["RO", "DE", "FR", "NL", "PL", "IT"];
  const lines = ["date,country,orders,revenue_eur"];
  let seed = month * 7919;
  const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let day = 1; day <= 28; day++) {
    for (const country of countries) {
      const orders = Math.round(20 + random() * 80);
      lines.push(`2025-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")},${country},${orders},${(orders * (18 + random() * 30)).toFixed(2)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const README = `# Welcome to the jvinu demo

This bucket is **read-only**: look around, nothing here can be changed.

| Folder | What to try |
| --- | --- |
| [lake/sales/](lake/sales/) | A **Delta table** — open it for the banner and *Table details* |
| [lake/orders/](lake/orders/) | An **Iceberg table**, with snapshots and schema |
| [sales/](sales/) | CSV by month — press **SQL** and run a \`GROUP BY\` over all of them |
| [data/](data/) | Parquet, Avro and JSON Lines — select one, then **Preview data** |
| [site/](site/) | A small website — select files and try **Metadata…** (on your own install) |

Tips: press **space** on any file for Quick Look, **⌘K** to search the whole bucket,
and **Compare** to diff two folders.
`;

console.log(`Seeding s3://${bucket}`);
await put("README.md", README);
await folder(path.join(root, "tests/fixtures/lake/delta-sales"), "lake/sales/");
await folder(path.join(root, "tests/fixtures/lake/iceberg-orders"), "lake/orders/");
for (const name of ["pages-v2.parquet", "long-values.parquet", "events-snappy.avro"]) {
  await put(`data/${name}`, readFileSync(path.join(root, "tests/fixtures/data", name)));
}
await put(
  "data/app-logs.jsonl",
  Array.from({ length: 500 }, (_, i) => JSON.stringify({ at: new Date(Date.UTC(2025, 5, 1, 0, i)).toISOString(), level: i % 17 ? "info" : "error", route: ["/", "/api/orders", "/login"][i % 3], ms: 5 + ((i * 37) % 400) })).join("\n") + "\n",
);
for (let month = 1; month <= 12; month++) await put(`sales/2025-${String(month).padStart(2, "0")}.csv`, salesCsv(month));
await put("sales/README.md", "# Sales\n\nOne CSV per month. Try:\n\n```sql\nSELECT country, sum(revenue_eur) AS revenue\nFROM 'sales/*.csv'\nGROUP BY 1 ORDER BY 2 DESC\n```\n");
await put("site/index.html", "<!doctype html><title>Demo site</title><link rel=stylesheet href=app.css><h1>Hello from a bucket</h1><script src=app.js></script>\n");
await put("site/app.css", "body { font-family: system-ui; margin: 4rem; }\n");
await put("site/app.js", "console.log('served from object storage');\n");
console.log("Done.");
