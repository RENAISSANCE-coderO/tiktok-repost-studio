// Limites de dépense des API : un appel payant est refusé dès que la dépense de la période atteint la limite.
// OpenRouter : dépense réelle de la clé, fournie par OpenRouter. FAL : estimation locale (la clé ne donne pas accès à la facturation).
import path from 'node:path';
import { getSettings, secret, DATA_DIR } from './config.js';
import { httpRequest, readJSON, writeJSON } from './util.js';

const SPEND_FILE = path.join(DATA_DIR, 'spend.json');
export const PERIODS = { day: 'aujourd\'hui', week: 'cette semaine', month: 'ce mois-ci', total: 'au total' };
const NAMES = { openrouter: 'OpenRouter', fal: 'FAL' };
// Tarif FAL ElevenLabs indicatif, appliqué aussi à Inworld faute de tarif connu : l'estimation reste du côté prudent.
export const FAL_USD_PER_CHAR = 0.10 / 1000;
const usd = (x) => x.toLocaleString('fr-FR', { style: 'currency', currency: 'USD' });

// Début de la période en temps UTC, comme les compteurs d'OpenRouter (semaine commençant le lundi).
function periodStart(period, now = new Date()) {
  if (period === 'total') return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), period === 'month' ? 1 : now.getUTCDate()));
  if (period === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString();
}

let orCache = null;
async function openrouterSpent(period) {
  if (!orCache || Date.now() - orCache.at > 15000) {
    const base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    const r = await httpRequest(base + '/key', { headers: { Authorization: `Bearer ${secret('OPENROUTER_API_KEY')}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`lecture de la dépense OpenRouter impossible (HTTP ${r.status})`);
    orCache = { at: Date.now(), data: (await r.json()).data || {} };
  }
  const d = orCache.data;
  return Number({ day: d.usage_daily, week: d.usage_weekly, month: d.usage_monthly, total: d.usage }[period]) || 0;
}

function falSpent(period) {
  const since = periodStart(period);
  return readJSON(SPEND_FILE, []).filter((e) => e.service === 'fal' && (!since || e.at >= since)).reduce((a, e) => a + e.cost, 0);
}

export function recordSpend(service, cost, detail = '') {
  const list = readJSON(SPEND_FILE, []);
  list.push({ at: new Date().toISOString(), service, cost, detail });
  writeJSON(SPEND_FILE, list);
}

const spent = (service, period) => (service === 'openrouter' ? openrouterSpent(period) : falSpent(period));

export async function assertWithinBudget(service) {
  const { budget } = getSettings();
  const limit = Number(budget[service]) || 0;
  if (!limit) return;
  const s = await spent(service, budget.period);
  if (s >= limit) {
    throw Object.assign(new Error(`Limite de dépense ${NAMES[service]} atteinte : ${usd(s)} dépensés ${PERIODS[budget.period]} pour une limite de ${usd(limit)}. ` +
      'Augmentez la limite dans « Paramètres et intégrations API » pour continuer.'), { retryable: false, needsConfig: true, budgetExceeded: true });
  }
}

export async function budgetStatus() {
  const { budget } = getSettings();
  const one = async (service) => {
    const limit = Number(budget[service]) || 0;
    if (service === 'openrouter' && !secret('OPENROUTER_API_KEY')) return { limit, spent: null };
    try { return { limit, spent: Math.round((await spent(service, budget.period)) * 100) / 100, estimated: service === 'fal' }; } catch (e) { return { limit, spent: null, error: e.message }; }
  };
  const [openrouter, fal] = await Promise.all([one('openrouter'), one('fal')]);
  return { period: budget.period, periodLabel: PERIODS[budget.period], openrouter, fal };
}
