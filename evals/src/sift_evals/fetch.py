"""Download the RCAEval case index and one split's cases from Hugging Face, and pin them by hash.

The first fetch writes manifests/rcaeval-<split>.json (committed) (SHA-256 of every file); later fetches
verify against it and stop on any mismatch.

Run: uv run --project evals python -m sift_evals.fetch --split dev
"""

from __future__ import annotations

import argparse
import hashlib
import json

from huggingface_hub import hf_hub_download, snapshot_download

from .data import CASES_DIR, HF_REPO, RCAEVAL, ROOT, SPLITS


def sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, choices=list(SPLITS))
    args = ap.parse_args()
    RCAEVAL.mkdir(parents=True, exist_ok=True)
    hf_hub_download(HF_REPO, "cases.parquet", repo_type="dataset", local_dir=RCAEVAL)
    prefixes = [ds.lower().replace("-", "") for ds in SPLITS[args.split]]  # RE2-OB -> re2ob
    snapshot_download(
        HF_REPO,
        repo_type="dataset",
        local_dir=CASES_DIR,
        allow_patterns=[f"{p}_*/*" for p in prefixes],
        max_workers=8,
    )
    files = sorted(p for pre in prefixes for p in CASES_DIR.glob(f"{pre}_*/*") if p.is_file())
    hashes = {str(p.relative_to(RCAEVAL)): sha256(p) for p in files} | {
        "cases.parquet": sha256(RCAEVAL / "cases.parquet")
    }
    manifest = ROOT / "manifests" / f"rcaeval-{args.split}.json"
    manifest.parent.mkdir(exist_ok=True)
    if manifest.exists():
        expected = json.loads(manifest.read_text())
        bad = sorted(k for k in expected if hashes.get(k) != expected[k])
        if bad:
            raise SystemExit(
                f"SIFT-E104 {len(bad)} files differ from {manifest.name} (first: {bad[0]})\n"
                f"fix: delete data/rcaeval and run make fetch SPLIT={args.split} again"
            )
        print(f"{len(hashes)} files verified against {manifest.name}")
    else:
        manifest.write_text(json.dumps(hashes, indent=1, sort_keys=True) + "\n")
        print(f"{len(hashes)} files pinned in {manifest.name}")


if __name__ == "__main__":
    main()
