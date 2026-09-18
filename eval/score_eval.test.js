'use strict';

/**
 * Automates the ONE part of eval/cases.json that doesn't need a live LLM:
 * given the hand-derived `expected_findings` for each case (what a
 * correctly-functioning agent pair SHOULD produce), does scorer.js turn
 * those into the documented `expected` score/band/decision/gates?
 *
 * This does NOT test whether the agents actually produce those findings --
 * that requires a live n8n + Gemini run against the real evidence bundles,
 * see eval/run_eval.md. What it does test: the scoring policy in
 * config/scoring.json + scoring/scorer.js is self-consistent with every
 * documented scenario in the plan, including the two PRD worked examples
 * and all 5 demo scenarios (S1-S5) plus the 7 variants (V1-V7).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scoreRun } = require('../scoring/scorer.js');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'scoring.json'), 'utf8'));
const casesFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));

/** Pad a minimal expected_findings entry with whatever scorer.js reads. */
function toScorerFinding(partial, index) {
  return {
    id: partial.id || `F-${index + 1}`,
    category: partial.category,
    confidence: partial.confidence || 'high',
    files: partial.files || [],
  };
}

for (const c of casesFile.cases) {
  test(`eval case ${c.id}: ${c.name}`, () => {
    const findings = c.expected_findings.map(toScorerFinding);
    const result = scoreRun(findings, config);

    for (const [key, expectedValue] of Object.entries(c.expected)) {
      if (key === 'gates') {
        assert.deepEqual(
          [...result.gates].sort(),
          [...expectedValue].sort(),
          `${c.id}: gates mismatch`
        );
      } else {
        assert.equal(result[key], expectedValue, `${c.id}: ${key} mismatch (got ${result[key]}, expected ${expectedValue})`);
      }
    }
  });
}

test('every case in cases.json has at least an id, name, expected_findings, and expected', () => {
  for (const c of casesFile.cases) {
    assert.ok(c.id, 'case missing id');
    assert.ok(c.name, `${c.id}: missing name`);
    assert.ok(Array.isArray(c.expected_findings), `${c.id}: expected_findings must be an array (can be empty)`);
    assert.ok(c.expected && typeof c.expected === 'object', `${c.id}: missing expected`);
  }
});

test('cases.json has 12 scenarios total, matching the plan\'s eval set size', () => {
  assert.equal(casesFile.cases.length, 12);
});
