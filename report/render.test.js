'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderReport, escapeHtml } = require('./render.js');

function sampleRunRecord(overrides) {
  return {
    run_id: 'run-1',
    repo: 'stormbreakers/stormbreakers-demo-shop',
    pr: 42,
    sha: 'abcdef1234567890',
    score: 55,
    band: 'block',
    decision: 'block',
    gates: [],
    summary: 'This PR introduces a reachable critical CVE and drops coverage.',
    findings: [
      {
        id: 'F-1',
        agent: 'security',
        category: 'reachable_critical_cve',
        title: 'PyYAML CVE-2020-14343 reachable via yaml.full_load',
        classification: 'reachable',
        confidence: 'high',
        evidence: [{ label: 'app/config.py:29', url: 'https://github.com/x/y/blob/abc/app/config.py#L29' }],
        files: ['app/config.py'],
        reasoning: 'yaml.full_load is called directly on untrusted input.',
      },
      {
        id: 'F-2',
        agent: 'build_test',
        category: 'coverage_drop',
        title: 'Coverage dropped 7.2%',
        classification: 'coverage_drop',
        confidence: 'high',
        evidence: [{ label: 'coverage.xml', url: 'https://github.com/x/y/actions/runs/1' }],
        files: ['app/config.py'],
        reasoning: 'Head coverage 78.1% vs base 85.3%.',
      },
    ],
    deductions: [
      { finding_id: 'F-1', category: 'reachable_critical_cve', amount: 35, capped: false },
      { finding_id: 'F-2', category: 'coverage_drop', amount: 10, capped: false },
    ],
    correlations: [
      { finding_ids: ['F-1', 'F-2'], shared_files: ['app/config.py'], note: 'F-1 and F-2 both touch app/config.py.' },
    ],
    trace: [
      {
        agent: 'security',
        step: 1,
        tool: 'search_imports',
        input_summary: 'package=pyyaml',
        output_summary: 'imported in app/config.py:9',
      },
      {
        agent: 'security',
        step: 2,
        tool: 'search_symbol_usage',
        input_summary: 'symbols=[yaml.full_load]',
        output_summary: 'call site found at app/config.py:29',
        decision: 'classified reachable, confidence high',
      },
    ],
    approver: null,
    approval_comment: null,
    decided_at: null,
    ...overrides,
  };
}

test('escapeHtml neutralizes script tags and quotes', () => {
  const out = escapeHtml('<script>alert(1)</script> "quoted" \'single\'');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('&quot;'));
  assert.ok(out.includes('&#39;'));
});

test('escapeHtml handles null/undefined without throwing', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('renderReport includes score, decision, and repo/PR', () => {
  const html = renderReport(sampleRunRecord());
  assert.ok(html.includes('55'));
  assert.ok(html.includes('BLOCK'));
  assert.ok(html.includes('stormbreakers/stormbreakers-demo-shop'));
  assert.ok(html.includes('#42'));
});

test('renderReport links evidence URLs verbatim', () => {
  const html = renderReport(sampleRunRecord());
  assert.ok(html.includes('https://github.com/x/y/blob/abc/app/config.py#L29'));
});

test('renderReport shows the agent trace with tool names', () => {
  const html = renderReport(sampleRunRecord());
  assert.ok(html.includes('search_imports'));
  assert.ok(html.includes('search_symbol_usage'));
  assert.ok(html.includes('classified reachable, confidence high'));
});

test('renderReport shows correlations when findings share a file', () => {
  const html = renderReport(sampleRunRecord());
  assert.ok(html.includes('Linked findings'));
  assert.ok(html.includes('app/config.py'));
});

test('renderReport shows Approve/Reject forms when undecided', () => {
  const html = renderReport(sampleRunRecord(), 'https://n8n.example/webhook-waiting/run-1');
  assert.ok(html.includes('btn-approve'));
  assert.ok(html.includes('btn-reject'));
  assert.ok(html.includes('https://n8n.example/webhook-waiting/run-1'));
});

test('renderReport shows a decided banner instead of buttons once approver is set', () => {
  const html = renderReport(
    sampleRunRecord({ approver: 'gowtham', decided_at: '2026-09-15T10:00:00Z', approval_comment: 'looks fine after fix' })
  );
  // .btn-approve the CSS rule is always present in <style>; what must be
  // absent is the actual <button> element and its <form>.
  assert.ok(!html.includes('<button'));
  assert.ok(!html.includes('<form'));
  assert.ok(html.includes('gowtham'));
  assert.ok(html.includes('looks fine after fix'));
});

test('renderReport escapes a hostile finding title instead of injecting it raw', () => {
  const record = sampleRunRecord();
  record.findings[0].title = '<img src=x onerror=alert(1)>';
  const html = renderReport(record);
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(html.includes('&lt;img'));
});

test('renderReport handles an empty findings/deductions run (clean approve) without crashing', () => {
  const html = renderReport(
    sampleRunRecord({ score: 100, band: 'approve', decision: 'approve', findings: [], deductions: [], correlations: [], trace: [] })
  );
  assert.ok(html.includes('100'));
  assert.ok(html.includes('No deductions'));
});

test('renderReport shows gate badges when gates fired', () => {
  const html = renderReport(sampleRunRecord({ gates: ['BLOCK'] }));
  assert.ok(html.includes('BLOCK'));
  assert.ok(html.includes('badge-gate'));
});
