'use strict';
// Semantic regression detector.
//
// Premise: a green test suite only asserts what somebody thought to assert.
// tests/test_main.py checks status 200 and that a key exists; it never checks
// WHICH value came back. So a swap of two correct-looking values ships green.
// This compares the actual HTTP responses of base vs head and reports where
// behaviour diverged.
//
// Same trust split the Deterministic Validation Gate already uses: this file
// establishes *that* behaviour changed and whether the change is self-
// contradictory. It never decides whether the change was intended -- that
// judgement is the agent's, and the agent only ever sees divergences this
// file actually found.

// Flattens a JSON body to leaf paths so a change can be pointed at precisely
// ("home_banner.banner") instead of "the body changed".
function flatten(value, prefix, out) {
  out = out || {};
  prefix = prefix || '';
  if (value === null || typeof value !== 'object') {
    out[prefix || '(root)'] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, prefix + '[' + i + ']', out));
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) out[prefix || '(root)'] = '{}';
  keys.forEach((k) => flatten(value[k], prefix ? prefix + '.' + k : k, out));
  return out;
}

// The coherence check, and the reason the banner case is detectable at all.
//
// It runs PER CHANGED LEAF, not across the whole body. After a banner swap the
// response still contains partner:"amazon" untouched, so searching the whole
// body for "amazon" finds nothing wrong. Only the banner leaf broke its own
// promise: it used to name the requested partner and now names a different one.
//
// Do not "simplify" this to a whole-body scan -- see the test named
// coherence is per-leaf, not whole-body.
function checkCoherence(probe, path, oldValue, newValue) {
  const tokens = probe.identity_tokens || [];
  if (!tokens.length) return null;
  const oldStr = String(oldValue == null ? '' : oldValue).toLowerCase();
  const newStr = String(newValue == null ? '' : newValue).toLowerCase();

  for (const raw of tokens) {
    const token = String(raw).toLowerCase();
    if (!token) continue;
    // The leaf used to reference this probe's own identity and no longer does.
    if (oldStr.includes(token) && !newStr.includes(token)) {
      const foreign = (probe.foreign_tokens || [])
        .map((t) => String(t).toLowerCase())
        .find((t) => t && t !== token && newStr.includes(t));
      return {
        kind: 'coherence_break',
        detail: '`' + path + '` identified `' + token + '` before this change and no longer does' +
          (foreign ? ', it now references `' + foreign + '` instead' : '') +
          '. The request still asks for `' + token + '`, so this value now contradicts the request that produced it.',
        confidence: foreign ? 'high' : 'medium',
      };
    }
  }
  return null;
}

const isMissing = (s) => s === 404 || s === 405;
const isOk = (s) => typeof s === 'number' && s >= 200 && s < 300;

function diffProbe(baseProbe, headProbe) {
  const divergences = [];
  const id = baseProbe.id;

  // An endpoint that did not exist before is new capability, not a regression.
  // Diffing its body against a 404's error body is meaningless and produces
  // nonsense like "`detail` was returned before and is now gone" -- verified
  // against the real capture from PR #13. Report the addition and stop.
  if (isMissing(baseProbe.status) && isOk(headProbe.status)) {
    return [{
      probe_id: id, path: '(endpoint)', kind: 'endpoint_added',
      before: baseProbe.status, after: headProbe.status,
      detail: '`' + (baseProbe.path || id) + '` did not exist before this change (' + baseProbe.status +
        ') and now responds ' + headProbe.status + '. New capability, not a regression.',
      confidence: 'low',
    }];
  }

  // The reverse genuinely breaks callers.
  if (isOk(baseProbe.status) && isMissing(headProbe.status)) {
    return [{
      probe_id: id, path: '(endpoint)', kind: 'endpoint_removed',
      before: baseProbe.status, after: headProbe.status,
      detail: '`' + (baseProbe.path || id) + '` responded ' + baseProbe.status +
        ' before this change and now returns ' + headProbe.status + '. Any caller depending on it breaks.',
      confidence: 'high',
    }];
  }

  if (baseProbe.status !== headProbe.status) {
    divergences.push({
      probe_id: id, path: '(status)', kind: 'status_changed',
      before: baseProbe.status, after: headProbe.status,
      detail: 'HTTP status changed from ' + baseProbe.status + ' to ' + headProbe.status + '.',
      confidence: 'high',
    });
  }

  const a = flatten(baseProbe.body);
  const b = flatten(headProbe.body);
  const paths = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();

  for (const p of paths) {
    const inA = Object.prototype.hasOwnProperty.call(a, p);
    const inB = Object.prototype.hasOwnProperty.call(b, p);

    // A field appearing is additive -- new capability, not a regression.
    // Reported at low confidence so the agent can see it and usually ignore it.
    if (!inA && inB) {
      divergences.push({ probe_id: id, path: p, kind: 'field_added', before: undefined, after: b[p],
        detail: '`' + p + '` is new in this change.', confidence: 'low' });
      continue;
    }
    if (inA && !inB) {
      divergences.push({ probe_id: id, path: p, kind: 'field_removed', before: a[p], after: undefined,
        detail: '`' + p + '` was returned before this change and is now gone. Any client reading it breaks.',
        confidence: 'high' });
      continue;
    }
    if (a[p] === b[p]) continue;

    const coherence = checkCoherence(baseProbe, p, a[p], b[p]);
    divergences.push({
      probe_id: id, path: p, kind: coherence ? coherence.kind : 'value_changed',
      before: a[p], after: b[p],
      detail: coherence ? coherence.detail : '`' + p + '` changed from `' + a[p] + '` to `' + b[p] + '`.',
      confidence: coherence ? coherence.confidence : 'low',
    });
  }

  return divergences;
}

// Business-rule (invariant) results, evaluated in CI by tools/invariants.py on
// both commits. This is what makes a regression provable without a test: a
// changed number alone might be intended, but a rule from the BASE contract
// that held before and fails now is broken behaviour, whatever the diff was.
//
// A rule already failing on base is reported but NOT pinned on this PR -- the
// same pre-existing vs introduced line the scope check draws for CVEs.
const newEndpointError = (r) => r && r.status === 'error' && /status 40[45]\b/.test(String(r.error || ''));

function diffInvariants(baseCapture, headCapture) {
  const baseByKey = {};
  ((baseCapture && baseCapture.invariants) || []).forEach((r) => { baseByKey[r.key] = r; });
  const out = [];

  for (const h of ((headCapture && headCapture.invariants) || [])) {
    const b = baseByKey[h.key];
    const baseHolds = !!b && b.status === 'holds';
    const baseNew = !b || newEndpointError(b);
    const headBroken = h.status === 'violated' || h.status === 'error';
    const rule = '"' + (h.description || h.id) + '"';
    const where = '`' + h.probe + '`';
    const evidence = h.observed ? ' Observed: ' + h.observed + '.'
      : (h.error ? ' It could not be evaluated: ' + h.error + '.' : '');
    const base = { probe_id: h.probe, path: '(rule) ' + h.id, rule: h.rule, before: b ? b.status : null, after: h.status };

    if (baseHolds && headBroken) {
      out.push(Object.assign(base, {
        kind: 'invariant_violation', confidence: 'high',
        detail: 'Business rule ' + rule + ' held before this change and ' +
          (h.status === 'violated' ? 'is now violated' : 'can no longer be evaluated') + ' on ' + where + '.' + evidence,
      }));
    } else if (baseNew && headBroken) {
      out.push(Object.assign(base, {
        kind: 'invariant_violation_new', confidence: 'medium',
        detail: 'Business rule ' + rule + ' fails on ' + where + ', which has no baseline on the base commit (new endpoint or new rule).' + evidence,
      }));
    } else if (b && !baseHolds && !baseNew && headBroken) {
      out.push(Object.assign(base, {
        kind: 'invariant_preexisting_violation', confidence: 'low',
        detail: 'Business rule ' + rule + ' was already failing on ' + where + ' before this change; not introduced by this PR.' + evidence,
      }));
    } else if (b && !baseHolds && !baseNew && h.status === 'holds') {
      out.push(Object.assign(base, {
        kind: 'invariant_fixed', confidence: 'low',
        detail: 'Business rule ' + rule + ' was failing on ' + where + ' before this change and now holds.',
      }));
    }
  }
  return out;
}

function diffResponses(baseCapture, headCapture) {
  const baseProbes = (baseCapture && baseCapture.probes) || [];
  const headProbes = (headCapture && headCapture.probes) || [];
  const byId = {};
  headProbes.forEach((p) => { byId[p.id] = p; });

  const divergences = [];
  const skipped = [];

  for (const bp of baseProbes) {
    const hp = byId[bp.id];
    if (!hp) { skipped.push({ probe_id: bp.id, reason: 'probe missing from head capture' }); continue; }
    divergences.push(...diffProbe(bp, hp));
  }
  for (const hp of headProbes) {
    if (!baseProbes.some((bp) => bp.id === hp.id)) skipped.push({ probe_id: hp.id, reason: 'probe missing from base capture' });
  }

  divergences.push(...diffInvariants(baseCapture, headCapture));

  const rank = { high: 0, medium: 1, low: 2 };
  divergences.sort((x, y) => (rank[x.confidence] ?? 3) - (rank[y.confidence] ?? 3));

  // One number, one meaning: "did this PR change behaviour in a way that could
  // be a regression". Purely additive changes do not count. Every consumer
  // (the Gate's rules, the PR comment's scope line) reads THIS field rather
  // than recombining coherence/high counts on its own -- two consumers deriving
  // the same idea differently is how a report ends up contradicting itself.
  // Not regressions: additive changes, fixes, and rules that were already
  // broken before this PR.
  const ADDITIVE = ['endpoint_added', 'field_added', 'invariant_fixed', 'invariant_preexisting_violation'];
  const regressionCandidates = divergences.filter((d) => ADDITIVE.indexOf(d.kind) === -1);

  return {
    available: true,
    probes_compared: baseProbes.filter((bp) => byId[bp.id]).length,
    divergence_count: divergences.length,
    high_confidence_count: divergences.filter((d) => d.confidence === 'high').length,
    coherence_break_count: divergences.filter((d) => d.kind === 'coherence_break').length,
    regression_candidate_count: regressionCandidates.length,
    invariant_checks: ((headCapture && headCapture.invariants) || []).length,
    invariant_violation_count: divergences.filter((d) => d.kind === 'invariant_violation' || d.kind === 'invariant_violation_new').length,
    contract_source: (headCapture && headCapture.contract_source) || null,
    contract_changed_in_pr: (headCapture && headCapture.contract_changed_in_pr) || null,
    invariant_error: (headCapture && headCapture.invariant_error) || null,
    divergences,
    skipped,
  };
}

module.exports = { diffResponses, diffProbe, diffInvariants, flatten, checkCoherence };
