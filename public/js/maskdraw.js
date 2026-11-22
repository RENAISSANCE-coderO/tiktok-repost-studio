// Masque des sous-titres incrustés : on dessine un rectangle sur une image de la vidéo d'origine (souris ou doigt).
import { raw, esc, fileUrl } from './core.js';

export function maskEditor(p, mask) {
  const a = p.steps.source_analyze?.output;
  if (!a?.frames?.length) return raw('<p class="small muted">Analysez d\'abord la vidéo à modifier pour pouvoir dessiner la zone.</p>');
  const m = mask || {};
  // Image du milieu de la vidéo : les sous-titres incrustés y sont généralement visibles.
  const f = a.frames[Math.floor(a.frames.length / 2)];
  const rect = m.enabled ? `left:${m.x * 100}%;top:${m.y * 100}%;width:${m.w * 100}%;height:${m.h * 100}%` : 'display:none';
  return raw(`<label class="inline field"><input type="checkbox" id="mask-enabled"${m.enabled ? ' checked' : ''}> Flouter les sous-titres déjà incrustés dans la vidéo</label>
    <p class="small muted">Dessinez un rectangle sur la zone des anciens sous-titres (glissez avec la souris ou le doigt). Vos sous-titres seront centrés dessus.</p>
    <div class="mask-stage" id="mask-stage"><img src="${esc(fileUrl(p, a.framesDir + '/' + f.file, { v: p.steps.source_analyze.finishedAt }))}" alt="Image de la vidéo d'origine" draggable="false"><div class="mask-rect" id="mask-rect" style="${rect}"></div></div>
    <label class="inline field" style="margin-top:8px"><input type="checkbox" id="mask-center"${m.centerSubs !== false ? ' checked' : ''}> Centrer mes sous-titres sur la zone floutée</label>`);
}

export function bindMask(root, save) {
  const stage = root.querySelector('#mask-stage');
  root.querySelector('#mask-enabled')?.addEventListener('change', (e) => save({ mask: { enabled: e.target.checked } }));
  root.querySelector('#mask-center')?.addEventListener('change', (e) => save({ mask: { centerSubs: e.target.checked } }));
  if (!stage) return;
  const rectEl = root.querySelector('#mask-rect');
  let start = null, cur = null;
  const pos = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const draw = (m) => Object.assign(rectEl.style, { display: 'block', left: m.x * 100 + '%', top: m.y * 100 + '%', width: m.w * 100 + '%', height: m.h * 100 + '%' });
  stage.addEventListener('pointerdown', (e) => { start = pos(e); stage.setPointerCapture(e.pointerId); e.preventDefault(); });
  stage.addEventListener('pointermove', (e) => {
    if (!start) return;
    const q = pos(e);
    cur = { x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.abs(q.x - start.x), h: Math.abs(q.y - start.y) };
    draw(cur);
  });
  stage.addEventListener('pointerup', () => {
    if (start && cur && cur.w > 0.03 && cur.h > 0.02) save({ mask: { enabled: true, ...Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) } });
    start = cur = null;
  });
}
