"""
Regenerates the binary test fixtures in tests/fixtures/ — not needed to run the tests.

    python -m venv .venv && .venv/bin/pip install pyarrow deltalake "pyiceberg[sql-sqlite,pyarrow]" fastavro cramjam backports.zstd
    .venv/bin/python tests/fixtures/generate.py

Parquet files come from pyarrow (the writer behind pandas and most Python tools), tables
from delta-rs and PyIceberg, so the readers are tested against real writers, not hand-made
bytes. The files are kept small; what matters is their layout: several pages per column
chunk, v2 pages, long values, many row groups.
"""
import datetime, glob, json, os, random, shutil, sys, tempfile
import pyarrow as pa
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
LAKE = os.path.join(HERE, "lake")
random.seed(7)


def table(n, long_strings=False):
    base = datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc)
    return pa.table({
        "id": pa.array(range(n), pa.int64()),
        "name": pa.array([f"name-{i}-" + ("x" * 1000 if long_strings else "y" * (i % 30)) for i in range(n)]),
        "ts": pa.array([base + datetime.timedelta(seconds=i * 37) for i in range(n)], pa.timestamp("us", tz="UTC")),
        "tags": pa.array([[f"t{j}" for j in range(i % 4)] if i % 7 else None for i in range(n)], pa.list_(pa.string())),
        "attrs": pa.array([{"a": i % 1000, "b": None if i % 3 == 0 else f"b{i % 17}"} for i in range(n)],
                          pa.struct([("a", pa.int32()), ("b", pa.string())])),
        "city": pa.array([random.choice(["Cluj", "Timișoara", "București", "Iași"]) for _ in range(n)]),
    })


def parquet():
    os.makedirs(DATA, exist_ok=True)
    t = table(6000)
    # Many small pages per column chunk, data page v1, snappy.
    pq.write_table(t, f"{DATA}/pages-v1.parquet", row_group_size=6000, data_page_size=2048, compression="snappy")
    # Data page v2 (which counts rows itself), zstd.
    pq.write_table(t, f"{DATA}/pages-v2.parquet", row_group_size=6000, data_page_size=2048, compression="zstd",
                   data_page_version="2.0")
    # Pages holding far fewer rows than DuckDB decodes at once.
    pq.write_table(table(5000, long_strings=True), f"{DATA}/long-values.parquet", row_group_size=5000,
                   data_page_size=64 * 1024, compression="snappy")
    # Row groups smaller than a preview: it takes several.
    pq.write_table(t.slice(0, 500), f"{DATA}/tiny-groups.parquet", row_group_size=30, compression="snappy")


def delta():
    from deltalake import DeltaTable, write_deltalake
    root = tempfile.mkdtemp()

    def batch(start, n):
        return pa.table({
            "id": pa.array(range(start, start + n), pa.int64()),
            "country": pa.array(["RO" if i % 2 else "DE" for i in range(n)]),
            "amount": pa.array([float(i) for i in range(n)]),
        })

    path = f"{root}/sales"
    write_deltalake(path, batch(0, 1000), partition_by=["country"], name="sales", description="Daily sales")
    for k in range(1, 12):
        write_deltalake(path, batch(k * 1000, 500), mode="append", partition_by=["country"])
    DeltaTable(path).create_checkpoint()  # at version 11
    DeltaTable(path).delete("id < 100")  # 12
    write_deltalake(path, batch(100_000, 300), mode="append", partition_by=["country"])  # 13
    DeltaTable(path).optimize.compact()  # 14
    out = f"{LAKE}/delta-sales"
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(f"{path}/_delta_log", f"{out}/_delta_log")
    # One data file, so the table folder looks like one; the log is what's read.
    first = sorted(glob.glob(f"{path}/country=RO/*.parquet"))[0]
    os.makedirs(f"{out}/country=RO", exist_ok=True)
    shutil.copy(first, f"{out}/country=RO/{os.path.basename(first)}")
    shutil.rmtree(root)


def iceberg():
    from pyiceberg.catalog.sql import SqlCatalog
    root = tempfile.mkdtemp()
    catalog = SqlCatalog("local", uri=f"sqlite:///{root}/catalog.db", warehouse=f"file://{root}/wh")
    catalog.create_namespace("shop")
    t = table(1, False).select(["id", "name", "ts"])
    orders = catalog.create_table("shop.orders", schema=t.schema)
    orders.append(table(2000).select(["id", "name", "ts"]))
    orders.append(pa.table({"id": pa.array(range(2000, 2500), pa.int64()), "name": pa.array(["n"] * 500),
                            "ts": pa.array([datetime.datetime(2024, 2, 1, tzinfo=datetime.timezone.utc)] * 500,
                                           pa.timestamp("us", tz="UTC"))}))
    orders.delete("id < 10")
    out = f"{LAKE}/iceberg-orders"
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(f"{root}/wh/shop/orders/metadata", f"{out}/metadata")
    # Paths inside the JSON point at the temporary folder: make them look like a real bucket.
    for name in glob.glob(f"{out}/metadata/*.metadata.json"):
        with open(name) as f:
            text = f.read().replace(f"file://{root}/wh", "s3://lake")
        with open(name, "w") as f:
            f.write(text)
    shutil.rmtree(root)


def avro():
    import decimal
    import fastavro
    schema = fastavro.parse_schema({
        "type": "record", "name": "Event", "namespace": "com.example",
        "fields": [
            {"name": "id", "type": "long"},
            {"name": "user", "type": ["null", "string"]},
            {"name": "at", "type": {"type": "long", "logicalType": "timestamp-millis"}},
            {"name": "day", "type": {"type": "int", "logicalType": "date"}},
            {"name": "price", "type": {"type": "bytes", "logicalType": "decimal", "precision": 10, "scale": 2}},
            {"name": "tags", "type": {"type": "array", "items": "string"}},
            {"name": "attrs", "type": {"type": "map", "values": "long"}},
            {"name": "kind", "type": {"type": "enum", "name": "Kind", "symbols": ["A", "B"]}},
            {"name": "big", "type": "long"},
        ]})
    base = datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc)
    records = [{"id": i, "user": None if i % 4 == 0 else f"u{i}", "at": base + datetime.timedelta(seconds=i),
                "day": datetime.date(2024, 1, 1) + datetime.timedelta(days=i % 30), "price": decimal.Decimal(i - 500) / 100,
                "tags": [f"t{i % 3}"], "attrs": {"k": i}, "kind": "A" if i % 2 else "B",
                "big": 1_700_000_000_000_000_000 + i} for i in range(1000)]
    for codec in ["null", "deflate", "snappy", "zstandard"]:
        with open(f"{DATA}/events-{codec}.avro", "wb") as f:
            fastavro.writer(f, schema, records, codec=codec, sync_interval=8000)


if __name__ == "__main__":
    parquet()
    avro()
    delta()
    iceberg()
    for path in sorted(glob.glob(f"{HERE}/**/*", recursive=True)):
        if os.path.isfile(path) and not path.endswith(".py"):
            print(os.path.relpath(path, HERE), os.path.getsize(path))
