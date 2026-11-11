"""Paths, the case index, and the split that decides which cases a run may read.

The split is the guard rail for every experiment: Dev is open for design,
Test A and Test B open once each, in order. Nothing outside this module decides
which datasets belong to which set.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "data"
RCAEVAL = DATA / "rcaeval"
CASES_DIR = RCAEVAL / "hf"
# the downloaded index, or the committed copy (29 KB, MIT) so scoring runs on a clean checkout
CASE_INDEX = (
    RCAEVAL / "cases.parquet"
    if (RCAEVAL / "cases.parquet").exists()
    else ROOT / "manifests" / "rcaeval-cases.parquet"
)
RESULTS = ROOT / "results"

HF_REPO = "phamquiluan/RCAEval"
RCAEVAL_COMMIT = "90b63a46ac1e969f1fa9015318b51e455c62f8c4"

SPLITS: dict[str, tuple[str, ...]] = {
    "dev": ("RE2-OB", "RE3-OB"),
    "test_a": ("RE2-SS", "RE3-SS"),
    "test_b": ("RE2-TT", "RE3-TT"),
}

SYSTEM_OF = {"RE2-OB": "ob", "RE3-OB": "ob", "RE2-SS": "ss", "RE3-SS": "ss", "RE2-TT": "tt", "RE3-TT": "tt"}


@dataclass(frozen=True)
class Case:
    case: str
    dataset: str
    system: str
    root_cause_service: str
    fault: str
    repetition: int
    inject_time: int
    n_logs: int

    @property
    def scenario(self) -> str:
        """Repetitions of one (service, fault) injection share a scenario; the bootstrap resamples these."""
        return f"{self.dataset}:{self.root_cause_service}:{self.fault}"

    @property
    def dir(self) -> Path:
        return CASES_DIR / self.case


def cases(split: str) -> list[Case]:
    """Every case of a split, in a fixed order. Runs enumerate this list before starting."""
    if split not in SPLITS:
        raise KeyError(f"unknown split {split!r}; expected one of {sorted(SPLITS)}")
    datasets = SPLITS[split]
    rows = duckdb.sql(
        f"""
        select "case", dataset, system, root_cause_service, fault, repetition, inject_time, n_logs
        from read_parquet('{CASE_INDEX}')
        where dataset in {tuple(datasets)!r}
        order by dataset, "case"
        """
    ).fetchall()
    return [Case(r[0], r[1], r[2], r[3], r[4], int(r[5]), int(r[6]), int(r[7] or 0)) for r in rows]


def dump(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n")
