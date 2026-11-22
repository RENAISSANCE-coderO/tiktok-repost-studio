// Assistant en 5 étapes (Liens → Accroche → Paramètres → Script → Génération), pour aller vite.
// Les pages détaillées du projet restent disponibles pour les réglages avancés.
import { api, upload, html, raw, esc, toast, fileUrl, stepError, progressBar, options, wordCount, LANGS, autoFgScale, fillScale } from './core.js';
import { voiceCards, bindVoiceCards } from './voicecards.js';
import { presetCards, SUB_PRESETS } from './substyles.js';
import { maskEditor, bindMask } from './maskdraw.js';
import { promptBox, bindPromptBox } from './promptbox.js';

const STEPS = ['Liens', 'Hook', 'Paramètres', 'Script', 'Génération'];
const TITLES = ['Colle tes liens TikTok', 'Choisis le début de ton TikTok viral', 'Paramètres de ta vidéo', 'Script de ta vidéo', 'Génération de ta vidéo'];
const compact = (n) => (n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : n >= 1e3 ? Math.round(n / 100) / 10 + 'k' : String(n));

export function wizardPage({ act, st, anyRunning, bindCommon }) {
  let voices = null;
  let defaults = null;
  const go = (p, n) => { location.hash = `#/p/${p.id}/go/${n}`; };

  function head(p, n) {
    const done = [st(p, 'source_analyze') === 'done', st(p, 'source_analyze') === 'done', Boolean(p.voiceParams), Boolean(p.finalScript.text), st(p, 'export') === 'done'];
    return `<div class="wiz-steps">${STEPS.map((_, i) => `<a href="#/p/${p.id}/go/${i + 1}" class="${i + 1 === n ? 'cur' : done[i] ? 'done' : ''}">${i + 1}</a>`).join('')}</div>
      <div class="wiz-caption">Étape ${n} sur 5 - ${STEPS[n - 1]}</div><h1 class="big">${TITLES[n - 1]}</h1>`;
  }

  // --- Étape 1 : liens ---
  function step1(c) {
    const p = c.p;
    const cur = p.source.urls || (p.source.origin === 'tiktok' && p.source.url ? [p.source.url] : []);
    c.app.wizLinks ||= cur.length ? [...cur] : [''];
    return `<div class="card">
      ${c.app.wizLinks.map((u, i) => `<div class="link-row"><span>🔗</span><input type="url" data-link="${i}" value="${esc(u)}" placeholder="https://www.tiktok.com/@compte/video/…">${c.app.wizLinks.length > 1 ? `<button class="btn sm ghost" data-unlink="${i}" title="Retirer">✕</button>` : ''}</div>`).join('')}
      ${c.app.wizLinks.length < 6 ? '<button class="btn ghost" id="wz-add" style="width:100%;border-style:dashed">+ Ajouter un nouveau lien</button>' : ''}
      <label class="inline field" style="margin-top:12px"><input type="checkbox" id="wz-rights"${p.source.rightsConfirmed ? ' checked' : ''}> Je confirme disposer des droits d'utilisation et de modification de ces vidéos.</label>
      <div class="actions"><button class="btn primary" id="wz-next1"${anyRunning(p) ? ' disabled' : ''}>Continuer →</button></div>
      <p class="small muted">Vous avez un fichier sur votre ordinateur ? <a href="#/p/${p.id}/source">Importez-le ici</a>.</p></div>
      <div class="card"><h2>💡 Conseils</h2><p class="small">• Utilisez des vidéos qui ont déjà de bonnes performances.<br>• Mélangez plusieurs vidéos du même thème : la vidéo obtenue est plus originale.</p></div>`;
  }

  // --- Étape 2 : accroche ---
  function step2(c) {
    const p = c.p;
    const fetching = ['running'].includes(st(p, 'source_fetch')) || ['running'].includes(st(p, 'source_analyze'));
    if (st(p, 'source_fetch') !== 'done' || fetching) {
      return `<div class="card">${fetching || anyRunning(p) ? `<p>Récupération des vidéos… cela peut prendre une minute par vidéo.</p>${progressBar(p, 'source_fetch')}${progressBar(p, 'source_analyze')}` : ''}
        ${stepError(p, 'source_fetch')}${!anyRunning(p) && st(p, 'source_fetch') !== 'done' ? `<p class="muted">Aucune vidéo récupérée. <a href="#/p/${p.id}/go/1">Retour aux liens</a></p>` : ''}</div>`;
    }
    const clips = p.source.clips;
    if (!clips?.length) {
      return `<div class="hook-grid"><div class="hook-card on"><video src="${fileUrl(p, p.source.file)}#t=0.5" muted playsinline preload="metadata" controls></video><div class="meta">Une seule vidéo : elle sert de début.</div></div></div>
        <div class="actions"><button class="btn primary" id="wz-next2">Continuer →</button><a class="btn" href="#/p/${p.id}/go/1">← Retour</a></div>`;
    }
    const sel = c.app.wizHook ?? (p.source.hook || 0);
    return `<div class="hook-grid">${clips.map((k) => `<div class="hook-card${k.index === sel ? ' on' : ''}" data-hook="${k.index}">${k.index === (p.source.hook || 0) ? '<span class="badge-first">Début actuel</span>' : ''}
        <video src="${fileUrl(p, k.file)}#t=0.5" muted playsinline loop preload="metadata"></video>
        <div class="meta"><strong>${esc(k.title || '@' + k.uploader)}</strong><div class="muted">${k.stats?.views != null ? compact(k.stats.views) + ' vues' : ''}${k.used ? ` · ${Math.round(k.used.end - k.used.start)} s utilisées` : ''}</div></div></div>`).join('')}</div>
      <div class="actions"><button class="btn primary" id="wz-next2"${anyRunning(p) ? ' disabled' : ''}>Choisir ce début ✓</button><a class="btn" href="#/p/${p.id}/go/1">← Retour</a></div>`;
  }

  // --- Étape 3 : paramètres ---
  function step3(c) {
    const p = c.p;
    const provs = voices.providers;
    const vp = c.app.voiceDraft || p.voiceParams || {};
    const prov = provs.find((x) => x.id === vp.provider && x.available) || provs.find((x) => x.available) || provs[0];
    const lang = vp.language || p.params.language;
    const gender = vp.gender || 'all';
    const list = prov.voices.filter((v) => (v.lang === '*' || v.lang === lang.slice(0, 2)) && (gender === 'all' || v.gender === gender || v.gender === 'N'));
    const M = { ...defaults, ...(p.montageParams || {}) };
    const sub = { ...defaults.subtitles, ...(p.montageParams?.subtitles || {}) };
    // Sans réglage enregistré, une source verticale est réduite à 92 % (bordure floue visible), comme au rendu.
    const meta = p.source.meta || {};
    // Flou visible tant que la vidéo ne remplit pas tout le cadre.
    const blurOn = (p.montageParams?.fgScale ?? autoFgScale(meta)) < fillScale(meta) - 0.01 && (M.blur ?? 30) > 0;
    return `<div class="card"><h2>🎙️ Voix IA</h2>
        <div class="field"><label for="wz-prov">Service</label><select id="wz-prov">${provs.map((x) => `<option value="${esc(x.id)}"${x.id === prov.id ? ' selected' : ''}${x.available ? '' : ' disabled'}>${esc(x.label)}${x.available ? '' : ' — ' + esc(x.reason)}</option>`).join('')}</select></div>
        <div class="grid two"><div class="field"><label for="wz-lang">Langue</label><select id="wz-lang">${options(LANGS, lang)}</select></div>
          <div class="field"><label for="wz-gender">Genre</label><select id="wz-gender">${options([['all', 'Tous'], ['F', 'Féminine'], ['M', 'Masculine']], gender)}</select></div></div>
        ${voiceCards(prov, list, vp.voice, lang)}</div>
      <div class="card"><h2>🔤 Sous-titres</h2>
        <label class="inline field"><input type="checkbox" id="wz-subs"${sub.enabled ? ' checked' : ''}> Sous-titres incrustés</label>
        ${sub.enabled ? `<div class="field"><label for="wz-anim">Animation</label><select id="wz-anim">${options([['phrase', 'Phrase'], ['mot', 'Mot par mot']], sub.animation || 'phrase')}</select></div>${presetCards(sub)}` : ''}</div>
      <div class="card"><h2>🎵 Musique de fond</h2>
        ${M.musicFile ? `<div class="row"><audio controls preload="none" style="flex:1" src="${fileUrl(p, M.musicFile)}"></audio><button class="btn sm danger" id="wz-music-del">Retirer</button></div>` : '<p class="small muted">Sans musique de fond. Importez un fichier dont vous détenez les droits.</p>'}
        <input id="wz-music" type="file" accept="audio/*,.mp3,.wav,.m4a"></div>
      <div class="card"><h2>▦ Arrière-plan flou</h2>
        <label class="inline field"><input type="checkbox" id="wz-blur"${blurOn ? ' checked' : ''}> Ajouter un flou en haut et en bas de la vidéo (format 9:16)</label></div>
      <div class="card"><h2>✂️ Masque des sous-titres incrustés</h2>${maskEditor(p, { ...defaults.mask, ...(p.montageParams?.mask || {}) })}</div>
      <div class="actions"><a class="btn primary" href="#/p/${p.id}/go/4">Suivant →</a><a class="btn" href="#/p/${p.id}/go/2">← Retour</a></div>
      <p class="small muted" style="text-align:center">Plus de réglages (mode réaction, titre choc, zooms, cadrage) : <a href="#/p/${p.id}/montage">page Montage</a>.</p>`;
  }

  // --- Étape 4 : script ---
  function step4(c) {
    const p = c.p;
    const busy = anyRunning(p);
    const extracted = st(p, 'reference_extract') === 'done';
    const text = p.finalScript.text || '';
    const tgt = p.scriptTarget || { seconds: p.params.durationTarget, wps: 2.6 };
    const sec = Math.round(wordCount(text) / (tgt.wps || 2.6));
    return `<div class="card" style="text-align:center"><strong>Tu as déjà une inspiration ?</strong>
        <div class="link-row" style="margin-top:10px"><input id="wz-ref" type="url" data-keep placeholder="Lien de la vidéo TikTok virale" value="${esc(p.reference.url || '')}">
          <button class="btn primary" id="wz-fetchref"${busy ? ' disabled' : ''}>📄 Récupérer le script</button></div>
        ${progressBar(p, 'reference_fetch')}${progressBar(p, 'reference_extract')}${stepError(p, 'reference_fetch')}${stepError(p, 'reference_extract')}
        ${extracted ? `<details style="text-align:left;margin-top:8px"><summary class="small">Script récupéré (${wordCount(p.reference.script)} mots)</summary><p class="small" style="white-space:pre-wrap">${esc(p.reference.script)}</p></details>
          <button class="btn" id="wz-adapt" style="margin-top:8px"${busy ? ' disabled' : ''}>✨ Adapter ce script à ma vidéo</button>` : ''}
        ${progressBar(p, 'narrative_agent')}${progressBar(p, 'visual_agent')}${progressBar(p, 'script_agent')}${stepError(p, 'script_agent')}</div>
      <div class="card"><strong>Ton script viral</strong>
        <textarea id="wz-script" data-keep style="min-height:260px;margin-top:8px" placeholder="Décris ce qui se passe dans ta vidéo, ou récupère un script ci-dessus.">${esc(text)}</textarea>
        <div class="counter-row"><span id="wz-count">${wordCount(text)} mots</span><span id="wz-sec">≈ ${sec} s (cible ${tgt.seconds} s)</span></div>
        <div class="row" style="justify-content:center;margin-top:8px"><button class="btn" id="wz-opt"${busy || !text ? ' disabled' : ''}>🪄 Ajuster à ${tgt.seconds} s</button></div>
        ${promptBox(p, { disabled: busy || !text, inline: true })}
        <div class="actions"><button class="btn primary" id="wz-gen"${busy ? ' disabled' : ''}>Générer la vidéo →</button><a class="btn" href="#/p/${p.id}/go/3">← Retour</a></div></div>
      <div class="card"><h2>✨ Conseils pour un script viral</h2><p class="small">• Décris précisément ce qu'il se passe dans ta vidéo.<br>• Garde le dénouement pour la fin pour augmenter ton watchtime.</p></div>`;
  }

  // --- Étape 5 : génération ---
  function step5(c) {
    const p = c.p;
    const steps = [['voice', 'Voix off'], ['montage', 'Montage'], ['export', 'Export MP4']];
    const out = st(p, 'export') === 'done' ? p.steps.export.output : null;
    const failed = steps.find(([s]) => st(p, s) === 'error');
    return `<div class="card"><ul class="steps-list">${steps.map(([s, l]) => `<li><span>${l}</span>${raw(`<span class="badge ${st(p, s)}">${{ done: 'terminé', running: 'en cours', error: 'erreur', stale: 'à refaire', todo: 'en attente' }[st(p, s)] || st(p, s)}</span>`)}</li>${progressBar(p, s)}`).join('')}</ul>
        ${failed ? stepError(p, failed[0]) + '<div class="actions"><button class="btn primary" id="wz-retry">Réessayer</button></div>' : ''}
        ${!out && !anyRunning(p) && !failed ? `<div class="actions"><button class="btn primary" id="wz-retry">Lancer la génération</button></div>` : ''}</div>
      ${out ? `<div class="card" style="text-align:center"><video class="player" data-key="wz-final" controls src="${fileUrl(p, out.file, { v: p.steps.export.finishedAt })}" style="max-height:560px"></video>
        <div class="actions"><a class="btn primary" href="${fileUrl(p, out.file, { download: true })}">⬇ Télécharger la vidéo</a><a class="btn" href="#/p/${p.id}/publish">Titre, description et score de viralité →</a></div>
        <p class="small muted">Retouches fines : <a href="#/p/${p.id}/montage">page Montage</a>.</p></div>` : ''}
      <div class="actions"><a class="btn" href="#/p/${p.id}/go/4">← Retour au script</a></div>`;
  }

  return {
    title: 'Assistant',
    async load() {
      voices ||= await api('GET', '/api/voices');
      defaults ||= await api('GET', '/api/montage/defaults');
    },
    render(c) {
      const n = Math.min(5, Math.max(1, Number(c.route.step) || 1));
      const body = [step1, step2, step3, step4, step5][n - 1](c);
      return `<div class="wiz">${head(c.p, n)}${body}</div>`;
    },
    bind(root, c) {
      const p = c.p;
      const n = Math.min(5, Math.max(1, Number(c.route.step) || 1));
      bindCommon(root, c);
      const saveMontage = async (patch) => { try { c.setProject(await api('PUT', `/api/projects/${p.id}/montage/params`, patch)); } catch (e) { toast(e.message, 'error'); } };

      if (n === 1) {
        const links = () => [...root.querySelectorAll('[data-link]')].map((el) => el.value.trim());
        root.querySelectorAll('[data-link]').forEach((el) => el.addEventListener('input', () => { c.app.wizLinks = links(); }));
        root.querySelector('#wz-add')?.addEventListener('click', () => { c.app.wizLinks = [...links(), '']; c.setProject(p); });
        root.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', () => { const l = links(); l.splice(Number(b.dataset.unlink), 1); c.app.wizLinks = l; c.setProject(p); }));
        root.querySelector('#wz-next1').addEventListener('click', async () => {
          const urls = links().filter(Boolean);
          const cur = p.source.urls || (p.source.url ? [p.source.url] : []);
          if (urls.length && JSON.stringify(urls) === JSON.stringify(cur) && st(p, 'source_fetch') === 'done') return go(p, 2);
          const ok = await act(c, () => api('POST', `/api/projects/${p.id}/source/urls`, { urls, rightsConfirmed: root.querySelector('#wz-rights').checked }));
          if (ok) { c.app.wizHook = null; go(p, 2); }
        });
      }
      if (n === 2) {
        root.querySelectorAll('[data-hook]').forEach((card) => {
          const v = card.querySelector('video');
          card.addEventListener('mouseenter', () => v?.play().catch(() => {}));
          card.addEventListener('mouseleave', () => v?.pause());
          card.addEventListener('click', () => { c.app.wizHook = Number(card.dataset.hook); root.querySelectorAll('[data-hook]').forEach((x) => x.classList.toggle('on', x === card)); });
        });
        root.querySelector('#wz-next2')?.addEventListener('click', async () => {
          const sel = c.app.wizHook ?? (p.source.hook || 0);
          if (p.source.clips?.length && sel !== (p.source.hook || 0)) {
            const ok = await act(c, () => api('POST', `/api/projects/${p.id}/source/hook`, { index: sel }), 'Nouveau début : la vidéo est réassemblée…');
            if (!ok) return;
          }
          go(p, 3);
        });
      }
      if (n === 3) {
        const vp = () => ({ ...(c.app.voiceDraft || p.voiceParams || {}), provider: root.querySelector('#wz-prov').value, language: root.querySelector('#wz-lang').value, gender: root.querySelector('#wz-gender').value, voice: root.querySelector('#vo-voice')?.value || '' });
        const saveVoice = async (d) => { c.app.voiceDraft = d; try { c.setProject(await api('PUT', `/api/projects/${p.id}/voice/params`, { tone: p.params.tone, speed: 1, ...d })); } catch (e) { toast(e.message, 'error'); } };
        ['#wz-prov', '#wz-lang', '#wz-gender'].forEach((s) => root.querySelector(s).addEventListener('change', () => saveVoice({ ...vp(), voice: '' })));
        bindVoiceCards(root, () => saveVoice(vp()));
        // Une voix est enregistrée d'office : la génération ne bloque pas si l'utilisateur garde la première proposée.
        if (!p.voiceParams?.voice && root.querySelector('#vo-voice')) saveVoice(vp());
        root.querySelector('#wz-subs').addEventListener('change', (e) => saveMontage({ subtitles: { enabled: e.target.checked } }));
        root.querySelector('#wz-anim')?.addEventListener('change', (e) => saveMontage({ subtitles: { animation: e.target.value } }));
        root.querySelectorAll('[data-subpreset]').forEach((b) => b.addEventListener('click', () => saveMontage({ subtitles: SUB_PRESETS.find((x) => x.id === b.dataset.subpreset).patch })));
        root.querySelector('#wz-blur').addEventListener('change', (e) => saveMontage(e.target.checked ? { fgScale: autoFgScale(p.source.meta), blur: 30 } : { fgScale: fillScale(p.source.meta) }));
        root.querySelector('#wz-music').addEventListener('change', async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try { await upload(`/api/projects/${p.id}/montage/music`, f, {}); toast('Musique ajoutée.'); } catch (err) { toast(err.message, 'error'); }
          c.refresh();
        });
        root.querySelector('#wz-music-del')?.addEventListener('click', () => saveMontage({ musicFile: '' }));
        bindMask(root, saveMontage);
      }
      if (n === 4) {
        const ta = root.querySelector('#wz-script');
        const tgt = p.scriptTarget || { seconds: p.params.durationTarget, wps: 2.6 };
        ta.addEventListener('input', () => {
          ta.dataset.dirty = '1';
          const w = wordCount(ta.value);
          root.querySelector('#wz-count').textContent = `${w} mots`;
          root.querySelector('#wz-sec').textContent = `≈ ${Math.round(w / (tgt.wps || 2.6))} s (cible ${tgt.seconds} s)`;
        });
        const clean = () => root.querySelectorAll('[data-keep]').forEach((el) => delete el.dataset.dirty);
        const saveText = async () => { if (ta.dataset.dirty === '1') await api('PUT', `/api/projects/${p.id}/script`, { text: ta.value }); };
        root.querySelector('#wz-fetchref').addEventListener('click', () => { clean(); act(c, () => api('POST', `/api/projects/${p.id}/reference/url`, { url: root.querySelector('#wz-ref').value }), 'Récupération du script…'); });
        root.querySelector('#wz-adapt')?.addEventListener('click', () => { clean(); act(c, () => api('POST', `/api/projects/${p.id}/wizard/script`), 'Écriture du script adapté à ta vidéo…'); });
        root.querySelector('#wz-opt').addEventListener('click', async () => {
          await saveText();
          delete ta.dataset.dirty;
          act(c, () => api('POST', `/api/projects/${p.id}/script/transform`, { action: 'fit' }), 'Ajustement du script à la durée…');
        });
        bindPromptBox(root, async (instruction) => {
          await saveText();
          delete ta.dataset.dirty;
          return act(c, () => api('POST', `/api/projects/${p.id}/script/transform`, { action: 'custom', instruction }), 'L\'IA modifie le script selon ton prompt…');
        });
        root.querySelector('#wz-gen').addEventListener('click', async () => {
          const ok = await act(c, () => api('POST', `/api/projects/${p.id}/wizard/generate`, { text: ta.value }), 'Génération lancée : voix off, montage puis export.');
          if (ok) { clean(); go(p, 5); }
        });
      }
      if (n === 5) {
        root.querySelector('#wz-retry')?.addEventListener('click', () => act(c, () => api('POST', `/api/projects/${p.id}/wizard/generate`, {}), 'Génération relancée.'));
      }
    },
  };
}
