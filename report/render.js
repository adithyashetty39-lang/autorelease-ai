/**
 * Renders one RunRecord (schemas/run_record.schema.json) into the report
 * page judges actually look at -- score, gate badges, itemized deductions
 * with evidence links, the agent investigation timeline, and Approve/Reject
 * buttons that POST to n8n's Wait-node resume URL.
 *
 * Self-contained on purpose (inline CSS, no build step, one exported
 * function returning a full HTML string) so it can be pasted directly into
 * an n8n Code node behind a Webhook GET -> Respond to Webhook pair (WF-R in
 * the plan). Uses the Tailwind CDN script, which is on the artifact/n8n
 * CDN allowlist-equivalent for a plain served page (it's just a public
 * <script> tag, not subject to any artifact sandbox here).
 *
 * Every value that could contain LLM output, a PR title, a commit message,
 * or anything else outside our control is HTML-escaped before interpolation
 * -- do not remove escapeHtml() calls to "simplify" this file.
 */

'use strict';

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DECISION_LABEL = {
  approve: { text: 'APPROVE', className: 'decision-approve' },
  approve_with_caveats: { text: 'APPROVE WITH CAVEATS', className: 'decision-caveats' },
  block: { text: 'BLOCK', className: 'decision-block' },
  manual_review: { text: 'MANUAL REVIEW REQUIRED', className: 'decision-review' },
};

const TOOL_ICON = {
  get_test_history: '🕘',
  get_job_logs: '📜',
  compare_commits: '🔀',
  get_advisory: '🛡️',
  search_imports: '🔎',
  search_symbol_usage: '🎯',
};

function renderGateBadges(gates) {
  if (!gates || gates.length === 0) return '<span class="badge badge-none">no gates triggered</span>';
  return gates
    .map((g) => `<span class="badge badge-gate">${escapeHtml(g)}</span>`)
    .join(' ');
}

function renderDeductionsTable(findings, deductions) {
  const findingById = Object.fromEntries((findings || []).map((f) => [f.id, f]));
  if (!deductions || deductions.length === 0) {
    return '<p class="muted">No deductions -- score is clean.</p>';
  }
  const rows = deductions
    .map((d) => {
      const f = findingById[d.finding_id] || {};
      const evidenceLinks = (f.evidence || [])
        .map((e) => `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.label)}</a>`)
        .join(', ');
      return `<tr>
        <td>${escapeHtml(f.title || d.finding_id)}</td>
        <td><code>${escapeHtml(d.category)}</code></td>
        <td>${escapeHtml(f.confidence || '-')}</td>
        <td class="num">${d.amount > 0 ? '-' + d.amount : d.amount}${d.capped ? ' <span class="capped-tag">(capped)</span>' : ''}</td>
        <td>${evidenceLinks || '<span class="muted">none</span>'}</td>
      </tr>`;
    })
    .join('\n');
  return `<table class="findings-table">
    <thead><tr><th>Finding</th><th>Category</th><th>Confidence</th><th>Deduction</th><th>Evidence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderTrace(trace) {
  if (!trace || trace.length === 0) return '<p class="muted">No trace recorded for this run.</p>';
  const byAgent = {};
  for (const step of trace) {
    (byAgent[step.agent] ||= []).push(step);
  }
  return Object.entries(byAgent)
    .map(([agent, steps]) => {
      const items = steps
        .sort((a, b) => a.step - b.step)
        .map(
          (s) => `<li class="trace-step">
            <span class="trace-icon">${TOOL_ICON[s.tool] || '🔧'}</span>
            <strong>${escapeHtml(s.tool)}</strong>
            <span class="muted">(${escapeHtml(s.input_summary)})</span>
            &rarr; ${escapeHtml(s.output_summary)}
            ${s.decision ? `<div class="trace-decision">${escapeHtml(s.decision)}</div>` : ''}
          </li>`
        )
        .join('\n');
      return `<div class="trace-agent">
        <h4>${escapeHtml(agent)} agent — ${steps.length} tool call${steps.length === 1 ? '' : 's'}</h4>
        <ol class="trace-list">${items}</ol>
      </div>`;
    })
    .join('\n');
}

function renderCorrelations(correlations) {
  if (!correlations || correlations.length === 0) return '';
  const items = correlations
    .map((c) => `<li>${escapeHtml(c.note)}</li>`)
    .join('\n');
  return `<div class="correlations">
    <h4>Linked findings</h4>
    <ul>${items}</ul>
  </div>`;
}

/**
 * @param {object} runRecord - see schemas/run_record.schema.json
 * @param {string} [resumeUrl] - n8n Wait node resume URL for Approve/Reject POSTs
 * @returns {string} full HTML document
 */
function renderReport(runRecord, resumeUrl) {
  const decisionInfo = DECISION_LABEL[runRecord.decision] || { text: runRecord.decision, className: '' };
  const score = typeof runRecord.score === 'number' ? runRecord.score : 0;
  const actionUrl = resumeUrl || runRecord.resume_url || '#';
  const isDecided = Boolean(runRecord.approver);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AutoRelease AI — ${escapeHtml(runRecord.repo)} #${escapeHtml(runRecord.pr ?? '')}</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 24px 16px 64px; background: #0b0f14; color: #e6edf3; }
  h1, h2, h3, h4 { line-height: 1.25; }
  .muted { color: #8b949e; }
  .score-gauge { font-size: 64px; font-weight: 800; }
  .band-strip { display: flex; gap: 12px; align-items: center; margin: 12px 0 24px; flex-wrap: wrap; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge-gate { background: #f85149; color: #fff; }
  .badge-none { background: #21262d; color: #8b949e; }
  .decision-approve { background: #2ea043; color: #fff; }
  .decision-caveats { background: #d29922; color: #0b0f14; }
  .decision-block, .decision-review { background: #f85149; color: #fff; }
  .decision-pill { padding: 8px 16px; border-radius: 8px; font-weight: 700; display: inline-block; }
  .contrast-strip { display: flex; gap: 16px; margin: 16px 0; }
  .contrast-box { flex: 1; padding: 12px 16px; border-radius: 8px; background: #161b22; border: 1px solid #30363d; }
  table.findings-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  .findings-table th, .findings-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #30363d; font-size: 14px; }
  .findings-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .capped-tag { color: #d29922; font-size: 11px; }
  code { background: #161b22; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  a { color: #58a6ff; }
  .trace-agent { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  .trace-list { list-style: none; padding: 0; margin: 8px 0 0; }
  .trace-step { padding: 6px 0; border-top: 1px dashed #30363d; }
  .trace-step:first-child { border-top: none; }
  .trace-icon { margin-right: 6px; }
  .trace-decision { margin: 4px 0 0 24px; padding: 6px 10px; background: #0d1117; border-left: 3px solid #58a6ff; font-size: 13px; }
  .actions { display: flex; gap: 12px; margin-top: 32px; }
  button { font-size: 16px; font-weight: 700; padding: 12px 24px; border-radius: 8px; border: none; cursor: pointer; }
  .btn-approve { background: #2ea043; color: #fff; }
  .btn-reject { background: #f85149; color: #fff; }
  .decided-banner { padding: 12px 16px; border-radius: 8px; background: #161b22; border: 1px solid #30363d; margin-top: 24px; }
  .summary-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin: 16px 0; }
</style>
</head>
<body>
  <p class="muted">AutoRelease AI · ${escapeHtml(runRecord.repo)} · PR #${escapeHtml(runRecord.pr ?? '?')} · <code>${escapeHtml((runRecord.sha || '').slice(0, 10))}</code></p>

  <div class="band-strip">
    <div class="score-gauge">${score}<span class="muted" style="font-size:24px">/100</span></div>
    <span class="decision-pill ${decisionInfo.className}">${escapeHtml(decisionInfo.text)}</span>
    ${renderGateBadges(runRecord.gates)}
  </div>

  <div class="summary-box">${escapeHtml(runRecord.summary || '')}</div>

  <h3>Itemized findings</h3>
  ${renderDeductionsTable(runRecord.findings, runRecord.deductions)}
  ${renderCorrelations(runRecord.correlations)}

  <h3>Agent investigation timeline</h3>
  ${renderTrace(runRecord.trace)}

  ${
    isDecided
      ? `<div class="decided-banner">Decision recorded: <strong>${escapeHtml(runRecord.approver)}</strong> chose <strong>${escapeHtml(runRecord.decision)}</strong> at ${escapeHtml(runRecord.decided_at || '')}${runRecord.approval_comment ? ` — "${escapeHtml(runRecord.approval_comment)}"` : ''}</div>`
      : `<div class="actions">
          <form method="post" action="${escapeHtml(actionUrl)}" style="display:inline">
            <input type="hidden" name="decision" value="approve" />
            <button type="submit" class="btn-approve">Approve</button>
          </form>
          <form method="post" action="${escapeHtml(actionUrl)}" style="display:inline">
            <input type="hidden" name="decision" value="reject" />
            <button type="submit" class="btn-reject">Reject</button>
          </form>
        </div>`
  }
</body>
</html>`;
}

module.exports = { renderReport, escapeHtml };
