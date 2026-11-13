# SQL on files

Press **SQL** in any folder to query files in that bucket with [DuckDB](https://duckdb.org)'s
SQL — on any provider jvinu connects to, encrypted connections included.

```sql
SELECT country, count(*) AS orders, sum(revenue_eur) AS revenue
FROM 'sales/2025-*.csv'
GROUP BY 1
ORDER BY revenue DESC
```

- **Name files in quotes**, with paths from the top of the bucket. Globs work: `*` within a
  folder, `**` across folders, `{a,b}`, `[0-9]`. `s3://<this-bucket>/…` works too.
- **Formats:** Parquet, CSV, TSV and JSON / JSON Lines, gzipped or not. All of DuckDB's
  options apply: `read_csv('x/*.csv', delim = ';')`, `read_parquet('t/**/*.parquet',
  hive_partitioning = true)`, `filename = true`…
- **Results:** the first 1,000 rows on screen. **Save** writes the whole result as Parquet,
  CSV or JSON Lines to any connection that takes writes — never over an existing file.
- **Delta and Iceberg:** a table's folder also holds files from older versions, so totals over
  its raw files may not match what Spark or Databricks report.

## How it runs

jvinu lists the objects each quoted path matches, copies them into a private scratch folder,
rewrites the paths, and runs the query in a fresh DuckDB that can see only that folder. See
[SECURITY.md](../SECURITY.md#sql-on-files) for the sandbox.

| Variable | Default | |
| --- | --- | --- |
| `JVINU_SQL_MAX_MB` | 1024 | Most a query may fetch, in MB. |
| `JVINU_SQL_MEMORY` | 1GB | DuckDB's memory cap per query; it spills to disk past it. |
| `JVINU_SQL_TIMEOUT_S` | 60 | Longest a query may run. |
| `JVINU_SQL_THREADS` | 2 | Threads per query. At most two queries run at once. |
| `JVINU_SCRATCH_DIR` | system temp | Where fetched files and spill live while a query runs. |
