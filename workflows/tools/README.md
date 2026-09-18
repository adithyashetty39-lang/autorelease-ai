# Tool sub-workflows

3 of the 6 tools have real, importable, **verified** JSON here:
`get_advisory.json`, `search_imports.json`, `search_symbol_usage.json`.
"Verified" means `node workflows/tools/verify_tools.js` actually executes
each file's embedded Code-node `jsCode` — the exact bytes that will run
inside n8n — against the real `stormbreakers-demo-shop` source files and
checks the output. Run it yourself any time you touch these files:

```bash
node workflows/tools/verify_tools.js
```

That run is also how a real bug got caught before this ever touched n8n:
the first version of the symbol-usage regex matched a mention of
`yaml.full_load()` inside `config.py`'s own module *docstring*, not just the
real call site. Both files now skip docstrings/comments — see the header
comment in `search_symbol_usage.json` for the fix.

**Before wiring these into WF-1:** replace every `OWNER/REPO` placeholder
with your actual demo repo path, and create a `GitHub PAT` Header Auth
credential in n8n (`Authorization: Bearer <token>`) for `search_imports`
and `search_symbol_usage` (their `Get repo tree` node needs it;
`get_advisory` needs no auth — OSV.dev and raw.githubusercontent.com on a
public repo are both open).

The other 3 tools — `get_test_history`, `get_job_logs`, `compare_commits` —
are specified in `../BUILD_GUIDE.md` instead of shipped as JSON here: they
depend on the `test_history`/`coverage_history` Data Table schema you set
up in WF-0, which only exists once you've built that workflow, so a
hand-typed JSON file referencing table names that don't exist yet would be
more confusing than useful. Build those 3 directly from the guide — same
Trigger → HTTP/DB lookup → Code shape as the three here, so it's a quick
pattern to repeat once you've built one.
