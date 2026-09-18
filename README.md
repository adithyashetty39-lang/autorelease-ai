# AutoRelease AI

Team Stormbreakers · DSU DevHack 3.0 · Agentic AI theme

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

## Repo layout

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

## Setup

```bash
cp .env.example .env        # fill in secrets
docker compose up -d        # starts n8n + Postgres + cloudflared
docker compose logs cloudflared   # grab the public *.trycloudflare.com URL
```
Config was validated with `docker compose config` in this environment;
Docker Desktop's daemon wasn't running here so the actual boot (n8n
reachable on :5678, migrations applying against Postgres) is **not yet
confirmed live** — do this first, before anything else.

## Deviations from the PRD (and why)

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

## What you (the team) must do

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

## Judge Q&A

PRD Section 7 has the three prepared answers (hallucination trust,
false-negative risk on reachability, "why wouldn't GitHub just build this").
Add a fourth, now that this build exists: **"why only 2 agents?"** — see the
plan file's Section 1 for the full answer; the short version is depth over
agent count, and the reasoning trace in the report is the proof, not an
assertion.
