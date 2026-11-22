// Soldes des comptes API (OpenRouter, FAL), lus côté serveur : les clés ne quittent jamais le serveur.
import { secret } from './config.js';
import { httpRequest } from './util.js';

export const LOW_BALANCE = 1; // en dollars : en dessous, l'interface prévient avant que les traitements échouent
const round = (x) => Math.round(x * 100) / 100;

async function getJSON(url, auth) {
  const r = await httpRequest(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* corps non JSON */ }
  return { status: r.status, ok: r.ok, j, text };
}

async function openrouter() {
  const link = 'https://openrouter.ai/settings/credits';
  const key = secret('OPENROUTER_API_KEY');
  if (!key) return { configured: false, link };
  const base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const [c, k] = await Promise.all([getJSON(base + '/credits', `Bearer ${key}`), getJSON(base + '/key', `Bearer ${key}`)]);
  if (!c.ok || !c.j?.data) return { configured: true, error: `OpenRouter ${c.status} : ${c.j?.error?.message || c.text.slice(0, 200)}`, link };
  const purchased = Number(c.j.data.total_credits) || 0;
  const used = Number(c.j.data.total_usage) || 0;
  const balance = purchased - used;
  // La clé peut avoir son propre plafond de dépense, plus bas que le solde du compte.
  const keyRemaining = k.ok && k.j?.data?.limit != null ? Number(k.j.data.limit_remaining) : null;
  const available = keyRemaining != null ? Math.min(balance, keyRemaining) : balance;
  return { configured: true, balance: round(balance), purchased: round(purchased), used: round(used), keyRemaining: keyRemaining != null ? round(keyRemaining) : null,
    available: round(available), low: available < LOW_BALANCE, link };
}

async function fal() {
  const link = 'https://fal.ai/dashboard/billing';
  const key = secret('FAL_KEY');
  if (!key) return { configured: false, link };
  const r = await getJSON('https://rest.alpha.fal.ai/billing/user_balance', `Key ${key}`);
  if (r.status === 401 || r.status === 403) {
    return { configured: true, error: 'Cette clé FAL ne permet pas de lire le solde (permission « billing:usage:read » manquante). Créez une clé avec cette permission sur https://fal.ai/dashboard/keys, ou consultez le solde sur le tableau de bord FAL.', link };
  }
  if (!r.ok) return { configured: true, error: `FAL ${r.status} : ${r.text.slice(0, 200)}`, link };
  const balance = typeof r.j === 'number' ? r.j : Number(r.j?.balance ?? r.j?.credits);
  if (!Number.isFinite(balance)) return { configured: true, error: 'Réponse inattendue de FAL pour le solde.', link };
  return { configured: true, balance: round(balance), available: round(balance), low: balance < LOW_BALANCE, link };
}

export async function balances() {
  const safe = (fn) => fn().catch((e) => ({ configured: true, error: 'Solde indisponible (réseau) : ' + (e.code || e.message) }));
  const [o, f] = await Promise.all([safe(openrouter), safe(fal)]);
  return { openrouter: o, fal: f, lowThreshold: LOW_BALANCE, at: new Date().toISOString() };
}
