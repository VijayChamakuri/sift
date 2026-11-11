"""Service-level scoring shared by every method, with failures counted and ties scored fairly.

A method returns an ordered list of names (metric columns, log-template columns, trace
operations or plain services). Names are mapped to universe services, deduplicated by
first appearance, and services the method never ranked are tied at the bottom. A tie is
scored by its expected value under a random tie-break, the same for every method. A
failed run (no ranking at all) scores 0 at every k: a miss, never a skipped case.
"""

from __future__ import annotations

import random
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .universe import to_service

KS = (1, 2, 3, 4, 5)


def service_ranking(names: Iterable[str], universe: list[str]) -> list[str]:
    seen: list[str] = []
    for name in names:
        svc = to_service(name, universe) or to_service(name.split("_")[0], universe)
        if svc is not None and svc not in seen:
            seen.append(svc)
    return seen


def hit_at_k(ranking: Sequence[str] | None, answer: str, universe: list[str], k: int) -> float:
    """Probability that `answer` is in the top k once the unranked tail is shuffled."""
    if ranking is None:
        return 0.0
    ranked = [s for s in ranking if s in universe]
    if answer in ranked:
        return float(ranked.index(answer) < k)
    tail = len(universe) - len(ranked)
    if answer not in universe or tail == 0:
        return 0.0
    return max(0, min(k - len(ranked), tail)) / tail


@dataclass(frozen=True)
class CaseScore:
    case: str
    scenario: str
    fault: str
    hits: tuple[float, ...]  # AC@1..AC@5 for this case
    chance: tuple[float, ...]
    failed: bool

    @property
    def avg5(self) -> float:
        return sum(self.hits) / len(self.hits)

    @property
    def chance_avg5(self) -> float:
        return sum(self.chance) / len(self.chance)


def score_case(case, ranking: Sequence[str] | None, universe: list[str]) -> CaseScore:
    n = len(universe)
    return CaseScore(
        case=case.case,
        scenario=case.scenario,
        fault=case.fault,
        hits=tuple(hit_at_k(ranking, case.root_cause_service, universe, k) for k in KS),
        chance=tuple(min(k, n) / n for k in KS),
        failed=ranking is None,
    )


def summarize(scores: list[CaseScore]) -> dict:
    n = len(scores)
    out = {f"ac{k}": sum(s.hits[i] for s in scores) / n for i, k in enumerate(KS)}
    out["avg5"] = sum(s.avg5 for s in scores) / n
    out["chance_avg5"] = sum(s.chance_avg5 for s in scores) / n
    out["lift5"] = out["avg5"] - out["chance_avg5"]
    out["cases"] = n
    out["failed"] = sum(s.failed for s in scores)
    return out


def cluster_bootstrap(
    per_method: dict[str, list[CaseScore]], metric: str = "avg5", reps: int = 2000, seed: int = 0
) -> dict[str, tuple[float, float]]:
    """95% CI per method, resampling (service, fault) scenarios with their repetitions; paired across methods."""
    methods = list(per_method)
    by_scenario: dict[str, list[int]] = {}
    for i, s in enumerate(per_method[methods[0]]):
        by_scenario.setdefault(s.scenario, []).append(i)
    scenarios = list(by_scenario)
    rng = random.Random(seed)
    draws: dict[str, list[float]] = {m: [] for m in methods}
    for _ in range(reps):
        idx = [i for sc in rng.choices(scenarios, k=len(scenarios)) for i in by_scenario[sc]]
        for m in methods:
            vals = [_metric(per_method[m][i], metric) for i in idx]
            draws[m].append(sum(vals) / len(vals))
    return {m: _interval(d) for m, d in draws.items()}


def paired_difference(
    a: list[CaseScore], b: list[CaseScore], metric: str = "avg5", reps: int = 2000, seed: int = 0
) -> dict:
    """Mean of (a - b) with a 95% cluster-bootstrap interval over scenarios."""
    by_scenario: dict[str, list[int]] = {}
    for i, s in enumerate(a):
        by_scenario.setdefault(s.scenario, []).append(i)
    scenarios = list(by_scenario)
    diffs = [_metric(x, metric) - _metric(y, metric) for x, y in zip(a, b, strict=True)]
    rng = random.Random(seed)
    draws = []
    for _ in range(reps):
        idx = [i for sc in rng.choices(scenarios, k=len(scenarios)) for i in by_scenario[sc]]
        draws.append(sum(diffs[i] for i in idx) / len(idx))
    lo, hi = _interval(draws)
    return {"mean": sum(diffs) / len(diffs), "lo": lo, "hi": hi}


def _metric(s: CaseScore, metric: str) -> float:
    if metric == "avg5":
        return s.avg5
    if metric.startswith("ac"):
        return s.hits[int(metric[2:]) - 1]
    raise KeyError(metric)


def _interval(draws: list[float]) -> tuple[float, float]:
    d = sorted(draws)
    return d[int(0.025 * (len(d) - 1))], d[int(0.975 * (len(d) - 1))]
