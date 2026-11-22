// Client OpenRouter (API compatible OpenAI) : texte, images et audio, réponses JSON.
import fs from 'node:fs';
import { secret } from '../config.js';
import { retry, httpRequest } from '../util.js';
import { assertWithinBudget } from '../budget.js';

export function aiAvailable() { return Boolean(secret('OPENROUTER_API_KEY')); }

export const imagePart = (file) => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64') } });
export const audioPart = (file, format = 'mp3') => ({ type: 'input_audio', input_audio: { data: fs.readFileSync(file).toString('base64'), format } });
export const textPart = (text) => ({ type: 'text', text });

export function extractJSON(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* on tente d'isoler l'objet */ }
  const a = t.indexOf('{'), z = t.lastIndexOf('}');
  if (a >= 0 && z > a) return JSON.parse(t.slice(a, z + 1));
  throw new Error('réponse non JSON');
}

// reasoning : effort de réflexion du modèle (minimal | low | medium | high). Les modèles Gemini 3 réfléchissent par défaut :
// cette réflexion consomme la limite de jetons (jusqu'à tronquer le JSON) et ajoute des dizaines de secondes.
export async function chatJSON({ model, system, content, temperature = 0.4, maxTokens = 16000, reasoning = 'low', label = 'IA' }) {
  const key = secret('OPENROUTER_API_KEY');
  if (!key) throw Object.assign(new Error('Clé OpenRouter absente : configurez OPENROUTER_API_KEY dans Paramètres et intégrations API.'), { retryable: false, needsConfig: true });
  return retry(async () => {
    await assertWithinBudget('openrouter');
    let r;
    const payload = JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      reasoning: { effort: reasoning },
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    });
    try {
      r = await httpRequest((process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'TikTok Repost Studio' },
        body: payload,
        signal: AbortSignal.timeout(240000),
        // OpenRouter répond par ses en-têtes en quelques secondes, puis maintient la connexion pendant le calcul :
        // passé 8 s (+ temps d'envoi à 100 Ko/s) sans en-têtes, l'envoi est bloqué et on relance aussitôt.
        headersTimeout: 8000 + Math.round(Buffer.byteLength(payload) / 100),
        idleTimeout: 60000,
      });
    } catch (e) { throw Object.assign(new Error('connexion à OpenRouter impossible (réseau) : ' + (/STALL$/.test(e.code || '') ? e.message : e.code || e.message)), { retryable: true }); }
    const body = await r.text();
    if (!r.ok) {
      let msg = body.slice(0, 300);
      try { msg = JSON.parse(body).error?.message || msg; } catch { /* corps brut */ }
      if (r.status === 402) throw Object.assign(new Error("Crédit OpenRouter insuffisant : rechargez votre compte ou augmentez la limite de la clé sur https://openrouter.ai/settings/credits (détail : " + msg + ")"), { retryable: false, needsConfig: true });
      throw Object.assign(new Error(`OpenRouter ${r.status} : ${msg}`), { retryable: r.status === 429 || r.status >= 500 });
    }
    const j = JSON.parse(body);
    if (j.error) throw Object.assign(new Error('OpenRouter : ' + (j.error.message || JSON.stringify(j.error))), { retryable: true });
    const text = j.choices?.[0]?.message?.content;
    if (j.choices?.[0]?.finish_reason === 'length') throw Object.assign(new Error(`réponse tronquée par le modèle (limite de ${maxTokens} jetons atteinte)`), { retryable: true });
    if (!text) throw Object.assign(new Error('réponse vide du modèle'), { retryable: true });
    try { return extractJSON(text); } catch { throw Object.assign(new Error('le modèle n\'a pas renvoyé un JSON valide'), { retryable: true }); }
  }, { attempts: 6, baseMs: 500, label });
}
