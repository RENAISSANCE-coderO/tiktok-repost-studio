// Choix de la voix en cartes, avec écoute d'un échantillon (généré une fois par le serveur puis gardé).
import { esc, toast } from './core.js';

const EMOJI = { F: '👩', M: '👨', N: '🧑' };

export function voiceCards(prov, voices, selected, lang) {
  if (!voices.length) return '<p class="small" style="color:var(--warn)">Aucune voix disponible pour cette langue avec ce service.</p>';
  return `<input type="hidden" id="vo-voice" value="${esc(selected || voices[0].id)}">
    <div class="pick-grid">${voices.map((v) => `<div class="pick${v.id === (selected || voices[0].id) ? ' on' : ''}" data-voice="${esc(v.id)}" role="button" tabindex="0">
      <div class="emoji">${EMOJI[v.gender] || EMOJI.N}</div><strong>${esc(v.label.replace(/ \(\w\w\)$/, ''))}</strong>
      <div class="small muted">${v.gender === 'F' ? 'féminine' : v.gender === 'M' ? 'masculine' : 'neutre'} · ${esc(v.accent)}</div>
      <button type="button" class="btn sm play" data-play="${esc(v.id)}" data-prov="${esc(prov.id)}" data-lang="${esc(String(lang).slice(0, 2))}" title="Écouter">▶ Écouter</button></div>`).join('')}</div>`;
}

let audio = null;
let playing = '';
// onPick(voiceId) est appelé quand une carte est choisie.
export function bindVoiceCards(root, onPick) {
  root.querySelectorAll('[data-voice]').forEach((card) => card.addEventListener('click', (e) => {
    if (e.target.closest('[data-play]')) return;
    root.querySelectorAll('[data-voice]').forEach((x) => x.classList.toggle('on', x === card));
    const input = root.querySelector('#vo-voice');
    if (input) input.value = card.dataset.voice;
    onPick(card.dataset.voice);
  }));
  root.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', async () => {
    if (audio && !audio.paused && playing === b.dataset.play) { audio.pause(); return; }
    audio?.pause();
    const label = b.textContent;
    b.textContent = '… chargement';
    b.disabled = true;
    try {
      const url = `/api/voices/preview?provider=${encodeURIComponent(b.dataset.prov)}&voice=${encodeURIComponent(b.dataset.play)}&lang=${encodeURIComponent(b.dataset.lang)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erreur ${r.status}`);
      audio = new Audio(URL.createObjectURL(await r.blob()));
      playing = b.dataset.play;
      await audio.play();
    } catch (err) { toast(err.message, 'error'); }
    b.textContent = label;
    b.disabled = false;
  }));
}
