import { getDb } from '../db.js';
import { corridorRate, computeQuote, type CorridorRate } from './convert.js';

// One place that ranks routes for a corridor and amount, so compare_routes, the
// route card, the trace summary and the proposal can never disagree about which
// route is best.

export interface RankedRoute {
  id: string;
  name: string;
  provider: string;
  corridor: string;
  currency: string;
  pair: string;
  rate: number;
  feeBDT: number;
  spreadPct: number;
  etaDays: number;
  dataType: string;
  dateCollected: string;
  sourceUrl?: string;
  gross: number;
  net: number | null;
  quotable: boolean;
  reason: string | null;
  totalCostPct: number;
  note: string;
}

export interface RankedRoutes {
  conv: CorridorRate;
  routes: RankedRoute[];
  illustrative: boolean;
}

const round2 = (n: number) => Number(n.toFixed(2));

// A row is only "real" if it has a source URL that is not a placeholder. Until
// then route/rate data is labelled "Sample data (illustrative)".
export function isIllustrative(sourceUrl?: string): boolean {
  if (!sourceUrl) return true;
  try {
    const host = new URL(sourceUrl).host.toLowerCase();
    return host === '' || /(^|\.)example\.(com|org|net)$/.test(host);
  } catch {
    return true;
  }
}

export async function rankRoutes(corridor: string, amountUSD: number): Promise<RankedRoutes | null> {
  const conv = await corridorRate(corridor);
  if (!conv) return null;
  const db = await getDb();
  const rows = await db.collection('routes').find({ corridor }).toArray();
  const routes: RankedRoute[] = rows
    .map((rr: any) => {
      const q = computeQuote(amountUSD, conv.usdPerBdt, conv.rate, Number(rr.feeBDT), Number(rr.spreadPct), conv.dest, conv.pair);
      return {
        id: rr.provider,
        name: rr.provider,
        provider: rr.provider,
        corridor,
        currency: conv.dest,
        pair: conv.pair,
        rate: conv.rate,
        feeBDT: Number(rr.feeBDT),
        spreadPct: Number(rr.spreadPct),
        etaDays: Number(rr.etaDays),
        dataType: rr.dataType,
        dateCollected: rr.dateCollected,
        sourceUrl: rr.sourceUrl,
        gross: round2(q.gross),
        net: q.quotable ? round2(q.net) : null,
        quotable: q.quotable,
        reason: q.quotable ? null : 'fee_and_margin_exceed_amount',
        totalCostPct: round2((Number(rr.feeBDT) / conv.usdPerBdt / amountUSD) * 100 + Number(rr.spreadPct)),
        note: rr.dataType === 'estimated' ? 'estimated' : '',
      };
    })
    .sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
  const illustrative = routes.length === 0 || isIllustrative(routes[0].sourceUrl);
  return { conv, routes, illustrative };
}
