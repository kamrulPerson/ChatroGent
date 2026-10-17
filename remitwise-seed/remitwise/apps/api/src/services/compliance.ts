import { getDb } from '../db.js';
import { ObjectId } from 'mongodb';
import { policy } from '../config.js';
import { latestRate } from './convert.js';

// Outcomes used by the spec v2 (section 6). The draft also mentions
// "needs_review" (BEN_02, PAYER_01) and "refuse and log" (INJ_01); those are
// folded into the four canonical outcomes, because the product surfaces only
// these four: needs_review -> escalate_to_bank, refuse_and_log -> blocked.
export type Outcome = 'pass' | 'needs_documents' | 'escalate_to_bank' | 'blocked';
export type RuleStatus = 'enforced' | 'not_enforced' | 'not_applicable';

export interface RuleResult {
  ruleId: string;
  outcome: Outcome;
  status: RuleStatus;
  passed: boolean;
  userMessage: string;
  reason: string;
}

export interface ComplianceInput {
  corridor: string;
  amountUSD: number;
  purpose?: string;
  studyLevel?: string;
  coveragePeriodMonths?: number;
  isFirstRelease?: boolean;
  beneficiaryType?: string;
  namedInInstitutionDocs?: boolean;
  bankBranchId?: string;
  payerName?: string;
  instructionSource?: string;
  note?: string;
}

export interface ComplianceContext {
  instructionSource: 'user_typed' | 'pasted_or_untrusted';
  purpose?: string;
  studyLevel?: string;
  amountUSD: number;
  coveragePeriodMonths?: number;
  isFirstRelease?: boolean;
  user: {
    kycTier: number;
    sentTodayUSD: number;
    transfersLast24h: number;
    medianTransferUSD: number | null;
  };
  documents: { verified: string[] };
  estimate: {
    totalUSD: number | null;
    academicYearMonths: number | null;
    advanceRequiredByInstitution: boolean | null;
  };
  beneficiary: { type?: string; namedInInstitutionDocs?: boolean };
  studentFile: { bankBranchId?: string };
  request: { bankBranchId?: string };
  payer: { name?: string };
  invoice: { payerName?: string };
  route: { feeBDT: number | null; spreadPct: number | null };
  fx: { usdPerBdt: number | null };
}

export interface Decision {
  decision: Outcome;
  ruleResults: RuleResult[];
  notEnforced: string[];
  rulesVersion: string;
  component: string;
  limits: { dailyCapUSD: number; sentTodayUSD: number };
}

const RANK: Record<Outcome, number> = {
  blocked: 3,
  escalate_to_bank: 2,
  needs_documents: 1,
  pass: 0,
};

const DOC_LABELS: Record<string, string> = {
  admission_letter: 'admission letter',
  cost_estimate: "institution's cost estimate",
  passport: 'valid passport',
  certificates: 'attested educational certificates',
  progress_report: 'current progress report',
  current_estimate: 'updated cost estimate',
};

// Spec v2, section 6: admission letter, cost estimate, passport, certificates.
const REQUIRED_DOCS = ['admission_letter', 'cost_estimate', 'passport', 'certificates'];

const INJECTION_RE = /\b(ignore|disregard)\b.{0,30}\b(previous|prior|above|all|the|your)\b.{0,20}\b(instruction|rule|prompt)/i;

export function looksLikeInjection(text?: string): boolean {
  if (!text) return false;
  return INJECTION_RE.test(text) || /ignore (previous|prior|all) instructions/i.test(text);
}

export async function buildContext(userId: string, input: ComplianceInput): Promise<ComplianceContext> {
  const db = await getDb();
  const uid = new ObjectId(userId);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [user, student, docs, last24h, todayDone, history] = await Promise.all([
    db.collection('users').findOne({ _id: uid }),
    db.collection('student_files').findOne({ userId: uid }),
    db.collection('documents').find({ userId: uid, status: 'valid' }).toArray(),
    db.collection('transfers').countDocuments({ userId: uid, createdAt: { $gte: since24h }, status: 'completed' }),
    db.collection('transfers').find({ userId: uid, createdAt: { $gte: todayStart }, status: 'completed' }).toArray(),
    db.collection('transfers').find({ userId: uid, status: 'completed' }).sort({ createdAt: -1 }).limit(50).toArray(),
  ]);

  const amounts = history
    .map((t: any) => t.quoteSnapshot?.amountUSD)
    .filter((n: any) => typeof n === 'number' && n > 0)
    .sort((a: number, b: number) => a - b);
  let median: number | null = null;
  if (amounts.length) {
    const mid = Math.floor(amounts.length / 2);
    median = amounts.length % 2 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2;
  }

  const [cheapestRoute, usdPerBdt] = await Promise.all([
    db.collection('routes').find({ corridor: input.corridor }).sort({ feeBDT: 1 }).limit(1).toArray(),
    latestRate('USD/BDT'),
  ]);
  const route = cheapestRoute[0] as any;

  const estimate = (student?.estimate || {}) as any;
  const untrusted = input.instructionSource === 'pasted_or_untrusted' || looksLikeInjection(input.note);

  return {
    instructionSource: untrusted ? 'pasted_or_untrusted' : 'user_typed',
    purpose: input.purpose,
    studyLevel: input.studyLevel ?? student?.level ?? undefined,
    amountUSD: input.amountUSD,
    coveragePeriodMonths: input.coveragePeriodMonths,
    isFirstRelease: input.isFirstRelease,
    user: {
      kycTier: user?.kycTier ?? 0,
      sentTodayUSD: todayDone.reduce((s: number, t: any) => s + (t.quoteSnapshot?.amountUSD || 0), 0),
      transfersLast24h: last24h,
      medianTransferUSD: median,
    },
    documents: { verified: docs.map((d: any) => d.type) },
    estimate: {
      totalUSD: typeof estimate.totalUSD === 'number' ? estimate.totalUSD : null,
      academicYearMonths: typeof estimate.academicYearMonths === 'number' ? estimate.academicYearMonths : null,
      advanceRequiredByInstitution:
        typeof estimate.advanceRequiredByInstitution === 'boolean' ? estimate.advanceRequiredByInstitution : null,
    },
    beneficiary: {
      type: input.beneficiaryType,
      namedInInstitutionDocs: input.namedInInstitutionDocs ?? false,
    },
    studentFile: { bankBranchId: student?.bankBranchId ?? undefined },
    request: { bankBranchId: input.bankBranchId ?? student?.bankBranchId ?? undefined },
    payer: { name: input.payerName ?? student?.payerName ?? undefined },
    invoice: { payerName: student?.invoicePayerName ?? student?.payerName ?? undefined },
    route: {
      feeBDT: route ? Number(route.feeBDT) : null,
      spreadPct: route ? Number(route.spreadPct) : null,
    },
    fx: { usdPerBdt: usdPerBdt ?? null },
  };
}

type Evaluated = { outcome: Outcome; status: RuleStatus; reason: string; userMessage?: string };

function pass(reason = 'ok'): Evaluated {
  return { outcome: 'pass', status: 'enforced', reason };
}
function fail(outcome: Outcome, reason: string, userMessage?: string): Evaluated {
  return { outcome, status: 'enforced', reason, userMessage };
}
function skip(reason: string): Evaluated {
  return { outcome: 'pass', status: 'not_enforced', reason };
}
function na(reason: string): Evaluated {
  return { outcome: 'pass', status: 'not_applicable', reason };
}

// One function per ruleId. The JSON file stays the source of truth for the
// user-facing messages; anything not derivable from data returns not_enforced
// instead of silently passing.
function evaluateRule(ruleId: string, ctx: ComplianceContext): Evaluated {
  switch (ruleId) {
    case 'INJ_01': {
      if (ctx.instructionSource !== 'user_typed') {
        return fail('blocked', 'instruction came from pasted/untrusted text');
      }
      return pass();
    }
    case 'KYC_01': {
      const tier = ctx.user.kycTier;
      if (tier <= 0) return fail('blocked', 'kyc tier 0');
      if (tier === 1) {
        const purpose = ctx.purpose || '';
        const needsEnhanced = policy.enhancedKycPurposes.includes(purpose);
        if (needsEnhanced || ctx.amountUSD > policy.tier1LowValueCapUSD) {
          return fail(
            'blocked',
            'tier 1 above low-value cap or restricted purpose',
            'Tuition payments and cross-border remittances need enhanced verification. Please complete enhanced KYC (tier 2).',
          );
        }
      }
      return pass();
    }
    case 'PURPOSE_01': {
      if (!ctx.purpose) return skip('no purpose supplied');
      return policy.purposes.includes(ctx.purpose)
        ? pass()
        : fail('blocked', `purpose ${ctx.purpose} not permitted`);
    }
    case 'PURPOSE_02': {
      if (!ctx.studyLevel) return skip('no study level on file');
      return ctx.studyLevel === 'school'
        ? fail('escalate_to_bank', 'school-level study')
        : pass();
    }
    case 'DOC_01': {
      const missing = REQUIRED_DOCS.filter((d) => !ctx.documents.verified.includes(d));
      if (!missing.length) return pass();
      const labels = missing.map((d) => DOC_LABELS[d] || d);
      return fail('needs_documents', `missing ${missing.join(', ')}`, missing.join(', '));
    }
    case 'AMT_01': {
      if (ctx.estimate.totalUSD === null) return skip('no institution estimate on file');
      return ctx.amountUSD <= ctx.estimate.totalUSD
        ? pass()
        : fail('escalate_to_bank', `amount ${ctx.amountUSD} > estimate ${ctx.estimate.totalUSD}`);
    }
    case 'AMT_02': {
      if (ctx.coveragePeriodMonths == null || ctx.estimate.academicYearMonths === null) {
        return skip('coverage period or academic year length unknown');
      }
      return ctx.coveragePeriodMonths <= ctx.estimate.academicYearMonths
        ? pass()
        : fail('needs_documents', 'coverage longer than one academic year');
    }
    case 'MIN_AMT': {
      if (ctx.amountUSD < policy.minTransferUSD) {
        return fail(
          'blocked',
          `amount ${ctx.amountUSD} below minimum ${policy.minTransferUSD}`,
          `The smallest transfer I can prepare is ${policy.minTransferUSD} USD. Please send a larger amount.`,
        );
      }
      if (ctx.route.feeBDT == null || !ctx.fx.usdPerBdt) {
        return skip('no route fee or usd rate to estimate fees');
      }
      const feeUSD = ctx.route.feeBDT / ctx.fx.usdPerBdt;
      const totalPct = (feeUSD / ctx.amountUSD) * 100 + (ctx.route.spreadPct ?? 0);
      if (totalPct >= policy.maxFeePct) {
        return fail(
          'blocked',
          `fee+spread ${totalPct.toFixed(1)}% >= maxFeePct ${policy.maxFeePct}%`,
          `Fees and FX margin on this transfer add up to ${totalPct.toFixed(1)}% of the amount, above the ${policy.maxFeePct}% limit. Send a larger amount or pick a cheaper route.`,
        );
      }
      return pass();
    }
    case 'BEN_01': {
      const applies = ['tuition', 'admission_fee', 'insurance', 'advance_fee'].includes(ctx.purpose || '');
      if (!applies) return na('purpose not subject to BEN_01');
      const t = ctx.beneficiary.type;
      if (!t) return skip('beneficiary type not supplied');
      const ok = t === 'institution' || (t === 'intermediary' && ctx.beneficiary.namedInInstitutionDocs === true);
      return ok ? pass() : fail('blocked', `tuition beneficiary type ${t}`);
    }
    case 'BEN_02': {
      const applies = ['living', 'incidental'].includes(ctx.purpose || '');
      if (!applies) return na('purpose not subject to BEN_02');
      const t = ctx.beneficiary.type;
      if (!t) return skip('beneficiary type not supplied');
      return t === 'student_card' ? pass() : fail('escalate_to_bank', `living/incidental beneficiary type ${t}`);
    }
    case 'ADV_01': {
      if (ctx.purpose !== 'advance_fee') return na('not an advance payment');
      if (ctx.estimate.advanceRequiredByInstitution === null) return skip('institution advance flag unknown');
      return ctx.estimate.advanceRequiredByInstitution
        ? pass()
        : fail('blocked', 'advance not required by institution docs');
    }
    case 'BANK_01': {
      if (!ctx.studentFile.bankBranchId || !ctx.request.bankBranchId) return skip('branch ids not on file');
      return ctx.studentFile.bankBranchId === ctx.request.bankBranchId
        ? pass()
        : fail('needs_documents', 'request branch differs from student file');
    }
    case 'FOLLOW_01': {
      if (ctx.isFirstRelease === undefined) return skip('release number unknown');
      if (ctx.isFirstRelease) return pass();
      const hasProgress = ctx.documents.verified.includes('progress_report');
      const hasEstimate = ctx.documents.verified.includes('current_estimate');
      return hasProgress && hasEstimate
        ? pass()
        : fail('needs_documents', 'repeat release missing progress report or updated estimate');
    }
    case 'VEL_01': {
      return ctx.user.transfersLast24h < policy.velocityMaxTransfers24h
        ? pass()
        : fail('escalate_to_bank', `${ctx.user.transfersLast24h} transfers in 24h`);
    }
    case 'ANOM_01': {
      if (!ctx.user.medianTransferUSD) return skip('no transfer history to compare');
      return ctx.amountUSD <= policy.anomalyMultiplier * ctx.user.medianTransferUSD
        ? pass()
        : fail('escalate_to_bank', 'amount above usual pattern');
    }
    case 'PAYER_01': {
      if (!ctx.payer.name || !ctx.invoice.payerName) return skip('payer or invoice name not on file');
      return ctx.payer.name === ctx.invoice.payerName
        ? pass()
        : fail('escalate_to_bank', 'payer name differs from invoice');
    }
    case 'AUDIT_01':
    case 'CANCEL_01':
      return { outcome: 'pass', status: 'enforced', reason: 'always on' };
    default:
      return skip('no evaluator for this ruleId');
  }
}

const EVAL_ORDER = [
  'INJ_01',
  'KYC_01',
  'PURPOSE_01',
  'PURPOSE_02',
  'DOC_01',
    'AMT_01',
    'AMT_02',
    'MIN_AMT',
    'BEN_01',
  'BEN_02',
  'BANK_01',
  'FOLLOW_01',
  'VEL_01',
  'ANOM_01',
  'PAYER_01',
  'AUDIT_01',
  'CANCEL_01',
];

function renderMessage(template: string, ctx: ComplianceContext, ev: Evaluated): string {
  if (ev.userMessage) return ev.userMessage;
  if (template.includes('{missingDocuments}')) {
    const missing = REQUIRED_DOCS.filter((d) => !ctx.documents.verified.includes(d)).map((d) => DOC_LABELS[d] || d);
    return template.replace('{missingDocuments}', missing.join(', '));
  }
  return template;
}

export async function checkCompliance(userId: string, input: ComplianceInput): Promise<Decision> {
  const ctx = await buildContext(userId, input);
  const db = await getDb();
  const rules = await db.collection('compliance_rules').find({}).toArray();
  const byId = new Map<string, any>(rules.map((r: any) => [r.ruleId || r.id, r]));
  const known = new Set(EVAL_ORDER);
  const ids = [...EVAL_ORDER, ...rules.map((r: any) => r.ruleId || r.id).filter((id: string) => id && !known.has(id))];

  const ruleResults: RuleResult[] = [];
  const notEnforced: string[] = [];
  let decision: Outcome = 'pass';

  for (const ruleId of ids) {
    const def = byId.get(ruleId);
    if (!def) continue;
    const ev = evaluateRule(ruleId, ctx);
    if (ev.status === 'not_enforced') notEnforced.push(ruleId);
    if (ev.status === 'enforced' && RANK[ev.outcome] > RANK[decision]) decision = ev.outcome;
    ruleResults.push({
      ruleId,
      outcome: ev.outcome,
      status: ev.status,
      passed: ev.outcome === 'pass',
      userMessage: ev.outcome === 'pass' ? '' : renderMessage(def.userMessage || '', ctx, ev),
      reason: ev.reason,
    });
  }

  return {
    decision,
    ruleResults,
    notEnforced,
    rulesVersion: policy.rulesVersion,
    component: policy.component,
    limits: {
      dailyCapUSD: policy.dailyCapUSDByKycTier[ctx.user.kycTier] ?? 0,
      sentTodayUSD: ctx.user.sentTodayUSD,
    },
  };
}
