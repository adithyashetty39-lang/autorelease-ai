// Executes the ACTUAL jsCode string embedded in the shipped tool JSON files
// (not a re-typed analog) against real demo-app file content, using a
// minimal stand-in for n8n's Code node execution context ($json, $input,
// $('Node Name')). This is the highest-confidence check available without
// a running n8n instance.
'use strict';
const fs = require('fs');
const path = require('path');

function extractJsCode(workflowFile, nodeName) {
  const wf = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`node "${nodeName}" not found in ${workflowFile}`);
  return node.parameters.jsCode;
}

function runCodeNode(jsCode, { triggerJson, items }) {
  // Minimal n8n expression-context stand-in: $('Node Name').first()/.all(),
  // $input.all(), $json. jsCode itself ends with `return [...]` (n8n "Run
  // Once for All Items" convention), so it's a valid function body as-is.
  const nodeOutputs = { 'When called as a tool': [{ json: triggerJson }] };
  function $(nodeName) {
    const data = nodeOutputs[nodeName];
    return { first: () => data[0], all: () => data };
  }
  const $input = { all: () => items };
  const $json = items.length ? items[0].json : {};
  const fn = new Function('$', '$input', '$json', jsCode);
  return fn($, $input, $json);
}

const demoRoot = path.join(__dirname, '..', '..', '..', 'stormbreakers-demo-shop', 'app');
const pyFiles = fs.readdirSync(demoRoot).filter((f) => f.endsWith('.py'));
const items = pyFiles.map((f) => ({ json: { path: `app/${f}`, data: fs.readFileSync(path.join(demoRoot, f), 'utf8') } }));

console.log('=== search_imports.json, shipped jsCode, package=yaml ===');
const importsCode = extractJsCode(path.join(__dirname, 'search_imports.json'), 'Search for import statements');
console.log(JSON.stringify(runCodeNode(importsCode, { triggerJson: { package: 'yaml', sha: 'test' }, items }), null, 2));

console.log('=== search_imports.json, shipped jsCode, package=PIL ===');
console.log(JSON.stringify(runCodeNode(importsCode, { triggerJson: { package: 'PIL', sha: 'test' }, items }), null, 2));

console.log('=== search_symbol_usage.json, shipped jsCode, symbols=[yaml.full_load, yaml.unsafe_load] ===');
const symbolsCode = extractJsCode(path.join(__dirname, 'search_symbol_usage.json'), 'Search for call sites');
console.log(JSON.stringify(runCodeNode(symbolsCode, { triggerJson: { symbols: ['yaml.full_load', 'yaml.unsafe_load'], sha: 'test' }, items }), null, 2));

console.log('=== search_symbol_usage.json, shipped jsCode, symbols=[PIL.ImageMath.eval] (expect 0 matches) ===');
console.log(JSON.stringify(runCodeNode(symbolsCode, { triggerJson: { symbols: ['PIL.ImageMath.eval'], sha: 'test' }, items }), null, 2));
