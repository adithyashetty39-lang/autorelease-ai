// Executes the ACTUAL jsCode string embedded in the shipped tool JSON files
// (not a re-typed analog) against real demo-app file content, using a
// minimal stand-in for n8n's Code node execution context ($json, $input,
// $('Node Name')). This is the highest-confidence check available without
// a running n8n instance.
//
// Usage: clone the demo repo next to this one, then
//   node workflows/tools/verify_tools.js
// (looks for ../stormbreakers-demo, falling back to ../stormbreakers-demo-shop)
'use strict';
const fs = require('fs');
const path = require('path');

function extractJsCode(workflowFile, nodeName) {
  const wf = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`node "${nodeName}" not found in ${workflowFile}`);
  return node.parameters.jsCode;
}

// The tool workflows' trigger node is named differently depending on how the
// tool is invoked, and the search nodes read file paths back from the node that
// listed the files (the HTTP fetch replaces each item's json with the file body).
// The stand-in answers every name the shipped code may ask for.
function runCodeNode(jsCode, { triggerJson, items }) {
  const trigger = [{ json: triggerJson }];
  const nodeOutputs = {
    'When called as a tool': trigger,
    'When Executed by Another Workflow': trigger,
    'Filter .py files': items.map((i) => ({ json: { path: i.json.path } })),
  };
  function $(nodeName) {
    const data = nodeOutputs[nodeName];
    if (!data) throw new Error(`verify_tools stand-in has no output for node "${nodeName}"`);
    return { first: () => data[0], all: () => data };
  }
  const $input = { all: () => items };
  const $json = items.length ? items[0].json : {};
  const fn = new Function('$', '$input', '$json', jsCode);
  return fn($, $input, $json);
}

const candidates = ['stormbreakers-demo', 'stormbreakers-demo-shop']
  .map((name) => path.join(__dirname, '..', '..', '..', name, 'app'));
const demoRoot = candidates.find((p) => fs.existsSync(p));
if (!demoRoot) {
  console.error('Demo app not found. Clone https://github.com/adithyashetty39-lang/stormbreakers-demo next to this repo.');
  process.exit(2);
}
const pyFiles = fs.readdirSync(demoRoot).filter((f) => f.endsWith('.py'));
const items = pyFiles.map((f) => ({ json: { path: `app/${f}`, data: fs.readFileSync(path.join(demoRoot, f), 'utf8') } }));

let failures = 0;
function check(label, result, predicate, expectation) {
  const ok = predicate(result[0].json);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -- expected ${expectation}`);
  console.log('     ' + JSON.stringify(result[0].json));
}

const importsCode = extractJsCode(path.join(__dirname, 'search_imports.json'), 'Search for import statements');
const symbolsCode = extractJsCode(path.join(__dirname, 'search_symbol_usage.json'), 'Search for call sites');
const has = (j, file, field, text) => (j.matches || []).some((m) => m.file === file && String(m[field]).includes(text));

check('search_imports package=yaml', runCodeNode(importsCode, { triggerJson: { package: 'yaml', sha: 'test' }, items }),
  (j) => has(j, 'app/config.py', 'statement', 'import yaml'), 'an import in app/config.py');
check('search_imports package=PIL', runCodeNode(importsCode, { triggerJson: { package: 'PIL', sha: 'test' }, items }),
  (j) => has(j, 'app/image_utils.py', 'statement', 'PIL'), 'an import in app/image_utils.py');
check('search_symbol_usage yaml.full_load/unsafe_load', runCodeNode(symbolsCode, { triggerJson: { symbols: 'yaml.full_load,yaml.unsafe_load', sha: 'test' }, items }),
  (j) => has(j, 'app/config.py', 'snippet', 'yaml.full_load('), 'the real call site in app/config.py');
check('search_symbol_usage PIL.ImageMath.eval', runCodeNode(symbolsCode, { triggerJson: { symbols: 'PIL.ImageMath.eval', sha: 'test' }, items }),
  (j) => (j.matches || []).length === 0, 'no call sites (vulnerable function never called)');

console.log(failures ? `\n${failures} check(s) failed` : '\nall tool checks passed');
process.exit(failures ? 1 : 0);
