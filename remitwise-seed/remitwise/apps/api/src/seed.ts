// Idempotent seed: safe to run any number of times.
import { MongoClient, ObjectId } from 'mongodb';
import { scryptSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';

const DATA_DIR = process.env.DATA_DIR || '/data'; // compose mounts ./data at /data
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234'; // sandbox only

const hashPassword = (pw: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
};

async function main() {
  const client = new MongoClient(process.env.MONGO_URL!);
  await client.connect();
  const db = client.db();
  const now = new Date();

  // Four demo users, one per compliance scenario.
  //   tier2          happy path (all documents valid)
  //   tier2expired   enhanced KYC but passport expired -> DOC_01 fails
  //   tier1          basic KYC, low-value transfers only
  //   tier0          unverified -> KYC_01 blocks any payment
  const demoUsers = [
    { key: 'tier2', email: 'tier2@demo.remitwise', name: 'Nadia (tier 2, happy path)', kycTier: 2 },
    { key: 'tier2expired', email: 'tier2expired@demo.remitwise', name: 'Omar (tier 2, expired passport)', kycTier: 2 },
    { key: 'tier1', email: 'tier1@demo.remitwise', name: 'Priya (tier 1, low value only)', kycTier: 1 },
    { key: 'tier0', email: 'tier0@demo.remitwise', name: 'Guest (tier 0, unverified)', kycTier: 0 },
  ];

  const ids: Record<string, ObjectId> = {};
  for (const u of demoUsers) {
    const doc = await db.collection('users').findOneAndUpdate(
      { email: u.email },
      { $set: { name: u.name, kycTier: u.kycTier, updatedAt: now }, $setOnInsert: { email: u.email, passwordHash: hashPassword(DEMO_PASSWORD), createdAt: now } },
      { upsert: true, returnDocument: 'after' },
    );
    ids[u.key] = doc!._id;
  }

  // Accounts (BDT and MYR). $setOnInsert keeps balances if re-run.
  const balances: Record<string, { BDT: number; MYR: number }> = {
    tier2: { BDT: 2500000, MYR: 6000 },
    tier2expired: { BDT: 2500000, MYR: 6000 },
    tier1: { BDT: 800000, MYR: 1500 },
    tier0: { BDT: 50000, MYR: 0 },
  };
  for (const u of demoUsers) {
    for (const currency of ['BDT', 'MYR'] as const) {
      await db.collection('accounts').updateOne(
        { userId: ids[u.key], currency },
        { $setOnInsert: { balance: balances[u.key][currency], createdAt: now } },
        { upsert: true },
      );
    }
  }

  // Student files. `level` feeds PURPOSE_02; payer/invoice names feed PAYER_01.
  const files: Record<string, any> = {
    tier2: { institution: 'Universiti Malaya', totalUSD: 12000, months: 12, advance: false, level: 'postgraduate', branch: 'BR-DHK-001', payerName: 'Rafiq Ahmed' },
    tier2expired: { institution: 'University of Toronto', totalUSD: 12000, months: 12, advance: false, level: 'postgraduate', branch: 'BR-DHK-001', payerName: 'Rafiq Ahmed' },
    tier1: { institution: 'Universiti Malaya', totalUSD: 12000, months: 12, advance: false, level: 'postgraduate', branch: 'BR-DHK-002', payerName: 'Rafiq Ahmed' },
    tier0: { institution: 'Universiti Malaya', totalUSD: 12000, months: 12, advance: false, level: 'postgraduate', branch: 'BR-DHK-001', payerName: 'Rafiq Ahmed' },
  };
  for (const u of demoUsers) {
    const f = files[u.key];
    await db.collection('student_files').updateOne(
      { userId: ids[u.key] },
      {
        $set: {
          institution: f.institution,
          level: f.level,
          estimate: { totalUSD: f.totalUSD, academicYearMonths: f.months, advanceRequiredByInstitution: f.advance },
          bankBranchId: f.branch,
          payerName: f.payerName,
          invoicePayerName: f.payerName,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  // Documents, with deliberate edge cases for the compliance logic.
  const valid = { admission_letter: 'valid', cost_estimate: 'valid', passport: 'valid', certificates: 'valid' };
  const docStatus: Record<string, Record<string, string>> = {
    tier2: { ...valid },
    tier2expired: { ...valid, passport: 'expired' },
    tier1: { ...valid },
    tier0: { ...valid },
  };
  for (const u of demoUsers) {
    for (const [type, status] of Object.entries(docStatus[u.key])) {
      await db.collection('documents').updateOne(
        { userId: ids[u.key], type },
        { $set: { status, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }
  }

  // Reference data: clear and reload
  const routes = parse(readFileSync(join(DATA_DIR, 'routes.csv')), { columns: true, cast: true, skip_empty_lines: true });
  await db.collection('routes').deleteMany({});
  if (routes.length) await db.collection('routes').insertMany(routes);

  const fx = parse(readFileSync(join(DATA_DIR, 'fx_history.csv')), { columns: true, cast: true, skip_empty_lines: true })
    .map((r: any) => ({ ...r, date: new Date(r.date) }));
  await db.collection('fx_rates').deleteMany({});
  if (fx.length) await db.collection('fx_rates').insertMany(fx);

  const rules = JSON.parse(readFileSync(join(DATA_DIR, 'compliance_rules.json'), 'utf8'));
  await db.collection('compliance_rules').deleteMany({});
  await db.collection('compliance_rules').insertMany(Array.isArray(rules) ? rules : [rules]);

  await db.collection('audit_log').insertOne({
    ts: now, userId: 'system', event: 'Seed completed', tier: 'SYS', outcome: 'ok',
    decision: 'n/a', component: 'seed', rulesVersion: 'n/a',
    inputs: { users: Object.keys(ids).length, routes: routes.length, fxRates: fx.length, rules: Array.isArray(rules) ? rules.length : 1 },
  });

  console.log(`Seed OK: ${Object.keys(ids).length} users, ${routes.length} routes, ${fx.length} fx rates, ${Array.isArray(rules) ? rules.length : 1} rules`);
  await client.close();
}

main().catch((e) => { console.error('Seed failed:', e); process.exit(1); });
