# AutoRelease AI

Team Stormbreakers · DSU DevHack 3.0 · Agentic AI theme

An agentic release gate for GitHub pull requests. It investigates CI results,
test history, the app's real behaviour and security alerts, then posts one
evidence-backed verdict on the PR — **APPROVE**, **REVIEW** or **BLOCK** — with
plain-code rules that the AI cannot overrule.

**The AI investigates and explains. Written rules decide.** The agent can be
wrong; it cannot be wrong alone.

## What's live

Everything below runs today on a self-hosted n8n instance against the demo
app [`adithyashetty39-lang/stormbreakers-demo`](https://github.com/adithyashetty39-lang/stormbreakers-demo).
The workflow exports in [`workflows/`](workflows/) are the source of truth.

```
Pull request
  └─ GitHub CI (demo repo .github/workflows/ci.yml)
       tests + coverage · CodeQL · gitleaks · semantic response probe
  └─ WF-0 ingest            fetch JUnit + coverage for the run
  └─ WF-1 validation (54 nodes)
       1. PR scope          which files this PR actually changed
       2. Behaviour         base vs head responses + business rules (from CI)
       3. Security          Dependabot / code-scanning alerts, minus ones already tracked
       4. AI agent          GLM-5.3 Flash via OpenRouter, with 4 tools:
                            get_test_history · get_advisory · search_imports · search_symbol_usage
       5. Cross-check       independent re-derivation of every flaky/regression call
       6. Deterministic gate  rules 1–10 below
  └─ Outputs  one PR report (updated in place) · commit status · tracked issues
```

### What it catches, and the PR that shows it

| Capability | How | Demo PR |
|---|---|---|
| **Flaky test vs real regression** | Same commit both passed and failed on `main` ⇒ flaky (proof). Never failed before and the PR changes code ⇒ regression. Re-derived independently of the AI. | [#54](https://github.com/adithyashetty39-lang/stormbreakers-demo/pull/54) flaky on a docs PR · [#24](https://github.com/adithyashetty39-lang/stormbreakers-demo/pull/24) regression + flaky in one run |
| **Don't blame the PR for old problems** | Findings attributed from the PR's real diff: introduced vs pre-existing | [#54](https://github.com/adithyashetty39-lang/stormbreakers-demo/pull/54) — "nothing in this report was introduced by this PR" |
| **Silent behaviour regressions (green CI)** | CI captures the app's real HTTP responses on base and head; compared field by field. A value that contradicts its own request is flagged | [#14](https://github.com/adithyashetty39-lang/stormbreakers-demo/pull/14) banner swap, 24/24 tests pass |
| **Business-logic regressions** | Business rules declared in the demo repo's `probes.json` (e.g. "GST is 18% of the discounted price", "total = taxable + GST + shipping") are checked on both commits. Rules and checker come from the **base** commit, so a PR can't loosen them | [#33](https://github.com/adithyashetty39-lang/stormbreakers-demo/pull/33) two different live edits, 42/42 tests pass, both caught |
| **No false alarms on safe changes** | Behaviour-preserving refactor: 0 divergences, all rules hold | [#40](https://github.com/adithyashetty39-lang/stormbreakers-demo/pull/40) |
| **CVE reachability** | Advisory → vulnerable functions → are they imported → are they actually called | PyYAML `yaml.full_load` is called at `app/config.py:37`; Pillow's `ImageMath.eval` is never called |
| **Don't redo known work** | Findings are filed as GitHub issues once and skipped on later runs (still listed, still count against release) | every report's "Already tracked" section |

### Deterministic gate (WF-1 · *Deterministic Validation Gate*)

| # | Rule | Effect |
|---|---|---|
| 1 | Any failing test | approve → review |
| 2 | Security evidence unavailable | approve → review |
| 3 | Low agent confidence | approve → review |
| 4 | Secret detected | **block** (hard) |
| 5 | Agent says "flaky" but history says regression | → review |
| 6 | Known critical/high issue still open | approve → review |
| 7 | Nothing attributable to this PR | block → review |
| 8 | Response contradicts its request | approve → review |
| 9 | Regression introduced by this PR (clean history, now failing, PR changes code) | **block** (hard) |
| 10 | Business rule held on base, broken by this PR | **block** (hard) |

If the agent returns no verdict (or crashes), it is asked once more; if that
also fails the run takes a fail-safe REVIEW path. Every override and retry is
disclosed in the report.

### Honest limits

- Behaviour checks only see endpoints listed in `probes.json`; business rules
  only protect what someone wrote a rule for. Unprobed code is not checked.
- It is built to catch mistakes, not attackers: a hidden backdoor that never
  fires during testing, or a PR that edits `ci.yml` itself, needs code review
  and branch protection.
- The demo repo pins vulnerable dependencies and has a test that fails on
  every third CI run, on purpose, so the demo is repeatable. Detection runs on
  the real advisories and the real CI history.
- #14's BLOCK comes from the agent's judgement (rule 8 guarantees at least
  REVIEW); #24 and #33 are held by hard rules 9 and 10.
- GitHub → n8n triggering needs a public URL for n8n (GitHub webhook,
  `workflow_run` events → `/webhook/autorelease/github`). During the event the
  same `workflow_run` payload was posted to that webhook manually.

## Repo map

| Path | What it is |
|---|---|
| `workflows/wf0_ingest.json`, `wf1_validation.json`, `approval_gate.json` | **Live** n8n workflows (exported) |
| `workflows/tools/*.json` | **Live** agent tool sub-workflows |
| `workflows/tools/verify_tools.js` | Runs the shipped tool code against the real demo app |
| `semantic/diffResponses.js` (+ test) | Behaviour-diff detector; embedded verbatim in WF-1's *Diff Responses* node |
| `scoring/`, `validation/`, `report/`, `eval/`, `schemas/`, `prompts/`, `config/` | Tested modules and prompts from the original design (below). The live release decision is made in WF-1, not by `scoring/scorer.js` |
| `workflows/BUILD_GUIDE.md` | Original build spec; the exported JSON supersedes it |

Behaviour contract, checker and probe runner live in the demo repo:
`probes.json`, `tools/invariants.py`, `tools/probe_runner.py`, CI job `semantic-probe`.

## Run it

```bash
cp .env.example .env              # fill in secrets
docker compose up -d              # n8n + Postgres
```

1. In n8n, import `workflows/tools/*.json` first, then `wf0_ingest.json`, `wf1_validation.json`, `approval_gate.json`.
2. Create credentials: a GitHub token for the target repo (read contents, actions and security alerts; write issues, pull-request comments and commit statuses) and an OpenRouter API key. Re-select them on the nodes that reference them.
3. Point a GitHub webhook (`workflow_run` events) at `https://<your-n8n>/webhook/autorelease/github`.

Tests:

```bash
npm test                                   # modules + semantic detector
node workflows/tools/verify_tools.js       # needs the demo repo cloned next to this one
```

---

## Original build plan (pre-event, kept for reference)

An autonomous DevOps agent that decides whether a code release is safe to
ship, by investigating GitHub Actions, Code Scanning, and Dependabot
evidence, and producing a single evidence-linked Release Readiness Score for
human approval. Full product spec: `AutoRelease_AI_PRD.md` (shared
separately). This repo is the orchestration layer + everything testable
without a running n8n instance; `stormbreakers-demo-shop` (sibling repo) is
the target app it validates.

**Everything in this repo that CAN be verified without live n8n/Gemini/a
pushed GitHub repo has been. Run `npm test` — 54 tests, all green:**
scoring math (19), finding validation (10), report rendering (11), and the
12-scenario eval table (14, including both of the PRD's worked examples:
25/100 block and the "GitHub green, we block it" 55/100 case).

```bash
npm test
node workflows/tools/verify_tools.js   # tool logic, run against real demo-app files
```

What did NOT get built here, and why: n8n itself, live GitHub API calls, and
live Gemini calls all need a running n8n instance, a pushed GitHub repo, and
API keys this environment doesn't have. `workflows/BUILD_GUIDE.md` is a
precise node-by-node spec for building those in the editor — more reliable
than a hand-typed AI-Agent-node JSON export I can't test against a live
n8n version.

### Repo layout

```
docker-compose.yml, .env.example    n8n + Postgres + cloudflared tunnel (config validated, not runtime-tested -- see below)
workflows/BUILD_GUIDE.md            node-by-node spec for WF-0, WF-1, WF-R
workflows/tools/*.json              3 of 6 tool sub-workflows, importable + verified
prompts/*.md                        system prompts for both agents + the summary call
schemas/*.json                      Finding / TraceStep / RunRecord JSON Schema
config/scoring.json                 externalized scoring policy (PRD 6.2)
scoring/scorer.js (+ .test.js)      deterministic scorer -- 19 tests
validation/validateFinding.js       schema + evidence-provenance validation -- 10 tests
report/render.js (+ .test.js)       report page renderer -- 11 tests
report/example_S3_report.html       what it actually looks like
fixtures/github/                    representative GitHub API response shapes
fixtures/scenarios/s1-s5.json       full evidence bundles for the 5 demo scenarios
eval/cases.json, score_eval.test.js 12 labeled scenarios, scoring half automated
eval/run_eval.md                    how to run the agent-classification half live
```

### Setup

```bash
cp .env.example .env        # fill in secrets
docker compose up -d        # starts n8n + Postgres + cloudflared
docker compose logs cloudflared   # grab the public *.trycloudflare.com URL
```
Config was validated with `docker compose config` in this environment;
Docker Desktop's daemon wasn't running here so the actual boot (n8n
reachable on :5678, migrations applying against Postgres) is **not yet
confirmed live** — do this first, before anything else.

### Deviations from the PRD (and why)

| PRD said | This build does | Why |
|---|---|---|
| Fixed branches ("on failing test → fetch history") | Tool-calling AI Agent nodes | Real autonomy + a visible reasoning trace, not an if-else with an LLM summary |
| Manual n8n Form trigger only | GitHub webhook primary, Form as fallback | Matches the "autonomous" claim |
| Flaky detection "from the Actions API" | JUnit XML artifact + a `test_history` table (WF-0) | The Actions API has no per-test data |
| Secret / coverage deductions, no data source | gitleaks → SARIF; pytest-cov → coverage.xml | Evidence-backed, not aspirational |
| Reachability: "imported by changed files" | Imported *anywhere* in the repo + symbol-level call-site check | The original rule was a false-negative risk (see PRD Q2's own answer, which already contradicted section 4 — this build follows the Q2 answer) |
| −100 for a secret | `secret_detected` / low-confidence-high-weight are **gates**, separate from the score | Score always clamps to [0,100]; a gate can't be "outscored" |
| Score reachability example severity "high" | Demo uses two **critical** CVEs (one reachable, one not) | Stronger demo point: even a 9.8-CVSS CVE gets 0 score impact when unreachable |
| CVE-function mapping assumed to exist in GHSA data | `stormbreakers-demo-shop/security/vulnerable_functions.json` fallback | Real advisory APIs don't reliably expose function-level data; PRD Phase 1 step 1 anticipated exactly this fallback |

Two real bugs the review + build process caught, worth repeating out loud to
judges as evidence of rigor: the reachability rule in PRD section 4
contradicted the PRD's own Q2 answer (fixed above), and the first symbol-
search regex matched a *docstring mention* of the vulnerable function, not
just the real call site (fixed in `search_symbol_usage.json`, verified by
`verify_tools.js` against the actual demo repo).

### What you (the team) must do

Nothing here replaces a human doing these — they need real accounts,
real judgment calls, or a live n8n instance this environment doesn't have.

1. **Confirm hackathon rules on pre-event repo/API setup.** Everything under
   "Before the event" below assumes some prep is allowed — check first.
2. **Create the two GitHub repos** (`stormbreakers-demo-shop` public,
   `autorelease-ai` can be private) and push this code. Not done here —
   pushing to GitHub is a real publish action.
3. **Get API access**: GitHub fine-grained PAT (actions, contents,
   pull_requests, statuses, security_events, workflows scopes), Gemini API
   key (**check the current free-tier rate limit** — a 6-step tool loop
   burns ~15-20 calls per validation run), Slack incoming webhook, Google
   service account for Sheets.
4. **Run `docker compose up -d` and confirm n8n actually boots** — not
   verified live in this environment.
5. **Build WF-0, WF-1, WF-R in the n8n editor** following
   `workflows/BUILD_GUIDE.md`. Import the 3 tool JSONs, fill in
   `OWNER/REPO`, attach the GitHub PAT credential, build the other 3 tools
   from the guide.
6. **Seed flaky-test history**: push ~10 commits to `main` on the demo repo
   before judging (see `stormbreakers-demo-shop/README.md`).
7. **Run the eval** (`eval/run_eval.md`) against S1–S5 once WF-1 works
   end-to-end; build V1–V7 as time allows. Record the results table for the
   demo/README.
8. **Rehearse the demo**: S3 (GitHub green, AutoRelease blocks) as the
   opening wow moment, then S2 (GitHub red, AutoRelease approves), then
   Approve → deploy.yml fires → audit row appears. Record a fallback video.
9. **Team roles for a 3-person team** (rebalanced from the plan's 4-person
   split):
   - **P1 — Evidence & CI**: demo repo, `ci.yml`/`deploy.yml`, seeded
     history, WF-0, the Evidence Collector, all 6 tool workflows.
   - **P2 — Agents & Scoring**: wire both AI Agent nodes with the prompts
     in `prompts/`, the validation retry loop, Release Manager step
     (scorer + summary call already built/tested — port into a Code node).
   - **P3 — Human gate, integrations & demo**: WF-R report page (renderer
     already built/tested), Wait/resume flow, commit status/PR
     comment/Slack/Sheets/deploy trigger, eval runs, README polish, video,
     pitch rehearsal.
   With 3 people there's no natural "4th floating debugger" — whoever
   finishes their Phase 2/3 piece first floats to unblock whichever of the
   other two is behind at the hour-10/hour-20 checkpoints (see the plan's
   go/no-go table).

### Judge Q&A

PRD Section 7 has the three prepared answers (hallucination trust,
false-negative risk on reachability, "why wouldn't GitHub just build this").
Add a fourth, now that this build exists: **"why only 2 agents?"** — see the
plan file's Section 1 for the full answer; the short version is depth over
agent count, and the reasoning trace in the report is the proof, not an
assertion.
