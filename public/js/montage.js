// Page 6 — Montage vidéo : réglages, aperçu instantané, timeline, rendu réel et synchronisation.
import { html, raw, esc, toast, badge, fmtTime, fmtDuration, fileUrl, stepError, progressBar, upload, options, autoFgScale } from './core.js';
import { presetCards, SUB_PRESETS } from './substyles.js';
import { maskEditor, bindMask } from './maskdraw.js';

const FONTS = ['Segoe UI Black', 'Arial Black', 'Impact', 'Bahnschrift', 'Arial', 'Verdana', 'Trebuchet MS', 'Segoe UI', 'Georgia', 'Comic Sans MS'];
let defaults = null;

const kept = (P, dur) => {
  const segs = (P.segments?.length ? P.segments : [{ start: 0, end: dur }]).map((s) => ({ start: Math.max(0, +s.start), end: Math.min(dur, +s.end) })).filter((s) => s.end - s.start > 0.05).sort((a, b) => a.start - b.start);
  return segs.length ? segs : [{ start: 0, end: dur }];
};

// Même calcul que le serveur (lib/media.js planTimeline) pour afficher la timeline avant le rendu.
function plan(P, dur, voiceDur) {
  const segs = kept(P, dur);
  const videoLen = segs.reduce((a, s) => a + s.end - s.start, 0);
  const voiceEnd = voiceDur ? P.voiceOffset + voiceDur : 0;
  let total = videoLen, freeze = 0;
  const target = P.exactDuration ? Number(P.targetDuration) || 0 : 0;
  if (target) {
    total = Math.max(target, voiceEnd ? voiceEnd + 0.1 : 0);
    freeze = Math.max(0, total - videoLen);
  } else if (voiceEnd && voiceEnd + P.tail > videoLen) {
    if (P.fit === 'freeze') { freeze = voiceEnd + P.tail - videoLen; total = voiceEnd + P.tail; } else total = Math.max(videoLen, voiceEnd);
  } else if (voiceEnd && P.trimToVoice) total = Math.min(videoLen, voiceEnd + P.tail);
  return { segs, videoLen, voiceEnd, total, freeze };
}

const GROUPS = { 'sub-': 'subtitles', 'ht-': 'hookTitle', 'pi-': 'punchIn', 'rx-': 'reaction' };
const slider = (id, label, min, max, step, value, fmt = (v) => v) => raw(`<div class="field"><label for="${id}">${esc(label)}</label><div class="range-row"><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${esc(value)}" data-fmt="${esc(fmt.name || '')}"><output for="${id}">${esc(fmt(value))}</output></div></div>`);
const pct = (v) => Math.round(v * 100) + ' %';
const sec = (v) => Number(v).toFixed(1) + ' s';
const num = (v) => String(v);
const FMT = { blur: num, bgZoom: (v) => Number(v).toFixed(2) + '×', bgBrightness: (v) => Number(v).toFixed(2), fgScale: pct, fgX: pct, fgY: pct, voiceOffset: sec, voiceVolume: pct, originalVolume: pct, musicVolume: pct, tail: sec, size: num, outlineWidth: num, duration: sec, boxOpacity: pct, volume: pct, offset: sec, pipSize: pct, zoom: (v) => '+' + Math.round((v - 1) * 100) + ' %' };

export function montagePage({ api, act, bindCommon, st, anyRunning, nextBtn }) {
  return {
    title: 'Montage vidéo',
    state: (p) => (st(p, 'montage_ok') === 'done' ? 'done' : st(p, 'montage')),
    async load() { defaults ||= await api('GET', '/api/montage/defaults'); },
    render(c) {
      const p = c.p;
      const busy = anyRunning(p);
      const a = p.steps.source_analyze?.output;
      const v = ['done', 'stale'].includes(st(p, 'voice')) ? p.steps.voice.output : null;
      if (!a || !v || !defaults) {
        return html`<div class="page-head"><div><h1>Montage vidéo</h1></div></div><div class="card empty"><p>Le montage nécessite la vidéo source et une voix off.</p>
          ${raw(!a ? `<a class="btn primary" href="#/p/${p.id}/source">Importer la vidéo à modifier</a>` : `<a class="btn primary" href="#/p/${p.id}/voice">Générer la voix off</a>`)}</div>`;
      }
      const P = { ...defaults, fgScale: autoFgScale(a.meta), ...(p.montageParams || {}), subtitles: { ...defaults.subtitles, ...(p.montageParams?.subtitles || {}) },
        reaction: { ...defaults.reaction, ...(p.montageParams?.reaction || {}) }, credit: { ...defaults.credit, ...(p.montageParams?.credit || {}) }, mask: { ...defaults.mask, ...(p.montageParams?.mask || {}) } };
      const rx = P.reaction;
      const out = ['done', 'stale'].includes(st(p, 'montage')) ? p.steps.montage.output : null;
      const pl = plan(P, a.meta.duration, v.duration);
      const tab = out ? c.app.montageTab || 'render' : 'live';
      const fresh = st(p, 'montage') === 'done';
      const validated = st(p, 'montage_ok') === 'done';
      const sub = P.subtitles;
      const srcUrl = fileUrl(p, p.source.file, { v: p.steps.source_fetch.finishedAt });

      return html`
        <div class="page-head"><div><h1>Montage vidéo</h1><div class="sub">Rendu vertical 9:16 avec arrière-plan flouté, voix off synchronisée et sous-titres. Le rendu produit un vrai fichier MP4.</div></div>
          <div class="row">${validated ? nextBtn(p, 'export', 'Exporter la vidéo') : ''}</div></div>
        ${stepError(p, 'montage')}
        <div class="grid side">
          <div>
            <div class="card">
              <div class="row" style="margin-bottom:10px">
                <button class="btn sm${tab === 'live' ? ' primary' : ''}" data-tab="live">Aperçu instantané des réglages</button>
                <button class="btn sm${tab === 'render' ? ' primary' : ''}" data-tab="render"${raw(out ? '' : ' disabled')}>Rendu réel${out ? ' (v' + p.versions.montage.length + ')' : ''}</button>
                <span class="spacer"></span>${badge(st(p, 'montage'), fresh ? 'à jour' : out ? 'réglages modifiés' : 'non rendu')}
              </div>
              ${tab === 'live' ? html`
                <div id="live" style="position:relative;aspect-ratio:9/16;max-height:620px;margin:0 auto;overflow:hidden;border-radius:10px;background:#000">
                  <video id="live-bg" muted playsinline loop src="${srcUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
                  <video id="live-fg" muted playsinline loop src="${srcUrl}" style="position:absolute;left:50%;top:50%;object-fit:contain"></video>
                  <div id="live-sub" style="position:absolute;left:6%;right:6%;text-align:center;font-weight:800;line-height:1.15;pointer-events:none">${sub.uppercase ? 'EXEMPLE DE SOUS-TITRE' : 'Exemple de sous-titre'}</div>
                </div>
                <p class="small muted" style="margin-top:8px">Simulation dans le navigateur pour régler le cadrage. Le fichier final est produit par « Prévisualiser » (rendu FFmpeg).</p>`
              : raw(`<video id="mt-player" class="player vertical" data-key="montage" controls preload="auto" src="${fileUrl(p, out.file)}"></video>`)}
              <div class="row" style="margin-top:10px;justify-content:center">
                <button class="btn sm" data-seek="start">⏮</button><button class="btn sm" data-seek="-1">−1 s</button>
                <button class="btn sm" data-seek="play">▶ / ❚❚</button><button class="btn sm" data-seek="1">+1 s</button><button class="btn sm" data-seek="end">⏭</button>
                <span class="mono small" id="mt-time">0:00.0 / ${fmtTime(tab === 'render' && out ? out.duration : pl.total)}</span>
              </div>
              ${progressBar(p, 'montage')}
              <div class="row" style="margin-top:12px">
                <button class="btn primary" id="mt-preview"${raw(busy ? ' disabled' : '')}>Prévisualiser</button>
                <button class="btn" id="mt-rerun"${raw(busy || !out ? ' disabled' : '')}>Relancer le montage</button>
                <span class="spacer"></span>
                <button class="btn primary" id="mt-validate"${raw(busy || !fresh || validated ? ' disabled' : '')}>${validated ? 'Montage validé ✓' : 'Valider le montage'}</button>
              </div>
            </div>

            <div class="card"><h2>Timeline</h2>
              <div class="timeline" id="tl"></div>
              <p class="small muted" style="margin-top:8px">Cliquez sur un plan de la source pour le couper ou le rétablir. Faites glisser la voix off pour ajuster sa position.</p>
              <details style="margin-top:8px"><summary class="small">Coupes précises (${pl.segs.length} passage(s) conservé(s), ${pl.videoLen.toFixed(1)} s)</summary>
                <table style="margin-top:8px"><thead><tr><th>Début (s)</th><th>Fin (s)</th><th></th></tr></thead><tbody>
                ${raw(pl.segs.map((s, i) => `<tr><td><input type="number" step="0.1" min="0" max="${a.meta.duration}" value="${s.start.toFixed(2)}" data-seg="${i}" data-edge="start"></td><td><input type="number" step="0.1" min="0" max="${a.meta.duration}" value="${s.end.toFixed(2)}" data-seg="${i}" data-edge="end"></td><td><button class="btn sm danger" data-segdel="${i}"${pl.segs.length < 2 ? ' disabled' : ''}>Retirer</button></td></tr>`).join(''))}
                </tbody></table>
                <div class="row" style="margin-top:8px"><button class="btn sm" id="seg-add">+ Ajouter un passage</button><button class="btn sm ghost" id="seg-reset">Toute la vidéo</button></div></details>
            </div>

            <div class="card"><h2>Synchronisation</h2>
              <dl class="kv"><dt>Images conservées</dt><dd>${fmtDuration(pl.videoLen)}</dd><dt>Voix off</dt><dd>${fmtDuration(v.duration)} (de ${sec(P.voiceOffset)} à ${sec(pl.voiceEnd)})</dd><dt>Durée finale</dt><dd>${fmtDuration(pl.total)}${pl.freeze > 0.05 ? ' dont ' + sec(pl.freeze) + ' d\'image figée' : ''}</dd>
                ${out?.subtitleTiming ? html`<dt>Sous-titres</dt><dd>${out.cues} lignes, horodatage ${out.subtitleTiming}</dd>` : ''}</dl>
              ${out ? raw([...out.warnings.map((w) => `<div class="alert ${w.level === 'warning' ? 'warning' : 'info'}" style="margin-top:10px">${esc(w.message)}</div>`),
                ...(out.issues || []).map((i) => `<div class="alert warning" style="margin-top:10px"><strong>Passage problématique</strong>${esc(i.message)}<div class="small muted">« ${esc(i.text)}… »</div></div>`)].join('')) : ''}
              ${out?.suggestion ? html`<div class="alert info" style="margin-top:10px"><strong>Coupe proposée</strong>Conserver ${out.suggestion.segments.length} passage(s) pour ${sec(out.suggestion.duration)}${out.suggestion.removedScenes.length ? ', en retirant le(s) plan(s) non commenté(s) ' + out.suggestion.removedScenes.join(', ') : ''}, sans couper la narration.
                <div class="row" style="margin-top:8px"><button class="btn sm primary" id="mt-apply">Appliquer la coupe proposée</button></div></div>` : ''}
              ${!out ? raw('<p class="small muted" style="margin-top:10px">L\'analyse détaillée (passages mal placés, coupes proposées) s\'affiche après le premier rendu.</p>') : ''}
            </div>
          </div>

          <div>
            <div class="card"><h2>Mode réaction (votre vidéo)</h2>
              <p class="small muted">Filmez-vous en train de réagir ou de commenter la vidéo (téléphone à la verticale, au moins ${Math.ceil(pl.total)} s). Votre vidéo partage l'écran avec l'originale : c'est ce qui rend un repost réellement original pour TikTok.</p>
              ${rx.file ? html`<div class="row" style="gap:12px;align-items:flex-start"><video controls preload="metadata" style="width:110px;border-radius:8px" src="${fileUrl(p, rx.file, { v: rx.v })}"></video>
                  <div style="flex:1"><label class="inline field"><input type="checkbox" id="rx-enabled"${raw(rx.enabled ? ' checked' : '')}> Utiliser ma vidéo dans le montage</label>
                  <div class="field"><label for="rx-layout">Mise en page</label><select id="rx-layout">${options([['split', 'Écran partagé : originale en haut, moi en bas (recommandé)'], ['pip', 'Incrustation : moi dans un coin']], rx.layout)}</select></div>
                  ${rx.layout === 'pip' ? html`<div class="field"><label for="rx-pipSide">Côté</label><select id="rx-pipSide">${options([['right', 'Droite'], ['left', 'Gauche']], rx.pipSide)}</select></div>${slider('rx-pipSize', 'Taille de l\'incrustation', 0.2, 0.6, 0.02, rx.pipSize, pct)}` : ''}
                  ${rx.hasAudio !== false ? slider('rx-volume', 'Son de ma vidéo (0 = coupé)', 0, 2, 0.05, rx.volume, pct) : raw('<p class="small muted">Votre vidéo n\'a pas de son.</p>')}
                  ${slider('rx-offset', 'Début utilisé dans ma vidéo', 0, Math.max(1, Math.floor(rx.duration || 60)), 0.5, rx.offset, sec)}
                  ${rx.duration && rx.duration < pl.total - 1 ? raw(`<div class="alert warning">Votre vidéo dure ${Math.round(rx.duration)} s pour un montage de ${Math.round(pl.total)} s : elle passera en boucle.</div>`) : ''}
                  <div class="row"><label class="btn sm">Remplacer<input id="rx-file" type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.m4v" hidden></label><button class="btn sm danger" id="rx-del">Retirer</button></div></div></div>
                  <p class="small muted">Si vous commentez vous-même, montez le son de votre vidéo et baissez la voix off (carte Audio).</p>`
                : raw('<div class="field"><input id="rx-file" type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.m4v"></div>')}
              <label class="inline field"><input type="checkbox" id="cr-enabled"${raw(P.credit.enabled ? ' checked' : '')}> Afficher « Vidéo originale : @créateur » en petit sur la vidéo</label>
              <p class="small muted">Visible après le rendu (l'aperçu instantané ne montre pas votre vidéo).</p>
            </div>
            <div class="card"><h2>Cadrage et arrière-plan</h2>
              ${slider('blur', 'Intensité du flou', 0, 80, 1, P.blur, FMT.blur)}
              ${slider('bgZoom', 'Zoom de l\'arrière-plan', 1, 2.5, 0.05, P.bgZoom, FMT.bgZoom)}
              ${slider('bgBrightness', 'Luminosité de l\'arrière-plan', -0.6, 0.3, 0.02, P.bgBrightness, FMT.bgBrightness)}
              ${slider('fgScale', 'Taille de la vidéo (plus grande = moins de flou)', 0.4, 2, 0.02, P.fgScale, FMT.fgScale)}
              ${slider('fgX', 'Position horizontale', -0.5, 0.5, 0.01, P.fgX, FMT.fgX)}
              ${slider('fgY', 'Position verticale', -0.5, 0.5, 0.01, P.fgY, FMT.fgY)}
            </div>
            <div class="card"><h2>Audio</h2>
              ${slider('voiceOffset', 'Début de la voix off', 0, Math.max(5, a.meta.duration), 0.1, P.voiceOffset, FMT.voiceOffset)}
              ${slider('voiceVolume', 'Volume de la voix off', 0, 2, 0.05, P.voiceVolume, FMT.voiceVolume)}
              ${a.meta.hasAudio ? slider('originalVolume', 'Son original (0 = coupé)', 0, 1, 0.05, P.originalVolume, FMT.originalVolume) : raw('<p class="small muted">La vidéo source n\'a pas de son.</p>')}
              <div class="field"><label>Musique de fond (fichier dont vous détenez les droits)</label>
                ${P.musicFile ? raw(`<div class="row"><audio controls preload="none" style="flex:1" src="${fileUrl(p, P.musicFile)}"></audio><button class="btn sm danger" id="music-del">Retirer</button></div>`) : ''}
                <input id="music-file" type="file" accept="audio/*,.mp3,.wav,.m4a"></div>
              ${P.musicFile ? slider('musicVolume', 'Volume de la musique', 0, 1, 0.02, P.musicVolume, FMT.musicVolume) : ''}
            </div>
            <div class="card"><h2>Accroche visuelle et dynamisme</h2>
              <label class="inline field"><input type="checkbox" id="ht-enabled"${raw(P.hookTitle.enabled ? ' checked' : '')}> Titre choc en haut de l'écran au début de la vidéo</label>
              <div class="field"><label for="ht-text">Texte du titre (*mot* = mot en couleur)</label><input id="ht-text" type="text" maxlength="60" value="${P.hookTitle.text}" placeholder="${p.hook?.screen || 'Généré avec l\'accroche du script'}"></div>
              ${slider('ht-duration', 'Durée d\'affichage', 1, 6, 0.5, P.hookTitle.duration, sec)}
              <label class="inline field"><input type="checkbox" id="pi-enabled"${raw(P.punchIn.enabled ? ' checked' : '')}> Montage dynamique : zoom « punch-in » une phrase sur deux</label>
              ${slider('pi-zoom', 'Intensité du zoom', 1.04, 1.3, 0.01, P.punchIn.zoom, (v) => '+' + Math.round((v - 1) * 100) + ' %')}
            </div>
            <div class="card"><h2>Durée</h2>
              <label class="inline field"><input type="checkbox" id="exactDuration"${raw(P.exactDuration ? ' checked' : '')}> Vidéo finale de ${p.params.durationTarget} s exactement (durée cible du projet) : coupée si la source est plus longue, dernière image figée si elle est plus courte</label>
              <label class="inline field"><input type="checkbox" id="fit"${raw(P.fit === 'freeze' ? ' checked' : '')}> Si la voix dépasse les images, figer la dernière image (la narration n'est jamais coupée)</label>
              <label class="inline field"><input type="checkbox" id="trimToVoice"${raw(P.trimToVoice ? ' checked' : '')}> Couper la vidéo à la fin de la narration</label>
              ${slider('tail', 'Marge après la narration', 0, 3, 0.1, P.tail, FMT.tail)}
            </div>
            <div class="card"><h2>Masque des sous-titres incrustés</h2>${maskEditor(p, P.mask)}</div>
            <div class="card"><h2>Sous-titres</h2>
              <label class="inline field"><input type="checkbox" id="sub-enabled"${raw(sub.enabled ? ' checked' : '')}> Sous-titres automatiques synchronisés</label>
              ${raw(presetCards(sub))}
              <div class="grid two">
                <div class="field"><label for="sub-animation">Animation</label><select id="sub-animation">${options([['phrase', 'Phrase (quelques mots)'], ['mot', 'Mot par mot']], sub.animation || 'phrase')}</select></div>
                <label class="inline field"><input type="checkbox" id="sub-box"${raw(sub.box ? ' checked' : '')}> Fond derrière le texte (box)</label>
                ${sub.box ? html`<div class="field"><label for="sub-boxColor">Couleur de la box</label><input id="sub-boxColor" type="color" value="${sub.boxColor || '#000000'}"></div>
                  ${slider('sub-boxOpacity', 'Opacité de la box', 0.3, 1, 0.05, sub.boxOpacity ?? 0.85, (v) => Math.round(v * 100) + ' %')}` : ''}
              </div>
              <div class="grid two">
                <div class="field"><label for="sub-font">Police</label><select id="sub-font">${options(FONTS.map((f) => [f, f]), sub.font)}</select></div>
                <div class="field"><label for="sub-position">Position</label><select id="sub-position">${options([['bottom', 'Bas'], ['middle', 'Centre'], ['top', 'Haut']], sub.position)}</select></div>
                <div class="field"><label for="sub-color">Couleur</label><input id="sub-color" type="color" value="${sub.color}"></div>
                <div class="field"><label for="sub-outline">Contour</label><input id="sub-outline" type="color" value="${sub.outline}"></div>
                <div class="field"><label for="sub-maxWords">Mots par ligne</label><input id="sub-maxWords" type="number" min="1" max="10" value="${sub.maxWords}"></div>
                <div class="field"><label for="sub-marginV">Marge verticale (px)</label><input id="sub-marginV" type="number" min="0" max="900" step="10" value="${sub.marginV}"></div>
              </div>
              ${slider('sub-size', 'Taille', 30, 140, 2, sub.size, FMT.size)}
              ${slider('sub-outlineWidth', 'Épaisseur du contour', 0, 14, 1, sub.outlineWidth, FMT.outlineWidth)}
              <div class="grid two">
                <label class="inline field"><input type="checkbox" id="sub-highlight"${raw(sub.highlight ? ' checked' : '')}> Surligner le mot prononcé</label>
                <div class="field"><label for="sub-highlightColor">Couleur du mot surligné</label><input id="sub-highlightColor" type="color" value="${sub.highlightColor}"></div>
              </div>
              <label class="inline"><input type="checkbox" id="sub-animate"${raw(sub.animate ? ' checked' : '')}> Apparition animée</label>
              <label class="inline"><input type="checkbox" id="sub-uppercase"${raw(sub.uppercase ? ' checked' : '')}> Majuscules</label>
            </div>
          </div>
        </div>`;
    },

    bind(root, c) {
      const p = c.p;
      bindCommon(root, c);
      const a = p.steps.source_analyze?.output;
      const v = p.steps.voice?.output;
      if (!a || !v || !defaults) return;
      // fgScale par défaut : même règle que le serveur (lib/media.js autoFgScale).
      const base = () => ({ ...defaults, fgScale: autoFgScale(a.meta), ...(p.montageParams || {}), targetDuration: Number(p.params.durationTarget) || 0, subtitles: { ...defaults.subtitles, ...(p.montageParams?.subtitles || {}) },
        reaction: { ...defaults.reaction, ...(p.montageParams?.reaction || {}) } });
      let P = base();
      const save = async (patch) => {
        try { const np = await api('PUT', `/api/projects/${p.id}/montage/params`, patch); c.setProject(np); } catch (e) { toast(e.message, 'error'); }
      };

      // --- Aperçu instantané (simulation CSS du rendu FFmpeg) ---
      const live = root.querySelector('#live');
      const bg = root.querySelector('#live-bg');
      const fg = root.querySelector('#live-fg');
      const subEl = root.querySelector('#live-sub');
      function paintLive() {
        if (!live) return;
        const W = live.clientWidth, H = live.clientHeight;
        const ar = a.meta.width / a.meta.height;
        const fw = W * P.fgScale;
        let w = fw, h = fw / ar;
        if (h > H * 2) { h = H * 2; w = h * ar; }
        Object.assign(fg.style, { width: w + 'px', height: h + 'px', transform: `translate(calc(-50% + ${P.fgX * W}px), calc(-50% + ${P.fgY * H}px))` });
        Object.assign(bg.style, { transform: `scale(${P.bgZoom})`, filter: `blur(${(P.blur * W) / 1080 / 1.2}px) brightness(${1 + P.bgBrightness * 1.6})` });
        const s = P.subtitles;
        const px = H / 1920;
        Object.assign(subEl.style, { display: s.enabled ? 'block' : 'none', fontFamily: `'${s.font}'`, fontWeight: 900, fontSize: s.size * px + 'px', color: s.color,
          WebkitTextStroke: s.box ? '0' : `${(s.outlineWidth ?? 6) * 2 * px}px ${s.outline}`, paintOrder: 'stroke fill', textShadow: s.box ? 'none' : `0 ${4 * px}px ${6 * px}px rgba(0,0,0,.45)`,
          background: s.box ? s.boxColor + Math.round((s.boxOpacity ?? 0.85) * 255).toString(16).padStart(2, '0') : 'transparent', padding: s.box ? `${10 * px}px ${16 * px}px` : '0' });
        subEl.style.top = subEl.style.bottom = '';
        if (s.position === 'top') subEl.style.top = (s.marginV * H) / 1920 + 'px';
        else if (s.position === 'middle') subEl.style.top = '48%';
        else subEl.style.bottom = (s.marginV * H) / 1920 + 'px';
        const sample = ['Exemple', 'de', 'sous-titre'].map((w) => (s.uppercase ? w.toUpperCase() : w));
        subEl.innerHTML = sample.map((w, i) => (s.highlight && i === 1 ? `<span style="color:${esc(s.highlightColor)}">${esc(w)}</span>` : esc(w))).join(' ');
      }
      if (live) {
        fg.addEventListener('timeupdate', () => { if (Math.abs(bg.currentTime - fg.currentTime) > 0.25) bg.currentTime = fg.currentTime; });
        fg.addEventListener('loadedmetadata', paintLive);
        new ResizeObserver(paintLive).observe(live);
        paintLive();
      }
      const player = root.querySelector('#mt-player') || fg;
      const timeEl = root.querySelector('#mt-time');

      // --- Réglages ---
      root.querySelectorAll('input[type=range]').forEach((el) => {
        const key = el.id;
        // Préfixe d'identifiant → groupe de réglages imbriqué (sous-titres, titre choc, punch-in).
        const group = Object.entries(GROUPS).find(([pre]) => key.startsWith(pre));
        const k = group ? key.slice(group[0].length) : key;
        const outEl = el.parentElement.querySelector('output');
        el.addEventListener('input', () => {
          const val = Number(el.value);
          outEl.textContent = (FMT[k] || num)(val);
          if (group) P[group[1]][k] = val; else P[k] = val;
          paintLive();
          if (k === 'voiceOffset') drawTimeline();
        });
        el.addEventListener('change', () => save(group ? { [group[1]]: { [k]: Number(el.value) } } : { [k]: Number(el.value) }));
      });
      const bindInput = (id, fn) => root.querySelector('#' + id)?.addEventListener('change', (e) => save(fn(e.target)));
      bindInput('fit', (t) => ({ fit: t.checked ? 'freeze' : 'none' }));
      bindInput('trimToVoice', (t) => ({ trimToVoice: t.checked }));
      bindInput('exactDuration', (t) => ({ exactDuration: t.checked }));
      bindInput('ht-enabled', (t) => ({ hookTitle: { enabled: t.checked } }));
      bindInput('ht-text', (t) => ({ hookTitle: { text: t.value.trim() } }));
      bindInput('pi-enabled', (t) => ({ punchIn: { enabled: t.checked } }));
      bindInput('sub-enabled', (t) => ({ subtitles: { enabled: t.checked } }));
      bindInput('sub-uppercase', (t) => ({ subtitles: { uppercase: t.checked } }));
      bindInput('sub-highlight', (t) => ({ subtitles: { highlight: t.checked } }));
      bindInput('sub-animate', (t) => ({ subtitles: { animate: t.checked } }));
      bindInput('sub-box', (t) => ({ subtitles: { box: t.checked } }));
      bindMask(root, save);
      bindInput('sub-animation', (t) => ({ subtitles: { animation: t.value } }));
      bindInput('sub-boxColor', (t) => ({ subtitles: { boxColor: t.value } }));
      root.querySelectorAll('[data-subpreset]').forEach((b) => b.addEventListener('click', () => save({ subtitles: SUB_PRESETS.find((x) => x.id === b.dataset.subpreset).patch })));
      ['font', 'position', 'color', 'outline', 'highlightColor'].forEach((k) => bindInput('sub-' + k, (t) => ({ subtitles: { [k]: t.value } })));
      ['maxWords', 'marginV'].forEach((k) => bindInput('sub-' + k, (t) => ({ subtitles: { [k]: Number(t.value) } })));
      ['color', 'outline', 'highlightColor'].forEach((k) => root.querySelector('#sub-' + k)?.addEventListener('input', (e) => { P.subtitles[k] = e.target.value; paintLive(); }));
      root.querySelector('#music-file')?.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { await upload(`/api/projects/${p.id}/montage/music`, f, {}); toast('Musique ajoutée.'); } catch (err) { toast(err.message, 'error'); }
        c.refresh();
      });
      root.querySelector('#music-del')?.addEventListener('click', () => save({ musicFile: '' }));
      bindInput('rx-enabled', (t) => ({ reaction: { enabled: t.checked } }));
      ['layout', 'pipSide'].forEach((k) => bindInput('rx-' + k, (t) => ({ reaction: { [k]: t.value } })));
      bindInput('cr-enabled', (t) => ({ credit: { enabled: t.checked } }));
      root.querySelector('#rx-file')?.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        toast('Import de votre vidéo…');
        try { await upload(`/api/projects/${p.id}/montage/reaction`, f, {}); toast('Votre vidéo est ajoutée : relancez le rendu pour la voir.'); } catch (err) { toast(err.message, 'error'); }
        c.refresh();
      });
      root.querySelector('#rx-del')?.addEventListener('click', () => save({ reaction: { enabled: false, file: '' } }));

      // --- Coupes ---
      const segs = () => kept(P, a.meta.duration).map((s) => ({ ...s }));
      root.querySelectorAll('[data-seg]').forEach((el) => el.addEventListener('change', () => {
        const list = segs();
        list[Number(el.dataset.seg)][el.dataset.edge] = Number(el.value);
        save({ segments: list });
      }));
      root.querySelectorAll('[data-segdel]').forEach((el) => el.addEventListener('click', () => { const list = segs(); list.splice(Number(el.dataset.segdel), 1); save({ segments: list }); }));
      root.querySelector('#seg-add')?.addEventListener('click', () => {
        const list = segs();
        const last = list[list.length - 1];
        const start = Math.min(a.meta.duration - 0.5, last.end + 0.5);
        list.push({ start, end: Math.min(a.meta.duration, start + 2) });
        save({ segments: list });
      });
      root.querySelector('#seg-reset')?.addEventListener('click', () => save({ segments: null }));
      root.querySelector('#mt-apply')?.addEventListener('click', () => save({ segments: p.steps.montage.output.suggestion.segments.map(({ start, end }) => ({ start, end })) }));

      // --- Timeline ---
      const tl = root.querySelector('#tl');
      function drawTimeline() {
        const pl = plan(P, a.meta.duration, v.duration);
        const span = Math.max(a.meta.duration, pl.total) || 1;
        const x = (t) => (t / span) * 100;
        const segsK = pl.segs;
        const isCut = (s) => !segsK.some((k) => Math.min(k.end, s.end) - Math.max(k.start, s.start) > (s.end - s.start) * 0.5);
        let acc = 0;
        const outBlocks = segsK.map((s) => { const b = `<div class="tl-block scene" style="left:${x(acc)}%;width:${x(s.end - s.start)}%;cursor:default" title="Source ${fmtTime(s.start)} → ${fmtTime(s.end)}">${fmtTime(s.start)}</div>`; acc += s.end - s.start; return b; }).join('');
        const freeze = pl.freeze > 0.05 ? `<div class="tl-block freeze" style="left:${x(pl.videoLen)}%;width:${x(pl.freeze)}%" title="Image figée">figée</div>` : '';
        const out = p.steps.montage?.output;
        const cues = st(p, 'montage') === 'done' && out?.cueList ? out.cueList.map((q) => `<div class="tl-block sub" style="left:${x(q.s)}%;width:${x(q.e - q.s)}%" title="${esc(q.t)}">${esc(q.t)}</div>`).join('') : '';
        const issues = (out?.issues || []).map((i) => `<div class="tl-issue" style="left:${x(i.at)}%" title="${esc(i.message)}"></div>`).join('');
        const ticks = Array.from({ length: Math.floor(span / Math.max(1, Math.ceil(span / 10))) + 1 }, (_, i) => i * Math.max(1, Math.ceil(span / 10))).map((t) => `<span style="left:${x(t)}%">${t}s</span>`).join('');
        tl.innerHTML = `<div class="tl-ruler">${ticks}</div>
          <div class="tl-track"><div class="tl-label">Source</div><div class="tl-lane">${a.scenes.map((s) => `<div class="tl-block scene${isCut(s) ? ' cut' : ''}" data-scene="${s.index}" style="left:${x(s.start)}%;width:${x(s.end - s.start)}%" title="Plan ${s.index} : ${fmtTime(s.start)} → ${fmtTime(s.end)} — cliquer pour ${isCut(s) ? 'rétablir' : 'couper'}">Plan ${s.index}</div>`).join('')}</div></div>
          <div class="tl-track"><div class="tl-label">Montage</div><div class="tl-lane" data-lane="out">${outBlocks}${freeze}${issues}<div class="tl-playhead" style="left:0"></div></div></div>
          <div class="tl-track"><div class="tl-label">Voix off</div><div class="tl-lane" data-lane="voice"><div class="tl-block voice" id="tl-voice" style="left:${x(P.voiceOffset)}%;width:${x(v.duration)}%">voix ${fmtTime(P.voiceOffset)} → ${fmtTime(pl.voiceEnd)}</div><div class="tl-playhead" style="left:0"></div></div></div>
          ${P.subtitles.enabled ? `<div class="tl-track"><div class="tl-label">Sous-titres</div><div class="tl-lane">${cues || '<span class="small muted" style="padding:8px;display:block">générés au rendu</span>'}</div></div>` : ''}
          ${P.musicFile ? `<div class="tl-track"><div class="tl-label">Musique</div><div class="tl-lane"><div class="tl-block music" style="left:0;width:${x(pl.total)}%">musique ${Math.round(P.musicVolume * 100)} %</div></div></div>` : ''}`;

        tl.querySelectorAll('[data-scene]').forEach((el) => el.addEventListener('click', () => {
          const idx = Number(el.dataset.scene);
          const keep = a.scenes.filter((s) => (s.index === idx ? isCut(s) : !isCut(s)));
          if (!keep.length) return toast('Au moins un plan doit être conservé.', 'error');
          const merged = [];
          for (const s of keep) { const l = merged[merged.length - 1]; if (l && Math.abs(l.end - s.start) < 0.02) l.end = s.end; else merged.push({ start: s.start, end: s.end }); }
          save({ segments: merged.length === 1 && merged[0].start === 0 && Math.abs(merged[0].end - a.meta.duration) < 0.02 ? null : merged });
        }));
        // Glisser la voix off.
        const vb = tl.querySelector('#tl-voice');
        const lane = tl.querySelector('[data-lane="voice"]');
        vb.addEventListener('pointerdown', (e) => {
          vb.setPointerCapture(e.pointerId);
          const startX = e.clientX, startOff = P.voiceOffset, w = lane.clientWidth;
          const move = (ev) => {
            P.voiceOffset = Math.max(0, Math.round((startOff + ((ev.clientX - startX) / w) * span) * 10) / 10);
            vb.style.left = x(P.voiceOffset) + '%';
            vb.textContent = `voix ${fmtTime(P.voiceOffset)} → ${fmtTime(P.voiceOffset + v.duration)}`;
          };
          const up = () => { vb.removeEventListener('pointermove', move); vb.removeEventListener('pointerup', up); if (P.voiceOffset !== startOff) save({ voiceOffset: P.voiceOffset }); };
          vb.addEventListener('pointermove', move);
          vb.addEventListener('pointerup', up);
        });
        return span;
      }
      const span = drawTimeline();

      // --- Lecteur ---
      const onTime = () => {
        const t = player.currentTime || 0;
        timeEl.textContent = `${fmtTime(t)} / ${fmtTime(player.duration || 0)}`;
        if (player.id === 'mt-player') tl.querySelectorAll('.tl-playhead').forEach((ph) => { ph.style.left = (t / span) * 100 + '%'; });
      };
      player.addEventListener('timeupdate', onTime);
      root.querySelectorAll('[data-seek]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.seek;
        const both = (fn) => { fn(player); if (player === fg && bg) fn(bg); };
        if (k === 'play') both((m) => (m.paused ? m.play() : m.pause()));
        else if (k === 'start') both((m) => { m.currentTime = 0; });
        else if (k === 'end') both((m) => { m.currentTime = Math.max(0, (m.duration || 0) - 0.1); });
        else both((m) => { m.currentTime = Math.max(0, m.currentTime + Number(k)); });
      }));

      root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { c.app.montageTab = b.dataset.tab; c.refresh(); }));
      root.querySelector('#mt-preview').addEventListener('click', () => {
        if (st(p, 'montage') === 'done') { c.app.montageTab = 'render'; c.refresh().then(() => document.getElementById('mt-player')?.play()); return; }
        c.app.montageTab = 'render';
        act(c, () => api('POST', `/api/projects/${p.id}/montage/render`), 'Rendu du montage en cours…');
      });
      root.querySelector('#mt-rerun')?.addEventListener('click', () => { c.app.montageTab = 'render'; act(c, () => api('POST', `/api/projects/${p.id}/montage/render`), 'Nouveau rendu en cours…'); });
      root.querySelector('#mt-validate')?.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${p.id}/montage/validate`), 'Montage validé.'));
    },
  };
}
