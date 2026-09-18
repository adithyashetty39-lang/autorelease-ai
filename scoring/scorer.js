/**
 * Deterministic scorer -- the Release Manager's scoring formula.
 *
 * PRD section 4, "Critical implementation rule": the LLM's job is to
 * CLASSIFY evidence (assign a category + confidence to each Finding).
 * Everything below is plain arithmetic over that structured output. No LLM
 * call happens in this file, and none should ever be added here -- that is
 * the whole answer to "how do you stop hallucinated scores."
 *
 * Usage in n8n: this file is unit-tested standalone (see scorer.test.js,
 * `npm test`) so the team can trust the logic before it ever touches n8n.
 * To use it in an n8n Code node, paste the function bodies in directly (n8n
 * Code nodes run an inline snippet, not a module import) -- keep this file
 * as the source of truth and copy from it, don't hand-edit a divergent copy
 * inside the workflow.
 *
 * Reads weights/caps/bands from config/scoring.json (PRD 6.2: policy is
 * externalized, never hardcoded here).
 */

'use strict';

/**
 * @param {Array<object>} findings - Finding objects (see schemas/finding.schema.json)
 * @param {object} config - parsed config/scoring.json
 * @returns {{finding_id: string, category: string, amount: number, capped: boolean}[]}
 */
function computeDeductions(findings, config) {
  const runningByCategory = {};
  const deductions = [];

  for (const finding of findings) {
    const categoryConfig = config.categories[finding.category];
    if (!categoryConfig) {
      throw new Error(
        `Unknown finding category "${finding.category}" (finding ${finding.id}) -- ` +
          'add it to config/scoring.json before scoring, or the agent emitted a category outside the schema enum.'
      );
    }

    const perFindingDeduction = categoryConfig.deduction || 0;
    const cap = categoryConfig.cap; // null/undefined = uncapped
    const priorTotal = runningByCategory[finding.category] || 0;

    let amount;
    let capped = false;
    if (cap === null || cap === undefined) {
      amount = perFindingDeduction;
    } else {
      const remainingBudget = Math.max(0, cap - priorTotal);
      amount = Math.min(perFindingDeduction, remainingBudget);
      capped = amount < perFindingDeduction;
    }

    runningByCategory[finding.category] = priorTotal + amount;
    deductions.push({
      finding_id: finding.id,
      category: finding.category,
      amount,
      capped,
    });
  }

  return deductions;
}

/**
 * @param {Array<{amount:number}>} deductions
 * @param {object} config
 * @returns {number} clamped score
 */
function computeScore(deductions, config) {
  const totalDeduction = deductions.reduce((sum, d) => sum + d.amount, 0);
  const raw = config.starting_score - totalDeduction;
  return Math.max(config.min_score, Math.min(config.max_score, raw));
}

/**
 * @param {number} score
 * @param {object} config
 * @returns {"approve"|"approve_with_caveats"|"block"}
 */
function bandForScore(score, config) {
  for (const b of config.bands) {
    if (score >= b.min && score <= b.max) return b.band;
  }
  throw new Error(`No band in config/scoring.json covers score ${score} -- bands must span [min_score, max_score] with no gaps.`);
}

/**
 * PRD 6.1 (manual review) + the original "secret = -100" rule, reworked as
 * gates that sit OUTSIDE the score instead of a deduction (see
 * autorelease-ai/README.md "Deviations from the PRD" for why).
 *
 * @param {Array<object>} findings
 * @param {object} config
 * @returns {Array<"BLOCK"|"MANUAL_REVIEW">} de-duplicated, order not significant
 */
function applyGates(findings, config) {
  const gates = new Set();

  for (const finding of findings) {
    const gateFromCategory = config.gate_categories[finding.category];
    if (gateFromCategory) gates.add(gateFromCategory);

    const categoryConfig = config.categories[finding.category];
    const weight = categoryConfig ? categoryConfig.deduction || 0 : 0;
    if (finding.confidence === 'low' && weight >= config.manual_review_min_weight) {
      gates.add('MANUAL_REVIEW');
    }
  }

  return Array.from(gates);
}

/**
 * Gates always win over the computed band. BLOCK beats MANUAL_REVIEW beats
 * the band (a run can never silently score its way past either gate).
 *
 * @param {string} band
 * @param {Array<string>} gates
 * @returns {"approve"|"approve_with_caveats"|"block"|"manual_review"}
 */
function decisionFor(band, gates) {
  if (gates.includes('BLOCK')) return 'block';
  if (gates.includes('MANUAL_REVIEW')) return 'manual_review';
  return band;
}

/**
 * Links findings that touch the same file(s) -- e.g. a regression and a
 * reachable CVE in the same module. Report-only signal, no score effect.
 *
 * @param {Array<object>} findings
 * @returns {Array<{finding_ids: string[], shared_files: string[], note: string}>}
 */
function correlateFindings(findings) {
  const withFiles = findings.filter((f) => Array.isArray(f.files) && f.files.length > 0);
  const correlations = [];

  for (let i = 0; i < withFiles.length; i++) {
    for (let j = i + 1; j < withFiles.length; j++) {
      const a = withFiles[i];
      const b = withFiles[j];
      const sharedFiles = a.files.filter((f) => b.files.includes(f));
      if (sharedFiles.length > 0) {
        correlations.push({
          finding_ids: [a.id, b.id],
          shared_files: sharedFiles,
          note: `${a.category} (${a.id}) and ${b.category} (${b.id}) both touch ${sharedFiles.join(', ')} -- same blast radius.`,
        });
      }
    }
  }

  return correlations;
}

/**
 * Top-level entry point: findings in, full scoring result out.
 *
 * @param {Array<object>} findings
 * @param {object} config - parsed config/scoring.json
 * @returns {{gates: string[], deductions: object[], score: number, band: string, decision: string, correlations: object[]}}
 */
function scoreRun(findings, config) {
  const gates = applyGates(findings, config);
  const deductions = computeDeductions(findings, config);
  const score = computeScore(deductions, config);
  const band = bandForScore(score, config);
  const decision = decisionFor(band, gates);
  const correlations = correlateFindings(findings);

  return { gates, deductions, score, band, decision, correlations };
}

module.exports = {
  computeDeductions,
  computeScore,
  bandForScore,
  applyGates,
  decisionFor,
  correlateFindings,
  scoreRun,
};
