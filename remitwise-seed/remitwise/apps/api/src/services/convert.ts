import { getDb } from '../db.js';

// Every corridor has exactly one destination currency and one rate pair. There
// is no fallback: if the pair has no rate we refuse the quote rather than
// silently quoting in another currency. GBP/CAD/AUD rows are estimated stubs.
export interface CorridorMeta {
  dest: string;
  pair: string;
  label: string;
}

export const CORRIDOR_META: Record<string, CorridorMeta> = {
  'BD-MY': { dest: 'MYR', pair: 'MYR/BDT', label: 'Malaysia' },
  'BD-US': { dest: 'USD', pair: 'USD/BDT', label: 'United States' },
  'BD-UK': { dest: 'GBP', pair: 'GBP/BDT', label: 'United Kingdom' },
  'BD-CA': { dest: 'CAD', pair: 'CAD/BDT', label: 'Canada' },
  'BD-AU': { dest: 'AUD', pair: 'AUD/BDT', label: 'Australia' },
};

export async function latestRate(pair: string): Promise<number | null> {
  const db = await getDb();
  const rows = await db.collection('fx_rates').find({ pair }).sort({ date: -1 }).limit(1).toArray();
  return rows.length ? Number((rows[0] as any).rate) : null;
}

export interface CorridorRate {
  dest: string;
  pair: string;
  rate: number;
  usdPerBdt: number;
}

// Returns null when the corridor is unknown or either leg of the conversion has
// no rate on file.
export async function corridorRate(corridor: string): Promise<CorridorRate | null> {
  const meta = CORRIDOR_META[corridor];
  if (!meta) return null;
  const [rate, usdPerBdt] = await Promise.all([latestRate(meta.pair), latestRate('USD/BDT')]);
  if (rate == null || usdPerBdt == null) return null;
  return { dest: meta.dest, pair: meta.pair, rate, usdPerBdt };
}

export interface Quote {
  destCurrency: string;
  pair: string;
  rate: number;
  sendBDT: number;
  gross: number;
  feeDest: number;
  net: number;
  netUsd: number;
  quotable: boolean;
}

// amountUSD -> taka -> destination currency. gross is before fee and FX margin;
// net is what the recipient gets. A flat fee and a percent spread can drive net
// to zero or below for small amounts, which is why quotable is explicit.
export function computeQuote(
  amountUSD: number,
  usdPerBdt: number,
  pairRate: number,
  feeBDT: number,
  spreadPct: number,
  destCurrency: string,
  pair: string,
): Quote {
  const grossBDT = amountUSD * usdPerBdt;
  const gross = grossBDT / pairRate;
  const feeDest = feeBDT / pairRate;
  const net = (gross - feeDest) * (1 - spreadPct / 100);
  const netUsd = (net * pairRate) / usdPerBdt;
  return {
    destCurrency,
    pair,
    rate: pairRate,
    sendBDT: grossBDT,
    gross,
    feeDest,
    net,
    netUsd,
    quotable: net > 0,
  };
}
