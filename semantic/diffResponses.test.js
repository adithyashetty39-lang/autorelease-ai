'use strict';
const assert = require('assert');
const { diffResponses, flatten } = require('./diffResponses.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const cap = (probes) => ({ probes });
const homeProbe = (banner) => ({
  id: 'home_amazon', method: 'GET', path: '/home?partner=amazon', status: 200,
  identity_tokens: ['amazon'], foreign_tokens: ['flipkart', 'amazon'],
  body: { partner: 'amazon', banner, currency: 'INR' },
});

console.log('\n--- diffResponses ---');

t('identical captures produce no divergences', () => {
  const c = cap([homeProbe('Amazon Big Billion Deals')]);
  const r = diffResponses(c, JSON.parse(JSON.stringify(c)));
  assert.strictEqual(r.divergence_count, 0, 'expected 0, got ' + r.divergence_count);
});

t('pure refactor (identical responses, different internals) finds nothing', () => {
  const base = cap([{ id: 'cart', status: 200, body: { total: 50.0, free_shipping: true } }]);
  const head = cap([{ id: 'cart', status: 200, body: { total: 50.0, free_shipping: true } }]);
  assert.strictEqual(diffResponses(base, head).divergence_count, 0);
});

t('additive field is reported but never high confidence', () => {
  const base = cap([{ id: 'cart', status: 200, body: { total: 50.0 } }]);
  const head = cap([{ id: 'cart', status: 200, body: { total: 50.0, tax: 9.0 } }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergence_count, 1);
  assert.strictEqual(r.divergences[0].kind, 'field_added');
  assert.strictEqual(r.high_confidence_count, 0, 'an additive change must not read as a regression');
});

t('banner swap is caught as a coherence break at high confidence', () => {
  const r = diffResponses(cap([homeProbe('Amazon Big Billion Deals')]),
                          cap([homeProbe('Flipkart Big Billion Deals')]));
  assert.strictEqual(r.coherence_break_count, 1, 'expected a coherence break');
  const d = r.divergences[0];
  assert.strictEqual(d.kind, 'coherence_break');
  assert.strictEqual(d.confidence, 'high');
  assert.ok(d.path === 'banner', 'should point at the banner leaf, got ' + d.path);
  assert.ok(d.detail.includes('flipkart'), 'should name the foreign value');
});

// This is the load-bearing test. A whole-body scan cannot catch the banner swap,
// because partner:"amazon" is still sitting in the response untouched. Only the
// banner LEAF broke its promise. If someone "simplifies" checkCoherence to scan
// the whole body, this test is what fails.
t('coherence is per-leaf, not whole-body', () => {
  const before = homeProbe('Amazon Big Billion Deals');
  const after = homeProbe('Flipkart Big Billion Deals');

  const wholeBodyStillMentionsIdentity = JSON.stringify(after.body).toLowerCase().includes('amazon');
  assert.ok(wholeBodyStillMentionsIdentity,
    'precondition: the swapped body must still contain "amazon" somewhere, or this test proves nothing');

  const r = diffResponses(cap([before]), cap([after]));
  assert.strictEqual(r.coherence_break_count, 1,
    'per-leaf check must still flag it even though the whole body mentions amazon');
  assert.strictEqual(r.divergences[0].path, 'banner');
});

t('unchanged sibling fields are not reported', () => {
  const r = diffResponses(cap([homeProbe('Amazon Big Billion Deals')]),
                          cap([homeProbe('Flipkart Big Billion Deals')]));
  assert.ok(!r.divergences.some((d) => d.path === 'partner'), 'partner did not change');
  assert.ok(!r.divergences.some((d) => d.path === 'currency'), 'currency did not change');
});

t('status change is high confidence', () => {
  const base = cap([{ id: 'cart', status: 200, body: {} }]);
  const head = cap([{ id: 'cart', status: 500, body: {} }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergences[0].kind, 'status_changed');
  assert.strictEqual(r.divergences[0].confidence, 'high');
});

t('removed field is high confidence (breaks clients)', () => {
  const base = cap([{ id: 'cart', status: 200, body: { total: 50.0, free_shipping: true } }]);
  const head = cap([{ id: 'cart', status: 200, body: { total: 50.0 } }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergences[0].kind, 'field_removed');
  assert.strictEqual(r.divergences[0].confidence, 'high');
});

t('numeric change with no identity token is value_changed, not a coherence break', () => {
  const base = cap([{ id: 'cart', status: 200, body: { total: 50.0 } }]);
  const head = cap([{ id: 'cart', status: 200, body: { total: 150.0 } }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergences[0].kind, 'value_changed');
  assert.strictEqual(r.coherence_break_count, 0, 'must not invent a coherence break');
});

t('nested and array values are compared by path', () => {
  const base = cap([{ id: 'x', status: 200, body: { items: [{ sku: 'a' }, { sku: 'b' }] } }]);
  const head = cap([{ id: 'x', status: 200, body: { items: [{ sku: 'a' }, { sku: 'ZZZ' }] } }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergence_count, 1);
  assert.strictEqual(r.divergences[0].path, 'items[1].sku');
});

t('probe missing from head is skipped, never reported as a divergence', () => {
  const base = cap([{ id: 'a', status: 200, body: {} }, { id: 'b', status: 200, body: {} }]);
  const head = cap([{ id: 'a', status: 200, body: {} }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergence_count, 0);
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(r.skipped[0].probe_id, 'b');
});

t('empty captures degrade without throwing', () => {
  assert.strictEqual(diffResponses(null, null).divergence_count, 0);
  assert.strictEqual(diffResponses({}, {}).divergence_count, 0);
  assert.strictEqual(diffResponses(cap([]), cap([])).probes_compared, 0);
});

t('flatten handles null, empty object and primitives', () => {
  assert.deepStrictEqual(flatten({ a: null }), { a: null });
  assert.deepStrictEqual(flatten({ a: {} }), { a: '{}' });
  assert.deepStrictEqual(flatten(5), { '(root)': 5 });
});

// Verified against the real capture from PR #13: base returned 404 for /home,
// head returned 200. Diffing a 404's error body against a real response used to
// emit "`detail` was returned before and is now gone", which is true and useless.
t('a newly added endpoint is additive, not a regression', () => {
  const base = cap([{ id: 'home', path: '/home', status: 404, body: { detail: 'Not Found' } }]);
  const head = cap([{ id: 'home', path: '/home', status: 200, body: { partner: 'amazon', banner: 'x' } }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergence_count, 1, 'should collapse to one finding, got ' + r.divergence_count);
  assert.strictEqual(r.divergences[0].kind, 'endpoint_added');
  assert.strictEqual(r.high_confidence_count, 0, 'adding an endpoint must not read as high severity');
  assert.ok(!r.divergences.some((d) => d.path === 'detail'),
    "must not report the 404 body's `detail` field as a removal");
});

t('a removed endpoint IS high confidence', () => {
  const base = cap([{ id: 'home', path: '/home', status: 200, body: { partner: 'amazon' } }]);
  const head = cap([{ id: 'home', path: '/home', status: 404, body: { detail: 'Not Found' } }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergences[0].kind, 'endpoint_removed');
  assert.strictEqual(r.divergences[0].confidence, 'high');
});

t('200 -> 500 is a status divergence, not endpoint removal', () => {
  const base = cap([{ id: 'x', path: '/x', status: 200, body: {} }]);
  const head = cap([{ id: 'x', path: '/x', status: 500, body: {} }]);
  const r = diffResponses(base, head);
  assert.strictEqual(r.divergences[0].kind, 'status_changed');
  assert.strictEqual(r.divergences[0].confidence, 'high');
});

// regression_candidate_count is what the Gate and the PR comment both read to
// answer "did this PR change behaviour". It exists so they cannot disagree.
t('purely additive changes have zero regression candidates', () => {
  const base = cap([{ id: 'home', path: '/home', status: 404, body: { detail: 'Not Found' } }]);
  const head = cap([{ id: 'home', path: '/home', status: 200, body: { partner: 'amazon' } }]);
  assert.strictEqual(diffResponses(base, head).regression_candidate_count, 0);

  const b2 = cap([{ id: 'c', status: 200, body: { total: 1 } }]);
  const h2 = cap([{ id: 'c', status: 200, body: { total: 1, tax: 2 } }]);
  assert.strictEqual(diffResponses(b2, h2).regression_candidate_count, 0);
});

t('a banner swap counts as a regression candidate', () => {
  const r = diffResponses(cap([homeProbe('Amazon Big Billion Deals')]),
                          cap([homeProbe('Flipkart Big Billion Deals')]));
  assert.strictEqual(r.regression_candidate_count, 1);
});

t('removals and status changes count as regression candidates', () => {
  const base = cap([{ id: 'x', path: '/x', status: 200, body: { a: 1 } }]);
  const head = cap([{ id: 'x', path: '/x', status: 404, body: { detail: 'gone' } }]);
  assert.strictEqual(diffResponses(base, head).regression_candidate_count, 1);
});

// ---- business-rule (invariant) diffing -------------------------------------
const inv = (probe, status, extra) => Object.assign({ key: 'rule@' + probe, id: 'rule', probe,
  description: 'total balances', rule: 'approx(body.total, body.a + body.b)', status }, extra || {});
const capInv = (invariants) => ({ probes: [], invariants });

t('a rule that held on base and is violated on head is a high-confidence regression', () => {
  const r = diffResponses(capInv([inv('q', 'holds')]), capInv([inv('q', 'violated', { observed: 'left = 1203.66, right = 1178.82' })]));
  assert.strictEqual(r.divergences[0].kind, 'invariant_violation');
  assert.strictEqual(r.divergences[0].confidence, 'high');
  assert.ok(r.divergences[0].detail.includes('1203.66'), 'must show the observed values');
  assert.strictEqual(r.regression_candidate_count, 1);
  assert.strictEqual(r.invariant_violation_count, 1);
});

t('a rule that can no longer be evaluated (field removed) counts as a violation', () => {
  const r = diffResponses(capInv([inv('q', 'holds')]), capInv([inv('q', 'error', { error: "response has no field 'total'" })]));
  assert.strictEqual(r.divergences[0].kind, 'invariant_violation');
});

// The pre-existing line: a rule already broken on base is not this PR's doing.
t('a rule already failing on base is reported but NOT a regression candidate', () => {
  const r = diffResponses(capInv([inv('q', 'violated')]), capInv([inv('q', 'violated')]));
  assert.strictEqual(r.divergences[0].kind, 'invariant_preexisting_violation');
  assert.strictEqual(r.regression_candidate_count, 0);
  assert.strictEqual(r.invariant_violation_count, 0);
});

t('a rule fixed by this PR is reported as a fix, not a regression', () => {
  const r = diffResponses(capInv([inv('q', 'violated')]), capInv([inv('q', 'holds')]));
  assert.strictEqual(r.divergences[0].kind, 'invariant_fixed');
  assert.strictEqual(r.regression_candidate_count, 0);
});

t('a new endpoint that breaks its rule on arrival is flagged at medium confidence', () => {
  const r = diffResponses(capInv([inv('q', 'error', { error: 'endpoint returned status 404' })]), capInv([inv('q', 'violated')]));
  assert.strictEqual(r.divergences[0].kind, 'invariant_violation_new');
  assert.strictEqual(r.divergences[0].confidence, 'medium');
  assert.strictEqual(r.regression_candidate_count, 1);
});

t('a new endpoint that satisfies its rules produces nothing', () => {
  const r = diffResponses(capInv([inv('q', 'error', { error: 'endpoint returned status 404' })]), capInv([inv('q', 'holds')]));
  assert.strictEqual(r.divergence_count, 0);
});

t('rules holding on both commits produce nothing', () => {
  const r = diffResponses(capInv([inv('q', 'holds')]), capInv([inv('q', 'holds')]));
  assert.strictEqual(r.divergence_count, 0);
  assert.strictEqual(r.invariant_checks, 1);
});

t('contract provenance is passed through from the head capture', () => {
  const head = Object.assign(capInv([]), { contract_source: 'base', contract_changed_in_pr: 'true' });
  const r = diffResponses(capInv([]), head);
  assert.strictEqual(r.contract_source, 'base');
  assert.strictEqual(r.contract_changed_in_pr, 'true');
});

t('divergences are ordered high confidence first', () => {
  const base = cap([{ id: 'x', status: 200, body: { keep: 1, drop: 2 } }]);
  const head = cap([{ id: 'x', status: 200, body: { keep: 9, added: 3 } }]);
  const r = diffResponses(base, head);
  const order = r.divergences.map((d) => d.confidence);
  assert.strictEqual(order[0], 'high', 'removed field should sort first, got ' + order.join(','));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
