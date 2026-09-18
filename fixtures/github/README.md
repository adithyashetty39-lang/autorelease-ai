# GitHub API fixtures

These are **synthetic but structurally accurate** — shaped to match GitHub's
documented REST API v3 responses (checked against the endpoints below), not
pulled from a live call. Use them to build and test the evidence collector
and tool sub-workflows before the demo repo has real history, and as the
offline "replay mode" data source (Phase 6 hardening) if live APIs flake
during judging.

**Regenerate real ones once `stormbreakers-demo-shop` exists and has run
CI a few times** — swap these for `curl` output against the real repo, same
filenames, so nothing downstream needs to change:

| File | Real endpoint |
|---|---|
| `workflow_run.json` | `GET /repos/{owner}/{repo}/actions/runs/{run_id}` |
| `jobs.json` | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` |
| `code_scanning_alerts.json` | `GET /repos/{owner}/{repo}/code-scanning/alerts` |
| `dependabot_alerts.json` | `GET /repos/{owner}/{repo}/dependabot/alerts` |
| `compare.json` | `GET /repos/{owner}/{repo}/compare/{base}...{head}` |
| `advisory_ghsa_pyyaml.json` | `GET /advisories/{ghsa_id}` (or `GET /repos/{owner}/{repo}/dependabot/alerts/{alert_number}`, which nests a similar `security_advisory` object) |
| `junit_sample.xml` | Downloaded from the `test-results` artifact (`actions/upload-artifact`) on a run |
| `coverage_sample.xml` | Same artifact, coverage.py's Cobertura-format output |

Auth note: `code_scanning_alerts` and `dependabot_alerts` require **GitHub
Advanced Security**, which is free on public repos but not available on
private ones without a paid plan — this is why the plan says "use a public
demo repo" (see Phase 0/1, and PRD Section 5 step 1).
