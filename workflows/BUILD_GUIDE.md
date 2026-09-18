# n8n workflow build guide

**Status update (post hackathon-night live debugging): this doc is now
historical planning context, not the current source of truth.**
`wf0_ingest.json`, `wf1_validation.json`, and `approval_gate.json` in this
folder (plus everything in `tools/`) are now real exports of the actual
live, working n8n instance — built by hand from this guide originally, then
run against the real `stormbreakers-demo` repo, and fixed through ~10 real
bugs found only by actually triggering them (stale node references, a race
condition between parallel branches, a regex that silently mislabeled which
test failed, n8n dropping a node's data on zero input items, and others —
see `workflows/tools/README.md` and the git history around this commit for
specifics). Import the JSON directly rather than rebuilding from the prose
below; keep this doc for the reasoning behind the design, not as a
build-from-scratch reference anymore.

---

**Original honesty note (kept for context — hand-typing a fully correct n8n
workflow export without a running instance to test against is a good way to
ship a JSON file that imports with cryptic errors):**
`typeVersion`s, LangChain node parameter shapes, credential bindings) without
a running n8n instance to test against is a good way to hand your team a
JSON file that imports with cryptic errors and burns an hour of Phase 2/3
debugging someone else's malformed export instead of building. So:
`workflows/tools/*.json` below ARE real, importable starting points for the
6 tool sub-workflows (simple enough — Trigger → HTTP Request → Code — to get
right by hand). For WF-0, WF-1, and WF-R, which lean on AI Agent /
LangChain / Wait nodes whose exact JSON shape depends on your n8n version,
this doc is the source of truth instead: precise enough to build each
workflow node-by-node in the editor in well under the phase budget, with no
risk of fighting a bad import. Build from this doc, then export your own
JSON into this folder at the end of Phase 3/5 so it's versioned.

Every workflow below reads/writes the contracts in `schemas/`, scores via
`scoring/scorer.js` (ported into a Code node — see `config/scoring.json`
comment on this), and validates via `validation/validateFinding.js` (same —
paste the function bodies into a Code node).

---

## WF-0 — Ingest (test history)

**Trigger:** Webhook (POST) — GitHub sends this on `workflow_run` /
`completed`. Add a second manual Form trigger as a fallback per the plan.

1. **Webhook** node → receives the GitHub `workflow_run` payload.
2. **IF** node: `body.action == "completed"` AND `body.workflow_run.name == "CI"`.
3. **HTTP Request**: `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts`
   (Header Auth credential = your GitHub PAT) → find the `test-results`
   artifact id.
4. **HTTP Request**: `GET .../artifacts/{artifact_id}/zip` (binary response).
5. **Compression** node: Decompress → gives you `junit.xml` and
   `coverage.xml` as binary/text.
6. **XML** node (or a **Code** node using a small regex/DOMParser — n8n's
   XML node handles JUnit fine): parse `junit.xml` → for each `<testcase>`,
   build `{ test_name: classname+"."+name, status: has <failure>/<error> child ? "fail" : "pass", run_id, sha: workflow_run.head_sha, branch: workflow_run.head_branch, run_number: workflow_run.run_number }`.
   See `fixtures/github/junit_sample.xml` for the exact shape to parse.
7. **Code** node: parse `coverage.xml` (Cobertura) — read the root
   `<coverage line-rate="...">` attribute → `coverage_pct = line-rate * 100`.
   See `fixtures/github/coverage_sample.xml`.
8. **n8n Data Table** (or **Postgres** node) `test_history`: upsert one row
   per test case from step 6.
9. **n8n Data Table** (or **Postgres**) `coverage_history`: upsert one row
   `{ sha, run_number, coverage_pct }`.

**Test it:** trigger manually with a fixture payload built from
`fixtures/github/workflow_run.json` + `fixtures/github/junit_sample.xml`
before wiring the real webhook.

---

## WF-1 — Main Validation

**Trigger:** Webhook (POST, same GitHub event as WF-0 — both workflows can
listen to the same GitHub webhook delivery; split concerns instead of
splitting webhooks) OR triggered by WF-0 via **Execute Workflow** once
ingest is done, so history is guaranteed fresh before collection starts.
Second trigger: **n8n Form** (manual fallback — repo, PR number/sha).

### 1. Evidence Collector (parallel branches, merged with a **Merge** node)

- Branch A: `GET /repos/{o}/{r}/actions/runs/{run_id}` +
  `.../jobs` → conclusion, failed job names.
- Branch B: query `test_history`/`coverage_history` Data Tables for this
  sha + base sha → `ci.failed_tests`, `coverage.head_pct`/`base_pct`.
- Branch C: `GET /repos/{o}/{r}/code-scanning/alerts?state=open`
- Branch D: `GET /repos/{o}/{r}/dependabot/alerts?state=open`
- Branch E: `GET /repos/{o}/{r}/compare/{base}...{head}` → `changed_files`.
- **Code** node: assemble the merged branches into one `evidence_bundle`
  object matching what `prompts/build_test_agent.md` and
  `prompts/security_agent.md` expect as input.

### 2. Build & Test Agent

- **AI Agent** node (LangChain). System Message = paste
  `prompts/build_test_agent.md`. User message = the `ci`/`coverage` slice
  of `evidence_bundle` as JSON.
- **Chat Model**: Google Gemini Chat Model node, model `gemini-2.5-flash`
  (verify current model id/free-tier limits before the event — see
  Phase 0). Add a second credential + a **Switch**/fallback path to a
  backup key if you hit rate limits mid-demo.
- **Tools**: three **Call n8n Workflow Tool** nodes, one per
  `workflows/tools/get_test_history.json`,
  `workflows/tools/get_job_logs.json`,
  `workflows/tools/compare_commits.json`. Give each tool a clear
  description matching its docstring in that JSON file — the agent picks
  tools by reading these descriptions.
- **Output Parser**: Structured Output Parser bound to
  `schemas/finding.schema.json` (n8n can take a JSON Schema directly, or
  paste an example array — check your n8n version's parser node).
- Node settings: max iterations ~6, **enable "Return Intermediate Steps"**
  — this is what feeds the trace timeline in the report. Capture that
  output into a `trace` array shaped like `schemas/trace_step.schema.json`
  (a small **Code** node mapping intermediate steps → TraceStep is usually
  needed since the raw LangChain format differs).

### 3. Security Agent

Same pattern as step 2, using `prompts/security_agent.md` and tools
`get_advisory.json`, `search_imports.json`, `search_symbol_usage.json`.
Runs in parallel with step 2 (both only need the evidence bundle).

### 4. Validation layer

- **Code** node per agent: paste in `validation/validateFinding.js`'s
  `validateFindings()` (pass the set of URLs seen across all tool outputs
  this run as `knownEvidenceUrls` — collect these as each tool sub-workflow
  runs, or reconstruct from the trace). On `rejected.length > 0`, loop back
  into the Agent node once with the errors appended to the prompt (n8n:
  simplest is an **IF** + one manual retry branch, not a full loop, to keep
  demo runtime bounded).
  On a second failure, call `syntheticLowConfidenceFinding()` instead of
  dropping the agent's output.

### 5. Release Manager

- **Merge** node: combine both agents' valid findings into one array.
- **Code** node: paste in `scoring/scorer.js`'s `scoreRun()`, called with
  the merged findings + `config/scoring.json` (HTTP Request or Read Binary
  File the config, or paste it as a static JSON in the Code node — your
  call on which is easier to keep in sync).
- **AI Agent** node (single call, no tools needed): System Message =
  `prompts/release_summary.md`, input = the `scoreRun()` result. This is
  the only LLM call allowed to touch the final numbers, and only to
  narrate them.
- **Code** node: assemble the full `run_record` per
  `schemas/run_record.schema.json` and persist it (Data Table / Postgres
  `run_records` table, keyed by `run_id`).

### 6. Notify + human gate

- **HTTP Request**: `POST /repos/{o}/{r}/statuses/{sha}` — commit status,
  `state` = success/failure/pending, `target_url` = the WF-R report URL for
  this `run_id`.
- **HTTP Request**: `POST /repos/{o}/{r}/issues/{pr}/comments` — PR comment
  with score/band/link.
- **HTTP Request**: Slack incoming webhook — "Report ready {score}/100 —
  {band}, {link}".
- **Wait** node, resume mode "webhook" — this pauses the workflow and gives
  you `$execution.resumeUrl`; pass that into the persisted run_record as
  `resume_url` so WF-R's report page can render the Approve/Reject `<form
  action>` pointed at it (see `report/render.js`'s `resumeUrl` param).

### 7. On resume (Approve / Reject POST arrives)

- **IF** node: `body.decision == "approve"`.
  - Approve: **HTTP Request** `POST
    /repos/{o}/{r}/actions/workflows/deploy.yml/dispatches` with
    `inputs: { run_id, score, approver }`. Then write the audit row
    (Google Sheets node — append `{timestamp, run_id, sha, score, band,
    decision, approver, comment}`).
  - Reject: Slack message to the engineer with the blocking findings, then
    write the same audit row with `decision: "reject"`.
- Update the persisted `run_record` with `approver`, `decided_at`,
  `approval_comment`.

---

## WF-R — Report page

**Trigger:** Webhook (GET) at `/report/:runId` (use n8n's `:param` path
syntax in the Webhook node path field).

1. **Postgres/Data Table** node: read the `run_record` for `runId`.
2. **Code** node: `require`/paste `report/render.js`'s `renderReport()` and
   call it with the loaded record and its `resume_url`.
   (If your n8n build restricts `require` in Code nodes, paste the whole
   `render.js` file content above the call instead of requiring it — same
   result, zero external dependency either way, since `render.js` has none.)
3. **Respond to Webhook** node: Content-Type `text/html`, body = the
   rendered string.

See `report/example_S3_report.html` for exactly what this should produce.

---

## Tool sub-workflows

Each is a tiny, independent, directly-testable workflow: **Execute Workflow
Trigger** (this is what "Call n8n Workflow Tool" invokes) → one or two
**HTTP Request**/**Code** nodes → **Set** node shaping the return value. See
`workflows/tools/*.json` for importable starting points and each file's
header comment for its exact input/output contract. Test each one standalone
(Execute Workflow Trigger nodes can be run directly in the n8n editor with
pinned test input) against the fixtures in `fixtures/github/` before wiring
them into the agents — this was Phase 2's explicit advice: "debugging two
branches at once inside n8n is painful," and the same goes double for
debugging a tool AND an agent's tool-selection logic at the same time.
