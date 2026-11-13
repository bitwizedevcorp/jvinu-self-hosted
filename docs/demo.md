# Running a public demo

`JVINU_DEMO=1` turns an instance into a showcase anyone can open without an account:

- the sign-in page offers **Explore the demo**, which signs in a shared "Demo visitor";
- every connection behaves as read-only, and changes — connecting, notes, team pins, share
  links, tokens — are refused; browsing, previews, Quick Look, search, SQL, compare and zip
  downloads all work.

Keep `JVINU_ADMIN_PASSWORD` set too: it's how you sign in to add the demo's connections.

## Set it up

1. Start jvinu with its bundled storage: `docker compose --profile storage up -d`.
2. Fill the bucket with the sample data — a README, a Delta table, an Iceberg table, Parquet,
   Avro, JSON Lines and a year of CSV:

   ```bash
   DEMO_S3_ENDPOINT=http://localhost:3900 DEMO_S3_BUCKET=my-files \
   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=garage \
   node scripts/seed-demo.mjs
   ```

   (Garage's keys are in the `garage-secrets` volume, or make a key with `garage key create`.)
3. Restart with `JVINU_DEMO=1` and put it behind HTTPS with `JVINU_TRUST_PROXY=1`.

Link to it from the website (the separate jvinu-site project) by building that with
`NEXT_PUBLIC_DEMO_URL` set to the demo's `/login`.
