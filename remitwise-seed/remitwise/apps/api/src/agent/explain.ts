// Plain-language mapper for compliance blocks.
//
// One place turns a set of failed rules into the user-facing final text: a
// cause in one sentence and a next step in one sentence, with no rule IDs and
// no "N of 18 checks" wording. The live loop, the output-check fallback and the
// deterministic offline flow all use this, so the three paths read the same.
//
// The fee ceiling (MIN_AMT) is described from the rule's own figures — the fee,
// the share of the amount and the smallest amount that clears the cap on this
// route — and is never called "below minimum" because that rule did not fire.

import { fmtBDT, fmtUsd } from './format.js';
import { injectionRefusal } from './injection.js';

export interface RuleFailure {
  ruleId: string;
  outcome?: string;
  userMessage?: string;
  reason?: string;
  detail?: any;
}

const RANK: Record<string, number> = { blocked: 3, escalate_to_bank: 2, needs_documents: 1 };

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function causeOf(f: RuleFailure): string {
  const d = f.detail || {};
  if (f.ruleId === 'MIN_AMT' && d.kind === 'fee_ceiling') {
    // Every figure comes from the rule's own inputs: the flat fee, the FX
    // margin, their combined share of the amount and the configured cap. When
    // the share is within 0.1 points of the cap the one-decimal form would round
    // to the cap itself ("5.0% above the 5% limit"), so say "just over".
    const fee = fmtBDT(d.feeBdt);
    const spread = Number(d.spreadPct).toFixed(1);
    const total = Number(d.totalPct);
    const near = Math.abs(total - Number(d.maxFeePct)) < 0.1;
    if (near) {
      return sentence(
        `This payment can't go ahead because the ৳${fee} fee plus the ` +
          `${spread}% FX margin come to just over the ${d.maxFeePct}% limit`,
      );
    }
    return sentence(
      `This payment can't go ahead because the ৳${fee} fee plus the ` +
        `${spread}% FX margin come to about ${Number(d.totalPct).toFixed(1)}% of the amount, ` +
        `above the ${d.maxFeePct}% limit`,
    );
  }
  if (f.ruleId === 'MIN_AMT' && d.kind === 'below_minimum') {
    return sentence(`This payment is below the smallest transfer I can prepare, USD ${fmtUsd(d.minUsd)}`);
  }
  return sentence(f.userMessage || f.reason || "I can't prepare that payment as it stands");
}

function nextStepOf(f: RuleFailure): string {
  const d = f.detail || {};
  if (f.ruleId === 'MIN_AMT' && d.kind === 'fee_ceiling' && typeof d.minWorkableBdt === 'number') {
    return sentence(
      `On this route, send at least ৳${fmtBDT(d.minWorkableBdt)} (or pick a cheaper route) and it can go ahead; ` +
        'nothing has been sent',
    );
  }
  if (f.ruleId === 'MIN_AMT' && d.kind === 'below_minimum') {
    return sentence(`Send at least USD ${fmtUsd(d.minUsd)} and I can prepare it; nothing has been sent`);
  }
  if (f.outcome === 'needs_documents') {
    return sentence('Add the documents above and ask me again; nothing has been sent');
  }
  if (f.outcome === 'escalate_to_bank') {
    return sentence('Your bank would need to handle this one; nothing has been sent');
  }
  return sentence('Nothing has been sent');
}

// Map a set of failed rules to the final chat text (cause + next step).
export function explainBlock(failures: RuleFailure[]): string {
  if (!failures || !failures.length) {
    return sentence("I can't prepare that payment as it stands. Nothing has been sent");
  }
  if (failures.some((f) => f.ruleId === 'INJ_01')) return injectionRefusal('user_typed');
  const top = [...failures].sort((a, b) => (RANK[b.outcome || ''] || 0) - (RANK[a.outcome || ''] || 0))[0];
  return `${causeOf(top)} ${nextStepOf(top)}`;
}

// Short, one-line label for the trace. The full explanation is emitted once, in
// the answer; the trace row only names the reason.
export function shortBlockLabel(failures: RuleFailure[]): string {
  if (!failures || !failures.length) return 'Blocked';
  if (failures.some((f) => f.ruleId === 'INJ_01')) return 'Blocked: untrusted instruction';
  const top = [...failures].sort((a, b) => (RANK[b.outcome || ''] || 0) - (RANK[a.outcome || ''] || 0))[0];
  const d = top.detail || {};
  if (top.ruleId === 'MIN_AMT' && d.kind === 'fee_ceiling') return 'Blocked: fee too high for this amount';
  if (top.ruleId === 'MIN_AMT' && d.kind === 'below_minimum') return 'Blocked: amount below the minimum';
  if (top.outcome === 'needs_documents') return 'Needs documents';
  if (top.outcome === 'escalate_to_bank') return 'Needs bank review';
  if (top.outcome === 'blocked') return 'Blocked';
  return 'Blocked';
}

// The single check-count wording used by the trace, the card and the text:
// "N of M applicable checks passed". Only checks that were actually evaluated
// (status 'enforced') count towards M, so not-applicable and skipped checks are
// never counted as either a pass or a failure.
export function checkCount(ruleResults: { status: string; passed: boolean }[]): {
  passed: number;
  applicable: number;
  notApplicable: number;
} {
  const enforced = ruleResults.filter((r) => r.status === 'enforced');
  return {
    passed: enforced.filter((r) => r.passed).length,
    applicable: enforced.length,
    notApplicable: ruleResults.filter((r) => r.status === 'not_applicable').length,
  };
}

// Used by the output checker when the model's own text cannot be trusted: one
// plain sentence, never a concatenation of raw tool summaries.
export function safeFallback(): string {
  return 'Nothing has been sent. Here is what I found from the tools.';
}
