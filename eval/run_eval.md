# Running the full eval (Phase 6)

`npm test` already proves the **scoring half** of all 12 cases in
`cases.json` — given the hand-derived `expected_findings`, `scorer.js`
reliably produces the documented score/band/decision/gates. That part needed
no LLM and is done.

What still needs a live run, once WF-1's agents work end-to-end:

## For S1–S5 (fixtures/scenarios/*.json exist)

1. Feed each `fixtures/scenarios/sN_*.json` evidence bundle into WF-1
   directly (skip the live Evidence Collector step — paste the fixture as
   the trigger data, or add a temporary "replay mode" IF branch that reads
   from `fixtures/scenarios/` instead of calling GitHub, per Phase 6
   hardening in the plan).
2. Let the real Build & Test Agent and Security Agent run against it.
3. Compare the agent's actual `findings[]` output to `cases.json`'s
   `expected_findings` for that case — same categories, same confidence
   levels? Note any mismatch.
4. Confirm the final `run_record.decision` matches `cases.json`'s
   `expected.decision`.
5. Repeat 2-3 times per case (the plan's "score stability" check) — a
   nondeterministic LLM call should still land on the same classification
   every time given the same evidence, or you have a prompt problem to fix
   before judging.

## For V1–V7 (no fixture file yet — build during Phase 6)

Each entry's `note` field in `cases.json` describes exactly what evidence
bundle to construct and what it's testing. Build the bundle (same shape as
`fixtures/scenarios/s3_reachable_cve.json`), save it alongside the others,
add its `evidence_bundle_file` path to `cases.json`, then follow the same
steps 2-5 above.

## Recording results

Track per case: agent output matched expected? (Y/N), decision matched?
(Y/N), average run time, and score spread across repeats (should be 0 for a
scorer bug-free run — the LLM's classification might vary, but scorer.js's
math never should). Put this table in the top-level README and on a demo
slide — this is your answer to "how do we trust it," backed by numbers
instead of an argument.

**Target before code freeze (Phase 7):** every S1-S5 case, 3/3 repeats,
correct decision. V1-V7 are stretch — even 4-5 of the 7 built and passing is
a credible "we tested this" story; don't let variant-hunting eat into demo
prep time (Phase 7 go/no-go discipline applies here too).
