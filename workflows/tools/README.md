# Tool sub-workflows

**Update (hackathon night, post-live-debugging):** all 4 built tools below are
now exports of the ACTUAL live, running n8n instance (`localhost:5679`) —
not hand-authored skeletons anymore. Everything here has been triggered for
real against the real `stormbreakers-demo`/`autorelease-ai` GitHub repos and
produced correct output. `get_job_logs` and `compare_commits` were never
built (not needed for the shipped 3-scenario demo).

## What's here

- `get_advisory.json` — CVE metadata (OSV.dev) + function-level reachability
  data (repo's `security/vulnerable_functions.json` fallback). **Fixed
  tonight**: the two parallel HTTP branches raced into a plain Code node and
  intermittently failed with "Node X hasn't been executed" — now sequential.
- `search_imports.json` — is a package imported anywhere in the repo at a
  given sha. **Fixed tonight**: (1) a stale `$('When called as a tool')`
  reference to a since-renamed trigger node caused "Referenced node doesn't
  exist" on every real invocation; (2) the trigger was missing the `package`
  input field entirely, so the Agent had no way to tell it which package to
  search for.
- `search_symbol_usage.json` — is a *specific vulnerable function* actually
  called (not just imported). Verified against real repo files; the
  docstring-skip fix from the original build held up.
- `get_test_history.json` — **new tonight**, the flaky-vs-regression tool.
  Fetches the last ~10-20 completed runs on `main`, downloads and parses
  each run's real JUnit artifact, and reports this specific test's pass/fail
  status per run. Verified against real GitHub history — correctly
  reconstructed the demo's seeded flaky pattern (fails every 3rd run) across
  6 real runs.

## Known remaining gap

`get_advisory`'s fallback config (`vulnerable_functions.json` in the demo
repo) only has real function-level data for 2 CVEs. Dependabot on the live
repo now reports ~30 alerts total (more get published over time); for CVEs
outside those 2, the Agent falls back to looser import-level reasoning,
biased toward over-flagging rather than under-flagging (the safe direction
to be wrong in) — but it's not the precise function-call confirmation the
pitch describes for those. Worth knowing before a judge probes it.

## Verifying changes

`verify_tools.js` executes the embedded Code-node `jsCode` directly against
real demo-app files — still the fastest way to catch a regex/string-parsing
bug before it ever touches n8n:

```bash
node workflows/tools/verify_tools.js
```
