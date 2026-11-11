"""Q2: what logs cost on disk, and how well Sift's online miner groups them (Loghub-2.0).

For each of the 14 Loghub-2.0 systems, on the same raw file:
  - Sift: the store's bytes on disk (Parquet segments, rollups, template registry, manifest), with
    every line rebuilt and its SHA-256 stream compared with the input (engine/bench/storage.ts);
    the write-ahead log is reported separately, because Sift does not yet trim it after a commit
  - gzip level 6, zstd levels 3 and 19 (whole file, one stream)
  - ClickHouse (official build, MergeTree, one String column per line): default codec (LZ4) and ZSTD(3)
  - grouping accuracy (Loghub's definition) of Sift's online miner, on the benchmark's message
    contents and on the full lines Sift actually stores

Data: Loghub-2.0 (Jiang et al., ISSTA 2024), Zenodo record 8275861, CC-BY-4.0, files checked by MD5.
Run: uv run --project evals python -m sift_evals.run_q2
"""

from __future__ import annotations

import argparse
import gzip
import json
import platform
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

import duckdb
import numpy as np
import zstandard

from .data import RESULTS, ROOT, dump

LOGHUB = ROOT / "data" / "loghub2"
WORK = ROOT / ".sift" / "q2"
ENGINE = ROOT / "engine"
CLICKHOUSE = Path.home() / ".local" / "share" / "sift-tools" / "clickhouse-macos-aarch64"
SYSTEMS = [
    "Apache", "BGL", "HDFS", "HPC", "Hadoop", "HealthApp", "Linux",
    "Mac", "OpenSSH", "OpenStack", "Proxifier", "Spark", "Thunderbird", "Zookeeper",
]  # fmt: skip


class Counter:
    """A write-only sink that counts bytes."""

    def __init__(self) -> None:
        self.n = 0

    def write(self, b: bytes) -> int:
        self.n += len(b)
        return len(b)

    def flush(self) -> None:
        pass


def compressed_sizes(path: Path) -> dict[str, int]:
    out: dict[str, int] = {}
    sink = Counter()
    with open(path, "rb") as f, gzip.GzipFile(fileobj=sink, mode="wb", compresslevel=6, mtime=0) as g:
        shutil.copyfileobj(f, g, 1 << 22)
    out["gzip-6"] = sink.n
    for level in (3, 19):
        sink = Counter()
        cctx = zstandard.ZstdCompressor(level=level, threads=-1)
        with open(path, "rb") as f, cctx.stream_writer(sink, closefd=False) as w:
            shutil.copyfileobj(f, w, 1 << 22)
        out[f"zstd-{level}"] = sink.n
    return out


def clickhouse_sizes(path: Path, name: str) -> dict[str, int]:
    db = WORK / f"ch-{name}"
    shutil.rmtree(db, ignore_errors=True)
    out = {}
    for label, codec in (("clickhouse-lz4", ""), ("clickhouse-zstd3", " CODEC(ZSTD(3))")):
        sql = f"""
            CREATE TABLE t (line String{codec}) ENGINE = MergeTree ORDER BY tuple();
            INSERT INTO t SELECT line FROM file('{path}', 'LineAsString', 'line String');
            OPTIMIZE TABLE t FINAL;
            SELECT sum(bytes_on_disk) FROM system.parts WHERE table = 't' AND active;
            DROP TABLE t;
        """
        p = subprocess.run(
            [str(CLICKHOUSE), "local", "--path", str(db), "--multiquery", "--query", sql],
            capture_output=True, text=True, check=True,
        )  # fmt: skip
        out[label] = int(p.stdout.strip().splitlines()[-1])
    shutil.rmtree(db, ignore_errors=True)
    return out


def grouping_accuracy(pred: np.ndarray, truth: np.ndarray) -> float:
    """Loghub's GA: a line counts when its predicted group holds exactly the lines of one true group."""
    if len(pred) != len(truth):
        raise SystemExit(f"SIFT-E104 {len(pred)} predicted ids for {len(truth)} lines\nfix: rerun run_q2")
    _, t = np.unique(truth, return_inverse=True)
    true_size = np.bincount(t)
    order = np.argsort(pred, kind="stable")
    p_sorted, t_sorted = pred[order], t[order]
    bounds = np.flatnonzero(np.diff(p_sorted)) + 1
    correct = 0
    for grp in np.split(t_sorted, bounds):
        if (grp == grp[0]).all() and true_size[grp[0]] == len(grp):
            correct += len(grp)
    return correct / len(pred)


def node(*args: str) -> str:
    p = subprocess.run(["node", "--import", "tsx", *args], cwd=ENGINE, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"SIFT-E104 {' '.join(args[:1])} failed: {(p.stderr or p.stdout)[-400:]}")
    return p.stdout


def one(name: str) -> dict:
    raw = LOGHUB / "raw" / name
    if not raw.exists():
        with zipfile.ZipFile(LOGHUB / "zip" / f"{name}.zip") as z:
            z.extractall(LOGHUB / "raw")
    log = raw / f"{name}_full.log"
    structured = raw / f"{name}_full.log_structured.csv"
    row: dict = {"system": name}

    t0 = time.perf_counter()
    node("bench/storage.ts", "--log", str(log), "--name", name, "--work", str(WORK),
         "--out", str(WORK / f"{name}.json"), "--ids", str(WORK / f"{name}.full.ids"))  # fmt: skip
    row["sift"] = json.loads((WORK / f"{name}.json").read_text())
    row["compressed"] = compressed_sizes(log) | clickhouse_sizes(log, name)

    contents = WORK / f"{name}.contents.txt"
    # stream through DuckDB, never holding the text in Python: 16M-line systems must fit in 8 GB
    con = duckdb.connect(config={"memory_limit": "2GB", "threads": "2"})
    src = f"read_csv('{structured}', header=true, all_varchar=true, quote='\"', escape='\"')"
    con.execute(
        f"copy (select replace(coalesce(Content, ''), chr(10), ' ') from {src} order by LineId::bigint) "
        f"to '{contents}' (format csv, header false, quote '', escape '', delimiter '\\x01')"
    )
    node("bench/grouping.ts", "--contents", str(contents), "--ids", str(WORK / f"{name}.content.ids"))
    truth = con.sql(f"select hash(EventId) h from {src} order by LineId::bigint").fetchnumpy()["h"]
    pred_content = np.fromfile(WORK / f"{name}.content.ids", dtype=np.int32)
    pred_full = np.fromfile(WORK / f"{name}.full.ids", dtype=np.int32)
    row["grouping"] = {
        "lines": len(truth),
        "true_templates": int(len(np.unique(truth))),
        "ga_content": round(grouping_accuracy(pred_content, truth), 4),
        "templates_content": int(len(np.unique(pred_content))),
        "ga_full_line": round(grouping_accuracy(pred_full, truth), 4)
        if len(pred_full) == len(truth)
        else None,
        "templates_full_line": int(len(np.unique(pred_full))),
    }
    contents.unlink()
    row["seconds"] = round(time.perf_counter() - t0, 1)
    return row


def probe(name: str, n_lines: int) -> dict:
    """Ingest speed of Sift's store on the first n lines only: for systems too slow to run in full."""
    log = LOGHUB / "raw" / name / f"{name}_full.log"
    part = WORK / f"probe-{name}.log"
    with open(log, "rb") as src, open(part, "wb") as dst:
        for i, line in enumerate(src):
            if i == n_lines:
                break
            dst.write(line)
    node("bench/storage.ts", "--log", str(part), "--name", f"probe-{name}", "--work", str(WORK),
         "--out", str(WORK / f"probe-{name}.json"), "--ids", str(WORK / f"probe-{name}.ids"))  # fmt: skip
    s = json.loads((WORK / f"probe-{name}.json").read_text())
    part.unlink()
    return {
        "system": name,
        "probe_lines": s["lines"],
        "ingest_seconds": s["ingestSeconds"],
        "lines_per_second": round(s["lines"] / s["ingestSeconds"]),
        "templates": s["templates"],
        "lossless": s["lossless"],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--systems", nargs="*", default=SYSTEMS)
    ap.add_argument("--probe-lines", type=int, help="only time ingest on the first N lines of each system")
    args = ap.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    out_dir = RESULTS / "q2"
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.probe_lines:
        for name in args.systems:
            r = probe(name, args.probe_lines)
            dump(out_dir / "probes" / f"{name}.json", r)
            print(json.dumps(r), flush=True)
        return
    for name in args.systems:
        row = one(name)
        dump(out_dir / f"{name}.json", row)
        print(
            name,
            json.dumps(
                {k: row[k] for k in ("compressed", "grouping")} | {"store": row["sift"]["storeBytes"]}
            ),
            flush=True,
        )
    dump(
        out_dir / "environment.json",
        {
            "machine": f"{platform.machine()} {platform.platform()}",
            "clickhouse": subprocess.run(
                [str(CLICKHOUSE), "local", "--version"], capture_output=True, text=True
            ).stdout.strip(),
            "zstandard": zstandard.__version__,
            "zstd_library": zstandard.ZSTD_VERSION,
            "data": "Loghub-2.0, Zenodo record 8275861, CC-BY-4.0",
        },
    )


if __name__ == "__main__":
    main()
