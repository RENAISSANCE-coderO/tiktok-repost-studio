// Les 8 pages du workflow d'un projet.
import { api, upload, html, raw, esc, toast, badge, fmtDuration, fmtTime, fmtSize, fmtDate, fileUrl, stepError, progressBar, options, wordCount, WPS, LANGS, TONES, SCRIPT_MODES } from './core.js';
import { montagePage } from './montage.js';
import { voiceCards, bindVoiceCards } from './voicecards.js';
import { wizardPage } from './wizard.js';
import { promptBox, bindPromptBox } from './promptbox.js';

const S = (p, name) => p.pipeline.steps[name];
const st = (p, name) => S(p, name).state;
const anyRunning = (p) => p.pipeline.running;

// Exécute une action, affiche l'erreur éventuelle, puis rafraîchit le projet.
async function act(c, fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); await c.refresh(); return r; } catch (e) { toast(e.message, 'error'); await c.refresh().catch(() => {}); }
}

function bindCommon(root, c) {
  root.querySelectorAll('[data-action="resume"]').forEach((b) => b.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${c.p.id}/resume`))));
  root.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${c.p.id}/run`, { target: b.dataset.run, force: b.dataset.force ? [b.dataset.run] : [] }))));
}

function dropzone(id, accept, label) {
  return raw(`<label class="dropzone" for="${id}" data-drop="${id}"><div style="font-size:22px">⬆</div>${esc(label)}<div class="small">Glissez-déposez ou cliquez pour choisir</div><input id="${id}" type="file" accept="${esc(accept)}" hidden></label>`);
}
function bindDrop(root, id, onFile) {
  const input = root.querySelector('#' + id);
  const zone = root.querySelector(`[data-drop="${id}"]`);
  if (!input || !zone) return;
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
}
async function doUpload(c, url, file, headers, zoneSel) {
  const zone = document.querySelector(zoneSel);
  try {
    await upload(url, file, headers, (f) => { if (zone) zone.innerHTML = `Import en cours… ${Math.round(f * 100)} %<div class="progress"><div style="width:${f * 100}%"></div></div>`; });
    toast('Fichier importé.');
  } catch (e) { toast(e.message, 'error'); }
  await c.refresh();
}

const nextBtn = (p, page, label) => raw(`<a class="btn primary" href="#/p/${p.id}/${page}">${esc(label)} →</a>`);

// =====================================================================================
// Page 1 — Vidéo à modifier
// =====================================================================================
const fmtCount = (n) => (n == null ? '–' : Number(n).toLocaleString('fr-FR'));

// Statistiques publiques de la vidéo à modifier : combien de fois les gens l'ont partagée ou republiée.
function sourceStatsCard(p) {
  const s = p.source.stats;
  const hist = p.source.statsHistory || [];
  const first = hist.length > 1 ? hist[0] : null;
  const delta = first && s?.shares != null && first.shares != null ? s.shares - first.shares : null;
  const up = s?.uploadDate ? `${s.uploadDate.slice(6, 8)}/${s.uploadDate.slice(4, 6)}/${s.uploadDate.slice(0, 4)}` : '';
  return html`<div class="card"><div class="row"><h2 style="margin:0">Republications sur TikTok</h2><span class="spacer"></span>
      <button class="btn sm" id="src-stats">Actualiser</button></div>
    ${s ? html`<div class="row" style="align-items:baseline;gap:10px;margin-top:10px"><div style="font-size:40px;font-weight:800">${fmtCount(s.shares)}</div>
        <div class="small muted">fois partagée ou republiée${delta != null ? ` · ${delta >= 0 ? '+' : ''}${fmtCount(delta)} depuis le ${fmtDate(first.at)}` : ''}</div></div>
      <dl class="kv" style="margin-top:10px">
        <dt>Vues</dt><dd>${fmtCount(s.views)}</dd>
        <dt>J'aime</dt><dd>${fmtCount(s.likes)}</dd>
        <dt>Commentaires</dt><dd>${fmtCount(s.comments)}</dd>
        <dt>Enregistrements</dt><dd>${fmtCount(s.saves)}</dd>
        ${up ? html`<dt>Publiée le</dt><dd>${up}</dd>` : ''}
      </dl>
      <p class="small muted">Relevé ${s.at ? 'le ' + fmtDate(s.at) : 'à la récupération de la vidéo'}. TikTok regroupe dans ce chiffre les partages et les republications (bouton « Republier »). Les copies réimportées par d'autres comptes ne sont pas comptées : TikTok ne les relie pas à la vidéo d'origine.</p>`
    : raw('<p class="small muted" style="margin-top:8px">TikTok n\'a pas fourni de statistiques lors de la récupération. Cliquez sur « Actualiser ».</p>')}
  </div>`;
}

// Détecteur de copies : autres comptes qui ont réimporté la vidéo, retrouvés par comparaison d'images.
const COPY_STATUS = { copie: ['error', 'copie certaine'], probable: ['stale', 'copie probable'], 'différente': ['done', 'vidéo différente'], erreur: ['todo', 'non analysée'] };

function copySearchLinks(p) {
  const info = p.source.info || {};
  const desc = info.description || '';
  const tags = (desc.match(/#[\p{L}\p{N}_]+/gu) || []).slice(0, 4);
  const words = desc.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
  const q = (words || tags.join(' ')).trim();
  const links = [];
  if (q) links.push(['TikTok : même légende', `https://www.tiktok.com/search/video?q=${encodeURIComponent(q)}`]);
  if (tags.length) links.push(['TikTok : mêmes hashtags', `https://www.tiktok.com/search/video?q=${encodeURIComponent(tags.join(' '))}`]);
  if (q || tags.length) links.push(['Google : vidéos TikTok', `https://www.google.com/search?q=${encodeURIComponent(`site:tiktok.com ${q || tags.join(' ')}`)}`]);
  if (info.soundAuthor) links.push([`TikTok : son de ${info.soundAuthor}`, `https://www.tiktok.com/search/video?q=${encodeURIComponent(`${info.track || ''} ${info.soundAuthor}`.trim())}`]);
  return links;
}

function copiesCard(p, busy) {
  const cp = p.copies || {};
  const running = busy && p.pipeline.runningStep === 'copies';
  const order = { copie: 0, probable: 1, 'différente': 2, erreur: 3 };
  const results = (cp.results || []).slice().sort((a, b) => order[a.status] - order[b.status] || (b.views || 0) - (a.views || 0));
  const found = results.filter((r) => r.status === 'copie' || r.status === 'probable');
  const info = p.source.info || {};
  const date = (d) => (d ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : '');
  // Copie publiée avant la vidéo « d'origine » : celle-ci n'est peut-être pas l'originale.
  const older = found.filter((r) => r.uploadDate && info.uploadDate && r.uploadDate < info.uploadDate);
  const soundElsewhere = info.track && /original|originale/i.test(info.track) && info.soundAuthor && info.uploader && !info.soundAuthor.toLowerCase().includes(info.uploader.toLowerCase());
  return html`<div class="card"><div class="row"><h2 style="margin:0">Copies sur d'autres comptes</h2><span class="spacer"></span>${found.length ? badge('error', `${found.length} compte${found.length > 1 ? 's' : ''}`) : ''}</div>
    <p class="small muted">TikTok ne relie pas les réimportations à la vidéo d'origine. L'application compare donc les images : collez des liens de vidéos suspectes, ou des pseudos de comptes dont elle analysera les dernières vidéos.</p>
    ${soundElsewhere ? html`<div class="alert info">Le son de cette vidéo appartient à un autre compte (« ${info.track} » de ${info.soundAuthor}) : @${info.uploader} n'en est peut-être pas l'auteur.</div>` : ''}
    ${raw(copySearchLinks(p).length ? `<div class="small" style="margin-bottom:8px"><strong>Chercher des copies :</strong> ${copySearchLinks(p).map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)}</a>`).join(' · ')}</div>` : '')}
    <div class="field"><label for="cp-urls">Liens de vidéos à vérifier (un par ligne)</label><textarea id="cp-urls" data-keep style="min-height:70px" placeholder="https://www.tiktok.com/@compte/video/…"></textarea></div>
    <div class="row"><div class="field" style="flex:1"><label for="cp-accounts">Comptes à analyser (pseudos, 5 maximum)</label><input id="cp-accounts" type="text" data-keep placeholder="@compte1 @compte2"></div>
      <div class="field" style="width:150px"><label for="cp-limit">Vidéos par compte</label><select id="cp-limit">${options([['10', '10 dernières'], ['20', '20 dernières'], ['50', '50 dernières']], '20')}</select></div></div>
    <button class="btn primary" id="cp-scan"${raw(busy ? ' disabled' : '')}>Rechercher les copies</button>
    ${running && cp.progress ? html`<div class="progress" style="margin-top:10px"><div style="width:${cp.progress.total ? Math.round((cp.progress.done / cp.progress.total) * 100) : 5}%"></div></div><div class="small muted">Vidéo ${Math.min(cp.progress.done + 1, cp.progress.total || 1)} sur ${cp.progress.total || '…'} — environ 20 s par vidéo.</div>` : ''}
    ${cp.error ? html`<div class="alert error">${cp.error}</div>` : ''}
    ${older.length ? html`<div class="alert warning">${older.length === 1 ? 'Une copie a été publiée' : `${older.length} copies ont été publiées`} avant la vidéo « d'origine » (@${older.map((r) => r.account).join(', @')}) : la vraie source est peut-être là.</div>` : ''}
    ${results.length ? raw(`<ul class="steps-list">${results.map((r) => `<li><span>${badge(COPY_STATUS[r.status][0], COPY_STATUS[r.status][1] + (r.match != null && r.status !== 'erreur' ? ` · ${Math.round(r.match * 100)} %` : '')).s}
        <strong>${r.account ? '@' + esc(r.account) : 'compte inconnu'}</strong>${r.mirrored ? ' <span class="small muted">(image retournée en miroir)</span>' : ''}${r.cropped && r.status !== 'différente' ? ' <span class="small muted">(image réduite ou recadrée)</span>' : ''}
        <div class="small"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></div>
        ${r.status === 'erreur' ? `<div class="small muted">${esc(r.error || '')}</div>` : `<div class="small muted">${[r.uploadDate && 'publiée le ' + date(r.uploadDate), r.views != null && fmtCount(r.views) + ' vues', r.likes != null && fmtCount(r.likes) + ' j\'aime', r.shares != null && fmtCount(r.shares) + ' partages'].filter(Boolean).map(esc).join(' · ')}</div>`}</span>
        <button class="btn sm" data-cpdel="${esc(r.id || r.url)}" title="Retirer de la liste">Retirer</button></li>`).join('')}</ul>`) : ''}
    ${results.length ? raw(`<p class="small muted">${cp.scannedAt ? 'Dernière recherche le ' + esc(fmtDate(cp.scannedAt)) + '. ' : ''}Une copie retournée en miroir, réduite ou recadrée est reconnue ; une copie en écran partagé ou très retouchée peut passer inaperçue.</p>`) : ''}
  </div>`;
}

const sourcePage = {
  title: 'Vidéo à modifier',
  state: (p) => (st(p, 'visual_agent') === 'done' ? 'done' : ['source_fetch', 'source_analyze', 'visual_agent'].map((s) => st(p, s)).find((x) => ['running', 'error', 'interrupted'].includes(x)) || (st(p, 'source_analyze') === 'done' ? 'stale' : 'todo')),
  render(c) {
    const p = c.p;
    const fetchSt = c.status?.remoteFetch;
    const a = p.steps.source_analyze?.output;
    const fetchErr = S(p, 'source_fetch');
    const vis = p.steps.visual_agent?.output;
    const busy = anyRunning(p);
    return html`
      <div class="page-head"><div><h1>Vidéo à modifier</h1><div class="sub">La source visuelle de votre nouvelle vidéo. Elle est conservée séparément de la vidéo de référence.</div></div>
        ${st(p, 'source_analyze') === 'done' ? nextBtn(p, 'reference', 'Étape suivante : script de référence') : ''}</div>
      <div class="grid side">
        <div>
          <div class="card">
            <h2>Depuis un lien TikTok</h2>
            <div class="field"><label for="src-url">Lien TikTok de la vidéo à modifier</label>
              <input id="src-url" type="url" data-keep placeholder="https://www.tiktok.com/@compte/video/…" value="${p.source.origin === 'tiktok' ? p.source.url : ''}"></div>
            ${raw(fetchSt && !fetchSt.available ? `<div class="alert warning">${esc(fetchSt.reason)} Utilisez l'import de fichier ci-dessous.</div>` : '')}
            <label class="inline field"><input type="checkbox" id="src-rights"${raw(p.source.rightsConfirmed ? ' checked' : '')}> Je confirme disposer des droits d'utilisation et de modification de cette vidéo.</label>
            <div class="row"><button class="btn primary" id="src-fetch"${raw(busy || (fetchSt && !fetchSt.available) ? ' disabled' : '')}>Récupérer la vidéo</button></div>
            ${progressBar(p, 'source_fetch')}
            ${stepError(p, 'source_fetch', fetchErr.state === 'error' ? '<div class="small" style="margin-top:6px">Solution de remplacement : téléchargez la vidéo depuis l\'application TikTok (si vous en avez le droit) puis importez le fichier ci-dessous.</div>' : '')}
            <h3>Ou importer un fichier</h3>
            ${dropzone('src-file', 'video/*,.mp4,.mov,.webm,.mkv,.m4v', 'Importer une vidéo depuis l\'ordinateur (MP4, MOV, WEBM…)')}
          </div>
          ${a ? html`<div class="card"><h2>Plans détectés (${a.scenes.length})</h2>
            <div class="frames">${raw(a.frames.map((f) => `<figure><img loading="lazy" src="${fileUrl(p, a.framesDir + '/' + f.file, { v: p.steps.source_analyze.finishedAt })}" alt=""><figcaption>Plan ${f.scene} · ${fmtTime(f.t)}</figcaption></figure>`).join(''))}</div>
            <table style="margin-top:12px"><thead><tr><th>Plan</th><th>Début</th><th>Fin</th><th>Durée</th>${raw(vis ? '<th>Contenu visible (Agent A)</th>' : '')}</tr></thead><tbody>
            ${raw(a.scenes.map((s) => { const d = vis?.scenes?.find((x) => x.index === s.index); return `<tr><td>${s.index}</td><td>${fmtTime(s.start)}</td><td>${fmtTime(s.end)}</td><td>${(s.end - s.start).toFixed(1)} s</td>${vis ? `<td>${esc(d?.description || '')}${d?.actions?.length ? `<div class="small muted">${esc(d.actions.join(', '))}</div>` : ''}</td>` : ''}</tr>`; }).join(''))}
            </tbody></table></div>` : ''}
          <div class="card"><div class="row"><h2 style="margin:0">Analyse visuelle (Agent A)</h2><span class="spacer"></span>${badge(st(p, 'visual_agent'))}
            <button class="btn sm" data-run="visual_agent"${raw(st(p, 'visual_agent') === 'done' ? ' data-force="1"' : '')}${raw(busy || st(p, 'source_analyze') !== 'done' ? ' disabled' : '')}>${st(p, 'visual_agent') === 'done' ? 'Relancer' : 'Analyser le contenu'}</button></div>
            ${progressBar(p, 'visual_agent')}${stepError(p, 'visual_agent')}
            ${vis ? html`<p style="margin-top:10px">${vis.summary}</p>
              ${vis.key_moments?.length ? html`<h3>Moments importants</h3><ul>${raw(vis.key_moments.map((k) => `<li><span class="mono">${fmtTime(k.t)}</span> ${esc(k.description)}</li>`).join(''))}</ul>` : ''}
              ${vis.visible_facts?.length ? html`<h3>Faits visibles exploitables</h3><div class="chips">${raw(vis.visible_facts.map((f) => `<span class="chip">${esc(f)}</span>`).join(''))}</div>` : ''}
              ${vis.uncertain?.length ? html`<h3>Incertitudes</h3><ul class="small muted">${raw(vis.uncertain.map((f) => `<li>${esc(f)}</li>`).join(''))}</ul>` : ''}`
              : raw('<p class="muted small" style="margin-top:8px">Lancée automatiquement lors de la génération du script ; vous pouvez la lancer dès maintenant.</p>')}
          </div>
        </div>
        <div>
          <div class="card"><h2>Aperçu</h2>
            ${p.source.file && st(p, 'source_fetch') === 'done' ? raw(`<video class="player" data-key="source" controls preload="metadata" src="${fileUrl(p, p.source.file, { v: p.steps.source_fetch.finishedAt })}"></video>`) : raw('<div class="empty">Aucune vidéo importée.</div>')}
            ${progressBar(p, 'source_analyze')}${stepError(p, 'source_analyze')}
            ${a ? html`<dl class="kv" style="margin-top:12px">
              <dt>Durée</dt><dd>${fmtDuration(a.meta.duration)}</dd>
              <dt>Résolution</dt><dd>${a.meta.width} × ${a.meta.height}${a.meta.height > a.meta.width ? ' (verticale)' : a.meta.height === a.meta.width ? ' (carrée)' : ' (horizontale)'}</dd>
              <dt>Format</dt><dd>${a.meta.container.toUpperCase()} — ${a.meta.format}</dd>
              <dt>Codecs</dt><dd>${a.meta.videoCodec}${a.meta.hasAudio ? ' / ' + a.meta.audioCodec : ' (sans audio)'}</dd>
              <dt>Images/s</dt><dd>${a.meta.fps}</dd>
              <dt>Poids</dt><dd>${fmtSize(a.meta.size)}</dd>
              <dt>Origine</dt><dd>${p.source.origin === 'upload' ? 'Fichier importé' + (p.source.originalName ? ' (' + p.source.originalName + ')' : '') : 'TikTok'}</dd>
            </dl>` : ''}
            ${p.source.oembed?.title ? html`<p class="small muted" style="margin-top:10px">Légende d'origine : ${p.source.oembed.title} — @${p.source.oembed.author}</p>` : ''}
          </div>
          ${p.source.origin === 'tiktok' && st(p, 'source_fetch') === 'done' ? sourceStatsCard(p) : ''}
          ${st(p, 'source_fetch') === 'done' ? copiesCard(p, busy) : ''}
        </div>
      </div>`;
  },
  bind(root, c) {
    bindCommon(root, c);
    root.querySelector('#cp-scan')?.addEventListener('click', () => {
      const v = (s) => root.querySelector(s).value;
      root.querySelectorAll('#cp-urls, #cp-accounts').forEach((el) => delete el.dataset.dirty);
      act(c, () => api('POST', `/api/projects/${c.p.id}/copies/scan`, { urls: v('#cp-urls'), accounts: v('#cp-accounts'), limit: v('#cp-limit') }), 'Recherche des copies lancée…');
    });
    root.querySelectorAll('[data-cpdel]').forEach((b) => b.addEventListener('click', () => act(c, () => api('DELETE', `/api/projects/${c.p.id}/copies?id=${encodeURIComponent(b.dataset.cpdel)}`), 'Retirée de la liste.')));
    root.querySelector('#src-stats')?.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${c.p.id}/source/stats`), 'Statistiques mises à jour.'));
    root.querySelector('#src-fetch')?.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${c.p.id}/source/url`, { url: root.querySelector('#src-url').value, rightsConfirmed: root.querySelector('#src-rights').checked }), 'Récupération lancée…'));
    bindDrop(root, 'src-file', (file) => {
      if (!root.querySelector('#src-rights').checked) return toast('Cochez d\'abord la confirmation des droits d\'utilisation.', 'error');
      doUpload(c, `/api/projects/${c.p.id}/source/upload`, file, { 'x-rights-confirmed': '1' }, '[data-drop="src-file"]');
    });
  },
};

// =====================================================================================
// Page 2 — Extraire un script TikTok (fonctionnalité essentielle)
// =====================================================================================
const METHOD_STATE = { ok: 'done', 'échec': 'error', 'non configurée': 'stale', indisponible: 'todo', vide: 'todo', 'aucune parole': 'todo', 'aucun texte': 'todo' };

const referencePage = {
  title: 'Extraire un script TikTok',
  state: (p) => (st(p, 'reference_script') === 'done' ? 'done' : ['reference_fetch', 'reference_extract'].map((s) => st(p, s)).find((x) => ['running', 'error', 'interrupted'].includes(x)) || (st(p, 'reference_extract') === 'done' ? 'stale' : 'todo')),
  render(c) {
    const p = c.p;
    const busy = anyRunning(p);
    const ex = st(p, 'reference_extract') === 'done' || st(p, 'reference_extract') === 'stale' ? p.steps.reference_extract?.output : null;
    const fetchSt = c.status?.remoteFetch;
    const failed = st(p, 'reference_fetch') === 'error' || st(p, 'reference_extract') === 'error';
    const same = p.reference.url && p.reference.url === p.source.url;
    const tr = ex?.transcript;
    const refFile = p.reference.file && ['done', 'stale'].includes(st(p, 'reference_fetch')) ? p.reference.file : '';
    const isAudio = /\.(mp3|wav|m4a|aac|ogg)$/i.test(refFile);
    const editing = c.app.editRef ?? !p.reference.validated;
    const uncertain = p.reference.validated ? [] : tr?.segments?.filter((s) => s.uncertain) || [];
    return html`
      <div class="page-head"><div><h1>Extraire un script TikTok</h1><div class="sub">Collez le lien d'une vidéo TikTok performante : son script servira de <strong>base</strong> et sera adapté au contenu de votre vidéo à modifier.</div></div>
        ${st(p, 'reference_script') === 'done' ? nextBtn(p, 'analysis', 'Voir l\'analyse narrative') : ''}</div>
      <div class="grid side">
        <div>
          <div class="card">
            <div class="field"><label for="ref-url">Lien TikTok de référence</label>
              <input id="ref-url" type="url" data-keep placeholder="https://www.tiktok.com/@compte/video/…" value="${p.reference.origin === 'tiktok' ? p.reference.url : ''}">
              <div class="hint">Distinct de la vidéo à modifier${p.source.url ? ' (' + p.source.url + ')' : ''}.</div></div>
            ${same ? raw('<div class="alert info">Ce lien est identique à celui de la vidéo à modifier : c\'est possible, mais vérifiez qu\'il s\'agit bien de la vidéo d\'inspiration.</div>') : ''}
            ${raw(fetchSt && !fetchSt.available ? `<div class="alert warning">Récupération par lien indisponible : ${esc(fetchSt.reason)} Utilisez l'import de fichier ou collez le texte.</div>` : '')}
            <div class="row"><button class="btn primary" id="ref-extract"${raw(busy || (fetchSt && !fetchSt.available) ? ' disabled' : '')}>Extraire le script</button>
              ${!c.status?.ai ? raw('<span class="small muted">Sans clé OpenRouter, seuls les sous-titres publiés peuvent être récupérés.</span>') : ''}</div>
            ${progressBar(p, 'reference_fetch')}${progressBar(p, 'reference_extract')}
            ${stepError(p, 'reference_fetch')}${stepError(p, 'reference_extract')}
            ${failed || !fetchSt?.available || c.app.showFallback ? html`
              <div class="alert info"><strong>Solutions de remplacement</strong>Importez le fichier vidéo ou audio de la référence, ou collez directement son texte.</div>
              <div class="grid two">
                <div>${dropzone('ref-file', 'video/*,audio/*,.mp4,.mov,.webm,.mp3,.wav,.m4a', 'Importer la vidéo ou l\'audio de référence')}</div>
                <div><textarea id="ref-paste" data-keep placeholder="Collez ici le texte du script de référence…" style="min-height:110px"></textarea>
                  <div class="row end" style="margin-top:6px"><button class="btn" id="ref-paste-btn"${raw(busy ? ' disabled' : '')}>Utiliser ce texte</button></div></div>
              </div>` : raw('<button class="btn ghost sm" id="ref-show-fallback">Importer un fichier ou coller le texte à la place</button>')}
          </div>

          <div class="card">
            <div class="row"><h2 style="margin:0">Script de référence</h2>
              ${tr ? badge(p.reference.validated ? 'done' : 'stale', p.reference.validated ? 'validé' : 'à vérifier') : ''}
              <span class="spacer"></span>
              ${tr?.language && tr.languageConfidence !== 'low' ? raw(`<span class="chip">Langue détectée : ${esc(tr.language)}</span>`) : tr ? raw('<span class="chip">Langue non déterminée</span>') : ''}
              ${tr ? raw(`<span class="chip">Source : ${esc({ audio: 'transcription audio', subtitles: 'sous-titres', ocr: 'texte à l\'écran', manual: 'texte collé' }[tr.source])}</span>`) : ''}
            </div>
            ${tr?.source === 'ocr' ? raw('<div class="alert warning" style="margin-top:10px">Aucune parole détectée : ce script provient du texte affiché à l\'écran. Vérifiez qu\'il correspond bien à la narration.</div>') : ''}
            ${uncertain.length ? raw(`<div class="alert warning" style="margin-top:10px"><strong>${uncertain.length} passage(s) incertain(s)</strong>Vérifiez-les et corrigez le texte : les passages inaudibles ne sont jamais complétés automatiquement (marqueur [inaudible]).</div>`) : ''}
            <textarea id="ref-script" class="script" data-keep style="margin-top:10px"${raw(editing ? '' : ' readonly')} placeholder="Le script récupéré s'affichera ici.">${p.reference.script}</textarea>
            <div class="row" style="margin-top:10px">
              <button class="btn" id="ref-copy"${raw(p.reference.script ? '' : ' disabled')}>Copier le script</button>
              <button class="btn" id="ref-edit"${raw(p.reference.script ? '' : ' disabled')}>${editing ? 'Enregistrer les modifications' : 'Modifier le script'}</button>
              <span class="small muted" id="ref-wc">${wordCount(p.reference.script)} mots</span>
              <span class="spacer"></span>
              <button class="btn primary" id="ref-validate"${raw(!p.reference.script || busy ? ' disabled' : '')}>Valider le script de référence</button>
            </div>
            ${p.reference.validated ? raw(`<p class="small muted" style="margin-top:8px">Validé le ${fmtDate(p.reference.validatedAt)} et transmis à l'analyse narrative.</p>`) : ''}
          </div>

          ${tr?.segments?.length && tr.source !== 'manual' ? html`<div class="card"><h2>Segments de narration</h2>
            <table><thead><tr><th>Début</th><th>Fin</th><th>Texte</th></tr></thead><tbody>
            ${raw(tr.segments.map((s) => `<tr class="${s.uncertain ? 'uncertain' : ''}"><td class="mono">${s.start != null ? fmtTime(s.start) : '—'}</td><td class="mono">${s.end != null ? fmtTime(s.end) : '—'}</td><td>${esc(s.text)}${s.uncertain ? `<div class="small" style="color:var(--warn)">⚠ ${esc(s.note || 'transcription incertaine')}</div>` : ''}</td></tr>`).join(''))}
            </tbody></table><p class="small muted" style="margin-top:8px">Horodatages approximatifs.</p></div>` : ''}
        </div>

        <div>
          <div class="card"><h2>Aperçu de la référence</h2>
            ${refFile ? raw(isAudio ? `<audio data-key="ref" controls style="width:100%" src="${fileUrl(p, refFile, { v: p.steps.reference_fetch.finishedAt })}"></audio>` : `<video class="player" data-key="ref" controls preload="metadata" src="${fileUrl(p, refFile, { v: p.steps.reference_fetch.finishedAt })}"></video>`)
              : p.reference.oembed?.thumbnail ? raw(`<img src="${esc(p.reference.oembed.thumbnail)}" style="width:100%;border-radius:10px" alt="">`) : raw('<div class="empty">Aucune vidéo de référence.</div>')}
            ${p.reference.oembed?.title ? html`<p class="small muted" style="margin-top:8px">${p.reference.oembed.title} — @${p.reference.oembed.author}</p>` : ''}
          </div>
          ${ex?.methods ? html`<div class="card"><h2>Méthodes d'extraction</h2><ul class="methods">
            ${raw(ex.methods.map((m) => `<li>${badge(METHOD_STATE[m.status] || 'todo', m.status).s}<div><strong>${esc(m.method)}</strong><div class="small muted">${esc(m.detail)}</div></div></li>`).join(''))}</ul></div>` : ''}
          ${ex?.ocr?.length ? html`<div class="card"><h2>Texte affiché à l'écran</h2><p class="small muted">Texte incrusté, distinct des paroles prononcées.</p>
            <ul>${raw(ex.ocr.map((o) => `<li><span class="mono">${fmtTime(o.t)}</span> ${esc(o.text)} <span class="chip">${esc({ caption: 'sous-titre', title: 'titre', other: 'autre' }[o.kind] || o.kind)}</span></li>`).join(''))}</ul></div>` : ''}
          <div class="card"><h2>Performances (facultatif)</h2>
            <p class="small muted">Sans statistiques, l'analyse parle de mécanismes « potentiellement efficaces ».${p.reference.stats?.source ? ' Source actuelle : ' + esc(p.reference.stats.source) + '.' : ''}</p>
            <div class="grid two">
              ${raw(['views', 'likes', 'comments', 'shares'].map((k) => `<div class="field"><label for="ref-${k}">${{ views: 'Vues', likes: 'J\'aime', comments: 'Commentaires', shares: 'Partages' }[k]}</label><input id="ref-${k}" type="number" min="0" value="${esc(p.reference.stats?.[k] ?? '')}"></div>`).join(''))}
            </div><div class="row end"><button class="btn sm" id="ref-stats">Enregistrer</button></div>
          </div>
        </div>
      </div>`;
  },
  bind(root, c) {
    const p = c.p;
    bindCommon(root, c);
    root.querySelector('#ref-extract')?.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${p.id}/reference/url`, { url: root.querySelector('#ref-url').value }), 'Extraction lancée…'));
    root.querySelector('#ref-show-fallback')?.addEventListener('click', () => { c.app.showFallback = true; c.refresh(); });
    bindDrop(root, 'ref-file', (file) => doUpload(c, `/api/projects/${p.id}/reference/upload`, file, {}, '[data-drop="ref-file"]'));
    root.querySelector('#ref-paste-btn')?.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${p.id}/reference/text`, { text: root.querySelector('#ref-paste').value }), 'Texte importé.'));
    const ta = root.querySelector('#ref-script');
    ta.addEventListener('input', () => { root.querySelector('#ref-wc').textContent = wordCount(ta.value) + ' mots'; });
    root.querySelector('#ref-copy').addEventListener('click', async () => { await navigator.clipboard.writeText(ta.value); toast('Script copié.'); });
    root.querySelector('#ref-edit').addEventListener('click', async () => {
      const editing = c.app.editRef ?? !p.reference.validated;
      if (!editing) { c.app.editRef = true; await c.refresh(); document.getElementById('ref-script')?.focus(); return; }
      await act(c, () => api('PUT', `/api/projects/${p.id}/reference/script`, { text: ta.value }), 'Modifications enregistrées.');
      delete ta.dataset.dirty;
    });
    root.querySelector('#ref-validate').addEventListener('click', async () => {
      if (/\[inaudible\]/i.test(ta.value) && !confirm('Le script contient encore des passages [inaudible]. Valider quand même ?')) return;
      c.app.editRef = undefined;
      delete ta.dataset.dirty;
      await act(c, () => api('POST', `/api/projects/${p.id}/reference/validate`, { text: ta.value }), 'Script de référence validé : analyse narrative lancée.');
    });
    root.querySelector('#ref-stats').addEventListener('click', () => act(c, () => api('PUT', `/api/projects/${p.id}/reference/stats`,
      Object.fromEntries(['views', 'likes', 'comments', 'shares'].map((k) => [k, root.querySelector('#ref-' + k).value]))), 'Statistiques enregistrées.'));
  },
};

// =====================================================================================
// Page 3 — Analyse du script viral
// =====================================================================================
const list = (arr) => (arr?.length ? raw(`<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`) : raw('<p class="muted small">—</p>'));

const analysisPage = {
  title: 'Analyse du script viral',
  state: (p) => st(p, 'narrative_agent'),
  render(c) {
    const p = c.p;
    const n = p.steps.narrative_agent?.output;
    const s = st(p, 'narrative_agent');
    const busy = anyRunning(p);
    if (st(p, 'reference_script') !== 'done') return html`<div class="page-head"><div><h1>Analyse du script viral</h1></div></div>
      <div class="card empty"><p>Validez d'abord un script de référence.</p><a class="btn primary" href="#/p/${p.id}/reference">Extraire un script TikTok</a></div>`;
    return html`
      <div class="page-head"><div><h1>Analyse du script viral</h1><div class="sub">Mécanismes narratifs du script de référence et pistes d'adaptation (Agent B).</div></div>
        <div class="row"><button class="btn" data-run="narrative_agent" data-force="1"${raw(busy ? ' disabled' : '')}>Relancer l'analyse</button>${s === 'done' ? nextBtn(p, 'script', 'Générer mon nouveau script') : ''}</div></div>
      ${progressBar(p, 'narrative_agent')}${stepError(p, 'narrative_agent')}
      ${s === 'stale' ? raw('<div class="alert warning">Le script de référence a changé depuis cette analyse. <button class="btn sm" data-run="narrative_agent">Mettre à jour</button></div>') : ''}
      ${n ? html`
        <div class="alert ${n.evidence_level === 'stats_available' ? 'info' : 'warning'}"><strong>${n.evidence_level === 'stats_available' ? 'Statistiques publiques disponibles' : 'Aucune statistique d\'audience'}</strong>${n.caveat || (n.evidence_level === 'stats_available' ? 'Une corrélation ne prouve pas la cause du succès.' : 'Les éléments ci-dessous sont des mécanismes potentiellement efficaces, sans garantie de viralité.')}</div>
        <div class="card"><h2>Synthèse</h2><p>${n.summary}</p></div>
        <div class="grid two">
          <div class="card"><h2>Accroche (premières secondes)</h2>
            ${n.hook?.excerpt ? html`<blockquote class="muted" style="margin:0 0 8px;border-left:3px solid var(--accent);padding-left:10px">${n.hook.excerpt}</blockquote>` : ''}
            <p><strong>Technique :</strong> ${n.hook?.technique || '—'}</p><p class="small muted">${n.hook?.why_it_may_work || ''}</p></div>
          <div class="card"><h2>Structure narrative</h2>
            ${raw((n.structure || []).map((x) => `<div style="margin-bottom:8px"><div class="row"><strong>${esc(x.part)}</strong><span class="spacer"></span><span class="small muted">${x.share_percent ? esc(x.share_percent) + ' %' : ''}</span></div>${x.share_percent ? `<div class="progress"><div style="width:${Number(x.share_percent) || 0}%"></div></div>` : ''}<div class="small muted">${esc(x.description)}</div></div>`).join(''))}
            <p class="small"><strong>Progression :</strong> ${n.progression || '—'}</p></div>
          <div class="card"><h2>Rythme</h2><p>${n.rhythm?.pace ? 'Rythme ' + n.rhythm.pace : ''}${n.rhythm?.avg_words_per_sentence ? ' · ' + n.rhythm.avg_words_per_sentence + ' mots par phrase en moyenne' : ''}</p><p class="small muted">${n.rhythm?.notes || ''}</p>
            <h3>Transitions</h3>${list(n.transitions)}</div>
          <div class="card"><h2>Curiosité et suspense</h2>${list(n.curiosity_mechanisms)}<h3>Rétention</h3>${list(n.retention_devices)}</div>
          <div class="card"><h2>Émotions sollicitées</h2><div class="chips">${raw((n.emotions || []).map((e) => `<span class="chip">${esc(e)}</span>`).join(''))}</div>
            <h3>Conclusion / appel à l'action</h3><p>${n.ending?.type || '—'}${n.ending?.cta ? ' — ' + n.ending.cta : ''}</p></div>
          ${p.params.scriptMode !== 'inspire' ? '' : html`<div class="card"><h2>Formulations à ne pas reprendre</h2><p class="small muted">Expressions distinctives du script original, exclues de la réécriture.</p>${list(n.distinctive_phrases)}</div>`}
        </div>
        <div class="card"><h2>Comment l'adapter à votre vidéo</h2>
          <table><thead><tr><th>Mécanisme réutilisable</th><th>Adaptation</th></tr></thead><tbody>
          ${raw((n.reusable_patterns || []).map((r) => `<tr><td>${esc(r.pattern)}</td><td>${esc(r.how_to_adapt)}</td></tr>`).join(''))}</tbody></table></div>`
        : s !== 'running' && s !== 'error' ? raw('<div class="card empty"><p>L\'analyse n\'a pas encore été lancée.</p><button class="btn primary" data-run="narrative_agent">Analyser le script de référence</button></div>') : ''}`;
  },
  bind: bindCommon,
};

// =====================================================================================
// Page 4 — Générer mon nouveau script
// =====================================================================================
const AGENT_STEPS = [['visual_agent', 'A', 'Analyse visuelle'], ['narrative_agent', 'B', 'Analyse narrative'], ['script_agent', 'C + D', 'Réécriture + contrôle qualité']];

const scriptPage = {
  title: 'Générer mon nouveau script',
  state: (p) => (st(p, 'final_script') === 'done' ? 'done' : ['visual_agent', 'script_agent'].map((s) => st(p, s)).find((x) => ['running', 'error', 'interrupted'].includes(x)) || (p.finalScript.text ? 'stale' : 'todo')),
  render(c) {
    const p = c.p;
    const busy = anyRunning(p);
    const out = p.steps.script_agent?.output;
    const qa = out?.qa;
    const prm = p.params;
    const ready = st(p, 'source_analyze') === 'done' && st(p, 'reference_script') === 'done';
    const words = wordCount(p.finalScript.text);
    const tgt = p.scriptTarget || { seconds: prm.durationTarget, wps: WPS[prm.language] || 2.5 };
    const est = words / tgt.wps;
    return html`
      <div class="page-head"><div><h1>Générer mon nouveau script</h1><div class="sub">Adapte le script viral au contenu de votre vidéo à modifier, selon vos paramètres. Le texte reste entièrement modifiable.</div></div>
        ${st(p, 'final_script') === 'done' ? nextBtn(p, 'voice', 'Générer la voix off') : ''}</div>
      ${!ready ? raw(`<div class="alert warning">Prérequis : ${st(p, 'source_analyze') !== 'done' ? `<a href="#/p/${p.id}/source">importer la vidéo à modifier</a>` : ''}${st(p, 'source_analyze') !== 'done' && st(p, 'reference_script') !== 'done' ? ' et ' : ''}${st(p, 'reference_script') !== 'done' ? `<a href="#/p/${p.id}/reference">valider un script de référence</a>` : ''}.</div>`) : ''}
      <div class="grid side">
        <div>
          <div class="card">
            <div class="row"><h2 style="margin:0">Script final</h2>${p.finalScript.text ? badge(p.finalScript.validated ? 'done' : 'stale', p.finalScript.validated ? 'validé' : 'brouillon') : ''}
              <span class="spacer"></span><span class="small muted" id="sc-stats">${words} mots · voix ≈ ${est.toFixed(0)} s / cible ${tgt.seconds} s (${Math.round(tgt.seconds * tgt.wps)} mots) pour une vidéo de ${prm.durationTarget} s</span></div>
            ${progressBar(p, 'visual_agent')}${progressBar(p, 'script_agent')}${stepError(p, 'visual_agent')}${stepError(p, 'script_agent')}
            ${busy && p.pipeline.runningStep === 'script_transform' ? raw('<div class="progress indeterminate"><div></div></div><div class="small muted">Transformation du script…</div>') : ''}
            <textarea id="sc-text" class="script" data-keep style="margin-top:10px" placeholder="${!c.status?.ai ? 'Sans clé OpenRouter, rédigez ici votre script (un paragraphe par plan), puis validez-le.' : 'Cliquez sur « Générer le script ».'}">${p.finalScript.text}</textarea>
            <p class="small muted">Un paragraphe = un passage associé à un plan de la vidéo (utile pour la synchronisation).</p>
            <div class="row">
              <button class="btn primary" id="sc-gen"${raw(busy || !ready ? ' disabled' : '')}>Générer le script</button>
              <button class="btn" id="sc-regen"${raw(busy || !out ? ' disabled' : '')}>Régénérer</button>
              <button class="btn" data-transform="shorten"${raw(busy || !p.finalScript.text ? ' disabled' : '')}>Raccourcir</button>
              <button class="btn" data-transform="fit"${raw(busy || !p.finalScript.text ? ' disabled' : '')}>Ajuster à la durée cible</button>
              <button class="btn" data-transform="expand"${raw(busy || !p.finalScript.text ? ' disabled' : '')}>Développer</button>
              <select id="sc-tone2" style="width:auto">${options(TONES.map((t) => [t, t]), prm.tone)}</select>
              <button class="btn" data-transform="tone"${raw(busy || !p.finalScript.text ? ' disabled' : '')}>Modifier le ton</button>
            </div>
            ${raw(promptBox(p, { disabled: busy || !p.finalScript.text, inline: true }))}
            <hr>
            <div class="row"><button class="btn ghost" id="sc-save"${raw(busy ? ' disabled' : '')}>Enregistrer mes modifications</button><span class="spacer"></span>
              <button class="btn primary" id="sc-validate"${raw(busy ? ' disabled' : '')}>Valider le script</button></div>
            ${prm.autoMode ? raw('<p class="small muted" style="margin-top:8px">Mode automatique actif : la validation enchaîne voix off, montage et export.</p>') : raw('<p class="small muted" style="margin-top:8px">La voix off n\'est générée qu\'après validation.</p>')}
          </div>
          ${p.versions.script?.length > 1 ? html`<div class="card"><details><summary>Versions précédentes (${p.versions.script.length})</summary>
            ${raw(p.versions.script.slice().reverse().map((v) => `<div style="border-top:1px solid var(--line);padding:8px 0"><div class="row small muted">v${v.n} · ${esc({ agent: 'Agent C', user: 'modifié à la main', shorten: 'raccourci', expand: 'développé', tone: 'ton modifié' }[v.origin] || v.origin)} · ${fmtDate(v.at)}<span class="spacer"></span><button class="btn sm" data-restore="${v.n}">Restaurer</button></div><p class="small" style="white-space:pre-wrap">${esc(v.text.slice(0, 400))}${v.text.length > 400 ? '…' : ''}</p></div>`).join(''))}
          </details></div>` : ''}
        </div>
        <div>
          <div class="card"><h2>Paramètres</h2>
            <div class="field"><label for="sc-mode">Utilisation du script viral</label><select id="sc-mode">${options(SCRIPT_MODES, prm.scriptMode || 'adapt')}</select>
              <div class="hint">${(prm.scriptMode || 'adapt') === 'adapt' ? 'Garde l\'accroche, la structure et les tournures du script viral, et remplace son contenu par ce qu\'on voit dans votre vidéo.' : 'Écrit un texte nouveau qui reprend seulement les mécanismes narratifs du script viral.'}</div></div>
            <div class="grid two">
              <div class="field"><label for="sc-dur">Durée cible (s)</label><input id="sc-dur" type="number" min="5" max="180" value="${prm.durationTarget}"></div>
              <div class="field"><label for="sc-lang">Langue</label><select id="sc-lang">${options(LANGS, prm.language)}</select></div>
              <div class="field"><label for="sc-tone">Ton</label><select id="sc-tone">${options(TONES.map((t) => [t, t]), prm.tone)}</select></div>
              <div class="field"><label for="sc-aud">Public</label><input id="sc-aud" type="text" value="${prm.audience}"></div>
            </div>
            <label class="inline"><input id="sc-auto" type="checkbox"${raw(prm.autoMode ? ' checked' : '')}> Mode automatique</label>
            <div class="row end"><button class="btn sm" id="sc-params">Enregistrer les paramètres</button></div>
          </div>
          <div class="card"><h2>Agents IA</h2><ul class="steps-list">
            ${raw(AGENT_STEPS.map(([s, k, l]) => `<li><span><strong>Agent ${k}</strong> — ${esc(l)}</span>${badge(st(p, s)).s}</li>`).join(''))}</ul></div>
          ${qa ? html`<div class="card"><h2>Contrôle qualité (Agent D)</h2>
            <div class="row">${raw(Object.entries(qa.scores || {}).map(([k, v]) => `<div style="text-align:center"><div class="score">${esc(v)}</div><div class="small muted">${esc({ coherence: 'cohérence', video_fit: 'adéquation', fluency: 'fluidité', hook: 'accroche' }[k] || k)}</div></div>`).join(''))}</div>
            <p style="margin-top:10px">${badge(qa.verdict === 'ok' ? 'done' : 'stale', qa.verdict === 'ok' ? 'conforme' : 'à revoir')} ${qa.summary || ''}</p>
            <p class="small muted">Durée estimée ${qa.estimatedDuration} s · ${qa.words} mots · similarité avec la référence ${qa.overlap} %${out.rounds?.length > 1 ? ' · révisé automatiquement une fois' : ''}</p>
            ${qa.issues?.length ? html`<h3>Points relevés</h3><ul>${raw(qa.issues.map((i) => `<li>${badge(i.severity === 'high' ? 'error' : i.severity === 'medium' ? 'stale' : 'todo', i.severity).s} ${esc(i.problem)} <span class="small muted">${esc(i.suggestion || '')}</span></li>`).join(''))}</ul>` : ''}
            ${qa.invented_facts?.length ? html`<h3>Faits non visibles</h3>${list(qa.invented_facts)}` : ''}
            ${p.finalScript.edited ? raw('<p class="small muted">Le script a été modifié depuis ce contrôle.</p>') : ''}</div>` : ''}
          ${out?.hooks?.length ? html`<div class="card"><h2>Accroches</h2>
            <p class="small muted">Les 3 premières secondes décident si le spectateur reste. Claude a noté chaque accroche sur 40 (curiosité, clarté, émotion, cohérence) ; la mieux notée est appliquée.</p>
            <ul class="steps-list">${raw(out.hooks.map((h, i) => {
              const used = p.hook?.spoken === h.spoken;
              return `<li><span><strong>${esc(h.total)}/40</strong> ${esc(h.spoken)}<div class="small muted">${esc(h.current ? 'accroche d\'origine' : h.technique)}${h.screen ? ' · à l\'écran : « ' + esc(h.screen.replace(/\*/g, '')) + ' »' : ''}</div></span>${used ? badge('done', 'utilisée').s : `<button class="btn sm" data-hook="${i}"${busy ? ' disabled' : ''}>Utiliser</button>`}</li>`;
            }).join(''))}</ul></div>` : ''}
          ${p.finalScript.segments?.length ? html`<div class="card"><h2>Passages et plans</h2><table><tbody>
            ${raw(p.finalScript.segments.map((s, i) => `<tr><td class="mono">${i + 1}</td><td>${s.scene_index != null ? 'plan ' + s.scene_index : '—'}</td><td class="small">${esc(s.intent || '')}</td></tr>`).join(''))}</tbody></table></div>` : ''}
        </div>
      </div>`;
  },
  bind(root, c) {
    const p = c.p;
    bindCommon(root, c);
    const ta = root.querySelector('#sc-text');
    const tgt = p.scriptTarget || { seconds: p.params.durationTarget, wps: WPS[p.params.language] || 2.5 };
    ta.addEventListener('input', () => { const w = wordCount(ta.value); root.querySelector('#sc-stats').textContent = `${w} mots · voix ≈ ${(w / tgt.wps).toFixed(0)} s / cible ${tgt.seconds} s (${Math.round(tgt.seconds * tgt.wps)} mots) pour une vidéo de ${p.params.durationTarget} s`; });
    const params = () => ({ durationTarget: Number(root.querySelector('#sc-dur').value), language: root.querySelector('#sc-lang').value, tone: root.querySelector('#sc-tone').value, audience: root.querySelector('#sc-aud').value, autoMode: root.querySelector('#sc-auto').checked, scriptMode: root.querySelector('#sc-mode').value });
    const clean = () => { delete ta.dataset.dirty; };
    root.querySelector('#sc-params').addEventListener('click', () => act(c, () => api('PATCH', `/api/projects/${p.id}`, { params: params() }), 'Paramètres enregistrés.'));
    root.querySelector('#sc-gen').addEventListener('click', () => { clean(); act(c, () => api('POST', `/api/projects/${p.id}/script/generate`, { params: params() }), 'Génération lancée…'); });
    root.querySelector('#sc-regen').addEventListener('click', () => { clean(); act(c, () => api('POST', `/api/projects/${p.id}/script/generate`, { params: params(), regenerate: true }), 'Nouvelle version en cours…'); });
    root.querySelectorAll('[data-transform]').forEach((b) => b.addEventListener('click', async () => {
      if (ta.dataset.dirty === '1') await api('PUT', `/api/projects/${p.id}/script`, { text: ta.value });
      clean();
      act(c, () => api('POST', `/api/projects/${p.id}/script/transform`, { action: b.dataset.transform, tone: root.querySelector('#sc-tone2').value }));
    }));
    bindPromptBox(root, async (instruction) => {
      if (ta.dataset.dirty === '1') await api('PUT', `/api/projects/${p.id}/script`, { text: ta.value });
      delete ta.dataset.dirty;
      return act(c, () => api('POST', `/api/projects/${p.id}/script/transform`, { action: 'custom', instruction }), 'L\'IA modifie le script selon votre prompt…');
    });
    root.querySelector('#sc-save').addEventListener('click', () => { clean(); act(c, () => api('PUT', `/api/projects/${p.id}/script`, { text: ta.value }), 'Script enregistré.'); });
    root.querySelector('#sc-validate').addEventListener('click', () => { clean(); act(c, () => api('POST', `/api/projects/${p.id}/script/validate`, { text: ta.value }), 'Script validé.'); });
    root.querySelectorAll('[data-hook]').forEach((b) => b.addEventListener('click', () => {
      clean();
      act(c, () => api('POST', `/api/projects/${p.id}/hook/use`, { index: Number(b.dataset.hook) }), 'Accroche appliquée : validez le script pour régénérer la voix off.');
    }));
    root.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => {
      const v = p.versions.script.find((x) => x.n === Number(b.dataset.restore));
      clean();
      act(c, () => api('PUT', `/api/projects/${p.id}/script`, { text: v.text }), `Version ${v.n} restaurée.`);
    }));
  },
};

// =====================================================================================
// Page 5 — Voix off
// =====================================================================================
let voicesCache = null;
const voicePage = {
  title: 'Voix off',
  state: (p) => st(p, 'voice'),
  async load() { voicesCache = await api('GET', '/api/voices'); },
  render(c) {
    const p = c.p;
    const busy = anyRunning(p);
    if (!voicesCache) return '';
    const provs = voicesCache.providers;
    const vp = c.app.voiceDraft || p.voiceParams || {};
    const prov = provs.find((x) => x.id === vp.provider && x.available) || provs.find((x) => x.available) || provs[0];
    const lang = vp.language || p.params.language;
    const gender = vp.gender || 'F';
    const voices = prov.voices.filter((v) => (v.lang === '*' || v.lang === lang.slice(0, 2)) && (gender === 'all' || v.gender === gender || v.gender === 'N'));
    const allLangVoices = prov.voices.filter((v) => v.lang === '*' || v.lang === lang.slice(0, 2));
    const out = ['done', 'stale'].includes(st(p, 'voice')) ? p.steps.voice.output : null;
    const ready = st(p, 'final_script') === 'done';
    const speed = vp.speed || 1;
    return html`
      <div class="page-head"><div><h1>Voix off</h1><div class="sub">Narration générée à partir du script validé, enregistrée dans le projet et transmise au montage.</div></div>
        ${st(p, 'voice') === 'done' ? nextBtn(p, 'montage', 'Passer au montage') : ''}</div>
      ${!ready ? raw(`<div class="alert warning">Validez d'abord le script final. <a href="#/p/${p.id}/script">Générer mon nouveau script</a></div>`) : ''}
      <div class="grid side">
        <div class="card">
          <div class="field"><label for="vo-prov">Service de synthèse vocale</label><select id="vo-prov">${raw(provs.map((x) => `<option value="${esc(x.id)}"${x.id === prov.id ? ' selected' : ''}${x.available ? '' : ' disabled'}>${esc(x.label)}${x.available ? '' : ' — ' + esc(x.reason)}</option>`).join(''))}</select>
            <div class="hint">Coût : ${prov.cost}.${prov.tones ? '' : ' Ce service ne règle pas le ton : il est conservé pour l\'écriture du script.'}${prov.wordTimestamps ? ' Horodatage par mot (sous-titres exacts).' : ' Sous-titres synchronisés par estimation recalée sur les pauses.'}</div></div>
          <div class="grid two">
            <div class="field"><label for="vo-lang">Langue</label><select id="vo-lang">${options(LANGS, lang)}</select></div>
            <div class="field"><label for="vo-gender">Voix</label><select id="vo-gender">${options([['F', 'Féminine'], ['M', 'Masculine'], ['all', 'Toutes']], gender)}</select></div>
          </div>
          <div class="field"><label>Voix et accent (▶ pour écouter)</label>
            ${raw(voiceCards(prov, voices.length ? voices : allLangVoices, vp.voice, lang))}</div>
          <div class="field"><label for="vo-tone">Ton</label><select id="vo-tone"${raw(prov.tones ? '' : ' disabled')}>${options(TONES.map((t) => [t, t]), vp.tone || p.params.tone)}</select></div>
          <div class="field"><label for="vo-speed">Vitesse de lecture</label><div class="range-row"><input id="vo-speed" type="range" min="0.7" max="1.3" step="0.05" value="${speed}"><output id="vo-speed-out">${Number(speed).toFixed(2)}×</output></div></div>
          <div class="row"><button class="btn primary" id="vo-gen"${raw(busy || !ready ? ' disabled' : '')}>${out ? 'Régénérer la voix' : 'Générer la voix off'}</button>
            ${st(p, 'voice') === 'stale' ? raw('<span class="small" style="color:var(--warn)">Paramètres ou script modifiés : régénérez la voix.</span>') : ''}</div>
          ${progressBar(p, 'voice')}${stepError(p, 'voice')}
        </div>
        <div>
          <div class="card"><h2>Écoute</h2>
            ${out ? html`<audio data-key="voice" controls style="width:100%" src="${fileUrl(p, out.file)}"></audio>
              <dl class="kv" style="margin-top:10px"><dt>Durée réelle</dt><dd>${fmtDuration(out.duration)}</dd><dt>Cible</dt><dd>${p.params.durationTarget} s</dd><dt>Voix</dt><dd>${out.voice} (${out.provider})</dd><dt>Vitesse</dt><dd>${out.speed}×</dd>
              <dt>Horodatage</dt><dd>${out.words?.length ? 'par mot (' + out.words.length + ' mots)' : 'estimé'}</dd></dl>
              <div class="row" style="margin-top:10px"><a class="btn" href="${fileUrl(p, out.file, { download: true })}">Télécharger le fichier audio</a></div>` : raw('<div class="empty">Aucune voix générée.</div>')}
          </div>
          ${p.versions.voice?.length > 1 ? html`<div class="card"><details><summary>Versions (${p.versions.voice.length})</summary>
            ${raw(p.versions.voice.slice().reverse().map((v) => `<div style="padding:6px 0;border-top:1px solid var(--line)"><div class="small muted">v${v.n} · ${esc(v.voice)} · ${v.speed}× · ${fmtDuration(v.duration)}</div><audio controls preload="none" style="width:100%" src="${fileUrl(p, v.file)}"></audio></div>`).join(''))}</details></div>` : ''}
        </div>
      </div>`;
  },
  bind(root, c) {
    const p = c.p;
    bindCommon(root, c);
    const read = () => ({ provider: root.querySelector('#vo-prov').value, voice: root.querySelector('#vo-voice')?.value || '', language: root.querySelector('#vo-lang').value, gender: root.querySelector('#vo-gender').value, tone: root.querySelector('#vo-tone').value, speed: Number(root.querySelector('#vo-speed').value) });
    const save = async () => { c.app.voiceDraft = read(); await api('PUT', `/api/projects/${p.id}/voice/params`, c.app.voiceDraft); };
    ['#vo-prov', '#vo-lang', '#vo-gender'].forEach((s) => root.querySelector(s).addEventListener('change', async () => { const d = read(); d.voice = ''; c.app.voiceDraft = d; await api('PUT', `/api/projects/${p.id}/voice/params`, d); c.refresh(); }));
    root.querySelector('#vo-tone').addEventListener('change', async () => { await save(); c.refresh(); });
    bindVoiceCards(root, async () => { await save(); });
    const sp = root.querySelector('#vo-speed');
    sp.addEventListener('input', () => { root.querySelector('#vo-speed-out').textContent = Number(sp.value).toFixed(2) + '×'; });
    sp.addEventListener('change', async () => { await save(); c.refresh(); });
    root.querySelector('#vo-gen').addEventListener('click', async () => { await save(); act(c, () => api('POST', `/api/projects/${p.id}/voice/generate`, { regenerate: true }), 'Génération de la voix…'); });
  },
};

// =====================================================================================
// Page 7 — Exporter la vidéo
// =====================================================================================
const exportPage = {
  title: 'Exporter la vidéo',
  state: (p) => st(p, 'export'),
  render(c) {
    const p = c.p;
    const busy = anyRunning(p);
    const ep = p.exportParams || {};
    const out = ['done', 'stale'].includes(st(p, 'export')) ? p.steps.export.output : null;
    const validated = st(p, 'montage_ok') === 'done';
    const srcMeta = p.steps.source_analyze?.output?.meta;
    return html`
      <div class="page-head"><div><h1>Exporter la vidéo</h1><div class="sub">Rendu final à pleine résolution, directement depuis les fichiers sources (pas de ré-encodage de l'aperçu).</div></div>
        ${st(p, 'export') === 'done' ? nextBtn(p, 'publish', 'Préparer la publication') : ''}</div>
      ${!validated ? raw(`<div class="alert warning">Validez d'abord le montage. <a href="#/p/${p.id}/montage">Montage vidéo</a></div>`) : ''}
      <div class="grid side">
        <div class="card"><h2>Résultat</h2>
          ${out ? raw(`<video class="player vertical" data-key="export" controls preload="metadata" src="${fileUrl(p, out.file)}"></video>`) : raw('<div class="empty">Aucun export pour l\'instant.</div>')}
          ${progressBar(p, 'export')}${stepError(p, 'export')}
          ${st(p, 'export') === 'stale' ? raw('<div class="alert warning" style="margin-top:10px">Le montage ou les réglages ont changé depuis cet export.</div>') : ''}
        </div>
        <div>
          <div class="card"><h2>Réglages</h2>
            <div class="field"><label>Format</label><input type="text" value="MP4 (H.264 + AAC)" disabled></div>
            <div class="field"><label for="ex-res">Résolution</label><select id="ex-res">${options([['1080x1920', '1080 × 1920 (Full HD vertical)'], ['720x1280', '720 × 1280 (léger)']], ep.resolution)}</select>
              ${srcMeta && Math.max(srcMeta.width, srcMeta.height) < 1280 && ep.resolution !== '720x1280' ? raw(`<div class="hint" style="color:var(--warn)">La source (${srcMeta.width}×${srcMeta.height}) est de faible résolution : elle sera agrandie.</div>`) : ''}</div>
            <div class="field"><label for="ex-fps">Images par seconde</label><select id="ex-fps">${options([['source', `Comme la source (${srcMeta?.fps || '?'} i/s)`], ['24', '24'], ['25', '25'], ['30', '30'], ['60', '60']], ep.fps)}</select></div>
            <div class="field"><label for="ex-q">Qualité</label><select id="ex-q">${options([['max', 'Maximale (lent, fichier lourd)'], ['high', 'Haute (recommandée)'], ['medium', 'Moyenne'], ['light', 'Légère']], ep.quality)}</select></div>
            <button class="btn primary" id="ex-go"${raw(busy || !validated ? ' disabled' : '')}>${out ? 'Relancer l\'export' : 'Exporter la vidéo'}</button>
          </div>
          ${out ? html`<div class="card"><h2>Fichier final</h2><dl class="kv">
            <dt>Durée</dt><dd>${fmtDuration(out.duration)}</dd><dt>Résolution</dt><dd>${out.width} × ${out.height}</dd><dt>Images/s</dt><dd>${out.fps}</dd><dt>Taille</dt><dd>${fmtSize(out.size)}</dd><dt>Statut</dt><dd>${badge(st(p, 'export'))}</dd></dl>
            <div class="row" style="margin-top:12px"><a class="btn primary" href="${fileUrl(p, out.file, { download: true })}">Télécharger la vidéo</a></div></div>` : ''}
          ${p.versions.export?.length > 1 ? html`<div class="card"><details><summary>Exports précédents (${p.versions.export.length})</summary><ul>
            ${raw(p.versions.export.slice().reverse().map((v) => `<li><a href="${fileUrl(p, v.file, { download: true })}">v${v.n}</a> · ${v.width}×${v.height} · ${fmtSize(v.size)} · ${fmtDate(v.at)}</li>`).join(''))}</ul></details></div>` : ''}
        </div>
      </div>`;
  },
  bind(root, c) {
    bindCommon(root, c);
    root.querySelector('#ex-go').addEventListener('click', () => act(c, () => api('POST', `/api/projects/${c.p.id}/export`, { resolution: root.querySelector('#ex-res').value, fps: root.querySelector('#ex-fps').value, quality: root.querySelector('#ex-q').value }), 'Export lancé…'));
  },
};

// =====================================================================================
// Page 8 — Publication TikTok (avec le score de viralité)
// =====================================================================================
const VIRAL_CRITERIA = { hook: 'Accroche', retention: 'Rétention', length: 'Durée', clarity: 'Clarté sans le son', emotion: 'Émotion', packaging: 'Titre et hashtags', cta: 'Appel à l\'action' };
// Où une correction se répercute : le script demande une nouvelle voix off, le montage un nouveau rendu.
const FIX_TARGET = { use_hook: 'script', fit_duration: 'script', set_screen_title: 'montage', enable_hook_title: 'montage', enable_punch_in: 'montage', enable_highlight: 'montage' };

function viralityCard(p, busy) {
  const v = p.virality;
  const running = busy && p.pipeline.runningStep === 'virality';
  const color = (s) => (s >= 75 ? 'var(--ok)' : s >= 50 ? 'var(--warn)' : 'var(--err)');
  const scriptFixed = v?.fixes?.some((f) => f.applied && FIX_TARGET[f.action] === 'script');
  const montageFixed = v?.fixes?.some((f) => f.applied && FIX_TARGET[f.action] === 'montage');
  return html`<div class="card"><div class="row"><h2 style="margin:0">Score de viralité</h2><span class="spacer"></span>
      <button class="btn sm primary" id="vr-run"${raw(busy || !p.finalScript.text ? ' disabled' : '')}>${v ? 'Analyser à nouveau' : 'Analyser ma vidéo'}</button></div>
    ${running ? raw('<div class="progress indeterminate" style="margin-top:10px"><div></div></div><div class="small muted">Claude analyse l\'accroche, le rythme, la durée et le texte de publication…</div>') : ''}
    ${v ? html`<div class="row" style="margin-top:12px;align-items:center;gap:18px">
        <div style="font-size:44px;font-weight:800;color:${color(v.score)}">${v.score}<span style="font-size:18px;color:var(--muted)">/100</span></div>
        <div style="flex:1;min-width:220px">${raw(Object.entries(VIRAL_CRITERIA).map(([k, l]) => `<div class="row small" style="gap:8px"><span style="width:140px">${esc(l)}</span><div class="progress" style="flex:1"><div style="width:${(Number(v.criteria?.[k]) || 0) * 10}%;background:${color((Number(v.criteria?.[k]) || 0) * 10)}"></div></div><span style="width:32px;text-align:right">${esc(v.criteria?.[k] ?? '–')}</span></div>`).join(''))}</div>
      </div>
      <p>${v.summary}</p>
      ${v.strengths?.length ? html`<p class="small"><strong>Points forts :</strong> ${v.strengths.join(' · ')}</p>` : ''}
      ${v.fixes?.length ? html`<h3>Corrections proposées</h3><ul class="steps-list">${raw(v.fixes.map((f, i) => `<li><span>${badge(f.impact === 'fort' ? 'error' : f.impact === 'moyen' ? 'stale' : 'todo', 'impact ' + esc(f.impact)).s} <strong>${esc(f.problem)}</strong><div class="small">${esc(f.fix)}</div>${f.value && typeof f.value === 'string' ? `<div class="small muted">« ${esc(f.value.replace(/\*/g, ''))} »</div>` : Array.isArray(f.value) ? `<div class="small muted">${esc(f.value.map((h) => '#' + String(h).replace(/^#/, '')).join(' '))}</div>` : ''}</span>${f.applied ? badge('done', 'appliquée').s : `<button class="btn sm" data-vfix="${i}"${busy ? ' disabled' : ''}>Appliquer</button>`}</li>`).join(''))}</ul>` : ''}
      ${scriptFixed ? raw(`<div class="alert info">Le script a changé : validez-le, puis régénérez la voix off, le montage et l'export. <a href="#/p/${p.id}/script">Aller au script</a></div>`) : montageFixed ? raw(`<div class="alert info">Le montage a changé : relancez le rendu, puis l'export. <a href="#/p/${p.id}/montage">Aller au montage</a></div>`) : ''}
      <p class="small muted">Analysé le ${fmtDate(v.at)}. Ce score estime la rétention et l'attrait du texte ; il ne garantit pas la viralité, qui dépend aussi de votre compte, du sujet et du moment de publication.</p>`
    : raw('<p class="small muted" style="margin-top:8px">Claude évalue l\'accroche, le rythme, la durée, la clarté sans le son et le texte de publication, puis propose des corrections applicables en un clic.</p>')}
  </div>`;
}

// Diagnostic d'originalité : risque d'être classé « contenu non original » (non proposé dans le fil « Pour toi »).
const ZERO_VIEW_CHECKS = [
  ['Vérifiez l\'éligibilité', 'Dans TikTok, ouvrez la vidéo → « Plus de données » (ou TikTok Studio → Publications). La mention « Non éligible pour le fil Pour toi » donne la raison : le plus souvent « contenu non original ».'],
  ['Vérifiez le compte', 'Profil → Menu → Paramètres → Statut du compte : un avertissement ou une restriction bloque la diffusion de toutes les vidéos.'],
  ['Vérifiez la confidentialité', 'La vidéo doit être « Tout le monde » ; une vidéo « Amis » ou « Privée » ne fait pas de vues.'],
  ['Attendez la vérification', 'Une nouvelle vidéo peut rester « en cours de vérification » quelques heures avec 0 vue. Ne la supprimez pas pour la remettre : c\'est vu comme un doublon.'],
  ['Pas de VPN', 'Publiez depuis le pays de votre public, sans VPN : TikTok diffuse d\'abord aux utilisateurs de votre région.'],
  ['Une vidéo réellement nouvelle', 'Si la vidéo est classée non originale, republier la même version ne changera rien : ajoutez vos propres images (réaction, commentaire face caméra, autres plans) avant de réexporter.'],
];

function originalityCard(p, busy) {
  const o = p.originality;
  if (!o) return '';
  const color = o.score >= 75 ? 'var(--ok)' : o.score >= 50 ? 'var(--warn)' : 'var(--err)';
  const icon = { ok: 'done', warn: 'stale', bad: 'error' };
  const word = { ok: 'OK', warn: 'à améliorer', bad: 'risque' };
  return html`<div class="card"><h2>Diagnostic d'originalité</h2>
    <div class="row" style="align-items:center;gap:18px"><div style="font-size:44px;font-weight:800;color:${color}">${o.score}<span style="font-size:18px;color:var(--muted)">/100</span></div>
      <div style="flex:1;min-width:220px"><strong>Risque ${o.level} d'être classée « contenu non original »</strong>
        <div class="small muted">Une vidéo classée ainsi n'est pas proposée dans le fil « Pour toi » : c'est la cause la plus fréquente des vidéos à 0 vue pour les reposts.</div></div></div>
    <ul class="steps-list">${raw(o.checks.map((ch) => `<li><span>${badge(icon[ch.status], word[ch.status]).s} <strong>${esc(ch.label)}</strong><div class="small">${esc(ch.detail)}</div>${ch.status !== 'ok' && ch.fix ? `<div class="small muted">→ ${esc(ch.fix)}</div>` : ''}</span>${ch.status !== 'ok' && ch.action === 'credit' ? `<button class="btn sm" id="or-credit"${busy ? ' disabled' : ''}>Ajouter le crédit</button>` : ''}</li>`).join(''))}</ul>
    <details style="margin-top:10px"><summary><strong>Ma vidéo a fait 0 vue : que vérifier ?</strong></summary>
      <ol class="small">${raw(ZERO_VIEW_CHECKS.map(([t, d]) => `<li><strong>${esc(t)}.</strong> ${esc(d)}</li>`).join(''))}</ol></details>
    <p class="small muted">Estimation locale à partir du montage et du script ; TikTok ne publie pas ses critères exacts.</p>
  </div>`;
}

// Registre des publications : chaque mise en ligne est notée à la main (la publication n'est pas automatique).
function publicationsCard(p) {
  const pubs = p.publications || [];
  const curFile = p.steps.export?.output?.file || '';
  const sameVersion = pubs.filter((x) => curFile && x.exportFile === curFile).length;
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return html`<div class="card"><h2>Publications sur TikTok</h2>
    <div class="row" style="align-items:baseline;gap:10px"><div style="font-size:40px;font-weight:800">${pubs.length}</div>
      <div class="small muted">${pubs.length === 0 ? 'Aucune publication enregistrée.' : pubs.length === 1 ? 'publication enregistrée' : 'publications enregistrées'}${pubs.length ? ` · dernière le ${fmtDate(pubs[pubs.length - 1].at)}` : ''}${curFile && pubs.length ? ` · ${sameVersion} avec la version exportée actuelle` : ''}</div></div>
    ${pubs.length ? raw(`<ul class="steps-list">${pubs.slice().reverse().map((x, i) => `<li><span><strong>#${pubs.length - i}</strong> · ${esc(fmtDate(x.at))}${x.account ? ` · @${esc(x.account)}` : ''}${x.exportFile && x.exportFile !== curFile ? ' · <span class="muted">ancienne version</span>' : ''}${x.url ? `<div class="small"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a></div>` : ''}${x.note ? `<div class="small muted">${esc(x.note)}</div>` : ''}</span><button class="btn sm danger" data-pubdel="${esc(x.id)}" title="Retirer du registre">Retirer</button></li>`).join('')}</ul>`) : ''}
    <h3>J'ai publié cette vidéo</h3>
    <div class="field"><label for="pu-url">Lien de la vidéo TikTok (facultatif)</label><input id="pu-url" type="url" data-keep placeholder="https://www.tiktok.com/@compte/video/…"></div>
    <div class="row"><div class="field" style="flex:1"><label for="pu-account">Compte (facultatif)</label><input id="pu-account" type="text" data-keep placeholder="@moncompte"></div>
      <div class="field" style="flex:1"><label for="pu-at">Date</label><input id="pu-at" type="datetime-local" data-keep value="${today}"></div></div>
    <div class="field"><label for="pu-note">Note (facultatif)</label><input id="pu-note" type="text" data-keep maxlength="300" placeholder="Ex. : repost avec un autre titre"></div>
    <button class="btn primary" id="pu-add">Enregistrer cette publication</button>
    <p class="small muted">L'application ne publie pas à votre place : notez ici chaque mise en ligne pour savoir combien de fois cette vidéo a été publiée, sur quels comptes et avec quelle version.</p>
  </div>`;
}

// =====================================================================================
// Page 8 — Publication TikTok
// =====================================================================================
const publishPage = {
  title: 'Publication TikTok',
  state: (p) => (p.publishDraft.caption ? 'done' : 'todo'),
  render(c) {
    const p = c.p;
    const d = p.publishDraft;
    const exported = st(p, 'export') === 'done';
    const out = exported ? p.steps.export.output : null;
    const busy = anyRunning(p);
    // Le champ « caption » du brouillon est le titre ; la description publiée regroupe texte, appel à l'action et hashtags.
    const fullDesc = [d.description, d.cta, (d.hashtags || []).map((h) => '#' + h).join(' ')].filter(Boolean).join('\n\n');
    return html`
      <div class="page-head"><div><h1>Publication TikTok</h1><div class="sub">Préparez le titre et la description, vérifiez-les, puis téléchargez la vidéo et copiez les textes pour la publier vous-même sur TikTok.</div></div></div>
      ${!exported ? raw(`<div class="alert warning">Exportez d'abord la vidéo finale. <a href="#/p/${p.id}/export">Exporter la vidéo</a></div>`) : ''}
      ${originalityCard(p, busy)}
      ${viralityCard(p, busy)}
      <div class="grid side">
        <div class="card"><div class="row"><h2 style="margin:0">Titre et description</h2><span class="spacer"></span>
          <button class="btn sm" id="pb-gen"${raw(busy || st(p, 'final_script') !== 'done' ? ' disabled' : '')}>${d.caption ? 'Régénérer les propositions' : 'Proposer titre, description et hashtags'}</button></div>
          ${progressBar(p, 'caption')}${stepError(p, 'caption')}
          <div class="field" style="margin-top:12px"><label for="pb-caption">Titre</label>
            <div class="row"><input id="pb-caption" type="text" data-keep maxlength="150" value="${d.caption}" style="flex:1"><button class="btn sm" id="pb-copy-title"${raw(d.caption ? '' : ' disabled')}>Copier</button></div></div>
          <div class="field"><label for="pb-desc">Description</label><textarea id="pb-desc" data-keep style="min-height:90px">${d.description}</textarea></div>
          <div class="field"><label for="pb-tags">Hashtags (séparés par des espaces)</label><input id="pb-tags" type="text" data-keep value="${(d.hashtags || []).map((h) => '#' + h).join(' ')}"></div>
          <div class="field"><label for="pb-cta">Appel à l'action (facultatif)</label><input id="pb-cta" type="text" data-keep value="${d.cta}"></div>
          <div class="row"><button class="btn" id="pb-save">Enregistrer</button></div>
          <h3>Description à publier</h3>
          <div class="row"><span class="small muted">Description, appel à l'action et hashtags · ${fullDesc.length} / 2200 caractères</span><span class="spacer"></span><button class="btn sm" id="pb-copy-desc"${raw(fullDesc ? '' : ' disabled')}>Copier la description</button></div>
          <p style="white-space:pre-wrap" class="small">${fullDesc || '—'}</p>
        </div>
        <div>
          <div class="card"><h2>Publication manuelle</h2>
            <div class="stack">
              ${out ? raw(`<a class="btn primary" href="${fileUrl(p, out.file, { download: true })}">Télécharger la vidéo (${fmtSize(out.size)})</a>`) : raw('<button class="btn" disabled>Télécharger la vidéo</button>')}
              <a class="btn" href="/api/projects/${p.id}/publish/package">Télécharger le titre et la description (.txt)</a>
            </div></div>
          ${publicationsCard(p)}
        </div>
      </div>`;
  },
  bind(root, c) {
    const p = c.p;
    bindCommon(root, c);
    const draft = () => ({ caption: root.querySelector('#pb-caption').value, description: root.querySelector('#pb-desc').value, hashtags: root.querySelector('#pb-tags').value, cta: root.querySelector('#pb-cta').value });
    const clean = () => root.querySelectorAll('[data-keep]').forEach((el) => delete el.dataset.dirty);
    root.querySelector('#pb-gen').addEventListener('click', () => { clean(); act(c, () => api('POST', `/api/projects/${p.id}/caption/generate`), 'Propositions en cours…'); });
    root.querySelector('#pb-save').addEventListener('click', () => { clean(); act(c, () => api('PUT', `/api/projects/${p.id}/publish/draft`, draft()), 'Titre et description enregistrés.'); });
    root.querySelector('#vr-run').addEventListener('click', () => act(c, () => api('POST', `/api/projects/${p.id}/virality/analyze`), 'Analyse de viralité en cours…'));
    root.querySelectorAll('[data-vfix]').forEach((b) => b.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${p.id}/virality/apply`, { index: Number(b.dataset.vfix) }), 'Correction appliquée.')));
    root.querySelector('#or-credit')?.addEventListener('click', () => { clean(); act(c, () => api('POST', `/api/projects/${p.id}/originality/credit`), 'Crédit ajouté à la description.'); });
    root.querySelector('#pu-add').addEventListener('click', () => {
      const v = (s) => root.querySelector(s).value;
      const at = v('#pu-at') ? new Date(v('#pu-at')).toISOString() : '';
      clean();
      act(c, () => api('POST', `/api/projects/${p.id}/publications`, { url: v('#pu-url'), account: v('#pu-account'), at, note: v('#pu-note') }), 'Publication enregistrée.');
    });
    root.querySelectorAll('[data-pubdel]').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Retirer cette publication du registre ? (La vidéo reste en ligne sur TikTok.)')) act(c, () => api('DELETE', `/api/projects/${p.id}/publications/${b.dataset.pubdel}`), 'Publication retirée du registre.');
    }));
    root.querySelector('#pb-copy-title').addEventListener('click', async () => { await navigator.clipboard.writeText(draft().caption); toast('Titre copié.'); });
    root.querySelector('#pb-copy-desc').addEventListener('click', async () => {
      const d = draft();
      await navigator.clipboard.writeText([d.description, d.cta, d.hashtags].filter(Boolean).join('\n\n')); toast('Description copiée.');
    });
  },
};

export const PROJECT_PAGES = {
  source: sourcePage,
  reference: referencePage,
  analysis: analysisPage,
  script: scriptPage,
  voice: voicePage,
  montage: montagePage({ api, act, bindCommon, st, S, anyRunning, nextBtn }),
  export: exportPage,
  publish: publishPage,
};

export const WIZARD = wizardPage({ act, st, anyRunning, bindCommon });
