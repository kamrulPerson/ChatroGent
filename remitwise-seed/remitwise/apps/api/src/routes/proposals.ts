import { Router } from 'express';
import { getDb } from '../db.js';
import { ProposeSchema, ConfirmSchema } from '../validate.js';
import { checkCompliance } from '../services/compliance.js';
import { audit } from '../audit.js';
import { MockPaymentProvider } from '../provider.js';
import { createProposal, BDT_PER_USD } from '../services/proposals.js';
import { ObjectId } from 'mongodb';

const r = Router();
const provider = new MockPaymentProvider();

// Proposals and transfers key on the ObjectId form of the user id so that the
// compliance engine (velocity / anomaly / daily-cap reads) and the dashboard
// queries can find them; the audit log stays keyed on the string subject.
const uid = (req: any) => new ObjectId(req.user.sub);

r.post('/', async (req: any, res) => {
  try {
    const input = ProposeSchema.parse(req.body);
    const result = await createProposal(req.user.sub, input);
    if (!result.ok) return res.status(result.status).json(result.body);
    return res.json({
      id: result.id,
      approvalHash: result.approvalHash,
      expiresAt: result.expiresAt,
      decision: 'pass',
      quote: result.quote,
      ruleResults: result.ruleResults,
      notEnforced: result.notEnforced,
    });
  } catch (e: any) {
    return res.status(400).json({ error: 'bad request' });
  }
});

r.post('/:id/confirm', async (req: any, res) => {
  try {
    const body = ConfirmSchema.parse(req.body);
    const providedHash = body.approvalHash.toLowerCase();
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

    if (p.payloadHash !== providedHash) {
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
      .updateOne({ _id: pid, status: 'pending' }, { $set: { status: 'cancelled' } });
    if (upd.modifiedCount === 0) return res.status(400).json({ error: 'not_pending' });
    await audit({
      event: 'proposal_cancelled',
      tier: 'T2',
      outcome: 'pass',
      decision: 'pass',
      userId: req.user.sub,
      proposalHash: p.payloadHash,
      ruleId: 'CANCEL_01',
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
