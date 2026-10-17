// Agent tools. Every tool runs server-side with the userId from the verified
// session token; NO tool schema exposes a userId parameter. Arguments are
// validated with zod (.strict(), so unknown keys are rejected) and any key
// starting with '$' at any depth is refused.

import { z } from 'zod';
import { getDb } from '../db.js';
import { ObjectId } from 'mongodb';
import { checkCompliance } from '../services/compliance.js';
import { createProposal } from '../services/proposals.js';
import { CORRIDOR_META, corridorRate, computeQuote, latestRate } from '../services/convert.js';
import { corridors } from '../validate.js';
import type { ToolSpec } from './llm.js';

export type Tier = 'T1' | 'T2' | 'T3';

export const TOOL_TIERS: Record<string, Tier> = {
  get_balance: 'T1',
  compare_routes: 'T1',
  check_compliance: 'T1',
  fx_window: 'T1',
  build_credit_plan: 'T2',
  propose_payment: 'T2',
  set_alert: 'T2',
  execute_payment: 'T3',
};

// Phase 1 implements the tools needed for Flow 1 (plus fx_window, a T1 read).
// set_alert and build_credit_plan are Phase 2 and are intentionally NOT in the
// allowlist yet, so calling them returns an error result.
const ALLOWLIST = new Set(['get_balance', 'compare_routes', 'check_compliance', 'fx_window', 'propose_payment', 'execute_payment']);

const corridorEnum = z.enum(corridors as unknown as [string, ...string[]]);
const currencyEnum = z.enum(['BDT', 'USD']);
const amountField = z.object({ amount: z.number().positive(), currency: currencyEnum.default('USD') });

const Schemas: Record<string, z.ZodTypeAny> = {
  get_balance: z.object({}).strict(),
  compare_routes: amountField.extend({ corridor: corridorEnum }).strict(),
  check_compliance: amountField
    .extend({
      corridor: corridorEnum,
      purpose: z.string().max(40).optional(),
      beneficiaryType: z.string().max(40).optional(),
      coveragePeriodMonths: z.number().int().positive().max(120).optional(),
      isFirstRelease: z.boolean().optional(),
    })
    .strict(),
  fx_window: z.object({ pair: z.string().min(3).max(40).optional(), days: z.number().int().positive().max(365).optional() }).strict(),
  propose_payment: amountField
    .extend({
      corridor: corridorEnum,
      recipient: z.string().max(120).optional(),
      purpose: z.string().max(40).optional(),
      beneficiaryType: z.string().max(40).optional(),
      coveragePeriodMonths: z.number().int().positive().max(120).optional(),
      isFirstRelease: z.boolean().optional(),
      routeProvider: z.string().min(1).max(120).optional(),
    })
    .strict(),
  execute_payment: z.object({ proposalId: z.string().min(1).max(64) }).strict(),
};

export interface ToolResult {
  status: 'done' | 'blocked' | 'error';
  summary: string;
  data: any;
  card?: any;
}

export type ValidationOutcome = { ok: true; value: any } | { ok: false; error: string };

function hasIllegalKey(value: any, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasIllegalKey(v, depth + 1));
  for (const k of Object.keys(value)) {
    if (k.startsWith('$')) return true;
    if (hasIllegalKey(value[k], depth + 1)) return true;
  }
  return false;
}

export function isKnownTool(name: string): boolean {
  return ALLOWLIST.has(name);
}

export function validateToolArgs(name: string, raw: unknown): ValidationOutcome {
  if (!ALLOWLIST.has(name)) return { ok: false, error: `unknown tool: ${name}` };
  let parsed: any = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'arguments are not valid JSON' };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'arguments must be a JSON object' };
  }
  if (hasIllegalKey(parsed)) return { ok: false, error: 'illegal key: keys must not start with $' };
  if ('userId' in parsed) return { ok: false, error: 'userId is not accepted; it comes from the session' };
  const schema = Schemas[name];
  const res = schema.safeParse(parsed);
  if (!res.success) {
    const issue = res.error.issues[0];
    return { ok: false, error: `invalid arguments: ${(issue?.path || []).join('.')} ${issue?.message || ''}`.trim() };
  }
  return { ok: true, value: res.data };
}

async function amountToUsd(amount: number, currency: 'BDT' | 'USD'): Promise<{ ok: true; usd: number; rate: number } | { ok: false; error: string }> {
  const rate = await latestRate('USD/BDT');
  if (!rate) return { ok: false, error: 'no USD/BDT rate available' };
  const usd = currency === 'BDT' ? amount / rate : amount;
  return { ok: true, usd, rate };
}

async function getBalance(userId: string): Promise<ToolResult> {
  const db = await getDb();
  const bals = await db.collection('accounts').find({ userId: new ObjectId(userId) }).toArray();
  const balances = bals.map((b: any) => ({ currency: b.currency, amount: b.balance }));
  const notable = balances.find((b) => b.currency === 'BDT') || balances[0];
  return { status: 'done', summary: notable ? `${notable.currency} ${notable.amount}` : 'no accounts', data: { balances } };
}

async function compareRoutes(args: any): Promise<ToolResult> {
  const conv = await corridorRate(args.corridor);
  if (!conv) return { status: 'blocked', summary: `No rate for ${args.corridor}`, data: { error: 'no_rate', corridor: args.corridor } };
  const usdRes = await amountToUsd(args.amount, args.currency);
  if (!usdRes.ok) return { status: 'error', summary: usdRes.error, data: { error: 'no_rate' } };
  const db = await getDb();
  const rows = await db.collection('routes').find({ corridor: args.corridor }).toArray();
  const routes = rows
    .map((rr: any) => {
      const q = computeQuote(usdRes.usd, conv.usdPerBdt, conv.rate, Number(rr.feeBDT), Number(rr.spreadPct), conv.dest, conv.pair);
      return {
        id: rr.provider,
        name: rr.provider,
        provider: rr.provider,
        corridor: args.corridor,
        currency: conv.dest,
        pair: conv.pair,
        rate: conv.rate,
        feeBDT: Number(rr.feeBDT),
        spreadPct: Number(rr.spreadPct),
        etaDays: rr.etaDays,
        dataType: rr.dataType,
        dateCollected: rr.dateCollected,
        gross: Number(q.gross.toFixed(2)),
        net: q.quotable ? Number(q.net.toFixed(2)) : null,
        quotable: q.quotable,
        reason: q.quotable ? null : 'fee_and_margin_exceed_amount',
        totalCostPct: Number(((Number(rr.feeBDT) / conv.usdPerBdt / usdRes.usd) * 100 + Number(rr.spreadPct)).toFixed(2)),
        note: rr.dataType === 'estimated' ? 'estimated' : '',
      };
    })
    .sort((a: any, b: any) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
  if (!routes.length) return { status: 'error', summary: `No routes for ${args.corridor}`, data: { error: 'no_routes' } };
  const best = routes[0];
  return {
    status: 'done',
    summary: `${routes.length} route(s); best ${best.name} nets ${best.currency} ${best.net}`,
    data: { corridor: args.corridor, currency: conv.dest, pair: conv.pair, source: 'routes dataset', dateCollected: best.dateCollected, routes },
    card: { kind: 'routes', routes, bestId: best.id },
  };
}

async function checkComplianceTool(userId: string, args: any, instructionSource: string): Promise<ToolResult> {
  const usdRes = await amountToUsd(args.amount, args.currency);
  if (!usdRes.ok) return { status: 'error', summary: usdRes.error, data: { error: 'no_rate' } };
  const decision = await checkCompliance(userId, {
    corridor: args.corridor,
    amountUSD: usdRes.usd,
    purpose: args.purpose,
    beneficiaryType: args.beneficiaryType,
    coveragePeriodMonths: args.coveragePeriodMonths,
    isFirstRelease: args.isFirstRelease,
    instructionSource,
  });
  const failed = decision.ruleResults.filter((r) => !r.passed && r.status === 'enforced').map((r) => r.ruleId);
  return {
    status: decision.decision === 'pass' ? 'done' : 'blocked',
    summary: decision.decision + (failed.length ? ` (${failed.join(', ')})` : ''),
    data: {
      decision: decision.decision,
      failedRules: failed,
      notEnforced: decision.notEnforced,
      rulesVersion: decision.rulesVersion,
    },
  };
}

function resolvePair(raw: string): string | null {
  if (CORRIDOR_META[raw]) return CORRIDOR_META[raw].pair;
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(raw)) return raw;
  return null;
}

async function fxWindow(args: any): Promise<ToolResult> {
  const pair = resolvePair(args.pair || 'MYR/BDT');
  if (!pair) return { status: 'blocked', summary: `No rate for ${args.pair}`, data: { error: 'no_rate' } };
  const days = args.days || 30;
  const db = await getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.collection('fx_rates').find({ pair, date: { $gte: since } }).sort({ date: 1 }).toArray();
  if (!rows.length) return { status: 'blocked', summary: `No rate for ${pair}`, data: { error: 'no_rate' } };
  let best = rows[0];
  let worst = rows[0];
  let sum = 0;
  for (const row of rows) {
    if (row.rate < best.rate) best = row;
    if (row.rate > worst.rate) worst = row;
    sum += Number(row.rate);
  }
  const current = rows[rows.length - 1];
  const average = sum / rows.length;
  return {
    status: 'done',
    summary: `${pair} range ${best.rate}..${worst.rate}, current ${current.rate}`,
    data: {
      pair,
      days,
      dataPoints: rows.length,
      best: { date: best.date, rate: Number(best.rate) },
      worst: { date: worst.date, rate: Number(worst.rate) },
      current: { date: current.date, rate: Number(current.rate) },
      average: Number(average.toFixed(4)),
      notAForecast: true,
    },
  };
}

function ruleView(r: any) {
  return { ruleId: r.ruleId, outcome: r.outcome, status: r.status, passed: r.passed, userMessage: r.userMessage, reason: r.reason };
}

async function proposePayment(userId: string, args: any, instructionSource: string): Promise<ToolResult> {
  const db = await getDb();
  const student = await db.collection('student_files').findOne({ userId: new ObjectId(userId) });
  const recipient = args.recipient || student?.institution || 'your institution';
  const usdRes = await amountToUsd(args.amount, args.currency);
  if (!usdRes.ok) return { status: 'error', summary: usdRes.error, data: { error: 'no_rate' } };

  const res = await createProposal(userId, {
    corridor: args.corridor,
    amountUSD: usdRes.usd,
    purpose: args.purpose || 'tuition',
    beneficiaryType: args.beneficiaryType,
    coveragePeriodMonths: args.coveragePeriodMonths,
    isFirstRelease: args.isFirstRelease,
    routeProvider: args.routeProvider,
    instructionSource,
  });

  if (!res.ok) {
    const blocked = res.body?.decision === 'blocked' || res.body?.error === 'compliance_failed';
    const failed = (res.body?.ruleResults || []).filter((r: any) => !r.passed && r.status === 'enforced').map((r: any) => r.ruleId);
    return {
      status: blocked ? 'blocked' : 'error',
      summary: res.body?.error || 'proposal refused' + (failed.length ? ` (${failed.join(', ')})` : ''),
      data: { error: res.body?.error, decision: res.body?.decision, failedRules: failed, message: res.body?.message },
    };
  }

  const q = res.quote;
  const route = {
    id: q.provider,
    name: q.provider,
    feeBDT: q.feeBDT,
    spreadPct: q.spreadPct,
    etaDays: q.etaDays,
    note: q.dataType === 'estimated' ? 'estimated' : '',
    currency: q.currency,
    net: q.net,
    quotable: true,
    reason: null,
    totalCostPct: Number(((q.feeBDT / q.usdPerBdt / usdRes.usd) * 100 + q.spreadPct).toFixed(2)),
  };
  const proposal = {
    id: res.id,
    amountBDT: q.sendBDT,
    recipient,
    route,
    status: 'pending' as const,
    checks: res.ruleResults.filter((r: any) => r.passed && r.status === 'enforced').map((r: any) => `${r.ruleId} passed`),
    hash: res.payloadHash,
    rules: res.ruleResults.map(ruleView),
    notEnforced: res.notEnforced,
  };
  return {
    status: 'done',
    summary: `Draft ready: send BDT ${q.sendBDT}, they receive ${q.currency} ${q.net} (${q.provider})`,
    data: {
      proposalId: res.id,
      payloadHash: res.payloadHash,
      currency: q.currency,
      pair: q.pair,
      rate: q.rate,
      feeBDT: q.feeBDT,
      sendBDT: q.sendBDT,
      gross: q.gross,
      net: q.net,
      provider: q.provider,
      etaDays: q.etaDays,
      dateCollected: q.dateCollected,
      source: 'routes dataset',
      dataType: q.dataType,
    },
    card: { kind: 'proposal', proposal },
  };
}

async function executePayment(userId: string, args: any): Promise<ToolResult> {
  // T3 gate. This NEVER moves money and NEVER activates anything. It only hands
  // back the proposal for the user to confirm in the UI. ToolTrace must show
  // "Awaiting your confirmation", never "completed".
  let approvalHash: string | null = null;
  try {
    const db = await getDb();
    const p = await db
      .collection('proposals')
      .findOne({ _id: new ObjectId(args.proposalId), userId: new ObjectId(userId) });
    approvalHash = p?.payloadHash ?? null;
  } catch {
    approvalHash = null;
  }
  return {
    status: 'done',
    summary: 'Awaiting your confirmation',
    data: {
      status: 'awaiting_user_confirmation',
      proposalId: args.proposalId,
      approvalHash,
      message: 'Awaiting your confirmation. Nothing has been sent.',
    },
  };
}

export async function runTool(name: string, userId: string, args: any, ctx: { instructionSource?: string }): Promise<ToolResult> {
  const instructionSource = ctx.instructionSource || 'user_typed';
  switch (name) {
    case 'get_balance':
      return getBalance(userId);
    case 'compare_routes':
      return compareRoutes(args);
    case 'check_compliance':
      return checkComplianceTool(userId, args, instructionSource);
    case 'fx_window':
      return fxWindow(args);
    case 'propose_payment':
      return proposePayment(userId, args, instructionSource);
    case 'execute_payment':
      return executePayment(userId, args);
    default:
      return { status: 'error', summary: `unknown tool: ${name}`, data: { error: 'unknown_tool' } };
  }
}

export const toolSpecs: ToolSpec[] = [
  {
    name: 'get_balance',
    description: 'Show the signed-in user sandbox account balances.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'compare_routes',
    description: 'Compare remittance routes for a corridor and an amount. Returns fee, FX spread, ETA and net amount received per route.',
    parameters: {
      type: 'object',
      properties: {
        corridor: { type: 'string', enum: [...corridors] },
        amount: { type: 'number', description: 'Amount to send.' },
        currency: { type: 'string', enum: ['BDT', 'USD'], description: 'Defaults to USD.' },
      },
      required: ['corridor', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_compliance',
    description: 'Evaluate compliance rules for a transfer. Returns an overall decision and the rules that failed.',
    parameters: {
      type: 'object',
      properties: {
        corridor: { type: 'string', enum: [...corridors] },
        amount: { type: 'number' },
        currency: { type: 'string', enum: ['BDT', 'USD'] },
        purpose: { type: 'string' },
        beneficiaryType: { type: 'string' },
        coveragePeriodMonths: { type: 'number' },
        isFirstRelease: { type: 'boolean' },
      },
      required: ['corridor', 'amount'],
    },
  },
  {
    name: 'fx_window',
    description: 'Recent rate window (best, worst, current, average) for a corridor pair. This is not a forecast.',
    parameters: { type: 'object', properties: { pair: { type: 'string' }, days: { type: 'number' } } },
  },
  {
    name: 'propose_payment',
    description: 'Create a pending payment proposal (T2). Never sends money. Returns the quote and an approval hash the user confirms in the UI.',
    parameters: {
      type: 'object',
      properties: {
        corridor: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        recipient: { type: 'string' },
        purpose: { type: 'string' },
        beneficiaryType: { type: 'string' },
        coveragePeriodMonths: { type: 'number' },
        isFirstRelease: { type: 'boolean' },
        routeProvider: { type: 'string' },
      },
      required: ['corridor', 'amount'],
    },
  },
  {
    name: 'execute_payment',
    description: 'T3 gate. Does NOT send money. Returns "awaiting your confirmation"; the user confirms in the UI.',
    parameters: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'] },
  },
];

// Exported for the output checker: the set of figures that came from tools this
// turn is assembled by loop.ts from these results.
export function toolNames(): string[] {
  return [...ALLOWLIST];
}
