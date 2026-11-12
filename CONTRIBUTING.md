# Contributing

```bash
pnpm install && pnpm test
uv sync --project evals
uv run --project evals pytest evals/tests -q
```

- README and `docs/RESULTS.md` numbers come from `results/`. Edit `docs/README.template.md` and `docs/RESULTS.template.md`, then run `make report`. CI fails on drift.
- Design and tuning happen on Dev only. Test sets refuse to run until `PREREGISTRATION.md` is committed (`evals/src/sift_evals/guard.py`); Test B also needs the `q3-frozen` tag.
- Sift reads cases only through anonymised paths: RCAEval directory names contain the answer. `test_sift_never_sees_the_case_name_or_answer` guards it.
- Storage changes run the crash harness: `make infra`.
