// Application : routage, navigation latérale, suivi des traitements, pages globales.
import { api, html, raw, esc, toast, badge, fmtDate, options } from './core.js';
import { PROJECT_PAGES, WIZARD } from './pages.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const projectBar = document.getElementById('projectBar');

const app = {
  status: null,
  project: null,
  route: null,
  page: null,
  lastSig: '',
  pollTimer: null,
};

const getActive = () => { try { return localStorage.getItem('activeProject') || ''; } catch { return ''; } };
const setActive = (id) => { try { localStorage.setItem('activeProject', id); } catch { /* stockage indisponible */ } };

// --- Routage -------------------------------------------------------------------------------

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [pathPart, qs] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(qs || '');
  if (parts[0] === 'p' && parts[1] && parts[2] === 'go') return { name: 'wizard', step: Number(parts[3]) || 1, projectId: parts[1], query };
  if (parts[0] === 'p' && parts[1]) return { name: parts[2] || 'source', projectId: parts[1], query };
  return { name: parts[0] || 'dashboard', query };
}

const GLOBAL_PAGES = { dashboard: dashboardPage, scripts: scriptsPage, history: historyPage, settings: settingsPage };

// Raccourcis du menu qui ouvrent une page du projet actif.
const PROJECT_SHORTCUTS = { source: 'source', reference: 'reference', voice: 'voice', montage: 'montage' };

async function navigate() {
  const r = parseRoute();
  app.route = r;
  document.getElementById('sidebar').classList.remove('open');
  if (!r.projectId && r.name === 'new') return quickStart(r.query.get('then'));
  if (!r.projectId && PROJECT_SHORTCUTS[r.name]) {
    const id = getActive();
    if (id) { location.hash = `#/p/${id}/${PROJECT_SHORTCUTS[r.name]}`; return; }
    return quickStart(r.name);
  }
  if (r.projectId) {
    try {
      app.project = await api('GET', `/api/projects/${r.projectId}`);
      setActive(r.projectId);
    } catch (e) {
      app.project = null;
      setActive('');
      view.innerHTML = html`<div class="empty"><p>${e.message}</p><a class="btn" href="#/">Retour au tableau de bord</a></div>`;
      renderNav();
      return;
    }
    app.page = r.name === 'wizard' ? WIZARD : PROJECT_PAGES[r.name] || PROJECT_PAGES.source;
  } else {
    app.page = GLOBAL_PAGES[r.name] || dashboardPage;
    if (getActive() && !app.project) app.project = await api('GET', `/api/projects/${getActive()}`).catch(() => { setActive(''); return null; });
  }
  app.lastSig = '';
  await render(true);
  schedulePoll();
}

// --- Rendu -------------------------------------------------------------------------------------

function ctx() {
  return { app, p: app.project, route: app.route, status: app.status, refresh, reload: navigate, setProject: (p) => { app.project = p; return render(); } };
}

async function render(first = false) {
  renderNav();
  renderProjectBar();
  const page = app.page;
  const c = ctx();
  if (first && page.load) await page.load(c);
  // Préserve les lecteurs média et les saisies non enregistrées lors d'un nouveau rendu.
  const media = new Map([...view.querySelectorAll('video[data-key], audio[data-key]')].map((el) => [el.dataset.key + '|' + el.getAttribute('src'), el]));
  const dirty = new Map([...view.querySelectorAll('[data-keep][data-dirty="1"]')].map((el) => [el.id, el.value]));
  const focusId = document.activeElement?.id;
  const sel = document.activeElement && 'selectionStart' in document.activeElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scroll = window.scrollY;

  view.innerHTML = page.render(c);

  for (const el of view.querySelectorAll('video[data-key], audio[data-key]')) {
    const old = media.get(el.dataset.key + '|' + el.getAttribute('src'));
    if (old) el.replaceWith(old);
  }
  for (const [id, v] of dirty) { const el = document.getElementById(id); if (el) { el.value = v; el.dataset.dirty = '1'; } }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus({ preventScroll: true }); if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(...sel); } catch { /* type sans sélection */ } }
  }
  if (!first) window.scrollTo(0, scroll);
  page.bind?.(view, c);
}

async function refresh() {
  if (app.route?.projectId) app.project = await api('GET', `/api/projects/${app.route.projectId}`);
  app.lastSig = signature();
  await render();
  schedulePoll();
}

const signature = () => (app.project ? app.project.updatedAt + JSON.stringify(app.project.pipeline) : '');

// Une liste déroulante ouverte serait refermée par un nouveau rendu : le suivi attend que le choix soit fait.
let picking = false;
view.addEventListener('focusin', (e) => { if (e.target.tagName === 'SELECT') picking = true; });
view.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') picking = false; });
view.addEventListener('focusout', (e) => { if (e.target.tagName === 'SELECT') picking = false; });

// Suivi des traitements : interrogation rapide tant qu'un traitement tourne.
function schedulePoll() {
  clearTimeout(app.pollTimer);
  const busy = app.project?.pipeline?.running;
  app.pollTimer = setTimeout(async () => {
    try {
      if (app.route?.projectId) {
        app.project = await api('GET', `/api/projects/${app.route.projectId}`);
        const sig = signature();
        if (sig !== app.lastSig && !picking) {
          const wasRunning = app.lastSig && app.lastSig.includes('"running":true');
          app.lastSig = sig;
          await render();
          if (wasRunning && !app.project.pipeline.running) {
            const job = app.project.job;
            if (job?.status === 'error') toast(job.message, 'error');
            else if (job?.status === 'waiting') toast(job.message);
            else toast('Traitement terminé.');
          }
        }
      } else if (app.page?.poll) {
        await app.page.poll(ctx());
      }
    } catch { /* serveur momentanément indisponible */ }
    schedulePoll();
  }, busy ? 900 : 4000);
}

function renderNav() {
  const p = app.project;
  const r = app.route || {};
  const link = (href, label, active, extra = '') => `<a class="nav-link${active ? ' active' : ''}" href="${href}">${extra}${esc(label)}</a>`;
  const g = [
    '<div class="nav-group">Studio</div>',
    link('#/', 'Tableau de bord', r.name === 'dashboard' && !r.projectId, '<span class="num">⌂</span>'),
    link('#/new', 'Nouvelle vidéo', r.name === 'new', '<span class="num">+</span>'),
    link('#/source', 'Vidéo à modifier', r.projectId && r.name === 'source', '<span class="num">◧</span>'),
    link('#/reference', 'Extraction de scripts TikTok', r.projectId && r.name === 'reference', '<span class="num">❝</span>'),
    link('#/scripts', 'Mes scripts', r.name === 'scripts', '<span class="num">≡</span>'),
    link('#/voice', 'Génération de voix off', r.projectId && r.name === 'voice', '<span class="num">♪</span>'),
    link('#/montage', 'Montage vidéo', r.projectId && r.name === 'montage', '<span class="num">✂</span>'),
    link('#/history', 'Historique des traitements', r.name === 'history', '<span class="num">↺</span>'),
    link('#/settings', 'Paramètres et intégrations API', r.name === 'settings', '<span class="num">⚙</span>'),
  ];
  if (p) {
    g.push(`<div class="nav-group">Projet : ${esc(p.name)}</div>`);
    g.push(link(`#/p/${p.id}/go/${wizardStep(p)}`, 'Assistant rapide (5 étapes)', r.projectId && r.name === 'wizard', '<span class="num">⚡</span>'));
    Object.entries(PROJECT_PAGES).forEach(([key, pg], i) => {
      const st = pg.state ? pg.state(p) : 'todo';
      g.push(link(`#/p/${p.id}/${key}`, pg.title, r.projectId && r.name === key, `<span class="num ${st}">${st === 'done' ? '✓' : i + 1}</span>`));
    });
  }
  nav.innerHTML = g.join('');
}

function renderProjectBar() {
  const p = app.project;
  if (!p) { projectBar.innerHTML = '<span class="muted">Aucun projet actif</span><span class="spacer"></span><a class="btn sm primary" href="#/new">Nouvelle vidéo</a>'; return; }
  const job = p.job;
  const st = p.pipeline.status;
  const resume = !p.pipeline.running && job && ['interrupted', 'error'].includes(job.status) && job.target ? '<button class="btn sm" id="barResume">Reprendre</button>' : '';
  projectBar.innerHTML = html`<strong>${p.name}</strong> ${badge(st, st)}
    ${raw(p.pipeline.running ? `<span class="small muted">${esc(p.pipeline.steps[p.pipeline.runningStep]?.label || 'Traitement…')}</span>` : job?.status === 'waiting' ? `<span class="small muted">${esc(job.message)}</span>` : '')}
    <span class="spacer"></span>${raw(resume)}<a class="btn sm ghost" href="#/">Changer de projet</a>`;
  document.getElementById('barResume')?.addEventListener('click', async () => {
    try { app.project = await api('POST', `/api/projects/${p.id}/resume`); await refresh(); } catch (e) { toast(e.message, 'error'); }
  });
}

// --- Pages globales -------------------------------------------------------------------------------

function pipelineMini(pl) {
  const order = ['source_analyze', 'reference_extract', 'narrative_agent', 'script_agent', 'voice', 'montage', 'export'];
  return raw(`<div class="pipeline-mini">${order.map((s) => `<span class="${pl.steps[s].state}" title="${esc(pl.steps[s].label)} : ${esc(pl.steps[s].state)}"></span>`).join('')}</div>`);
}

let projectsCache = [];
// --- Soldes des API (OpenRouter, FAL) -----------------------------------------------------------

let balancesCache = null;
const usd = (x) => Number(x).toLocaleString('fr-FR', { style: 'currency', currency: 'USD' });
const loadBalances = () => api('GET', '/api/balances').then((b) => { balancesCache = b; }).catch(() => {});

function lowBalanceWarnings() {
  const b = balancesCache;
  if (!b) return [];
  const low = [['OpenRouter (IA)', b.openrouter], ['FAL (voix off)', b.fal]].filter(([, x]) => x?.low)
    .map(([name, x]) => `Solde ${esc(name)} bas : ${usd(x.available)} restants. Rechargez avant que les traitements échouent : <a href="${esc(x.link)}" target="_blank" rel="noopener">recharger</a>`);
  const capped = [['openrouter', 'OpenRouter (IA)'], ['fal', 'FAL (voix off)']].filter(([k]) => b.budget?.[k]?.limit && b.budget[k].spent >= b.budget[k].limit)
    .map(([k, name]) => `Limite de dépense ${esc(name)} atteinte (${usd(b.budget[k].spent)} sur ${usd(b.budget[k].limit)} ${esc(b.budget.periodLabel)}) : les étapes qui l'utilisent sont bloquées. <a href="#/settings">Modifier la limite</a>`);
  return [...low, ...capped];
}

function balanceCard() {
  const b = balancesCache;
  const row = (name, x) => {
    if (!x) return '';
    if (!x.configured) return `<li><span><strong>${esc(name)}</strong><div class="small muted">Clé non configurée.</div></span>${badge('todo', 'non configurée').s}</li>`;
    if (x.error) return `<li><span><strong>${esc(name)}</strong><div class="small muted">${esc(x.error)}</div>${x.link ? `<a class="small" href="${esc(x.link)}" target="_blank" rel="noopener">Voir le solde sur le site</a>` : ''}</span>${badge('stale', 'solde inconnu').s}</li>`;
    const detail = [x.purchased != null ? 'acheté ' + usd(x.purchased) : '', x.used != null ? 'consommé ' + usd(x.used) : '',
      x.keyRemaining != null && x.keyRemaining < x.balance ? 'plafond restant de la clé ' + usd(x.keyRemaining) : ''].filter(Boolean).join(' · ');
    return `<li><span><strong>${esc(name)}</strong> <span style="font-size:20px;font-weight:700;margin-left:6px">${usd(x.available)}</span>
      <div class="small muted">${esc(detail)}${detail ? ' · ' : ''}<a href="${esc(x.link)}" target="_blank" rel="noopener">Recharger</a></div></span>${badge(x.low ? 'error' : 'done', x.low ? 'solde bas' : 'ok').s}</li>`;
  };
  return html`<div class="card"><div class="row"><h2 style="margin:0">Soldes des API</h2><span class="spacer"></span><button class="btn sm" id="bal-refresh">Actualiser</button></div>
    ${b ? raw(`<ul class="steps-list" style="margin-top:10px">${row('OpenRouter (IA)', b.openrouter)}${row('FAL (voix off)', b.fal)}</ul>
      <p class="small muted">Alerte en dessous de ${usd(b.lowThreshold)}. Mis à jour ${esc(fmtDate(b.at))}.</p>`) : raw('<p class="small muted">Soldes indisponibles pour le moment.</p>')}
    ${budgetSection()}</div>`;
}

const BUDGET_PERIODS = [['day', 'par jour'], ['week', 'par semaine'], ['month', 'par mois'], ['total', 'au total']];

// Limites de dépense : au-delà, l'application refuse tout nouvel appel payant à l'API concernée.
function budgetSection() {
  const st = app.settings?.budget || { period: 'month', openrouter: 0, fal: 0 };
  const bs = balancesCache?.budget;
  const meter = (service, name) => {
    const x = bs?.[service];
    const limit = Number(st[service]) || 0;
    const spentTxt = x?.spent != null ? `${usd(x.spent)} dépensés ${esc(bs.periodLabel)}${x.estimated ? ' (estimation)' : ''}` : x?.error ? `Dépense inconnue : ${esc(x.error)}` : '';
    const ratio = limit && x?.spent != null ? Math.min(1, x.spent / limit) : 0;
    return `<div class="field"><label for="bud-${service}">Limite ${esc(name)} ($, 0 = aucune)</label>
      <input id="bud-${service}" type="number" min="0" step="0.5" value="${esc(limit)}">
      ${limit ? `<div class="progress" style="margin-top:6px"><div style="width:${Math.round(ratio * 100)}%;${ratio >= 1 ? 'background:var(--err)' : ratio >= 0.8 ? 'background:var(--warn)' : ''}"></div></div>` : ''}
      <div class="hint">${spentTxt}${limit && ratio >= 1 ? ' — <strong>limite atteinte : appels bloqués</strong>' : ''}</div></div>`;
  };
  return raw(`<hr><h3>Limites de dépense</h3>
    <p class="small muted">Au-delà de la limite, les étapes qui utilisent l'API concernée sont refusées au lieu de dépenser davantage.
      OpenRouter : dépense réelle de la clé. FAL : estimation d'après le nombre de caractères synthétisés (≈ 0,10 $ / 1000).</p>
    <div class="grid three">
      <div class="field"><label for="bud-period">Période</label><select id="bud-period">${options(BUDGET_PERIODS, st.period)}</select></div>
      ${meter('openrouter', 'OpenRouter')}${meter('fal', 'FAL')}
    </div>
    <div class="row end"><button class="btn sm primary" id="bud-save">Enregistrer les limites</button></div>`);
}

function dashboardPage() { return dashboardPage; }
Object.assign(dashboardPage, {
  async load() {
    projectsCache = await api('GET', '/api/projects'); app.status = await api('GET', '/api/status');
    // Les soldes ne bloquent pas l'affichage : la page est redessinée seulement si une alerte est à montrer.
    loadBalances().then(() => { if (app.page === dashboardPage && lowBalanceWarnings().length) render(); });
  },
  async poll(c) { const list = await api('GET', '/api/projects'); if (JSON.stringify(list) !== JSON.stringify(projectsCache)) { projectsCache = list; await render(); } },
  render(c) {
    const s = c.status;
    const counts = { 'à faire': 0, 'en cours': 0, 'en attente': 0, 'terminé': 0, 'erreur': 0 };
    projectsCache.forEach((p) => { counts[p.pipeline.status] = (counts[p.pipeline.status] || 0) + 1; });
    const warn = [];
    if (s && !s.tools.ffmpeg) warn.push('FFmpeg est introuvable : le montage et l\'export sont impossibles.');
    if (s && !s.ai) warn.push('Clé OpenRouter absente : transcription, analyses et réécriture IA désactivées (le texte collé et les sous-titres restent possibles).');
    if (s && !s.remoteFetch.available) warn.push('Récupération par lien TikTok indisponible : ' + s.remoteFetch.reason);
    return html`
      <div class="page-head"><div><h1>Tableau de bord</h1><div class="sub">Vos projets de reposts améliorés et leur état d'avancement.</div></div>
        <a class="btn primary" href="#/new">▶ Commencer une nouvelle vidéo</a></div>
      ${raw(warn.map((w) => `<div class="alert warning">${esc(w)} <a href="#/settings">Paramètres</a></div>`).join(''))}
      ${raw(lowBalanceWarnings().map((w) => `<div class="alert error">${w}</div>`).join(''))}
      <div class="grid three" style="margin-bottom:16px">
        <div class="card"><div class="muted small">En cours / en attente</div><div style="font-size:26px;font-weight:700">${counts['en cours'] + (counts['en attente'] || 0)}</div></div>
        <div class="card"><div class="muted small">Terminés</div><div style="font-size:26px;font-weight:700">${counts['terminé']}</div></div>
        <div class="card"><div class="muted small">En erreur</div><div style="font-size:26px;font-weight:700">${counts['erreur']}</div></div>
      </div>
      ${projectsCache.length ? raw(`<div class="project-cards">${projectsCache.map((p) => html`
        <div class="project-card">
          <a href="#/p/${p.id}/${nextPage(p)}">
            <div class="thumb" style="background-image:url('${raw(esc(p.thumb))}')"></div>
            <div class="body">
              <div class="row"><strong>${p.name}</strong><span class="spacer"></span>${badge(p.pipeline.status, p.pipeline.status)}</div>
              <div class="small muted">Modifié le ${fmtDate(p.updatedAt)}${p.publications ? ` · publiée ${p.publications} fois sur TikTok` : ''}</div>
              ${p.sourceShares != null ? html`<div class="small muted">Vidéo d'origine : ${Number(p.sourceShares).toLocaleString('fr-FR')} partages et republications</div>` : ''}
              ${pipelineMini(p.pipeline)}
              ${raw(p.job?.status === 'error' ? `<div class="small" style="color:var(--err);margin-top:6px">${esc(p.job.message.slice(0, 140))}</div>` : p.job?.status === 'interrupted' ? '<div class="small" style="color:var(--warn);margin-top:6px">Interrompu — ouvrez le projet pour reprendre.</div>' : '')}
            </div>
          </a>
          <div class="foot"><button class="btn sm danger" data-delete="${p.id}"${raw(p.pipeline.running ? ' disabled title="Traitement en cours"' : '')}>Supprimer</button></div>
        </div>`).join('')}</div>`)
        : raw('<div class="card empty"><p>Aucun projet pour l\'instant.</p><a class="btn primary" href="#/new">▶ Commencer ma première vidéo</a></div>')}`;
  },
  bind(root) {
    root.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
      const p = projectsCache.find((x) => x.id === b.dataset.delete);
      if (!p || !confirm(`Supprimer définitivement le projet « ${p.name} » ?\n\nLes vidéos, scripts, voix off et exports de ce projet seront effacés. Cette action est irréversible.`)) return;
      b.disabled = true;
      try {
        await api('DELETE', `/api/projects/${p.id}`);
        if (getActive() === p.id) { setActive(''); app.project = null; }
        projectsCache = await api('GET', '/api/projects');
        toast(`Projet « ${p.name} » supprimé.`);
        render();
      } catch (e) { b.disabled = false; toast(e.message, 'error'); }
    }));
  },
});

// Étape de l'assistant où reprendre un projet.
function wizardStep(p) {
  const st = p.pipeline.steps;
  if (['done', 'running', 'error'].includes(st.export.state) || p.pipeline.runningStep === 'voice' || p.pipeline.runningStep === 'montage') return 5;
  if (p.finalScript.text || st.reference_extract.state === 'done') return 4;
  if (p.voiceParams) return 3;
  if (st.source_fetch.state === 'done') return 2;
  return 1;
}

function nextPage(p) {
  const st = p.pipeline.steps;
  if (st.export.state === 'done') return 'publish';
  if (st.montage.state === 'done') return 'export';
  if (st.voice.state === 'done') return 'montage';
  if (st.final_script.state === 'done') return 'voice';
  if (st.narrative_agent.state === 'done') return 'script';
  if (st.reference_extract.state === 'done') return st.reference_script.state === 'done' ? 'analysis' : 'reference';
  if (st.source_analyze.state === 'done') return 'reference';
  return 'source';
}

// Démarrage immédiat : le projet est créé sans formulaire, avec les réglages du dernier projet,
// puis renommé automatiquement d'après la vidéo à modifier.
async function quickStart(then) {
  try {
    const p = await api('POST', '/api/projects', { quick: true });
    setActive(p.id);
    app.project = p;
    // Sans page demandée, la nouvelle vidéo s'ouvre dans l'assistant en 5 étapes.
    location.replace(then && PROJECT_PAGES[then] ? `#/p/${p.id}/${then}` : `#/p/${p.id}/go/1`);
  } catch (e) {
    toast(e.message, 'error');
    location.replace('#/');
  }
}

let scriptsCache = [];
function scriptsPage() { return scriptsPage; }
Object.assign(scriptsPage, {
  async load() { scriptsCache = await api('GET', '/api/scripts'); },
  render() {
    return html`<div class="page-head"><div><h1>Mes scripts</h1><div class="sub">Scripts de référence extraits et scripts finaux générés, rangés par projet. Les deux ne sont jamais confondus.</div></div></div>
      ${scriptsCache.length ? raw(scriptsCache.map((s, i) => html`<div class="card">
        <div class="row"><strong>${s.project}</strong>${badge(s.kind === 'final' ? 'done' : 'stale', s.kind === 'final' ? 'Script final' : 'Script de référence')}${badge(s.validated ? 'done' : 'todo', s.validated ? 'validé' : 'brouillon')}
          <span class="spacer"></span><span class="small muted">${fmtDate(s.at)}</span>
          <button class="btn sm" data-copy="${i}">Copier</button><a class="btn sm" href="#/p/${s.projectId}/${s.kind === 'final' ? 'script' : 'reference'}">Ouvrir</a></div>
        ${raw(s.url ? `<div class="small muted mono" style="margin:6px 0">${s.kind === 'final' ? 'Vidéo source' : 'Vidéo de référence'} : ${esc(s.url)}</div>` : '')}
        <details><summary class="small">Afficher le texte (${s.text.split(/\s+/).length} mots)</summary><p style="white-space:pre-wrap;margin-top:8px">${s.text}</p></details>
      </div>`).join('')) : raw('<div class="card empty">Aucun script pour l\'instant.</div>')}`;
  },
  bind(root) {
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(scriptsCache[Number(b.dataset.copy)].text); toast('Script copié.');
    }));
  },
});

let historyCache = [];
const EVENT_LABELS = { start: 'démarrage', done: 'terminé', error: 'erreur', waiting: 'en attente', interrupted: 'interrompu', validated: 'validé', 'auto-validated': 'validé automatiquement', created: 'créé', deleted: 'supprimé' };
function historyPage() { return historyPage; }
Object.assign(historyPage, {
  async load() { historyCache = await api('GET', '/api/history'); projectsCache = await api('GET', '/api/projects'); },
  async poll() { const l = await api('GET', '/api/history'); if (l[0]?.at !== historyCache[0]?.at) { historyCache = l; await render(); } },
  render() {
    const names = Object.fromEntries(projectsCache.map((p) => [p.id, p.name]));
    return html`<div class="page-head"><div><h1>Historique des traitements</h1><div class="sub">Journal de toutes les étapes exécutées, réussies ou en échec.</div></div></div>
      <div class="card">${historyCache.length ? raw(`<table><thead><tr><th>Date</th><th>Projet</th><th>Étape</th><th>Événement</th><th>Détail</th></tr></thead><tbody>${historyCache.map((e) => html`<tr>
        <td class="small">${fmtDate(e.at)}</td><td>${raw(names[e.projectId] ? `<a href="#/p/${esc(e.projectId)}/source">${esc(names[e.projectId])}</a>` : `<span class="muted">${esc(e.projectId)}</span>`)}</td>
        <td class="mono">${e.step}</td><td>${badge(e.event === 'error' ? 'error' : e.event === 'done' || e.event.includes('validated') ? 'done' : e.event === 'start' ? 'running' : 'stale', EVENT_LABELS[e.event] || e.event)}</td>
        <td class="small">${e.detail}</td></tr>`).join('')}</tbody></table>`) : raw('<div class="empty">Aucun traitement pour l\'instant.</div>')}</div>`;
  },
});

const SECRET_INFO = {
  OPENROUTER_API_KEY: { title: 'OpenRouter (IA)', use: 'Transcription audio, OCR, analyse visuelle (Agent A), analyse narrative (B), réécriture (C), contrôle qualité (D), légendes.', link: 'https://openrouter.ai/keys', cost: 'Paiement à l\'usage selon le modèle (Gemini Flash : quelques centimes par projet).' },
  FAL_KEY: { title: 'FAL.ai (voix off)', use: 'Synthèse vocale ElevenLabs multilingue (tons, vitesse, horodatage par mot) ou Inworld.', link: 'https://fal.ai/dashboard/keys', cost: 'Paiement à l\'usage (ElevenLabs ≈ 0,10 $ / 1000 caractères, tarif indicatif).' },
};

// Fournisseur des tâches texte : abonnement Claude (via Claude Code) ou OpenRouter.
function textAICard(s, st) {
  const cc = s.claudeCode || {};
  const t = st.textAI || { provider: 'openrouter', claudeModel: 'opus' };
  const ccState = cc.loggedIn ? badge('done', cc.subscription ? 'connecté (abonnement claude.ai)' : 'connecté') : badge(cc.installed ? 'stale' : 'error', cc.reason || 'indisponible');
  return html`<div class="card"><h2>IA pour les scripts et la publication</h2>
    <p class="small muted">Analyse du script viral, écriture et adaptation du script, contrôle qualité, transformations, titre, description et hashtags.
      La transcription audio, la lecture du texte à l'écran et l'analyse des images restent sur OpenRouter (Claude ne traite pas l'audio).</p>
    <div class="grid two">
      <label class="inline field"><input type="radio" name="tai-provider" value="claude-code"${raw(t.provider === 'claude-code' ? ' checked' : '')}${raw(cc.loggedIn ? '' : ' disabled')}>
        Mon abonnement Claude (via Claude Code) ${ccState}</label>
      <label class="inline field"><input type="radio" name="tai-provider" value="openrouter"${raw(t.provider !== 'claude-code' ? ' checked' : '')}> OpenRouter (modèle texte : ${st.models.text})</label>
    </div>
    <div class="field" style="max-width:420px"><label for="tai-model">Modèle Claude</label><select id="tai-model">${options(cc.models || [['opus', 'Claude Opus']], t.claudeModel)}</select>
      <div class="hint">Les appels sont décomptés des limites d'utilisation de votre abonnement, sans coût supplémentaire. Sonnet est environ 3 fois plus rapide qu'Opus et consomme moins de quota.</div></div>
    <div class="row end"><button class="btn" id="tai-test"${raw(cc.loggedIn ? '' : ' disabled')}>Tester l'abonnement Claude</button><button class="btn primary" id="tai-save">Enregistrer</button></div>
  </div>`;
}

// Méthode d'écriture des scripts : la base des consignes envoyées à l'IA pour écrire, adapter et optimiser les scripts.
function scriptPromptCard(st) {
  const custom = Boolean(String(st.scriptPrompt || '').trim());
  return html`<div class="card"><div class="row"><h2 style="margin:0">Méthode d'écriture des scripts</h2><span class="spacer"></span>${badge(custom ? 'stale' : 'done', custom ? 'personnalisée' : 'par défaut')}</div>
    <p class="small muted" style="margin-top:6px">Ce texte guide l'IA à chaque écriture, adaptation et optimisation de script. L'application y ajoute la langue, l'audience, le ton, la longueur calibrée sur votre voix off, l'analyse de la vidéo et le script d'inspiration.</p>
    <textarea id="sp-text" style="min-height:260px;font-size:13px">${custom ? st.scriptPrompt : st.defaultScriptPrompt}</textarea>
    <div class="row end" style="margin-top:8px"><button class="btn ghost" id="sp-reset"${raw(custom ? '' : ' disabled')}>Revenir au texte par défaut</button><button class="btn primary" id="sp-save">Enregistrer la méthode</button></div></div>`;
}

function settingsPage() { return settingsPage; }
Object.assign(settingsPage, {
  async load() { app.status = await api('GET', '/api/status'); app.settings = await api('GET', '/api/settings'); await loadBalances(); },
  render(c) {
    const s = app.status, st = app.settings;
    return html`<div class="page-head"><div><h1>Paramètres et intégrations API</h1><div class="sub">Les clés sont enregistrées côté serveur dans le fichier .env et ne sont jamais renvoyées au navigateur.</div></div></div>
      ${textAICard(s, st)}
      ${scriptPromptCard(st)}
      ${balanceCard()}
      <div class="grid two">
        <div class="card"><h2>Outils locaux</h2>
          <ul class="steps-list">
            <li>FFmpeg (analyse, montage, export) ${badge(s.tools.ffmpeg ? 'done' : 'error', s.tools.ffmpeg ? 'détecté' : 'absent')}</li>
            <li>yt-dlp (récupération des liens TikTok) ${badge(s.tools.ytdlp ? 'done' : 'error', s.tools.ytdlp ? 'détecté' : 'absent')}</li>
            ${raw(s.tts.map((t) => `<li>${esc(t.label)} ${badge(t.available ? 'done' : 'todo', t.available ? t.voiceCount + ' voix' : t.reason)}</li>`).join(''))}
          </ul>
          <hr>
          <div class="field"><label class="inline"><input type="checkbox" id="st-fetch"${raw(st.remoteFetch.enabled ? ' checked' : '')}> Autoriser la récupération des vidéos à partir d'un lien TikTok (yt-dlp)</label>
            <div class="hint">Vous restez responsable du respect des conditions d'utilisation de TikTok et des droits des auteurs. À défaut, importez vos fichiers manuellement.</div></div>
          <div class="field"><label for="st-yt">Chemin de yt-dlp (facultatif)</label><input id="st-yt" type="text" value="${st.ytdlpPath}" placeholder="détection automatique"></div>
          <h3>Modèles IA (OpenRouter)</h3>
          <div class="field"><label for="st-mm">Modèle multimodal (audio, images)</label><input id="st-mm" type="text" value="${st.models.multimodal}"></div>
          <div class="field"><label for="st-tx">Modèle texte (analyse, réécriture)</label><input id="st-tx" type="text" value="${st.models.text}"></div>
          <div class="row end"><button class="btn" id="st-test"${raw(s.ai ? '' : ' disabled')}>Tester OpenRouter</button><button class="btn primary" id="st-save">Enregistrer</button></div>
        </div>
        <div class="card"><h2>Clés API</h2>
          ${raw(Object.entries(SECRET_INFO).map(([k, info]) => html`<div class="field">
            <label for="sec-${k}">${info.title} ${badge(s.secrets[k] ? 'done' : 'todo', s.secrets[k] ? 'configurée' : 'non configurée')}</label>
            <div class="row"><input id="sec-${k}" type="password" autocomplete="off" placeholder="${s.secrets[k] ? '•••••••• (laisser vide pour conserver)' : 'Coller la clé'}" style="flex:1"><button class="btn sm" data-secret="${k}">Enregistrer</button></div>
            <div class="hint">${info.use} ${info.cost} <a href="${info.link}" target="_blank" rel="noopener">Obtenir</a></div></div>`).join(''))}
        </div>
      </div>`;
  },
  bind(root) {
    const saveSP = async (text, msg) => {
      try { app.settings = await api('PUT', '/api/settings', { scriptPrompt: text }); toast(msg); render(); } catch (e) { toast(e.message, 'error'); }
    };
    root.querySelector('#sp-save').addEventListener('click', () => saveSP(root.querySelector('#sp-text').value, 'Méthode d\'écriture enregistrée : elle servira pour les prochains scripts.'));
    root.querySelector('#sp-reset').addEventListener('click', () => { if (confirm('Revenir au texte par défaut ?')) saveSP('', 'Texte par défaut rétabli.'); });
    root.querySelector('#tai-save').addEventListener('click', async () => {
      try {
        app.settings = await api('PUT', '/api/settings', { textAI: { provider: root.querySelector('[name="tai-provider"]:checked').value, claudeModel: root.querySelector('#tai-model').value } });
        toast('Fournisseur IA enregistré.'); render();
      } catch (e) { toast(e.message, 'error'); }
    });
    root.querySelector('#tai-test')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { const r = await api('POST', '/api/test/claude'); toast(r.ok ? `Abonnement Claude opérationnel (${r.model}).` : 'Réponse inattendue.'); } catch (err) { toast(err.message, 'error'); }
      e.target.disabled = false;
    });
    root.querySelector('#bal-refresh').addEventListener('click', async (e) => { e.target.disabled = true; await loadBalances(); render(); });
    root.querySelector('#bud-save').addEventListener('click', async () => {
      try {
        app.settings = await api('PUT', '/api/settings', { budget: { period: root.querySelector('#bud-period').value,
          openrouter: root.querySelector('#bud-openrouter').value, fal: root.querySelector('#bud-fal').value } });
        await loadBalances(); toast('Limites de dépense enregistrées.'); render();
      } catch (e) { toast(e.message, 'error'); }
    });
    root.querySelector('#st-save').addEventListener('click', async () => {
      try {
        await api('PUT', '/api/settings', { remoteFetch: { enabled: root.querySelector('#st-fetch').checked }, ytdlpPath: root.querySelector('#st-yt').value,
          models: { multimodal: root.querySelector('#st-mm').value, text: root.querySelector('#st-tx').value } });
        toast('Paramètres enregistrés.'); await settingsPage.load(); render();
      } catch (e) { toast(e.message, 'error'); }
    });
    root.querySelector('#st-test')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { const r = await api('POST', '/api/test/openrouter'); toast(r.ok ? `Connexion OpenRouter opérationnelle (${r.model}).` : 'Réponse inattendue.'); } catch (err) { toast(err.message, 'error'); }
      e.target.disabled = false;
    });
    root.querySelectorAll('[data-secret]').forEach((b) => b.addEventListener('click', async () => {
      const input = root.querySelector('#sec-' + b.dataset.secret);
      if (!input.value) return toast('Collez d\'abord la clé.', 'error');
      try { await api('PUT', '/api/secrets', { name: b.dataset.secret, value: input.value }); toast('Clé enregistrée côté serveur.'); await settingsPage.load(); render(); } catch (e) { toast(e.message, 'error'); }
    }));
  },
});

// --- Démarrage -----------------------------------------------------------------------------------

view.addEventListener('input', (e) => { if (e.target.matches('[data-keep]')) e.target.dataset.dirty = '1'; });
document.getElementById('menuBtn').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
window.addEventListener('hashchange', navigate);
api('GET', '/api/version').then((v) => { document.getElementById('appVersion').textContent = 'v' + v.version; }).catch(() => {});
api('GET', '/api/status').then((s) => { app.status = s; }).finally(navigate);
