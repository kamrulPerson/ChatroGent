import { Router } from 'express';
import { getDb } from '../db.js';
import { ObjectId } from 'mongodb';
import { policy } from '../config.js';

const r = Router();
const uid = (req: any) => new ObjectId(req.user.sub);

r.get('/balances', async (req: any, res) => {
  const db = await getDb();
  const bals = await db.collection('accounts').find({ userId: uid(req) }).toArray();
  res.json(bals.map((b) => ({ currency: b.currency, amount: b.balance })));
});

r.get('/student-file', async (req: any, res) => {
  const db = await getDb();
  const sf = await db.collection('student_files').findOne({ userId: uid(req) });
  res.json(sf || {});
});

r.get('/documents', async (req: any, res) => {
  const db = await getDb();
  const docs = await db.collection('documents').find({ userId: uid(req) }).toArray();
  res.json(docs.map((d) => ({ type: d.type, status: d.status })));
});

// Tier, its meaning and the current sandbox limits (spec KYC-05: show the tier
// and the next required step).
r.get('/profile', async (req: any, res) => {
  const db = await getDb();
  const user = await db.collection('users').findOne({ _id: uid(req) });
  const tier = user?.kycTier ?? 0;
  const meanings: Record<number, string> = {
    0: 'Guest: guidance and rates only',
    1: 'Basic: link accounts and low-value transfers',
    2: 'Enhanced: tuition, remittances, insurance and conversions',
  };
  res.json({
    kycTier: tier,
    tierMeaning: meanings[tier] || 'Unknown',
    dailyCapUSD: policy.dailyCapUSDByKycTier[tier] ?? 0,
    tier1LowValueCapUSD: policy.tier1LowValueCapUSD,
    rulesVersion: policy.rulesVersion,
  });
});

// Aggregate used by the web dashboard.
r.get('/dashboard', async (req: any, res) => {
  const db = await getDb();
  const [user, bals, docs, alerts, transfers, fx] = await Promise.all([
    db.collection('users').findOne({ _id: uid(req) }),
    db.collection('accounts').find({ userId: uid(req) }).toArray(),
    db.collection('documents').find({ userId: uid(req) }).toArray(),
    db.collection('alerts').find({ userId: uid(req) }).sort({ createdAt: -1 }).toArray(),
    db.collection('transfers').find({ userId: uid(req) }).sort({ createdAt: -1 }).limit(25).toArray(),
    db.collection('fx_rates').find({ pair: 'MYR/BDT' }).sort({ date: 1 }).toArray(),
  ]);
  res.json({
    name: user?.name ?? '',
    kycTier: user?.kycTier ?? 0,
    balances: bals.map((b) => ({ currency: b.currency, amount: b.balance, label: b.label ?? null })),
    documents: docs.map((d) => ({ type: d.type, status: d.status, verified: d.status === 'valid' })),
    alerts: alerts.map((a) => ({ id: a._id, pair: a.pair, target: a.target, fallbackDate: a.fallbackDate, status: a.status })),
    transfers: transfers.map((t) => ({
      id: t.receiptId || t._id.toString(),
      date: (t.createdAt instanceof Date ? t.createdAt : new Date()).toISOString().slice(0, 10),
      amountUSD: t.quoteSnapshot?.amountUSD ?? null,
      amountBDT: t.amountBDT ?? null,
      status: t.status,
    })),
    fxSeries: fx.map((f) => ({ date: f.date, rate: f.rate })),
    rulesVersion: policy.rulesVersion,
  });
});

export default r;
