import { Router } from 'express';
import { getDb } from '../db.js';
import { CompareSchema } from '../validate.js';
import { audit } from '../audit.js';
import { CORRIDOR_META, corridorRate, computeQuote } from '../services/convert.js';

const r = Router();

// GET /api/routes/compare?corridor=BD-MY&amountUSD=8000
// Returns one entry per route with the destination currency, the gross and the
// net the recipient receives. A route whose net is zero or negative is reported
// with net: null and a reason instead of a negative number. If the corridor has
// no rate we refuse rather than falling back to another currency.
r.get('/compare', async (req: any, res) => {
  try {
    const { corridor, amountUSD } = CompareSchema.parse(req.query);
    const meta = CORRIDOR_META[corridor];
    if (!meta) return res.status(400).json({ error: 'unknown_corridor', message: `no rate for this corridor (${corridor})` });

    const conv = await corridorRate(corridor);
    if (!conv) {
      await audit({ event: 'routes_compare', tier: 'T1', outcome: 'blocked', decision: 'blocked', userId: req.user.sub, reason: 'no_rate', inputs: { corridor, amountUSD } });
      return res.status(400).json({ error: 'no_rate', message: `no rate for this corridor (${corridor})` });
    }

    const db = await getDb();
    const rows = await db.collection('routes').find({ corridor }).toArray();

    const routes = rows.map((rr: any) => {
      const q = computeQuote(amountUSD, conv.usdPerBdt, conv.rate, Number(rr.feeBDT), Number(rr.spreadPct), conv.dest, conv.pair);
      return {
        provider: rr.provider,
        corridor,
        currency: conv.dest,
        pair: conv.pair,
        rate: conv.rate,
        usdPerBdt: conv.usdPerBdt,
        sendBDT: Number(q.sendBDT.toFixed(2)),
        feeBDT: Number(rr.feeBDT),
        spreadPct: Number(rr.spreadPct),
        etaDays: rr.etaDays,
        dataType: rr.dataType,
        gross: Number(q.gross.toFixed(2)),
        net: q.quotable ? Number(q.net.toFixed(2)) : null,
        netUsd: q.quotable ? Number(q.netUsd.toFixed(2)) : null,
        quotable: q.quotable,
        reason: q.quotable ? null : 'fee_and_margin_exceed_amount',
        totalCostPct: Number(((Number(rr.feeBDT) / conv.usdPerBdt / amountUSD) * 100 + Number(rr.spreadPct)).toFixed(2)),
      };
    });

    // Best (highest net) first; unquotable routes sink to the bottom.
    routes.sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));

    await audit({ event: 'routes_compare', tier: 'T1', outcome: 'pass', decision: 'pass', userId: req.user.sub, inputs: { corridor, amountUSD } });
    return res.json(routes);
  } catch (e) {
    return res.status(400).json({ error: 'bad request' });
  }
});

export default r;
