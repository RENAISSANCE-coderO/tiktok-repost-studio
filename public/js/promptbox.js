// « Modifier le script avec un prompt » : consigne libre envoyée à l'IA, exemples en un clic et derniers prompts utilisés.
// Partagé par la page du script et l'assistant.
import { esc } from './core.js';

const EXAMPLES = [
  'Traduis en allemand',
  'Rends le hook beaucoup plus fort',
  'Ajoute plus de suspense jusqu\'à la fin',
  'Raccourcis à 45 secondes',
  'Ton plus drôle et décontracté',
  'Donne envie de commenter à la fin, sans question forcée',
  'Phrases plus courtes et plus percutantes',
];

// inline : intégré dans une carte existante (séparateur au lieu d'une carte).
export function promptBox(p, { disabled = false, inline = false } = {}) {
  const recent = (p.scriptPrompts || []).slice(-5).reverse();
  return `<div class="${inline ? 'prompt-box inline' : 'card prompt-box'}"><h2>✍️ Modifier le script avec un prompt</h2>
    <p class="small muted">Dites à l'IA ce qu'elle doit changer, comme vous le feriez dans une conversation. Elle garde les faits visibles dans la vidéo et votre méthode d'écriture.</p>
    <textarea id="pr-text" data-keep maxlength="2000" style="min-height:90px" placeholder="Ex. : « Rends le début plus choquant, ajoute un rebondissement au milieu et termine par une phrase qui donne envie de commenter. »"></textarea>
    <div class="chips" style="margin:8px 0">${EXAMPLES.map((e) => `<button type="button" class="chip" data-prex="${esc(e)}">${esc(e)}</button>`).join('')}</div>
    ${recent.length ? `<div class="small muted">Mes derniers prompts :</div><div class="chips" style="margin:4px 0 8px">${recent.map((e) => `<button type="button" class="chip" data-prex="${esc(e)}" title="${esc(e)}">↺ ${esc(e.length > 60 ? e.slice(0, 57) + '…' : e)}</button>`).join('')}</div>` : ''}
    <div class="row"><button class="btn primary" id="pr-go"${disabled ? ' disabled' : ''}>Modifier le script avec ce prompt</button>
      <span class="small muted">Version précédente conservée : vous pouvez la restaurer.</span></div>
    ${disabled && p.pipeline.runningStep === 'script_transform' ? '<div class="progress indeterminate" style="margin-top:10px"><div></div></div><div class="small muted">L\'IA modifie le script…</div>' : ''}
  </div>`;
}

// submit(instruction) : appelé avec le prompt saisi (non vide).
export function bindPromptBox(root, submit) {
  const ta = root.querySelector('#pr-text');
  if (!ta) return;
  ta.addEventListener('input', () => { ta.dataset.dirty = '1'; });
  root.querySelectorAll('[data-prex]').forEach((b) => b.addEventListener('click', () => {
    ta.value = ta.value.trim() ? `${ta.value.trim()}. ${b.dataset.prex}` : b.dataset.prex;
    ta.dataset.dirty = '1';
    ta.focus();
  }));
  root.querySelector('#pr-go').addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const ok = await submit(text);
    if (ok) { ta.value = ''; delete ta.dataset.dirty; }
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) root.querySelector('#pr-go').click(); });
}
