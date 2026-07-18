// aiki serve workspace — dependency-free HD3 client. The browser receives structured frames only;
// model prose appears solely in the reader-safe report projection.

const DECK_TOKEN = document.querySelector('meta[name="deck-token"]')?.content ?? '';
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.method === 'POST' || opts.method === 'PATCH') {
    headers['content-type'] = 'application/json';
    headers['x-deck-token'] = DECK_TOKEN;
  }
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${path} → ${res.status}`);
  return body;
}

const DISPLAY = { claude: 'Claude', codex: 'Codex', agy: 'Gemini' };
const DEFAULT_ROLE = { claude: 'judge', codex: 'verifier', agy: 'analyst' };
const STATUS_GLYPH = { running: '●', complete: '✓', failed: '⚠', cancelled: '◌' };
const state = {
  settings: null, providers: [], threadId: null, runId: null, events: null,
  attachments: [], gates: new Map(), turnKeys: new Set(), helloLastSeq: 0,
  calls: 0, budget: 1, active: false, canFollowup: false, runKind: 'decision',
};

// ── shell reads ───────────────────────────────────────────────────────────────

function renderProviders(providers) {
  state.providers = providers;
  const list = $('#provider-list');
  list.replaceChildren();
  for (const p of providers) {
    const li = el('li', 'provider');
    li.dataset.seat = p.id;
    li.title = p.fix ? `${p.label} — ${p.fix}` : p.label;
    const dot = el('span', 'provider__dot'); dot.dataset.tone = p.tone;
    const main = el('div', 'provider__main');
    main.append(el('div', 'provider__name', p.name), el('div', 'provider__model', p.model ?? 'CLI default'));
    li.append(dot, main, el('div', 'provider__status', p.label));
    list.append(li);
  }
}

function renderQuorum(q) {
  $('.lamp', $('#quorum')).dataset.tone = q.tone;
  $('.lamp', $('#deck-toggle')).dataset.tone = q.tone;
  $('.quorum__label', $('#quorum')).textContent = q.label;
}

function renderRoster(providers) {
  const roster = $('#seat-roster');
  if (!roster) return;
  roster.replaceChildren();
  const pinned = state.settings?.roles ?? {};
  for (const p of providers) {
    const seat = el('li', 'seat'); seat.dataset.seat = p.id;
    seat.append(el('span', 'seat__glyph'));
    const main = el('div', 'seat__main');
    main.append(el('div', 'seat__name', p.name), el('div', 'seat__role', roleFor(p.id, pinned)));
    const lamp = el('span', 'seat__lamp'); lamp.dataset.tone = p.tone;
    seat.append(main, lamp); roster.append(seat);
  }
}

function roleFor(id, pinned) {
  const roles = [];
  if (pinned.judge === id) roles.push('judge');
  if (pinned.verifier === id) roles.push('verifier');
  if (pinned.analyst === id) roles.push('analyst');
  if (pinned.responder === id) roles.push('responder');
  if (Array.isArray(pinned.s4) && pinned.s4.includes(id)) roles.push('seat');
  return roles.length ? roles.join(' · ') : DEFAULT_ROLE[id] ?? 'seat';
}

function renderThreads(threads) {
  const list = $('#thread-list'); list.replaceChildren();
  if (!threads.length) { list.append(el('li', 'thread-item__title', 'No decisions yet.')); return; }
  for (const t of threads) {
    const btn = el('button', 'thread-item'); btn.type = 'button'; btn.dataset.id = t.id;
    btn.append(el('span', 'thread-item__glyph', STATUS_GLYPH[t.status] ?? '·'));
    const title = el('span', 'thread-item__title', t.title); title.dataset.legacy = String(t.legacy);
    btn.append(title, el('span', 'thread-item__time', relTime(t.updatedAt)));
    btn.addEventListener('click', () => openThread(t.id, btn));
    const li = el('li'); li.append(btn); list.append(li);
  }
}

async function openThread(id, btn) {
  document.querySelectorAll('.thread-item[aria-current="true"]').forEach((b) => b.removeAttribute('aria-current'));
  btn?.setAttribute('aria-current', 'true');
  try {
    const detail = await api(`/api/threads/${encodeURIComponent(id)}`);
    state.threadId = detail.legacy ? null : detail.id;
    state.runId = detail.resumeRunId;
    renderThreadView(detail);
    closePanels(false);
  } catch (error) { toast(`Could not open decision (${error.message})`); }
}

function renderThreadView(detail) {
  state.canFollowup = !detail.legacy && detail.turns.some((turn) => turn.kind === 'report');
  const view = conversation(true);
  view.append(el('h1', 'thread-view__title', detail.title));
  view.append(el('p', 'thread-view__meta', detail.legacy ? 'Recorded run · read-only history' : 'Decision thread'));
  for (const turn of detail.turns) {
    if (turn.kind === 'report_md') view.append(el('div', 'report', turn.markdown));
    else if (turn.kind === 'note') view.append(el('p', 'empty__lede', turn.text));
    else if (turn.kind === 'user_message') appendUserTurn(turn, view);
    else if (turn.kind === 'report') renderVerdict(turn.report, view);
    else if (turn.kind === 'followup') renderFollowup(turn, view);
  }
  if (detail.resumeRunId) renderResumeCard(detail.resumeRunId, view);
  updateComposer();
  $('#center-scroll').scrollTop = 0;
}

function conversation(clear = false) {
  $('#empty-state').hidden = true;
  const view = $('#thread-view'); view.hidden = false;
  if (clear) { view.replaceChildren(); state.gates.clear(); state.turnKeys.clear(); }
  return view;
}

// ── live frames ───────────────────────────────────────────────────────────

function connectEvents(runId) {
  state.events?.close();
  state.helloLastSeq = 0;
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  state.events = source;
  source.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.t === 'hello') {
      state.helloLastSeq = frame.snapshot.lastSeq;
      renderSnapshot(frame.snapshot);
      return;
    }
    applyFrame(frame, frame.seq <= state.helloLastSeq);
  };
  source.onerror = () => { if (!state.active) source.close(); };
}

function renderSnapshot(snapshot) {
  state.calls = snapshot.calls.used;
  state.budget = snapshot.calls.budget;
  state.active = snapshot.status === 'gating' || snapshot.status === 'running';
  state.runKind = snapshot.mode === 'followup' ? 'followup' : 'decision';
  showSession(state.active, snapshot.status === 'gating' ? 'awaiting approval' : 'working');
  renderDeck(snapshot);
  snapshot.gates.forEach(renderGate);
}

function applyFrame(frame, historical) {
  if (frame.t === 'turn' && frame.turn.kind === 'user_message') appendUserTurn(frame.turn);
  else if (frame.t === 'turn') renderFollowup(frame.turn);
  else if (frame.t === 'gate') renderGate(frame.gate);
  else if (frame.t === 'gate_resolved') resolveGate(frame.gateId, frame.summary);
  else if (frame.t === 'stage') updateStage(frame);
  else if (frame.t === 'call') updateCall(frame, historical);
  else if (frame.t === 'counters') updateCounters(frame);
  else if (frame.t === 'report_ready') loadReport(frame.runId);
  else if (frame.t === 'receipt') renderReceipt(frame.receipt);
  else if (frame.t === 'done') finishRun(frame);
}

function appendUserTurn(turn, root = conversation()) {
  const key = JSON.stringify(turn);
  if (state.turnKeys.has(key)) return;
  state.turnKeys.add(key);
  const card = el('article', 'turn turn--user');
  card.append(el('p', 'turn__text', turn.text));
  if (turn.attachments?.length) {
    const chips = el('div', 'turn__chips');
    turn.attachments.forEach((item) => chips.append(el('span', 'turn__chip', item)));
    card.append(chips);
  }
  card.append(el('p', 'turn__meta', turn.mode === 'followup' ? 'Follow-up' : turn.mode === 'quick' ? 'Quick council' : 'Full council'));
  root.append(card); scrollConversation();
}

function renderGate(gate) {
  if (state.gates.has(gate.id)) return;
  const card = el('article', 'gate-card'); card.dataset.gateId = gate.id; card.dataset.kind = gate.kind;
  card.append(el('div', 'gate-card__eyebrow', gate.kind === 'attention' ? 'Needs attention' : 'Aiki access request'));
  card.append(el('h3', null, gate.title));
  gate.lines.forEach((line) => card.append(el('p', 'gate-card__line', line)));
  if (gate.question) card.append(el('p', 'gate-card__question', gate.question));
  if (gate.questions?.[0]) card.append(el('p', 'gate-card__question', gate.questions[0].prompt));

  if (gate.scopes) {
    const actions = el('div', 'gate-card__actions');
    for (const [decision, label] of [['allow_once', 'Allow once  y'], ['allow_session', 'Allow for session  s'], ['deny', 'Deny  n']]) {
      const btn = el('button', `btn${decision === 'allow_once' ? ' btn--primary' : ''}`, label);
      btn.type = 'button'; btn.addEventListener('click', () => answerGate(gate.id, { t: 'gate', gateId: gate.id, decision }));
      actions.append(btn);
    }
    card.append(actions);
  } else if (gate.kind === 'clarify') {
    const actions = el('div', 'gate-card__actions');
    gate.options?.forEach((option, index) => {
      const btn = el('button', 'btn', `${index + 1}. ${option}`); btn.type = 'button';
      btn.addEventListener('click', () => answerGate(gate.id, { t: 'answer', gateId: gate.id, value: index })); actions.append(btn);
    });
    card.append(actions, answerInput(gate.id));
  } else if (gate.kind === 'grill') card.append(answerInput(gate.id));
  else if (gate.fix) {
    card.append(el('p', 'gate-card__line', gate.fix));
    if (gate.kind === 'attention' && state.runKind === 'decision') {
      const resume = el('button', 'btn', 'Resume from cached calls'); resume.type = 'button';
      resume.addEventListener('click', () => resumeRun(state.runId)); card.append(resume);
    }
  }

  state.gates.set(gate.id, card);
  conversation().append(card); scrollConversation();
}

function answerInput(gateId) {
  const form = el('form', 'gate-answer');
  const input = el('input'); input.required = true; input.placeholder = 'Type your answer…';
  const button = el('button', 'btn btn--primary', 'Answer'); button.type = 'submit';
  form.append(input, button);
  form.addEventListener('submit', (event) => {
    event.preventDefault(); answerGate(gateId, { t: 'answer', gateId, value: input.value });
  });
  return form;
}

async function answerGate(gateId, action) {
  try {
    return await api(`/api/runs/${encodeURIComponent(state.runId)}/actions`, { method: 'POST', body: JSON.stringify(action) });
  } catch (error) { toast(error.message); }
}

function resolveGate(id, summary) {
  const card = state.gates.get(id);
  if (!card) return;
  card.classList.add('gate-card--resolved');
  card.append(el('div', 'gate-receipt', summary));
}

function renderDeck(snapshot) {
  $('#deck-state').textContent = snapshot.status;
  const body = $('#deck-body'); body.replaceChildren();
  const run = el('div', 'deck-run');
  const budget = el('div', 'budget');
  const line = el('div', 'budget__line');
  line.append(el('span', null, 'Call budget'), el('strong', 'budget-count', `${snapshot.calls.used}/${snapshot.calls.budget}${snapshot.calls.replays ? ` · ↻${snapshot.calls.replays}` : ''}`));
  const track = el('div', 'budget__track'); const fill = el('span', 'budget__fill');
  fill.style.width = `${Math.min(100, 100 * snapshot.calls.used / snapshot.calls.budget)}%`; track.append(fill); budget.append(line, track);
  const counters = el('div', 'deck-counters');
  for (const [key, label] of [['positions', 'positions'], ['evidence', 'evidence'], ['disagreements', 'disputes'], ['repairs', 'repairs']]) {
    const counter = el('div', 'deck-counter'); counter.dataset.counter = key;
    counter.append(el('strong', null, String(snapshot.counters[key] ?? 0)), el('span', null, label)); counters.append(counter);
  }
  const spine = el('ol', 'stage-spine');
  for (const stage of snapshot.stages) spine.append(stageNode(stage));
  run.append(budget, counters, spine); body.append(run);
}

function stageNode(stage) {
  const li = el('li', 'stage-node'); li.dataset.stage = stage.id; li.dataset.status = stage.status;
  li.append(el('span', 'stage-node__label', stage.label), el('span', 'stage-node__state', stage.status));
  li.append(el('span', 'stage-node__seat', stage.seat ? DISPLAY[stage.seat] : 'deterministic / assigned at call time'));
  return li;
}

function updateStage(frame) {
  let node = $(`.stage-node[data-stage="${CSS.escape(frame.id)}"]`);
  if (!node) { node = stageNode(frame); $('.stage-spine')?.append(node); }
  node.dataset.status = frame.status;
  $('.stage-node__state', node).textContent = frame.status;
  $('#deck-state').textContent = frame.status === 'running' ? frame.label : frame.status;
  $('#live-stage').textContent = frame.status === 'running' ? frame.label : $('#live-stage').textContent;
  $('#announcer').textContent = `${frame.label} ${frame.status}`;
}

function updateCall(frame, historical) {
  const node = $(`.stage-node[data-stage="${CSS.escape(frame.stage.split('-')[0])}"]`);
  if (node) $('.stage-node__seat', node).textContent = `${DISPLAY[frame.provider]} · ${frame.phase}${frame.replayed ? ' ↻ replay' : ''}`;
  if (frame.phase === 'end' && !frame.replayed && !historical) state.calls++;
  const count = $('.budget-count');
  if (count) count.textContent = `${state.calls}/${state.budget}`;
  const fill = $('.budget__fill');
  if (fill) fill.style.width = `${Math.min(100, 100 * state.calls / state.budget)}%`;
}

function updateCounters(frame) {
  for (const key of ['positions', 'evidence', 'disagreements', 'repairs']) {
    if (frame[key] == null) continue;
    const value = $(`.deck-counter[data-counter="${key}"] strong`);
    if (value) value.textContent = String(frame[key]);
  }
}

async function loadReport(runId) {
  try { renderVerdict(await api(`/api/runs/${encodeURIComponent(runId)}/report`)); }
  catch (error) { toast(`Could not load verdict (${error.message})`); }
}

function renderVerdict(report, root = conversation()) {
  if (root.querySelector(`[data-report-id="${CSS.escape(report.runId)}"]`)) return;
  const card = el('article', 'verdict-card'); card.dataset.tone = report.verdict.tone; card.dataset.reportId = report.runId;
  const banner = el('header', 'verdict-card__banner');
  banner.append(el('span', 'verdict-card__label', report.verdict.label), el('h2', null, report.headline));
  const body = el('div', 'verdict-card__body'); body.append(el('p', 'verdict-card__lead', report.bottomLine));
  report.warnings.forEach((warning) => body.append(el('p', 'verdict-warning', warning)));
  report.sections.forEach((section) => body.append(disclosure(section.heading, section.summary, section.bullets)));
  if (report.features.length) body.append(disclosure('Feature priorities', '', report.features.map((item) => `${item.priority} · ${item.feature} — ${item.rationale}`)));
  if (report.milestones.length) body.append(disclosure('Build plan', '', report.milestones.map((item) => `${item.timebox} · ${item.outcome} — done when ${item.doneWhen}`)));
  if (report.caveats.length) body.append(disclosure('Caveats', '', report.caveats));
  if (report.sources.length) body.append(disclosure('Sources', '', report.sources.map((item) => `${item.label}${item.citedFor.length ? ` — ${item.citedFor.join('; ')}` : ''}`)));
  const next = el('p', 'verdict-card__next'); next.append(el('strong', null, 'Next step · '), document.createTextNode(report.nextStep)); body.append(next);
  const receipt = el('footer', 'verdict-card__receipt', receiptLine(report.receipt));
  card.append(banner, body, receipt); root.append(card); scrollConversation();
  if (state.threadId) { state.canFollowup = true; updateComposer(); }
}

function renderFollowup(turn, root = conversation()) {
  const card = el('article', 'followup-card');
  card.append(el('p', 'followup-card__answer', turn.answer), el('p', 'followup-card__meta', turn.label));
  const reconvene = el('button', 'btn btn--icon', 'Re-convene council'); reconvene.type = 'button';
  reconvene.addEventListener('click', () => sendMessage(turn.question, 'decision'));
  card.append(reconvene); root.append(card); scrollConversation();
  state.canFollowup = true; updateComposer();
}

function renderResumeCard(runId, root = conversation()) {
  const card = el('article', 'gate-card'); card.dataset.kind = 'resume';
  card.append(el('div', 'gate-card__eyebrow', 'Interrupted council'), el('h3', null, 'Resume from cached calls?'));
  card.append(el('p', 'gate-card__line', 'Aiki will replay completed calls free and ask before any new spend.'));
  const button = el('button', 'btn btn--primary', 'Review resume cost'); button.type = 'button';
  button.addEventListener('click', () => resumeRun(runId)); card.append(button); root.append(card);
}

async function resumeRun(runId) {
  if (!runId) return;
  try {
    state.runId = runId;
    const outcome = await answerGate('', { t: 'resume' });
    if (!outcome?.runId) return;
    state.runId = outcome.runId; state.runKind = 'decision';
    showSession(true, 'awaiting resume approval'); connectEvents(outcome.runId);
  } catch (error) { toast(error.message); }
}

function disclosure(title, summary, bullets) {
  const details = el('details'); const head = el('summary', null, title); details.append(head);
  if (summary) details.append(el('p', null, summary));
  if (bullets?.length) { const list = el('ul'); bullets.forEach((item) => list.append(el('li', null, item))); details.append(list); }
  return details;
}

function renderReceipt(receipt) {
  let panel = $('.deck-receipt');
  if (!panel) { panel = el('section', 'deck-receipt'); $('#deck-body').append(panel); }
  panel.replaceChildren(el('h3', null, 'Run receipt'), el('p', null, receiptLine(receipt)));
  if (receipt.providers.length) {
    const list = el('ul'); receipt.providers.forEach((p) => list.append(el('li', null, `${p.name} · ${p.calls} call${p.calls === 1 ? '' : 's'}`))); panel.append(list);
  }
}

function receiptLine(r) {
  return `${r.mode} · ${r.calls}/${r.budget} calls${r.replays ? ` · ${r.replays} replayed` : ''} · ${r.repairs} repairs · ${(r.durationMs / 1000).toFixed(1)}s model time`;
}

function finishRun(frame) {
  state.active = false; showSession(false);
  $('#deck-state').textContent = frame.status === 'ok' ? 'complete' : frame.status;
  state.events?.close();
  if (frame.status === 'ok') state.canFollowup = true;
  updateComposer();
  api('/api/bootstrap').then((snap) => renderThreads(snap.threads)).catch(() => {});
  if (frame.status === 'aborted') toast(state.runKind === 'followup' ? 'Follow-up cancelled.' : 'Council cancelled. Partial artifacts were kept.');
  else if (frame.status === 'failed') toast(`${state.runKind === 'followup' ? 'Follow-up' : 'Council'} needs attention. See the card in the conversation.`);
}

function showSession(active, stage = 'awaiting approval') {
  state.active = active;
  $('#composer').hidden = active;
  $('#live-session').hidden = !active;
  if (active) {
    $('#session-label').textContent = state.runKind === 'followup' ? 'Follow-up in progress' : 'Council in session';
    $('#live-stage').textContent = stage;
  }
}

// ── composer + interactions ───────────────────────────────────────────────────────

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#decision-text').value.trim(); if (!text) return;
  await sendMessage(text, state.threadId && state.canFollowup ? 'followup' : 'decision');
});

async function sendMessage(text, kind) {
  const mode = $('#mode').value;
  try {
    const newThread = !state.threadId;
    const outcome = await api('/api/messages', { method: 'POST', body: JSON.stringify({
      ...(state.threadId ? { threadId: state.threadId } : {}), text, mode, kind,
      attachments: kind === 'followup' ? [] : state.attachments,
    }) });
    state.threadId = outcome.threadId; state.runId = outcome.runId;
    state.runKind = kind; state.canFollowup = kind === 'followup';
    conversation(newThread);
    showSession(true); connectEvents(outcome.runId);
    $('#decision-text').value = ''; state.attachments = []; renderAttachments();
    updateComposer();
  } catch (error) { toast(error.message); }
}

function updateComposer() {
  const followup = Boolean(state.threadId && state.canFollowup);
  $('#decision-text').placeholder = followup
    ? 'Ask a follow-up about this council answer…'
    : 'Describe the decision, constraints, and what a good answer must include…';
  $('#composer-send').textContent = followup ? 'Ask' : 'Convene';
  $('#attach').hidden = followup;
  $('.mode-select').hidden = followup;
  $('#estimate').textContent = followup ? '1 call · no council' : $('#mode').value === 'quick' ? '~3 calls · single-pass council' : '8–10 calls · council of installed models';
}

$('#attach').addEventListener('click', () => {
  const value = prompt('Paste a local file path or a public http(s) URL:')?.trim();
  if (!value) return;
  state.attachments.push(/^https?:\/\//i.test(value) ? { kind: 'url', url: value } : { kind: 'file', path: value });
  renderAttachments();
});

function renderAttachments() {
  const root = $('#attachment-chips'); root.replaceChildren();
  state.attachments.forEach((item, index) => {
    const chip = el('span', 'attachment-chip', item.kind === 'url' ? item.url : item.path.split(/[\\/]/).pop());
    const remove = el('button', null, '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove attachment');
    remove.addEventListener('click', () => { state.attachments.splice(index, 1); renderAttachments(); });
    chip.append(remove); root.append(chip);
  });
}

$('#mode').addEventListener('change', () => {
  $('#estimate').textContent = $('#mode').value === 'quick' ? '~3 calls · single-pass council' : '8–10 calls · council of installed models';
});

$('#cancel-run').addEventListener('click', () => answerGate('', { t: 'cancel' }));

$('#new-decision').addEventListener('click', () => {
  if (state.active) return toast('A council is already in session.');
  state.threadId = null; state.runId = null;
  state.canFollowup = false; state.runKind = 'decision'; updateComposer();
  $('#thread-view').hidden = true; $('#thread-view').replaceChildren(); $('#empty-state').hidden = false;
  closePanels(false);
  $('#decision-text').focus();
});

document.addEventListener('keydown', (event) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const pending = [...state.gates.entries()].reverse().find(([, card]) => !card.classList.contains('gate-card--resolved') && $('.gate-card__actions', card));
  if (!pending) return;
  const decision = event.key.toLowerCase() === 'y' ? 'allow_once' : event.key.toLowerCase() === 's' ? 'allow_session' : event.key.toLowerCase() === 'n' ? 'deny' : null;
  if (decision) { event.preventDefault(); answerGate(pending[0], { t: 'gate', gateId: pending[0], decision }); }
});

// ── provider check + settings ─────────────────────────────────────────────────────

$('#check-connections').addEventListener('click', async (event) => {
  if (!confirm('Check connections?\n\nThis makes up to 3 tiny provider calls. Continue?')) return;
  const btn = event.currentTarget; btn.setAttribute('aria-busy', 'true');
  try {
    const providers = await api('/api/providers/check', { method: 'POST', body: JSON.stringify({ fresh: true }) });
    renderProviders(providers); renderQuorum(quorumFrom(providers)); renderRoster(providers); toast('Connections checked.');
  } catch (error) { toast(`Check failed (${error.message})`); }
  finally { btn.removeAttribute('aria-busy'); }
});

function renderSettings(settings) {
  const body = $('#settings-body'); body.replaceChildren();
  const form = el('form', 'settings-form');
  const scope = settings.scope.startsWith('project') ? 'project config (.aiki/config.json)' : 'global config (~/.aiki/config.json)';
  form.append(el('p', 'settings-scope', `Saving to ${scope}. Changes apply to the next run.`));

  const local = settings.overrides ?? { models: settings.models, roles: settings.roles };
  const models = el('fieldset', 'settings-group'); models.append(el('legend', null, 'Models'));
  for (const id of ['claude', 'codex', 'agy']) {
    const label = el('label', 'settings-field');
    label.append(el('span', null, DISPLAY[id]));
    const input = el('input', 'settings-input'); input.name = `model-${id}`; input.autocomplete = 'off'; input.spellcheck = false;
    input.value = local.models[id] ?? '';
    input.placeholder = settings.models[id] ? `Inherited: ${settings.models[id]}` : 'CLI default';
    label.append(input); models.append(label);
  }
  form.append(models);

  const roles = el('fieldset', 'settings-group'); roles.append(el('legend', null, 'Roles'));
  const roleFields = [['judge', 'Judge'], ['verifier', 'Verifier'], ['analyst', 'Analyst'], ['responder', 'Follow-up responder']];
  for (const [key, label] of roleFields) roles.append(roleField(key, label, local.roles?.[key], settings.roles?.[key]));
  const seats = local.roles?.s4 ?? [];
  roles.append(roleField('s4-0', 'Council seat 1', seats[0], settings.roles?.s4?.[0]));
  roles.append(roleField('s4-1', 'Council seat 2', seats[1], settings.roles?.s4?.[1]));
  roles.append(el('p', 'settings-note', 'Claude is recommended for the judge role as the strongest default.'));
  form.append(roles, el('p', 'settings-note', 'Clear an override to fall back to the global or CLI default. No credentials are stored here.'));

  const actions = el('div', 'settings-actions');
  const save = el('button', 'btn btn--primary', 'Save settings'); save.type = 'submit'; actions.append(save); form.append(actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const seat1 = String(data.get('role-s4-0') ?? '');
    const seat2 = String(data.get('role-s4-1') ?? '');
    if (Boolean(seat1) !== Boolean(seat2)) return toast('Choose both council seats, or leave both on Default.');
    const value = (name) => String(data.get(name) ?? '').trim() || null;
    const patch = {
      models: { claude: value('model-claude'), codex: value('model-codex'), agy: value('model-agy') },
      roles: {
        judge: value('role-judge'), verifier: value('role-verifier'), analyst: value('role-analyst'),
        responder: value('role-responder'), s4: seat1 && seat2 ? [seat1, seat2] : null,
      },
    };
    save.setAttribute('aria-busy', 'true'); save.disabled = true;
    try {
      state.settings = await api('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
      renderSettings(state.settings); renderRoster(state.providers); toast('Settings saved for the next run.');
    } catch (error) { toast(`Could not save settings (${error.message})`); }
    finally { save.removeAttribute('aria-busy'); save.disabled = false; }
  });
  body.append(form);
}

function roleField(key, labelText, selected, inherited) {
  const label = el('label', 'settings-field'); label.append(el('span', null, labelText));
  const select = el('select', 'settings-select'); select.name = `role-${key}`;
  const fallback = el('option', null, inherited ? `Default (${DISPLAY[inherited]})` : 'Default'); fallback.value = ''; select.append(fallback);
  for (const id of ['claude', 'codex', 'agy']) {
    const option = el('option', null, DISPLAY[id]); option.value = id; option.selected = selected === id; select.append(option);
  }
  label.append(select); return label;
}

let settingsFocus;
async function openSettings() {
  settingsFocus = document.activeElement;
  const sheet = $('#settings-sheet'); sheet.hidden = false;
  $('#settings-body').replaceChildren(el('p', 'settings-empty', 'Loading settings…'));
  try {
    state.settings = await api('/api/settings'); renderSettings(state.settings);
    $('.settings-input, .settings-select', sheet)?.focus();
  } catch (error) {
    const message = el('p', 'settings-error', `Could not load settings. ${error.message}`); message.setAttribute('role', 'alert');
    $('#settings-body').replaceChildren(message);
  }
}
function closeSettings() {
  $('#settings-sheet').hidden = true;
  settingsFocus?.focus?.();
}
$('#settings-open').addEventListener('click', openSettings);
document.querySelectorAll('#settings-sheet [data-close]').forEach((node) => node.addEventListener('click', closeSettings));

// ── responsive rails and drawers ────────────────────────────────────────────────

function setPanel(name, open) {
  document.body.classList.toggle(`${name}-open`, open);
  $(`#${name}-toggle`)?.setAttribute('aria-expanded', String(open));
  $('#drawer-backdrop').hidden = !document.body.classList.contains('rail-open') && !document.body.classList.contains('deck-open');
  if (open) $(`#${name === 'rail' ? 'sessions-rail' : 'council-deck'} button`)?.focus();
}
function closePanels(restoreFocus = true) {
  const open = document.body.classList.contains('rail-open') ? 'rail' : document.body.classList.contains('deck-open') ? 'deck' : null;
  setPanel('rail', false); setPanel('deck', false);
  if (restoreFocus && open) $(`#${open}-toggle`)?.focus();
}
$('#rail-toggle').addEventListener('click', () => setPanel('rail', !document.body.classList.contains('rail-open')));
$('#deck-toggle').addEventListener('click', () => setPanel('deck', !document.body.classList.contains('deck-open')));
$('#drawer-backdrop').addEventListener('click', closePanels);
document.querySelectorAll('[data-close-panel]').forEach((node) => node.addEventListener('click', closePanels));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('#settings-sheet').hidden) closeSettings();
  else closePanels();
});

// ── helpers + boot ──────────────────────────────────────────────────────────────────

function quorumFrom(providers) {
  const ready = providers.filter((p) => p.kind === 'ready').length;
  if (ready >= 3) return { label: '3/3 council ready', tone: 'green' };
  if (ready === 2) return { label: '2/3 degraded', tone: 'amber' };
  return { label: 'council unavailable', tone: 'red' };
}
function relTime(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
function scrollConversation() { requestAnimationFrame(() => { $('#center-scroll').scrollTop = $('#center-scroll').scrollHeight; }); }
let toastTimer;
function toast(message) {
  const node = $('#toast'); node.textContent = message; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
}

async function boot() {
  try {
    const snapshot = await api('/api/bootstrap');
    state.settings = snapshot.settings;
    $('#version').textContent = `v${snapshot.version}`;
    renderProviders(snapshot.providers); renderQuorum(snapshot.quorum); renderRoster(snapshot.providers); renderThreads(snapshot.threads);
  } catch (error) {
    $('.empty__title').textContent = 'The workspace could not load.';
    $('.empty__lede').textContent = error.message;
    toast(`Failed to load workspace (${error.message})`);
  }
}
boot();
