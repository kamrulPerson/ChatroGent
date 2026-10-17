import { Router } from 'express';
import { getDb } from '../db.js';
import { ProposeSchema, ConfirmSchema } from '../validate.js';
import { checkCompliance } from '../services/compliance.js';
import { policy } from '../config.js';
import { audit } from '../audit.js';
import { MockPaymentProvider } from '../provider.js';
import { CORRIDOR_META, corridorRate, computeQuote } from '../services/convert.js';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';

const r = Router();
const provider = new MockPaymentProvider();
const BDT_PER_USD = 120;

// Proposals and transfers key on the ObjectId form of the user id so that the
// compliance engine (velocity / anomaly / daily-cap reads) and the dashboard
// queries can find them; the audit log stays keyed on the string subject.
const uid = (req: any) => new ObjectId(req.user.sub);

function canonical(obj: any): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export function payloadHashOf(input: any, userId: string): string {
  return crypto.createHash('sha256').update(canonical({ ...input, userId })).digest('hex');
}

r.post('/', async (req: any, res) => {
  try {
    const input = ProposeSchema.parse(req.body);
    const decision = await checkCompliance(req.user.sub, input);

    if (decision.decision !== 'pass') {
      await audit({
        event: 'proposal_refused',
        tier: 'T2',
        outcome: decision.decision,
        decision: decision.decision,
        userId: req.user.sub,
        inputs: input,
        ruleResults: decision.ruleResults,
        notEnforced: decision.notEnforced,
      });
      return res.status(400).json({
        error: 'compliance_failed',
        decision: decision.decision,
        ruleResults: decision.ruleResults,
        notEnforced: decision.notEnforced,
        rulesVersion: decision.rulesVersion,
      });
    }

    const remaining = decision.limits.dailyCapUSD - decision.limits.sentTodayUSD;
    if (input.amountUSD > remaining) {
      await audit({
        event: 'proposal_refused',
        tier: 'T2',
        outcome: 'escalate_to_bank',
        decision: 'escalate_to_bank',
        userId: req.user.sub,
        inputs: input,
        reason: 'daily_cap',
        ruleResults: decision.ruleResults,
      });
      return res.status(400).json({
        error: 'daily_limit_exceeded',
        decision: 'escalate_to_bank',
        dailyCapUSD: decision.limits.dailyCapUSD,
        sentTodayUSD: decision.limits.sentTodayUSD,
      });
    }

    const db = await getDb();

    // Resolve the destination currency for this corridor. No fallback: a
    // corridor without a rate is refused.
    const meta = CORRIDOR_META[input.corridor];
    const conv = meta ? await corridorRate(input.corridor) : null;
    if (!conv) {
      await audit({ event: 'proposal_refused', tier: 'T2', outcome: 'blocked', decision: 'blocked', userId: req.user.sub, reason: 'no_rate', inputs: input });
      return res.status(400).json({ error: 'no_rate', message: `no rate for this corridor (${input.corridor})` });
    }

    const route = await db.collection('routes').findOne({
      corridor: input.corridor,
      ...(input.routeProvider ? { provider: input.routeProvider } : {}),
    });
    const feeBDT = Number(route?.feeBDT ?? 2500);
    const spreadPct = Number(route?.spreadPct ?? 1.5);
    const q = computeQuote(input.amountUSD, conv.usdPerBdt, conv.rate, feeBDT, spreadPct, conv.dest, conv.pair);
    if (!q.quotable) {
      await audit({ event: 'proposal_refused', tier: 'T2', outcome: 'blocked', decision: 'blocked', userId: req.user.sub, reason: 'below_minimum_payout', inputs: input });
      return res.status(400).json({
        error: 'below_minimum_payout',
        reason: 'fee_and_margin_exceed_amount',
        message: 'Fees and the FX margin would leave nothing for the recipient. Send a larger amount.',
      });
    }

    const round2 = (n: number) => Number(n.toFixed(2));
    const quote = {
      provider: route?.provider ?? input.routeProvider ?? 'Unknown provider',
      feeBDT,
      spreadPct,
      etaDays: Number(route?.etaDays ?? 4),
      dataType: route?.dataType ?? 'estimated',
      dateCollected: route?.dateCollected ?? new Date().toISOString().slice(0, 10),
      currency: conv.dest,
      pair: conv.pair,
      rate: conv.rate,
      usdPerBdt: conv.usdPerBdt,
      sendBDT: round2(q.sendBDT),
      gross: round2(q.gross),
      net: round2(q.net),
      netUsd: round2(q.netUsd),
    };

    const normalized = {
      corridor: input.corridor,
      amountUSD: input.amountUSD,
      routeProvider: quote.provider,
      purpose: input.purpose ?? null,
      studyLevel: input.studyLevel ?? null,
      coveragePeriodMonths: input.coveragePeriodMonths ?? null,
      isFirstRelease: input.isFirstRelease ?? null,
      beneficiaryType: input.beneficiaryType ?? null,
      namedInInstitutionDocs: input.namedInInstitutionDocs ?? null,
      bankBranchId: input.bankBranchId ?? null,
      payerName: input.payerName ?? null,
    };

    const now = new Date();
    const doc = {
      ...normalized,
      userId: uid(req),
      quoteSnapshot: quote,
      payloadHash: payloadHashOf(normalized, req.user.sub),
      rulesVersion: decision.rulesVersion,
      status: 'pending',
      expiresAt: new Date(now.getTime() + policy.proposalTtlSeconds * 1000),
      createdAt: now,
    };
    const ins = await db.collection('proposals').insertOne(doc);

    await audit({
      event: 'proposal_created',
      tier: 'T2',
      outcome: 'pass',
      decision: 'pass',
      userId: req.user.sub,
      inputs: normalized,
      proposalHash: doc.payloadHash,
      ruleResults: decision.ruleResults,
    });

    return res.json({
      id: ins.insertedId.toString(),
      payloadHash: doc.payloadHash,
      expiresAt: doc.expiresAt,
      decision: 'pass',
      quote,
      ruleResults: decision.ruleResults,
      notEnforced: decision.notEnforced,
    });
  } catch (e: any) {
    return res.status(400).json({ error: 'bad request' });
  }
});

r.post('/:id/confirm', async (req: any, res) => {
  try {
    const body = ConfirmSchema.parse(req.body);
    const db = await getDb();
    const pid = new ObjectId(req.params.id);
    const p = await db.collection('proposals').findOne({ _id: pid, userId: uid(req) });
    if (!p) return res.status(404).json({ error: 'not_found' });
    if (p.status !== 'pending') return res.status(400).json({ error: 'not_pending', status: p.status });

    if (new Date(p.expiresAt) < new Date()) {
      await db.collection('proposals').updateOne({ _id: pid, status: 'pending' }, { $set: { status: 'expired' } });
      await audit({ event: 'proposal_expired', tier: 'T2', outcome: 'pass', decision: 'pass', userId: req.user.sub, proposalHash: p.payloadHash, ruleId: 'EXPIRY' });
      return res.status(400).json({ error: 'expired' });
    }

    if (p.payloadHash !== body.payloadHash.toLowerCase()) {
      await audit({ event: 'confirm_rejected', tier: 'SYS', outcome: 'blocked', decision: 'blocked', userId: req.user.sub, reason: 'hash_mismatch', proposalHash: p.payloadHash });
      return res.status(400).json({ error: 'hash_mismatch' });
    }

    // Re-run compliance at confirm time, folding in the confirm-time instruction
    // source so pasted/untrusted text is refused by INJ_01 (execute nothing).
    const decision = await checkCompliance(req.user.sub, {
      corridor: p.corridor,
      amountUSD: p.amountUSD,
      purpose: p.purpose ?? undefined,
      studyLevel: p.studyLevel ?? undefined,
      coveragePeriodMonths: p.coveragePeriodMonths ?? undefined,
      isFirstRelease: p.isFirstRelease ?? undefined,
      beneficiaryType: p.beneficiaryType ?? undefined,
      namedInInstitutionDocs: p.namedInInstitutionDocs ?? undefined,
      bankBranchId: p.bankBranchId ?? undefined,
      payerName: p.payerName ?? undefined,
      instructionSource: body.instructionSource,
      note: body.note,
    });

    if (decision.decision !== 'pass') {
      await audit({
        event: 'confirm_refused',
        tier: 'T3',
        outcome: decision.decision,
        decision: decision.decision,
        userId: req.user.sub,
        proposalHash: p.payloadHash,
        ruleResults: decision.ruleResults,
      });
      return res.status(400).json({
        error: 'compliance_failed',
        decision: decision.decision,
        ruleResults: decision.ruleResults,
        notEnforced: decision.notEnforced,
      });
    }

    // Single-use guard: only one caller can move pending -> confirmed.
    const claimed = await db
      .collection('proposals')
      .updateOne({ _id: pid, status: 'pending' }, { $set: { status: 'confirmed', confirmedAt: new Date() } });
    if (claimed.modifiedCount === 0) return res.status(409).json({ error: 'already_confirmed' });

    const bdt = Math.round(p.amountUSD * BDT_PER_USD);
    const debit = await db.collection('accounts').updateOne(
      { userId: new ObjectId(req.user.sub), currency: 'BDT', balance: { $gte: bdt } },
      { $inc: { balance: -bdt } },
    );
    if (debit.modifiedCount === 0) {
      await db.collection('proposals').updateOne({ _id: pid, status: 'confirmed' }, { $set: { status: 'pending' } });
      await audit({ event: 'confirm_rejected', tier: 'T3', outcome: 'blocked', decision: 'blocked', userId: req.user.sub, reason: 'insufficient_balance', proposalHash: p.payloadHash });
      return res.status(400).json({ error: 'insufficient_balance' });
    }

    // Debit done. If the provider fails after this, mark failed and refund.
    let receiptId: string;
    try {
      const sub = await provider.submit({ proposal: p });
      receiptId = sub.receiptId;
    } catch (err: any) {
      await db.collection('accounts').updateOne(
        { userId: new ObjectId(req.user.sub), currency: 'BDT' },
        { $inc: { balance: bdt } },
      );
      await db.collection('transfers').insertOne({
        userId: uid(req),
        proposalId: pid,
        status: 'failed',
        amountBDT: bdt,
        quoteSnapshot: { ...p, amountUSD: p.amountUSD },
        error: String(err?.message || err),
        createdAt: new Date(),
      });
      await db.collection('proposals').updateOne({ _id: pid, status: 'confirmed' }, { $set: { status: 'pending' } });
      await audit({ event: 'transfer_failed_refunded', tier: 'T3', outcome: 'blocked', decision: 'blocked', userId: req.user.sub, proposalHash: p.payloadHash, reason: 'provider_failure' });
      return res.status(502).json({ error: 'provider_failed', refunded: true });
    }

    await db.collection('transfers').insertOne({
      userId: uid(req),
      proposalId: pid,
      status: 'completed',
      amountBDT: bdt,
      quoteSnapshot: { ...p, amountUSD: p.amountUSD },
      receiptId,
      createdAt: new Date(),
    });
    await db.collection('proposals').updateOne({ _id: pid }, { $set: { status: 'executed', executedAt: new Date() } });
    await audit({ event: 'proposal_confirmed', tier: 'T3', outcome: 'pass', decision: 'pass', userId: req.user.sub, proposalHash: p.payloadHash, ruleResults: decision.ruleResults });

    return res.json({ receiptId, status: 'completed', amountBDT: bdt });
  } catch (e: any) {
    return res.status(400).json({ error: 'bad request' });
  }
});

r.post('/:id/cancel', async (req: any, res) => {
  try {
    const db = await getDb();
    const pid = new ObjectId(req.params.id);
    const p = await db.collection('proposals').findOne({ _id: pid, userId: uid(req) });
    if (!p) return res.status(404).json({ error: 'not_found' });
    const upd = await db
      .collection('proposals')
      .updateOne({ _id: pid, userId: uid(req), status: 'pending' }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
    if (upd.modifiedCount === 0) return res.status(400).json({ error: 'not_pending' });
    // CANCEL_01: a cancelled remittance is recorded as a reversal reference.
    await audit({
      event: 'transfer_reversed',
      tier: 'T2',
      outcome: 'cancelled',
      decision: 'pass',
      userId: req.user.sub,
      ruleId: 'CANCEL_01',
      proposalHash: p.payloadHash,
      reversalOf: { originalProposalId: pid.toString() },
    });
    return res.json({ ok: true, status: 'cancelled' });
  } catch (e: any) {
    return res.status(400).json({ error: 'bad request' });
  }
});

r.get('/:id', async (req: any, res) => {
  try {
    const db = await getDb();
    const p = await db.collection('proposals').findOne({ _id: new ObjectId(req.params.id), userId: uid(req) });
    if (!p) return res.status(404).json({ error: 'not_found' });
    return res.json(p);
  } catch {
    return res.status(400).json({ error: 'bad request' });
  }
});

export default r;
