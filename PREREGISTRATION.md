# Pre-registration: Q1, logs-only root cause analysis

Committed before any Test A or Test B case is read. The evaluation code refuses to open a test
set unless this file is committed and unchanged (`evals/src/sift_evals/guard.py`).

## Question

On injected microservice faults, how well can the root-cause service be ranked from logs alone,
and how does that compare with the same published method given metrics or traces?

## Data

RCAEval (Pham et al., WWW 2025), Hugging Face Parquet copy, code pinned at RCAEval commit
`90b63a46ac1e969f1fa9015318b51e455c62f8c4`; every file pinned by SHA-256 in `manifests/`.
Every case in a set is scored; none is excluded.

| Set | Datasets | Cases | Opened |
|---|---|---|---|
| Dev | RE2-OB, RE3-OB | 120 | used for all design and tuning |
| Test A | RE2-SS, RE3-SS | 120 | once, with the frozen configuration below |
| Test B | RE2-TT, RE3-TT | 120 | once, only after the Q3 configuration is frozen (git tag `q3-frozen`), built from the tagged Wave 1 commit |

Test A was downloaded and hashed before this commit; no Test A log, metric or trace value has
been read.

## Methods (all frozen)

- **Sift** (`engine/`, `sift rca`): replays the case's `logs.parquet` (through an anonymised
  path) into a fresh store, mines templates online, ranks services by novelty, error surge and
  volume shift around the injection time. Configuration: `configs/rank.json` at this commit.
- **Error-surge control**: services ranked by error-line count after minus before the injection
  time, same window and error lexicon as Sift.
- **RCAEval BARO** on metrics, and **RCAEval multi-source BARO** on metrics only, logs only,
  traces only, and all signals, run with RCAEval's own code (`evals/src/sift_evals/baselines.py`).

Inputs shared by all methods: the case's injection time and a window of 300 s before and after it.

## How the configuration was chosen (Dev only)

- Round 1 (`results/q1/dev/history/tuning_round1.json`): 18 settings. Superseded after the
  default-pick check showed Sift ranking `recommendationservice` first in 52 of 120 Dev cases and
  `redis` in 33: unmasked identifier lists made new templates, and the volume score inflated tiny
  services. Fixed in the miner (identifier mask) and the ranker (Poisson z against the system trend).
- Round 2 (`results/q1/dev/tuning.json`): 18 settings, Dev Avg@5 from 0.445 to 0.533. Chosen by
  max Dev Avg@5 (ties by AC@1): `errorWeight 0.5, wShift 2, wSurge 0.5`. It lies at the edge of
  the grid; the grid was not extended again, to limit Dev overfitting. Dev numbers are therefore
  optimistic; Test A is the estimate.

## Scoring

- Candidate set per case: RCAEval's own rule (non-constant metric columns in the window, service
  = column prefix, `-db` removed), the same for every method.
- A method's output is mapped to services, deduplicated by first appearance; unranked candidates
  tie at the bottom and are scored by expected rank under a random tie-break.
- A failed run, timeout or empty input scores as a miss at every k; failure counts are reported.
- Metrics: AC@1, AC@3, Avg@5; Chance@5 and Lift@5 (Avg@5 minus chance).
- 95% intervals: paired cluster bootstrap over (service, fault) scenarios, 2000 resamples, seed 0.
- Reported per set, per dataset, per fault type. No claim beyond the three RCAEval systems.

## Diagnostics (reported for every method)

- **Default-pick check:** the service each method ranks first most often, with its share of
  cases, against that service's share as the answer.
- **Evidence behind Sift's correct top-1 picks**, by a fixed keyword rule
  (`evals/src/sift_evals/score_q1.py`, `evidence_kind`): restart or redeploy, error lines, volume
  shift, other, weak. On Dev: 30 restart or redeploy, 4 error lines, 3 volume shift, 8 weak, of 45.

## Claims and how each is tested

1. **What logs carry** comes only from the signal ablation (multi-source BARO, signal varied,
   method fixed).
2. **Whether Sift ranks better** comes only from the method comparison on the same input
   (Sift vs multi-source BARO on logs vs the error-surge control), as paired differences.

## Predictions (written before Test A)

Dev values in brackets.

- Logs-only multi-source BARO stays near chance [Lift@5 +0.002].
- Sift beats logs-only multi-source BARO on Avg@5, with the paired interval above zero
  [0.533 vs 0.252].
- Sift stays below metric-based BARO on Avg@5 overall [0.533 vs 0.742].
- Sift's AC@1 is at least as high as metric-based BARO's [0.375 vs 0.100].
- By fault: Sift is strongest on code-level faults (RE3) and LOSS, weakest on CPU, MEM, DISK.
- Most of Sift's correct top-1 picks rest on restart or redeploy evidence [30 of 45].
- Test A Avg@5 for Sift is lower than its Dev Avg@5 (tuning optimism).

## Not changed after this commit

The ranker and miner code under `engine/src/`, `configs/rank.json`, the scoring code, the window,
the candidate rule, the bootstrap and the evidence classifier. Any later change is reported as a
new, labelled configuration and never replaces these numbers.

---

# Addendum: Test B (Train Ticket), committed before any Test B case is read

Test A has been read (results above, 3 of 7 predictions held). Everything below was designed on
Dev only. Test B is opened once, after this addendum is committed and tagged `q3-frozen`, and
scores every configuration below in the same run.

## Q1 configurations scored on Test B

- **Sift v1**, unchanged: `configs/rank.json`. Its code changed after Test A only behind a flag
  (v2) and in an empty-store query fix; re-running v1 on all 120 Dev cases gives 0 changed
  rankings (`results/q1/dev/v1_reproduction.json`).
- **Sift v2**: `configs/rank_v2.json`. Novelty is counted against the service's own new-template
  mass in the window before the alarm, so a service that always writes one-off lines is not novel
  by default. Motivated by the Test A diagnosis (post-hoc); tuned on Dev only by the same rule
  (`results/q1/dev/tuning_v2.json`, 18 settings, Dev Avg@5 0.517 to 0.558, chosen at the edge
  of the grid, not extended). Dev: Avg@5 0.558, AC@1 0.392.
- The same baselines, control, candidate rule and scoring as Test A.

## Q3: investigate before alert (`sift watch`)

- **Input:** the case's logs only, replayed forward in 15 s steps of event time. The injection
  time is never given to Sift; it is used only by the scorer (`evals/src/sift_evals/score_q3.py`).
- **Configuration, not tuned:** `DEFAULT_WATCH_CONFIG` in `engine/src/detect/watch.ts` (z threshold
  4, 60 s window against a 300 s baseline, 300 s warm-up, 120 s cooldown, 60 s gate); model
  `mlx-community/Qwen2.5-3B-Instruct-4bit` through an OpenAI-compatible local server, temperature 0,
  at most 8 model calls per case (later gate-passed signals keep the gate's decision).
- **Rungs:** raw sensors; + deterministic gate; + model. A model answer that is unusable keeps the
  gate's decision and is counted as a failure.
- **Scoring:** detection window 300 s after injection; "any" and "correct service" (model rung: the
  service the model names); issues before injection as false issues per monitored hour; repeat
  issues per (service, sensor) deduplicated; censored cases excluded from recall and counted;
  95% cluster bootstrap over (service, fault) scenarios.
- **Dev results** (design set): raw 0.483 any / 0.068 correct / 52.5 false per hour; gate 0.475 /
  0.110 / 4.0; model 0.475 / 0.127 / 4.0. The model answered "open" to 99.4% of gate-passed signals.

## Predictions for Test B (written before Test B is read)

1. Sift v2 beats Sift v1 on Avg@5 (paired 95% CI above zero).
2. Sift v2 ranks no single service first in more than half of the cases.
3. Sift v2 stays below metric-based BARO on Avg@5.
4. Sift v2 beats logs-only multi-source BARO on Avg@5 (paired 95% CI above zero).
5. The gate cuts false issues per hour at least five-fold against raw sensors, while losing at most
   0.05 of any-service recall.
6. The model rung's correct-service recall is within 0.05 of the gate's (the small model adds little).
7. The model answers "open" to at least 90% of the gate-passed signals it sees.
