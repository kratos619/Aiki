const REPLAY_PATH = './replay/a694.json';

const decisionContent = document.querySelector('#decision-content');
const sessionContent = document.querySelector('#session-content');
const activityContent = document.querySelector('#activity-content');
const progress = document.querySelector('#replay-progress');
const liveRegion = document.querySelector('#live-region');
let replayTimers = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

function inlineMarkup(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function assertReplay(data) {
  if (
    !data
    || data.schemaVersion !== 1
    || data.kind !== 'recorded-run'
    || data.label !== 'Recorded real run — no models are running.'
    || !Array.isArray(data.activity)
    || data.activity.length !== 10
    || !data.result
    || !data.receipt
  ) {
    throw new Error('The replay fixture does not match the public schema.');
  }
}

function list(items) {
  return `<ul>${items.map((item) => `<li>${inlineMarkup(item)}</li>`).join('')}</ul>`;
}

function titleCase(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

function formatDuration(milliseconds) {
  if (milliseconds === null) return 'Duration not recorded';
  const totalSeconds = Math.round(milliseconds / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s recorded`;
}

function formatModelTime(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function renderSession(data) {
  const providerClasses = { claude: 'claude', codex: 'codex', agy: 'agy' };
  sessionContent.innerHTML = `
    <p class="section-label">Recorded session</p>
    <article class="session-card" aria-current="page">
      <div class="status-line">
        <span class="status-dot" aria-hidden="true"></span>
        <span class="session-meta">Complete · ${data.session.resumed ? 'resumed run' : 'single run'}</span>
      </div>
      <h2>${escapeHtml(data.session.title)}</h2>
      <span class="session-meta">${escapeHtml(formatDate(data.session.completedAt))}</span>
      <span class="run-id">${escapeHtml(data.session.id)}</span>
    </article>
    <section class="provider-list" aria-labelledby="providers-title">
      <p class="section-label" id="providers-title">Council in this record</p>
      ${data.providers.map((provider) => `
        <div class="provider provider--${providerClasses[provider.id] || 'codex'}">
          <span class="provider-swatch" aria-hidden="true"></span>
          <span>
            <strong>${escapeHtml(provider.name)}</strong>
            <small>${provider.roles.map(titleCase).map(escapeHtml).join(' · ')}</small>
          </span>
        </div>
      `).join('')}
    </section>
  `;
}

function renderDecision(data) {
  const warningCards = data.warnings.map((warning) => `
    <div class="warning-card ${warning.level === 'info' ? 'warning-card--info' : ''}">
      <span class="warning-card__mark" aria-hidden="true">${warning.level === 'info' ? 'i' : '!'}</span>
      <span>${escapeHtml(warning.message)}</span>
    </div>
  `).join('');

  const chapters = data.result.sections.map((section, index) => `
    <article class="report-chapter">
      <span class="chapter-number">0${index + 1}</span>
      <h2>${inlineMarkup(section.heading)}</h2>
      <p>${inlineMarkup(section.summary)}</p>
      ${list(section.bullets)}
    </article>
  `).join('');

  const featureColumn = (key, label) => `
    <section class="feature-column feature-column--${key}">
      <h3>${escapeHtml(label)}</h3>
      ${data.result.features[key].map((feature) => `
        <div class="feature-item">
          <span>${escapeHtml(feature.name)}</span>
          <span class="effort">${escapeHtml(feature.effort)}</span>
        </div>
      `).join('')}
    </section>
  `;

  decisionContent.innerHTML = `
    <header class="report-header">
      <span class="report-kicker">Council result · recorded replay</span>
      <h1>${inlineMarkup(data.result.headline)}</h1>
      <div class="verdict-row">
        <span class="verdict-tag">${escapeHtml(titleCase(data.result.status))}</span>
        <div class="confidence" aria-label="Confidence ${data.result.confidence.score} out of 100, ${escapeHtml(data.result.confidence.label)}">
          <strong>${data.result.confidence.score}/100</strong>
          <span>${escapeHtml(data.result.confidence.label)} confidence</span>
        </div>
      </div>
    </header>

    <section class="bottom-line" aria-labelledby="bottom-line-title">
      <span class="eyebrow" id="bottom-line-title">Bottom line</span>
      <p>${inlineMarkup(data.result.bottomLine)}</p>
    </section>

    <section class="warning-stack" aria-label="Run warnings">${warningCards}</section>

    <section class="report-section" aria-labelledby="decision-frame-title">
      <div class="section-heading">
        <h2 id="decision-frame-title">Decision frame</h2>
        <p>Submitted brief and contract</p>
      </div>
      <div class="section-body decision-frame">
        <p>${inlineMarkup(data.decision.brief)}</p>
        <div class="frame-grid">
          <div>
            <h3>Constraints</h3>
            ${list(data.decision.constraints)}
          </div>
          <div>
            <h3>Success criteria</h3>
            ${list(data.decision.successCriteria)}
          </div>
        </div>
        <div class="output-tags" aria-label="Requested outputs">
          ${data.decision.requestedOutputs.map((output) => `<span class="output-tag">${escapeHtml(titleCase(output))}</span>`).join('')}
        </div>
      </div>
    </section>

    ${chapters}

    <section class="report-section" aria-labelledby="features-title">
      <div class="section-heading">
        <h2 id="features-title">Feature backlog</h2>
        <p>Prioritized by the council</p>
      </div>
      <div class="section-body">
        <div class="feature-grid">
          ${featureColumn('must', 'Must ship')}
          ${featureColumn('should', 'Should ship')}
        </div>
        <div class="frame-grid" style="margin-top: 24px">
          <div>
            <h3>Later</h3>
            ${data.result.features.later.map((feature) => `<div class="feature-item"><span>${escapeHtml(feature.name)}</span><span class="effort">${escapeHtml(feature.effort)}</span></div>`).join('')}
          </div>
          <div>
            <h3>Won't do</h3>
            ${list(data.result.features.wont)}
          </div>
        </div>
      </div>
    </section>

    <section class="report-section" aria-labelledby="milestones-title">
      <div class="section-heading">
        <h2 id="milestones-title">Implementation path</h2>
        <p>Three recorded milestones</p>
      </div>
      <div class="section-body">
        <ol class="milestones">
          ${data.result.milestones.map((milestone) => `
            <li class="milestone">
              <strong>${escapeHtml(milestone.timebox)}</strong>
              <p>${escapeHtml(milestone.outcome)}</p>
            </li>
          `).join('')}
        </ol>
      </div>
    </section>

    <section class="next-step" aria-labelledby="next-step-title">
      <span class="eyebrow" id="next-step-title">Immediate next step</span>
      <p>${inlineMarkup(data.result.nextStep)}</p>
    </section>

    <section class="report-section" aria-labelledby="caveats-title">
      <div class="section-heading">
        <h2 id="caveats-title">Caveats &amp; audit</h2>
        <p>Why confidence is low</p>
      </div>
      <div class="section-body">
        ${list(data.result.caveats)}
        <div class="audit-note">
          <div class="audit-stat"><strong>${data.audit.storedDisagreements}</strong><span>Stored disagreements</span></div>
          <div class="audit-stat"><strong>${data.audit.semanticClaimGroups}</strong><span>Semantic claim groups</span></div>
          <div class="audit-stat"><strong>${data.audit.verifications}</strong><span>Verifications</span></div>
          <p class="audit-summary">${escapeHtml(data.audit.summary)}</p>
        </div>
      </div>
    </section>

    <footer class="report-footer">
      Canonical sanitized replay · ${escapeHtml(data.session.id)}<br>
      No prompts, provider output, local paths, or hidden reasoning are included.
    </footer>
  `;
  decisionContent.setAttribute('aria-busy', 'false');
}

function renderActivity(data) {
  const metadata = (values) => Object.entries(values).map(([key, value]) => `
    <span class="metadata-chip">${escapeHtml(titleCase(key))}: ${escapeHtml(value)}</span>
  `).join('');

  activityContent.innerHTML = `
    <div class="activity-intro">
      <p>Accelerated reveal of ten validated stage artifacts. The statuses and recorded durations below are unchanged.</p>
      <button class="replay-button" id="replay-button" type="button"><span aria-hidden="true">↻</span> Replay stages</button>
    </div>
    <ol class="activity-list">
      ${data.activity.map((stage) => `
        <li class="activity-row" data-sequence="${stage.sequence}">
          <div class="activity-topline">
            <h3>${escapeHtml(stage.label)}</h3>
            <span class="stage-status">${escapeHtml(stage.status)}</span>
          </div>
          <p class="activity-actor">${escapeHtml(stage.actor)}</p>
          <span class="activity-duration">${escapeHtml(formatDuration(stage.durationMs))}</span>
          <div class="activity-metadata">${metadata(stage.metadata)}</div>
        </li>
      `).join('')}
    </ol>
    <section class="receipt" aria-labelledby="receipt-title">
      <span class="eyebrow">Evidence receipt</span>
      <h3 id="receipt-title">Calls after resume</h3>
      <div class="receipt-grid">
        <div class="receipt-cell"><strong>${data.receipt.calls}</strong><span>Recorded calls</span></div>
        <div class="receipt-cell"><strong>${escapeHtml(formatModelTime(data.receipt.modelTimeMs))}</strong><span>Model time</span></div>
        <div class="receipt-cell"><strong>${data.receipt.byProvider.Claude || 0}</strong><span>Claude calls</span></div>
        <div class="receipt-cell"><strong>${data.receipt.budget}</strong><span>Run budget</span></div>
      </div>
      <p class="receipt-note">${escapeHtml(data.receipt.note)}</p>
    </section>
  `;

  document.querySelector('#replay-button').addEventListener('click', () => startReplay(data.activity));
}

function clearReplayTimers() {
  replayTimers.forEach(clearTimeout);
  replayTimers = [];
}

function startReplay(stages) {
  clearReplayTimers();
  const rows = [...document.querySelectorAll('.activity-row')];
  const button = document.querySelector('#replay-button');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  rows.forEach((row) => row.classList.remove('is-revealed', 'is-current'));
  button.disabled = true;

  if (reducedMotion) {
    rows.forEach((row) => row.classList.add('is-revealed'));
    progress.textContent = 'Replay complete · 10 validated stages';
    button.disabled = false;
    return;
  }

  stages.forEach((stage, index) => {
    replayTimers.push(setTimeout(() => {
      rows.forEach((row) => row.classList.remove('is-current'));
      rows[index].classList.add('is-revealed', 'is-current');
      progress.textContent = `Accelerated artifact replay · ${index + 1}/${stages.length}`;
      liveRegion.textContent = `Recorded stage ${index + 1} of ${stages.length}: ${stage.label}, ${stage.status}.`;

      if (index === stages.length - 1) {
        replayTimers.push(setTimeout(() => {
          rows[index].classList.remove('is-current');
          progress.textContent = `Replay complete · ${stages.length} validated stages`;
          liveRegion.textContent = 'Recorded artifact replay complete. No models were run.';
          button.disabled = false;
        }, 450));
      }
    }, index * 420));
  });
}

function setupDrawers() {
  const backdrop = document.querySelector('.drawer-backdrop');
  const drawers = [...document.querySelectorAll('.pane')];

  function closeDrawers() {
    drawers.forEach((drawer) => drawer.classList.remove('is-open'));
    backdrop.hidden = true;
  }

  document.querySelectorAll('[data-open-drawer]').forEach((button) => {
    button.addEventListener('click', () => {
      closeDrawers();
      const drawer = document.querySelector(`#${button.dataset.openDrawer}`);
      drawer.classList.add('is-open');
      backdrop.hidden = false;
      drawer.querySelector('[data-close-drawer]').focus();
    });
  });

  document.querySelectorAll('[data-close-drawer]').forEach((button) => button.addEventListener('click', closeDrawers));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawers();
  });
}

function showError() {
  decisionContent.setAttribute('aria-busy', 'false');
  decisionContent.innerHTML = `
    <section class="error-card" role="alert">
      <span class="eyebrow">Replay unavailable</span>
      <h1>The recorded artifact could not be opened.</h1>
      <p>No live fallback was attempted. Reload the static page to try the same sanitized fixture again.</p>
      <button type="button" id="reload-button">Reload replay</button>
    </section>
  `;
  sessionContent.innerHTML = '';
  activityContent.innerHTML = '';
  progress.textContent = 'Recorded artifact unavailable';
  document.querySelector('#reload-button').addEventListener('click', () => window.location.reload());
}

async function loadReplay() {
  try {
    const response = await fetch(REPLAY_PATH, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Replay request failed: ${response.status}`);
    const data = await response.json();
    assertReplay(data);
    renderSession(data);
    renderDecision(data);
    renderActivity(data);
    startReplay(data.activity);
  } catch (error) {
    console.error(error);
    showError();
  }
}

setupDrawers();
loadReplay();
