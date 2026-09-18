'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateFinding, validateFindings, syntheticLowConfidenceFinding } = require('./validateFinding.js');

function goodFinding(overrides) {
  return {
    id: 'F-1',
    agent: 'security',
    category: 'reachable_critical_cve',
    title: 'PyYAML CVE reachable',
    classification: 'reachable',
    confidence: 'high',
    evidence: [{ label: 'config.py:12', url: 'https://github.com/x/y/blob/sha/app/config.py#L12' }],
    files: ['app/config.py'],
    reasoning: 'yaml.full_load called directly on untrusted input',
    ...overrides,
  };
}

test('accepts a well-formed finding with no provenance checking', () => {
  const result = validateFinding(goodFinding(), null);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sanitized.id, 'F-1');
});

test('rejects a finding missing a required field', () => {
  const f = goodFinding();
  delete f.reasoning;
  const result = validateFinding(f, null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('reasoning')));
});

test('rejects an unknown category', () => {
  const result = validateFinding(goodFinding({ category: 'made_up_category' }), null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('category')));
});

test('rejects a bad id format', () => {
  const result = validateFinding(goodFinding({ id: 'finding-1' }), null);
  assert.equal(result.valid, false);
});

test('rejects empty evidence array', () => {
  const result = validateFinding(goodFinding({ evidence: [] }), null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('evidence')));
});

test('provenance check: keeps evidence URLs that appeared in tool outputs', () => {
  const known = new Set(['https://github.com/x/y/blob/sha/app/config.py#L12']);
  const result = validateFinding(goodFinding(), known);
  assert.equal(result.valid, true);
  assert.equal(result.sanitized.evidence.length, 1);
  assert.equal(result.droppedFabricatedEvidenceCount, 0);
});

test('provenance check: drops a fabricated evidence URL not seen in tool outputs', () => {
  const known = new Set(['https://github.com/some/other/real-url']);
  const result = validateFinding(goodFinding(), known);
  // the only evidence item is fabricated -> nothing left -> whole finding rejected
  assert.equal(result.valid, false);
  assert.ok(result.errors[0].includes('fabricated'));
});

test('provenance check: drops only the fabricated URL, keeps a real one', () => {
  const known = new Set(['https://real.example/one']);
  const f = goodFinding({
    evidence: [
      { label: 'real', url: 'https://real.example/one' },
      { label: 'made up', url: 'https://fabricated.example/two' },
    ],
  });
  const result = validateFinding(f, known);
  assert.equal(result.valid, true);
  assert.equal(result.sanitized.evidence.length, 1);
  assert.equal(result.sanitized.evidence[0].url, 'https://real.example/one');
  assert.equal(result.droppedFabricatedEvidenceCount, 1);
});

test('validateFindings splits a mixed batch into valid/rejected', () => {
  const findings = [goodFinding({ id: 'F-1' }), goodFinding({ id: 'F-2', category: 'nonsense' })];
  const { valid, rejected } = validateFindings(findings, null);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].finding.id, 'F-2');
});

test('syntheticLowConfidenceFinding always has confidence low and a high-weight category', () => {
  const secF = syntheticLowConfidenceFinding('security', 'agent timed out after 3 retries');
  const buildF = syntheticLowConfidenceFinding('build_test', 'schema validation failed twice');
  assert.equal(secF.confidence, 'low');
  assert.equal(buildF.confidence, 'low');
  // must itself pass shape validation so it flows cleanly into the scorer
  assert.equal(validateFinding(secF, null).valid, true);
  assert.equal(validateFinding(buildF, null).valid, true);
});
