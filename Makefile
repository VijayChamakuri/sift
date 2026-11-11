# make reproduce: every published number, from a clean checkout. Each stage is resumable.
# make reproduce DRY_RUN=1: print what would run, the disk it needs and rough times; download nothing.

PY := uv run --project evals python -m
SPLIT ?= dev

.PHONY: reproduce fetch audit baselines sift score report infra test dry-run

ifeq ($(DRY_RUN),1)
reproduce: dry-run
else
reproduce: fetch audit baselines sift report
endif

dry-run:
	@echo "stages: fetch -> audit -> baselines -> sift -> report (split: $(SPLIT))"
	@echo "disk:   RCAEval Dev cases ~1.0 GB (all three systems ~3.4 GB), derived series ~0.2 GB"
	@echo "time:   fetch ~1-3 min per GB; baselines ~10 min per 120 cases; Sift ~1 min per 120 cases (Apple M2)"
	@echo "needs:  uv, Node 24, pnpm 10"
	@echo "test sets refuse to run until PREREGISTRATION.md is committed (Test B also needs tag q3-frozen)"

fetch:
	$(PY) sift_evals.fetch --split $(SPLIT)

audit:
	$(PY) sift_evals.audit

baselines:
	$(PY) sift_evals.baselines --split $(SPLIT)

sift:
	pnpm install --frozen-lockfile && pnpm build
	$(PY) sift_evals.run_sift --split $(SPLIT) --config configs/rank.json

report:
	$(PY) sift_evals.report

infra:
	pnpm build
	cd engine && pnpm exec tsx bench/crash.ts --runs 100 --out ../results/infra/crash.json
	cd engine && pnpm exec tsx bench/throughput.ts --logs ../fixtures/demo/logs.parquet --out ../results/infra/throughput.json

test:
	pnpm test
	uv run --project evals pytest evals/tests -q
