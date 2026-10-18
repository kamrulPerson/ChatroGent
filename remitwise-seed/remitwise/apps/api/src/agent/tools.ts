// Agent tools. Every tool runs server-side with the userId from the verified
// session token; NO tool schema exposes a userId parameter. Arguments are
// validated with zod (.strict(), so unknown keys are rejected) and any key
// starting with '$' at any depth is refused.

import { z } from 'zod';
import { getDb } from '../db.js';
import { ObjectId } from 'mongodb';
import { checkCompliance } from '../services/compliance.js';
import { createProposal } from '../services/proposals.js';
import { audit } from '../audit.js';
import { CORRIDOR_META, latestRate } from '../services/convert.js';
import { rankRoutes } from '../services/routes.js';
import { corridors } from '../validate.js';
import { fmtAmount, fmtMoney } from './format.js';
import { explainBlock } from './explain.js';
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

// Phase 1 implemented Flow 1 (plus fx_window, a T1 read). Phase 2 adds the
// credit-plan builder and alerts (both T2).
const ALLOWLIST = new Set([
  'get_balance',
  'compare_routes',
  'check_compliance',
  'fx_window',
  'build_credit_plan',
  'propose_payment',
  'set_alert',
  'execute_payment',
]);

const corridorEnum = z.enum(corridors as unknown as [string, ...string[]]);
const currencyEnum = z.enum(['BDT', 'USD']);
const amountField = z.object({ amount: z.number().positive(), currency: currencyEnum.default('USD') });

// The beneficiary is DERIVED on the server, never supplied by the model:
// tuition, fees and insurance go to the institution on the student file;
// living and incidental costs go to the student card. (Requirement 2.)
const INSTITUTION_PURPOSES = ['tuition', 'insurance', 'admission_fee', 'advance_fee'];
const STUDENT_CARD_PURPOSES = ['living', 'incidental'];
export function deriveBeneficiaryType(purpose: string | undefined, student: any): string | undefined {
  if (student && typeof student.beneficiaryType === 'string') return student.beneficiaryType;
  if (!purpose) return undefined;
  if (INSTITUTION_PURPOSES.includes(purpose)) return 'institution';
  if (STUDENT_CARD_PURPOSES.includes(purpose)) return 'student_card';
  return undefined;
}

const Schemas: Record<string, z.ZodTypeAny> = {
  get_balance: z.object({}).strict(),
  compare_routes: amountField.extend({ corridor: corridorEnum }).strict(),
  check_compliance: amountField
    .extend({
      corridor: corridorEnum,
      purpose: z.string().max(40).optional(),
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
      coveragePeriodMonths: z.number().int().positive().max(120).optional(),
      isFirstRelease: z.boolean().optional(),
      routeProvider: z.string().min(1).max(120).optional(),
    })
    .strict(),
  execute_payment: z.object({ proposalId: z.string().min(1).max(64) }).strict(),
  build_credit_plan: z
    .object({
      corridor: corridorEnum.optional(),
      totalAmount: z.number().positive().optional(),
      currency: currencyEnum.optional(),
    })
    .strict(),
  set_alert: z
    .object({
      pair: z.string().min(3).max(40),
      target: z.number().positive(),
      fallbackDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      corridor: corridorEnum.optional(),
    })
    .strict(),
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
  return { status: 'done', summary: notable ? fmtAmount(notable.amount, notable.currency) : 'no accounts', data: { balances } };
}

function routeDataLabel(illustrative: boolean, dateCollected?: string): string {
  return illustrative ? 'Sample data (illustrative)' : `routes dataset (${dateCollected || 'n/a'})`;
}

async function compareRoutes(args: any): Promise<ToolResult> {
  const usdRes = await amountToUsd(args.amount, args.currency);
  if (!usdRes.ok) return { status: 'error', summary: usdRes.error, data: { error: 'no_rate' } };
  const ranked = await rankRoutes(args.corridor, usdRes.usd);
  if (!ranked) return { status: 'blocked', summary: `No rate for ${args.corridor}`, data: { error: 'no_rate', corridor: args.corridor } };
  const { conv, routes, illustrative } = ranked;
  if (!routes.length) return { status: 'error', summary: `No routes for ${args.corridor}`, data: { error: 'no_routes' } };
  const best = routes[0];
  const source = routeDataLabel(illustrative, best.dateCollected);
  return {
    status: 'done',
    summary: `${routes.length} route(s); best ${best.name} nets ${fmtAmount(best.net ?? 0, best.currency)}`,
    data: { corridor: args.corridor, currency: conv.dest, pair: conv.pair, source, dateCollected: best.dateCollected, illustrative, routes },
    card: { kind: 'routes', routes, bestId: best.id, source, snapshot: best.dateCollected, illustrative },
  };
}

async function checkComplianceTool(userId: string, args: any, instructionSource: string): Promise<ToolResult> {
  const usdRes = await amountToUsd(args.amount, args.currency);
  if (!usdRes.ok) return { status: 'error', summary: usdRes.error, data: { error: 'no_rate' } };
  const db = await getDb();
  const student = await db.collection('student_files').findOne({ userId: new ObjectId(userId) });
  const decision = await checkCompliance(userId, {
    corridor: args.corridor,
    amountUSD: usdRes.usd,
    purpose: args.purpose,
    beneficiaryType: deriveBeneficiaryType(args.purpose, student),
    coveragePeriodMonths: args.coveragePeriodMonths,
    isFirstRelease: args.isFirstRelease,
    instructionSource,
  });
  const failed = decision.ruleResults.filter((r) => !r.passed && r.status === 'enforced');
  const failures = failed.map((r) => ({
    ruleId: r.ruleId,
    outcome: r.outcome,
    userMessage: r.userMessage,
    reason: r.reason,
    detail: r.detail,
  }));
  const passedCount = decision.ruleResults.filter((r) => r.passed && r.status === 'enforced').length;
  const total = decision.ruleResults.length;
  // Human summary only; raw rule IDs live in the Activity log, never in chat.
  // A block is written by the same plain-language mapper the offline flow uses.
  const summary =
    decision.decision === 'pass' ? `${passedCount} of ${total} checks passed` : explainBlock(failures);
  return {
    status: decision.decision === 'pass' ? 'done' : 'blocked',
    summary,
    data: {
      decision: decision.decision,
      failedRules: failed.map((r) => r.ruleId),
      failures,
      notEnforced: decision.notEnforced,
      rulesVersion: decision.rulesVersion,
      passedCount,
      total,
      messages: failed.map((r) => r.userMessage).filter(Boolean),
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

const CREDIT_MILESTONES = [1, 3, 6, 12];

// T2: builds a savings/remittance plan with milestones at 1, 3, 6 and 12 months.
// Malaysia (BD-MY) gets a per-month table; other corridors get general guidance
// behind a clear "not in the supported list" notice. It never opens an account
// or submits anything.
async function buildCreditPlan(args: any): Promise<ToolResult> {
  const corridor = args.corridor || 'BD-MY';
  const currency = args.currency || 'BDT';
  const total = typeof args.totalAmount === 'number' ? args.totalAmount : null;
  const supported = corridor === 'BD-MY';
  const monthly = total !== null ? total / 12 : null;
  const milestones = CREDIT_MILESTONES.map((m) => ({
    month: m,
    cumulative: monthly !== null ? Number((monthly * m).toFixed(2)) : null,
    remaining: monthly !== null && total !== null ? Number((total - monthly * m).toFixed(2)) : null,
  }));
  const dateCollected = new Date().toISOString().slice(0, 10);

  const data: any = {
    corridor,
    currency,
    totalAmount: total,
    monthlySetAside: monthly !== null ? Number(monthly.toFixed(2)) : null,
    milestones,
    supported,
    notFinancialAdvice: true,
    canOpenAccount: false,
    canSubmitApplication: false,
    disclaimer: 'This is guidance, not financial advice. I cannot open an account or submit an application for you.',
  };
  if (supported) {
    data.verified = false;
    data.source = 'Sample data (illustrative)';
    data.dateCollected = dateCollected;
    data.tableNote = 'Monthly set-aside assumes an even split across 12 months.';
  } else {
    data.note = `I don't have a verified plan for ${corridor}; it isn't in the supported list yet. Here are general principles: save in the currency you will spend, keep the money separate from daily spending, and review progress each month.`;
  }

  const summary =
    total === null
      ? 'Tell me the total you are planning for and I will lay out the monthly milestones.'
      : supported
        ? `Plan for ${fmtAmount(total, currency)}: set aside about ${fmtAmount(monthly || 0, currency)} a month. Milestones at 1, 3, 6 and 12 months. Guidance only; not financial advice.`
        : `I can only give general principles for ${corridor} — it isn't in the supported list yet. Guidance only; not financial advice.`;
  return { status: 'done', summary, data };
}

// T2: creates a PENDING alert. Alerts are never activated here; activation is a
// UI action. For a deadline, the fallback date must leave room for the route
// ETA plus a one-day buffer, so an alert can never fire after the deadline.
async function setAlert(userId: string, args: any): Promise<ToolResult> {
  const target = Number(args.target);
  if (!(target > 0)) {
    return { status: 'error', summary: 'The alert target must be greater than zero.', data: { error: 'invalid_target' } };
  }
  const fallbackDate = args.fallbackDate;
  const deadline: string | undefined = args.deadline;
  const iso = /^\d{4}-\d{2}-\d{2}$/;

  let etaDays = 4;
  const db = await getDb();
  const corridor = args.corridor || 'BD-MY';
  const routeRows = await db.collection('routes').find({ corridor }).toArray();
  if (routeRows.length) etaDays = Math.max(...routeRows.map((r: any) => Number(r.etaDays) || 0)) || 4;

  if (deadline && iso.test(deadline) && iso.test(fallbackDate)) {
    const latest = new Date(deadline);
    latest.setDate(latest.getDate() - etaDays - 1);
    if (new Date(fallbackDate) > latest) {
      return {
        status: 'error',
        summary: `That alert would leave too little time: with a ${etaDays}-day route, set the fallback by ${latest.toISOString().slice(0, 10)} so the money still arrives before ${deadline}.`,
        data: { error: 'fallback_too_late', latestFallbackDate: latest.toISOString().slice(0, 10), etaDays, deadline },
      };
    }
  }

  const now = new Date();
  const doc = {
    userId: new ObjectId(userId),
    pair: args.pair,
    corridor,
    target,
    fallbackDate,
    deadline: deadline || null,
    status: 'pending',
    active: false,
    createdAt: now,
  };
  const ins = await db.collection('alerts').insertOne(doc);
  await audit({
    event: 'alert_created',
    tier: 'T2',
    outcome: 'pass',
    decision: 'pass',
    userId,
    inputs: { pair: args.pair, target, fallbackDate, deadline: deadline || null },
  });
  const until = deadline ? `, and no later than ${fallbackDate} so it can still arrive before ${deadline}` : '';
  return {
    status: 'done',
    summary: `Alert created (pending): watch ${args.pair} for ${target}${until}. Turn it on in Alerts when you are ready. I can't activate it for you.`,
    data: { alertId: ins.insertedId.toString(), status: 'pending', active: false, pair: args.pair, target, fallbackDate, deadline: deadline || null },
  };
}

async function proposePayment(userId: string, args: any, instructionSource: string): Promise<ToolResult> {
  const db = await getDb();
  const student = await db.collection('student_files').findOne({ userId: new ObjectId(userId) });
  const recipient = args.recipient || student?.institution || 'your institution';
  const usdRes = await amountToUsd(args.amount, args.currency);
  if (!usdRes.ok) return { status: 'error', summary: usdRes.error, data: { error: 'no_rate' } };

  // A1: unless the user named a provider, use the same top-ranked route that
  // compare_routes shows, so the card, trace and proposal can never disagree.
  let routeProvider = args.routeProvider as string | undefined;
  let bestProvider: string | undefined;
  const ranked = await rankRoutes(args.corridor, usdRes.usd);
  if (ranked && ranked.routes.length) bestProvider = ranked.routes[0].provider;
  if (!routeProvider) routeProvider = bestProvider;

  const purpose = args.purpose || 'tuition';
  const res = await createProposal(userId, {
    corridor: args.corridor,
    amountUSD: usdRes.usd,
    purpose,
    beneficiaryType: deriveBeneficiaryType(purpose, student),
    coveragePeriodMonths: args.coveragePeriodMonths,
    isFirstRelease: args.isFirstRelease,
    routeProvider,
    instructionSource,
  });

  if (!res.ok) {
    const blocked = res.body?.decision === 'blocked' || res.body?.error === 'compliance_failed';
    const failedResults = (res.body?.ruleResults || []).filter((r: any) => !r.passed && r.status === 'enforced');
    const failures = failedResults.map((r: any) => ({
      ruleId: r.ruleId,
      outcome: r.outcome,
      userMessage: r.userMessage,
      reason: r.reason,
      detail: r.detail,
    }));
    const messages = failedResults.map((r: any) => r.userMessage).filter(Boolean);
    const plain = failures.length ? explainBlock(failures) : res.body?.message || 'That payment could not be prepared.';
    return {
      status: blocked ? 'blocked' : 'error',
      summary: plain,
      data: {
        error: res.body?.error,
        decision: res.body?.decision,
        failedRules: failedResults.map((r: any) => r.ruleId),
        failures,
        message: res.body?.message,
        messages,
      },
    };
  }

  const q = res.quote;
  const illustrative = ranked ? ranked.illustrative : true;
  const source = routeDataLabel(illustrative, q.dateCollected);
  const routeIsBest = !bestProvider || q.provider === bestProvider;
  const route = {
    id: q.provider,
    name: q.provider,
    provider: q.provider,
    corridor: args.corridor,
    currency: q.currency,
    pair: q.pair,
    rate: q.rate,
    feeBDT: q.feeBDT,
    spreadPct: q.spreadPct,
    etaDays: q.etaDays,
    dataType: q.dataType,
    dateCollected: q.dateCollected,
    gross: q.gross,
    net: q.net,
    netUsd: q.netUsd,
    sendBDT: q.sendBDT,
    quotable: true,
    reason: null,
    totalCostPct: Number(((q.feeBDT / q.usdPerBdt / usdRes.usd) * 100 + q.spreadPct).toFixed(2)),
    note: q.dataType === 'estimated' ? 'estimated' : '',
    isBest: routeIsBest,
  };
  const proposal = {
    id: res.id,
    approvalHash: res.approvalHash,
    amountBDT: q.sendBDT,
    amountUSD: Number(usdRes.usd.toFixed(2)),
    recipient,
    currency: q.currency,
    corridor: args.corridor,
    purpose: args.purpose || 'tuition',
    net: q.net,
    feeBDT: q.feeBDT,
    etaDays: q.etaDays,
    provider: q.provider,
    route,
    isBestRoute: routeIsBest,
    status: 'pending' as const,
    rules: res.ruleResults.map(ruleView),
    notEnforced: res.notEnforced,
    source,
    illustrative,
    snapshot: q.dateCollected,
  };
  return {
    status: 'done',
    summary: `Draft ready: send ${fmtAmount(q.sendBDT, 'BDT')}, they receive ${fmtAmount(q.net, q.currency)} (${q.provider})`,
    data: {
      proposalId: res.id,
      approvalHash: res.approvalHash,
      amountUsd: Number(usdRes.usd.toFixed(2)),
      currency: q.currency,
      pair: q.pair,
      rate: q.rate,
      usdPerBdt: q.usdPerBdt,
      feeBDT: q.feeBDT,
      sendBDT: q.sendBDT,
      gross: q.gross,
      net: q.net,
      provider: q.provider,
      isBestRoute: routeIsBest,
      bestProvider: bestProvider || null,
      etaDays: q.etaDays,
      dateCollected: q.dateCollected,
      source,
      dataType: q.dataType,
    },
    card: { kind: 'proposal', proposal, source, snapshot: q.dateCollected, illustrative },
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
    case 'build_credit_plan':
      return buildCreditPlan(args);
    case 'propose_payment':
      return proposePayment(userId, args, instructionSource);
    case 'set_alert':
      return setAlert(userId, args);
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
    description: 'Evaluate compliance rules for a transfer. Returns an overall decision and the rules that failed. The beneficiary type is derived server-side from the purpose.',
    parameters: {
      type: 'object',
      properties: {
        corridor: { type: 'string', enum: [...corridors] },
        amount: { type: 'number' },
        currency: { type: 'string', enum: ['BDT', 'USD'] },
        purpose: { type: 'string' },
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
    description:
      'Create a pending payment proposal (T2). Never sends money. The recipient defaults to the university on the student file and the beneficiary type is derived server-side from the purpose. Returns the quote and an approval hash the user confirms in the UI.',
    parameters: {
      type: 'object',
      properties: {
        corridor: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        recipient: { type: 'string' },
        purpose: { type: 'string' },
        coveragePeriodMonths: { type: 'number' },
        isFirstRelease: { type: 'boolean' },
        routeProvider: { type: 'string' },
      },
      required: ['corridor', 'amount'],
    },
  },
  {
    name: 'build_credit_plan',
    description:
      'Build a payment/savings plan with milestones at 1, 3, 6 and 12 months (T2). Malaysia gets a table; other corridors get general principles only. Never opens an account or submits an application. Not financial advice.',
    parameters: {
      type: 'object',
      properties: {
        corridor: { type: 'string', enum: [...corridors], description: 'Defaults to BD-MY.' },
        totalAmount: { type: 'number', description: 'Total the user is planning for.' },
        currency: { type: 'string', enum: ['BDT', 'USD'], description: 'Defaults to BDT.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_alert',
    description:
      'Create a PENDING rate alert (T2). Never activates it; the user turns it on in the UI. If a deadline is given, the fallback date must leave room for the route ETA plus one day.',
    parameters: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'Rate pair, e.g. MYR/BDT.' },
        target: { type: 'number', description: 'Target rate (must be > 0).' },
        fallbackDate: { type: 'string', description: 'Date to fall back, YYYY-MM-DD.' },
        deadline: { type: 'string', description: 'Date the money must arrive, YYYY-MM-DD.' },
        corridor: { type: 'string', description: 'Corridor used to look up route ETA. Defaults to BD-MY.' },
      },
      required: ['pair', 'target', 'fallbackDate'],
      additionalProperties: false,
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
