'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  computeDeductions,
  computeScore,
  bandForScore,
  applyGates,
  decisionFor,
  correlateFindings,
  scoreRun,
} = require('./scorer.js');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'scoring.json'), 'utf8')
);

/** Minimal-but-valid finding builder for tests -- only fields scorer.js reads. */
function finding(overrides) {
  return {
    id: 'F-1',
    agent: 'security',
    category: 'reachable_critical_cve',
    title: 'test finding',
    classification: 'reachable',
    confidence: 'high',
    evidence: [{ label: 'x', url: 'https://example.com' }],
    files: [],
    reasoning: 'test',
    ...overrides,
  };
}

test('clean run: no findings scores 100, approve, no gates', () => {
  const result = scoreRun([], config);
  assert.equal(result.score, 100);
  assert.equal(result.band, 'approve');
  assert.equal(result.decision, 'approve');
  assert.deepEqual(result.gates, []);
});

test('single flaky test: -5, still approve', () => {
  const result = scoreRun([finding({ id: 'F-1', category: 'flaky_test' })], config);
  assert.equal(result.score, 95);
  assert.equal(result.band, 'approve');
  assert.equal(result.decision, 'approve');
});

test('flaky_test cap: 4 flaky findings (would be -20) cap at -15 -> score 85, still approve (boundary)', () => {
  const findings = [1, 2, 3, 4].map((n) => finding({ id: `F-${n}`, category: 'flaky_test' }));
  const result = scoreRun(findings, config);
  const totalDeduction = result.deductions.reduce((s, d) => s + d.amount, 0);
  assert.equal(totalDeduction, 15, 'flaky_test cap is 15 in config/scoring.json');
  assert.equal(result.score, 85);
  assert.equal(result.band, 'approve', '85 is the approve/caveats boundary, inclusive of approve');
  // 4th finding should be the one that got capped to 0
  assert.equal(result.deductions[3].amount, 0);
  assert.equal(result.deductions[3].capped, true);
  assert.equal(result.deductions[0].capped, false);
});

test('S2-equivalent scenario: only a known flaky test + unreachable critical CVE -> approve/caveats, matches demo expectation', () => {
  const findings = [
    finding({ id: 'F-1', category: 'flaky_test', confidence: 'high' }),
    finding({ id: 'F-2', category: 'unreachable_critical_cve', confidence: 'high' }),
  ];
  const result = scoreRun(findings, config);
  assert.equal(result.score, 95);
  assert.ok(['approve', 'approve_with_caveats'].includes(result.decision));
});

test('reachable_critical_cve alone: -35 -> approve_with_caveats', () => {
  const result = scoreRun([finding({ category: 'reachable_critical_cve' })], config);
  assert.equal(result.score, 65);
  assert.equal(result.band, 'approve_with_caveats');
});

test('S3-equivalent scenario: reachable critical CVE + coverage drop -> block (the demo "GitHub green, we block it" case)', () => {
  const findings = [
    finding({ id: 'F-1', category: 'reachable_critical_cve' }),
    finding({ id: 'F-2', category: 'coverage_drop' }),
  ];
  const result = scoreRun(findings, config);
  assert.equal(result.score, 55); // 100 - 35 - 10
  assert.equal(result.band, 'block');
  assert.equal(result.decision, 'block');
});

test('new_regression + reachable_critical_cve: 100 - 40 - 35 = 25 -> block', () => {
  const findings = [
    finding({ id: 'F-1', category: 'new_regression' }),
    finding({ id: 'F-2', category: 'reachable_critical_cve' }),
  ];
  const result = scoreRun(findings, config);
  assert.equal(result.score, 25);
  assert.equal(result.decision, 'block');
});

test('new_regression cap: 2 regressions (would be -80) cap at -60 -> score 40', () => {
  const findings = [
    finding({ id: 'F-1', category: 'new_regression' }),
    finding({ id: 'F-2', category: 'new_regression' }),
  ];
  const result = scoreRun(findings, config);
  assert.equal(result.deductions[0].amount, 40);
  assert.equal(result.deductions[0].capped, false);
  assert.equal(result.deductions[1].amount, 20); // only 20 left in the 60 budget
  assert.equal(result.deductions[1].capped, true);
  assert.equal(result.score, 40);
});

test('score never goes below min_score (0) even with huge deductions', () => {
  const findings = [
    finding({ id: 'F-1', category: 'new_regression' }),
    finding({ id: 'F-2', category: 'new_regression' }),
    finding({ id: 'F-3', category: 'reachable_critical_cve' }),
    finding({ id: 'F-4', category: 'reachable_critical_cve' }),
    finding({ id: 'F-5', category: 'reachable_critical_cve' }),
  ];
  const result = scoreRun(findings, config);
  assert.equal(result.score, 0);
  assert.equal(result.band, 'block');
});

test('secret_detected: BLOCK gate wins even when the computed band is approve', () => {
  const findings = [finding({ id: 'F-1', category: 'secret_detected', confidence: 'high' })];
  const result = scoreRun(findings, config);
  assert.equal(result.band, 'approve', 'secret_detected has 0 score deduction by design');
  assert.ok(result.gates.includes('BLOCK'));
  assert.equal(result.decision, 'block', 'decision must be block regardless of band');
});

test('low confidence on a high-weight finding forces MANUAL_REVIEW even in the approve band', () => {
  const findings = [
    finding({ id: 'F-1', category: 'reachable_critical_cve', confidence: 'low' }),
  ];
  const result = scoreRun(findings, config);
  assert.ok(result.gates.includes('MANUAL_REVIEW'));
  assert.equal(result.decision, 'manual_review');
});

test('low confidence on a low-weight finding does NOT trigger manual review', () => {
  const findings = [finding({ id: 'F-1', category: 'flaky_test', confidence: 'low' })];
  const result = scoreRun(findings, config);
  assert.deepEqual(result.gates, []);
  assert.equal(result.decision, 'approve');
});

test('decisionFor: BLOCK takes precedence over MANUAL_REVIEW when both gates fire', () => {
  assert.equal(decisionFor('approve', ['MANUAL_REVIEW', 'BLOCK']), 'block');
  assert.equal(decisionFor('approve', ['BLOCK']), 'block');
  assert.equal(decisionFor('approve', ['MANUAL_REVIEW']), 'manual_review');
  assert.equal(decisionFor('block', []), 'block');
});

test('bandForScore boundaries match PRD table exactly', () => {
  assert.equal(bandForScore(100, config), 'approve');
  assert.equal(bandForScore(85, config), 'approve');
  assert.equal(bandForScore(84, config), 'approve_with_caveats');
  assert.equal(bandForScore(60, config), 'approve_with_caveats');
  assert.equal(bandForScore(59, config), 'block');
  assert.equal(bandForScore(0, config), 'block');
});

test('unknown category throws instead of silently scoring as 0', () => {
  assert.throws(() => {
    computeDeductions([finding({ category: 'not_a_real_category' })], config);
  }, /Unknown finding category/);
});

test('correlateFindings links findings that share a file', () => {
  const findings = [
    finding({ id: 'F-1', category: 'new_regression', files: ['app/config.py'] }),
    finding({ id: 'F-2', category: 'reachable_critical_cve', files: ['app/config.py'] }),
    finding({ id: 'F-3', category: 'flaky_test', files: ['tests/test_flaky.py'] }),
  ];
  const result = correlateFindings(findings);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].finding_ids.sort(), ['F-1', 'F-2']);
  assert.deepEqual(result[0].shared_files, ['app/config.py']);
});

test('correlateFindings returns empty when no files overlap', () => {
  const findings = [
    finding({ id: 'F-1', files: ['a.py'] }),
    finding({ id: 'F-2', files: ['b.py'] }),
  ];
  assert.deepEqual(correlateFindings(findings), []);
});

test('applyGates de-duplicates repeated gates across findings', () => {
  const findings = [
    finding({ id: 'F-1', category: 'secret_detected' }),
    finding({ id: 'F-2', category: 'secret_detected' }),
  ];
  const gates = applyGates(findings, config);
  assert.deepEqual(gates, ['BLOCK']);
});

test('computeScore clamps to config.max_score even on empty deductions past 100 starting_score', () => {
  assert.equal(computeScore([], config), 100);
});
