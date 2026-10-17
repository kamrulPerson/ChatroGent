import { Router } from 'express';
import { getDb } from '../db.js';
import { audit } from '../audit.js';
import { CORRIDOR_META, latestRate } from '../services/convert.js';

const r = Router();

// A corridor code (BD-MY) or an explicit pair (MYR/BDT). No cross-currency
// fallback: an unknown pair/corridor is refused.
function resolvePair(raw: string): string | null {
  if (CORRIDOR_META[raw]) return CORRIDOR_META[raw].pair;
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(raw)) return raw;
  return null;
}

// GET /api/fx/window?pair=MYR/BDT&days=30
// Best/worst rate in the window plus the current rate and the average, for the
// fx_window tool. Rates are estimated sandbox data.
r.get('/window', async (req: any, res) => {
  try {
    const pair = resolvePair(String(req.query.pair || 'MYR/BDT'));
    if (!pair) return res.status(400).json({ error: 'no_rate', message: `no rate for this corridor (${req.query.pair})` });
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const db = await getDb();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db
      .collection('fx_rates')
      .find({ pair, date: { $gte: since } })
      .sort({ date: 1 })
      .toArray();
    if (!rows.length) return res.status(400).json({ error: 'no_rate', message: `no rate for this corridor (${pair})` });

    let best = rows[0];
    let worst = rows[0];
    let sum = 0;
    for (const row of rows) {
      if (row.rate < best.rate) best = row;
      if (row.rate > worst.rate) worst = row;
      sum += row.rate;
    }
    const current = rows[rows.length - 1];
    const average = sum / rows.length;

    await audit({
      event: 'fx_window',
      tier: 'T1',
      outcome: 'pass',
      decision: 'pass',
      userId: req.user.sub,
      inputs: { pair, days },
    });

    return res.json({
      pair,
      days,
      dataPoints: rows.length,
      best: { date: best.date, rate: best.rate },
      worst: { date: worst.date, rate: worst.rate },
      current: { date: current.date, rate: current.rate },
      average: Number(average.toFixed(4)),
      currentVsAverage: Number((current.rate - average).toFixed(4)),
      dataType: 'estimated',
    });
  } catch (e) {
    return res.status(400).json({ error: 'bad request' });
  }
});

r.get('/:pair/history', async (req: any, res) => {
  try {
    const pair = resolvePair(req.params.pair);
    if (!pair) return res.status(400).json({ error: 'no_rate', message: `no rate for this corridor (${req.params.pair})` });
    const db = await getDb();
    const hist = await db.collection('fx_rates').find({ pair }).sort({ date: 1 }).toArray();
    if (!hist.length) return res.status(400).json({ error: 'no_rate', message: `no rate for this corridor (${pair})` });
    await audit({ event: 'fx_history', tier: 'T1', outcome: 'pass', decision: 'pass', userId: req.user.sub, inputs: { pair } });
    return res.json(hist.map((h) => ({ pair: h.pair, date: h.date, rate: h.rate, dataType: 'estimated' })));
  } catch (e) {
    return res.status(400).json({ error: 'bad request' });
  }
});

export default r;
