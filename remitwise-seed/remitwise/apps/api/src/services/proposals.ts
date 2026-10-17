import { getDb } from '../db.js';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { policy } from '../config.js';
import { audit } from '../audit.js';
import { checkCompliance, type ComplianceInput, type RuleResult } from './compliance.js';
import { CORRIDOR_META, corridorRate, computeQuote } from './convert.js';

// Proposals key on the ObjectId form of the user id so the compliance engine
// (velocity / anomaly / daily-cap reads) and the dashboard queries can find
// them; the audit log stays keyed on the string subject.
export const BDT_PER_USD = 120;

export type ProposeInput = ComplianceInput & { routeProvider?: string };

export interface QuoteShape {
  provider: string;
  feeBDT: number;
  spreadPct: number;
  etaDays: number;
  dataType: string;
  dateCollected: string;
  currency: string;
  pair: string;
  rate: number;
  usdPerBdt: number;
  sendBDT: number;
  gross: number;
  net: number;
  netUsd: number;
}

export type CreateProposalResult =
  | {
      ok: true;
      id: string;
      approvalHash: string;
      expiresAt: Date;
      quote: any;
      ruleResults: any[];
      notEnforced: string[];
    }
  | { ok: false; status: number; body: any };

function canonical(obj: any): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export function payloadHashOf(input: any, userId: string): string {
  return crypto.createHash('sha256').update(canonical({ ...input, userId })).digest('hex');
}

const round2 = (n: number) => Number(n.toFixed(2));

// Single source of truth for creating a payment proposal. Used by the HTTP
// route (/api/proposals) and by the agent's propose_payment tool so behaviour
// and audit output cannot drift.
export async function createProposal(userId: string, input: ComplianceInput & { routeProvider?: string }): Promise<
  | { ok: true; id: string; approvalHash: string; expiresAt: Date; quote: any; ruleResults: any[]; notEnforced: string[] }
  | { ok: false; status: number; body: any }
> {
  const decision = await checkCompliance(userId, input);

  if (decision.decision !== 'pass') {
    await audit({
      event: 'proposal_refused',
      tier: 'T2',
      outcome: decision.decision,
      decision: decision.decision,
      userId,
      inputs: input,
      ruleResults: decision.ruleResults,
      notEnforced: decision.notEnforced,
    });
    return {
      ok: false,
      status: 400,
      body: {
        error: 'compliance_failed',
        decision: decision.decision,
        ruleResults: decision.ruleResults,
        notEnforced: decision.notEnforced,
        rulesVersion: decision.rulesVersion,
      },
    };
  }

  const remaining = decision.limits.dailyCapUSD - decision.limits.sentTodayUSD;
  if (input.amountUSD > remaining) {
    await audit({
      event: 'proposal_refused',
      tier: 'T2',
      outcome: 'escalate_to_bank',
      decision: 'escalate_to_bank',
      userId,
      inputs: input,
      reason: 'daily_cap',
      ruleResults: decision.ruleResults,
    });
    return {
      ok: false,
      status: 400,
      body: {
        error: 'daily_limit_exceeded',
        decision: 'escalate_to_bank',
        dailyCapUSD: decision.limits.dailyCapUSD,
        sentTodayUSD: decision.limits.sentTodayUSD,
      },
    };
  }

  const db = await getDb();

  const meta = CORRIDOR_META[input.corridor];
  const conv = meta ? await corridorRate(input.corridor) : null;
  if (!conv) {
    await audit({ event: 'proposal_refused', tier: 'T2', outcome: 'blocked', decision: 'blocked', userId, reason: 'no_rate', inputs: input });
    return { ok: false, status: 400, body: { error: 'no_rate', message: `no rate for this corridor (${input.corridor})` } };
  }

  const route = await db.collection('routes').findOne({
    corridor: input.corridor,
    ...(input.routeProvider ? { provider: input.routeProvider } : {}),
  });
  const feeBDT = Number(route?.feeBDT ?? 2500);
  const spreadPct = Number(route?.spreadPct ?? 1.5);
  const q = computeQuote(input.amountUSD, conv.usdPerBdt, conv.rate, feeBDT, spreadPct, conv.dest, conv.pair);
  if (!q.quotable) {
    await audit({ event: 'proposal_refused', tier: 'T2', outcome: 'blocked', decision: 'blocked', userId, reason: 'below_minimum_payout', inputs: input });
    return {
      ok: false,
      status: 400,
      body: {
        error: 'below_minimum_payout',
        reason: 'fee_and_margin_exceed_amount',
        message: 'Fees and the FX margin would leave nothing for the recipient. Send a larger amount.',
      },
    };
  }

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
    userId: new ObjectId(userId),
    quoteSnapshot: quote,
    payloadHash: payloadHashOf(normalized, userId),
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
    userId,
    inputs: normalized,
    proposalHash: doc.payloadHash,
    ruleResults: decision.ruleResults,
  });

  return {
    ok: true,
    id: ins.insertedId.toString(),
    approvalHash: doc.payloadHash,
    expiresAt: doc.expiresAt,
    quote,
    ruleResults: decision.ruleResults,
    notEnforced: decision.notEnforced,
  };
}
