from dataclasses import replace

import pytest

from sift_evals.data import SPLITS, Case
from sift_evals.scoring import (
    cluster_bootstrap,
    hit_at_k,
    paired_difference,
    score_case,
    service_ranking,
    summarize,
)

U = ["a", "b", "c", "d", "e"]
CASE = Case("re2ob_c_cpu_1", "RE2-OB", "ob", "c", "cpu", 1, 100, 10)


def test_ranked_answer_is_exact():
    assert hit_at_k(["c", "a"], "c", U, 1) == 1.0
    assert hit_at_k(["a", "c"], "c", U, 1) == 0.0
    assert hit_at_k(["a", "c"], "c", U, 2) == 1.0


def test_unranked_answer_scores_expected_rank_in_the_tied_tail():
    # 2 ranked, 3 tied at the bottom: P(answer in top 3) = 1/3, top 4 = 2/3, top 5 = 1
    assert hit_at_k(["a", "b"], "c", U, 2) == 0.0
    assert hit_at_k(["a", "b"], "c", U, 3) == pytest.approx(1 / 3)
    assert hit_at_k(["a", "b"], "c", U, 4) == pytest.approx(2 / 3)
    assert hit_at_k(["a", "b"], "c", U, 5) == 1.0


def test_empty_ranking_equals_chance_and_failure_is_a_miss():
    s = score_case(CASE, [], U)
    assert s.hits == pytest.approx(s.chance)
    f = score_case(CASE, None, U)
    assert f.hits == (0.0,) * 5 and f.failed


def test_service_ranking_maps_and_dedupes():
    names = ["frontendservice_GET", "c_cpu", "c_mem", "redis-db_x", "unknown_svc"]
    assert service_ranking(names, ["frontend", "c", "redis"]) == ["frontend", "c", "redis"]


def test_summary_counts_failures_and_lift():
    scores = [score_case(CASE, ["c"], U), score_case(CASE, None, U)]
    s = summarize(scores)
    assert s["failed"] == 1 and s["cases"] == 2
    assert s["lift5"] == pytest.approx(s["avg5"] - s["chance_avg5"])


def test_bootstrap_is_deterministic_and_paired():
    cases = [replace(CASE, case=f"x{i}", root_cause_service=U[i % 5], repetition=i % 3) for i in range(30)]
    a = [score_case(c, [c.root_cause_service], U) for c in cases]
    b = [score_case(c, [], U) for c in cases]
    assert cluster_bootstrap({"a": a, "b": b}) == cluster_bootstrap({"a": a, "b": b})
    d = paired_difference(a, b)
    assert d["lo"] > 0 and d["mean"] > 0


def test_splits_are_disjoint():
    seen = [ds for v in SPLITS.values() for ds in v]
    assert len(seen) == len(set(seen))


def test_sift_never_sees_the_case_name_or_answer(monkeypatch, tmp_path):
    import sift_evals.run_sift as rs

    monkeypatch.setattr(rs, "BLIND", tmp_path)
    case_dir = tmp_path / "src" / "re2ob_productcatalogservice_loss_1"
    case_dir.mkdir(parents=True)
    (case_dir / "logs.parquet").write_bytes(b"x")
    case = replace(
        CASE, case="re2ob_productcatalogservice_loss_1", root_cause_service="productcatalogservice"
    )
    monkeypatch.setattr(Case, "dir", property(lambda self: case_dir))
    cmd = " ".join(rs.sift_command(case, None))
    assert "productcatalogservice" not in cmd
    assert case.case not in cmd
    assert "loss" not in cmd
