/**
 * Runtime validation for one agent Finding -- the "Code node after each
 * agent" from Phase 3 of the plan. Two jobs:
 *
 *   1. Schema-shape check (mirrors schemas/finding.schema.json; kept as a
 *      hand-rolled check rather than pulling in ajv so this drops into an
 *      n8n Code node with zero external dependencies -- self-hosted n8n
 *      needs NODE_FUNCTION_ALLOW_EXTERNAL set to use npm packages inside
 *      Code nodes, which is one more thing to configure under time
 *      pressure. If the schema changes, update both files together.)
 *
 *   2. Evidence provenance check -- drops any evidence URL that did NOT
 *      appear in this run's actual tool outputs, so the model cannot cite
 *      a link it made up. If that leaves a finding with zero evidence, the
 *      finding is rejected outright (a finding without real evidence
 *      should not exist -- see prompts/*.md "never guess without a tool
 *      result").
 *
 * On rejection, the n8n workflow should retry the agent once with the
 * error list appended to the prompt; if it fails twice, emit a synthetic
 * low_confidence finding instead of dropping the issue silently (Phase 3:
 * "the agent must never fail silently into an approval").
 */

'use strict';

const REQUIRED_FIELDS = ['id', 'agent', 'category', 'title', 'classification', 'confidence', 'evidence', 'reasoning'];
const AGENTS = ['build_test', 'security'];
const CATEGORIES = [
  'new_regression',
  'flaky_test',
  'infra_failure',
  'coverage_drop',
  'reachable_critical_cve',
  'reachable_high_cve',
  'unreachable_critical_cve',
  'unreachable_high_cve',
  'secret_detected',
  'code_scanning_alert',
];
const CONFIDENCES = ['high', 'medium', 'low'];

/**
 * @param {object} finding
 * @param {Set<string>|null} knownEvidenceUrls - every URL that actually appeared
 *   in this run's tool outputs. Pass null to skip provenance checking (e.g.
 *   for fixture/eval data where that context isn't available).
 * @returns {{valid: boolean, errors: string[], sanitized: object|null, droppedFabricatedEvidenceCount: number}}
 */
function validateFinding(finding, knownEvidenceUrls) {
  const errors = [];

  if (finding == null || typeof finding !== 'object') {
    return { valid: false, errors: ['finding is not an object'], sanitized: null, droppedFabricatedEvidenceCount: 0 };
  }

  for (const field of REQUIRED_FIELDS) {
    if (finding[field] === undefined || finding[field] === null) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (finding.id !== undefined && !/^F-\d+$/.test(String(finding.id))) {
    errors.push(`id must match ^F-\\d+$, got "${finding.id}"`);
  }
  if (finding.agent !== undefined && !AGENTS.includes(finding.agent)) {
    errors.push(`agent must be one of [${AGENTS.join(', ')}], got "${finding.agent}"`);
  }
  if (finding.category !== undefined && !CATEGORIES.includes(finding.category)) {
    errors.push(`category must be one of the known categories, got "${finding.category}"`);
  }
  if (finding.confidence !== undefined && !CONFIDENCES.includes(finding.confidence)) {
    errors.push(`confidence must be one of [${CONFIDENCES.join(', ')}], got "${finding.confidence}"`);
  }

  if (finding.evidence !== undefined) {
    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
      errors.push('evidence must be a non-empty array');
    } else {
      finding.evidence.forEach((e, i) => {
        if (!e || typeof e.label !== 'string' || typeof e.url !== 'string') {
          errors.push(`evidence[${i}] must have a string label and url`);
        }
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, sanitized: null, droppedFabricatedEvidenceCount: 0 };
  }

  let droppedFabricatedEvidenceCount = 0;
  const sanitizedEvidence = finding.evidence.filter((e) => {
    if (knownEvidenceUrls == null) return true; // provenance checking disabled
    const known = knownEvidenceUrls.has(e.url);
    if (!known) droppedFabricatedEvidenceCount += 1;
    return known;
  });

  if (sanitizedEvidence.length === 0) {
    return {
      valid: false,
      errors: [
        `all ${finding.evidence.length} evidence URL(s) were not present in this run's tool outputs -- likely fabricated, finding rejected`,
      ],
      sanitized: null,
      droppedFabricatedEvidenceCount,
    };
  }

  return {
    valid: true,
    errors: [],
    sanitized: { ...finding, evidence: sanitizedEvidence },
    droppedFabricatedEvidenceCount,
  };
}

/**
 * @param {Array<object>} findings
 * @param {Set<string>|null} knownEvidenceUrls
 * @returns {{valid: object[], rejected: Array<{finding: object, errors: string[]}>}}
 */
function validateFindings(findings, knownEvidenceUrls) {
  const valid = [];
  const rejected = [];
  for (const f of findings || []) {
    const result = validateFinding(f, knownEvidenceUrls);
    if (result.valid) {
      valid.push(result.sanitized);
    } else {
      rejected.push({ finding: f, errors: result.errors });
    }
  }
  return { valid, rejected };
}

/**
 * Builds a synthetic low_confidence finding so a failed/rejected agent
 * output can never silently disappear into an approval -- it always routes
 * to MANUAL_REVIEW instead (PRD 6.1's gate fires because confidence=low +
 * a high weight category).
 *
 * @param {"build_test"|"security"} agent
 * @param {string} reason
 */
function syntheticLowConfidenceFinding(agent, reason) {
  return {
    // id 0 is reserved for synthetic validation-failure findings -- a real
    // agent should never emit F-0, so this can't collide (see prompts/*.md).
    id: 'F-0',
    agent,
    category: agent === 'security' ? 'reachable_critical_cve' : 'new_regression',
    title: `[SYNTHETIC] ${agent} agent output could not be validated`,
    classification: 'unknown',
    confidence: 'low',
    evidence: [{ label: 'validation failure', url: 'about:blank', source_tool: 'validation_layer' }],
    files: [],
    reasoning: `Synthetic placeholder finding, not a real agent classification: ${reason}`,
  };
}

module.exports = {
  CATEGORIES,
  AGENTS,
  CONFIDENCES,
  validateFinding,
  validateFindings,
  syntheticLowConfidenceFinding,
};
