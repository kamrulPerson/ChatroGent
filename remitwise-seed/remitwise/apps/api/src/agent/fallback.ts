import { invokeTool } from './exec.js';
import { redactString } from './redact.js';
import { fmtBDT, fmtMoney, fmtUsd } from './format.js';
import { explainBlock } from './explain.js';
import { injectionRefusal } from './injection.js';
import type { Emit } from './events.js';

function say(emit: Emit, text: string): void {
  emit({ type: 'text', delta: redactString(text) });
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface FallbackCtx {
  userId: string;
  message: string;
  instructionSource: string;
  untrustedReason?: string;
  history?: HistoryMessage[];
  emit: Emit;
}

type Intent = 'tuition' | 'balance' | 'fx' | 'credit' | 'unknown';

export interface ParsedAmount {
  amount: number;
  currency: 'BDT' | 'USD';
}

export interface AmountInfo extends ParsedAmount {
  explicit: boolean;
}

// Returns null when no amount is present. We never invent a default amount.
export function parseAmount(message: string): ParsedAmount | null {
  const info = parseAmountInfo(message);
  return info ? { amount: info.amount, currency: info.currency } : null;
}

// Like parseAmount but records whether a currency was explicitly stated, so the
// offline flow can ask "Is 500 in BDT or USD?" instead of guessing.
export function parseAmountInfo(message: string): AmountInfo | null {
  const cleaned = message.replace(/,/g, '');
  const bdt = cleaned.match(/(?:৳|bdt|taka)\s*([\d.]+)/i) || cleaned.match(/([\d.]+)\s*(?:৳|bdt|taka)/i);
  if (bdt) {
    const amount = Number(bdt[1]);
    return amount > 0 ? { amount, currency: 'BDT', explicit: true } : null;
  }
  const usd = cleaned.match(/(?:usd|\$)\s*([\d.]+)/i) || cleaned.match(/([\d.]+)\s*(?:usd|\$)/i);
  if (usd) {
    const amount = Number(usd[1]);
    return amount > 0 ? { amount, currency: 'USD', explicit: true } : null;
  }
  const plain = cleaned.match(/\b(\d{3,})\b/);
  if (plain) {
    const amount = Number(plain[1]);
    return amount > 0 ? { amount, currency: 'USD', explicit: false } : null;
  }
  return null;
}

// True when the message is nothing but a number, e.g. "500".
function isBareNumber(message: string): boolean {
  return /^\s*[\d,]+\s*$/.test(message);
}

function detectIntent(message: string): Intent {
  const m = message.toLowerCase();
  if (/\b(balance|how much|my account|wallet)\b/.test(m)) return 'balance';
  if (/\b(rate|fx|forecast|exchange|window)\b/.test(m)) return 'fx';
  if (/\b(credit|payment plan|installment|build.*plan|afford)\b/.test(m)) return 'credit';
  if (/\b(tuition|university|college|fee|send|transfer|dad|mom|father|mother|pay)\b/.test(m)) return 'tuition';
  return 'unknown';
}

export { detectIntent };

// Reads session memory to see whether the assistant is waiting on an amount.
export function pendingQuestion(history?: HistoryMessage[]): 'amount' | null {
  if (!history || !history.length) return null;
  const last = history[history.length - 1];
  if (last.role !== 'assistant') return null;
  if (/how much/i.test(last.content) || /which currency|bdt or usd/i.test(last.content)) return 'amount';
  return null;
}

async function tuitionFlow(ctx: FallbackCtx, info: AmountInfo): Promise<void> {
  const { emit } = ctx;
  const { amount, currency } = info;
  const corridor = 'BD-MY';

  await invokeTool(emit, ctx.userId, 'get_balance', {}, ctx.instructionSource);

  const comp = await invokeTool(
    emit,
    ctx.userId,
    'check_compliance',
    {
      corridor,
      amount,
      currency,
      purpose: 'tuition',
      coveragePeriodMonths: 12,
      isFirstRelease: true,
    },
    ctx.instructionSource,
  );
  if (comp.status !== 'done') {
    // Requirement 4: the same plain-language mapper writes every block, so this
    // reads the same as the live path. No rule IDs, no "N of 18 checks".
    const failures = (comp.data && comp.data.failures) || [];
    say(emit, explainBlock(failures));
    return;
  }

  // A3: run all tools first, then emit text, then the cards in order.
  const routes = await invokeTool(emit, ctx.userId, 'compare_routes', { corridor, amount, currency }, ctx.instructionSource);

  const prop = await invokeTool(
    emit,
    ctx.userId,
    'propose_payment',
    {
      corridor,
      amount,
      currency,
      purpose: 'tuition',
      coveragePeriodMonths: 12,
      isFirstRelease: true,
    },
    ctx.instructionSource,
  );

  if (prop.status !== 'done') {
    // Requirement 5: when compliance blocks, we never show a routes card as an
    // offer. Nothing but the explanation is emitted.
    const failures = (prop.data && prop.data.failures) || [];
    say(emit, failures.length ? explainBlock(failures) : `${prop.summary} Nothing has been sent.`);
    return;
  }

  const d = prop.data;
  const bdtAmount = currency === 'BDT' ? amount : amount * d.usdPerBdt;
  let text =
    `You asked to send ৳${fmtBDT(bdtAmount)} (about USD ${fmtUsd(d.amountUsd)}). ` +
    `Route: ${d.provider}. You send BDT ${fmtBDT(d.sendBDT)}; they receive ` +
    `${d.currency} ${fmtMoney(d.net, d.currency)}. `;
  if (d.isBestRoute === false && d.bestProvider) {
    text += `This isn't the highest-payout route; the best is ${d.bestProvider}. `;
  }
  text += `Route data: ${d.source}. Snapshot ${d.dateCollected}. ` + `This is a draft — approve the card below to send. Nothing has been sent yet.`;
  say(emit, text);

  if (routes.card) emit({ type: 'card', card: routes.card });
  if (prop.card) emit({ type: 'card', card: prop.card });
}

export async function runFallback(ctx: FallbackCtx): Promise<void> {
  const { emit } = ctx;
  if (ctx.untrustedReason) {
    say(emit, injectionRefusal(ctx.untrustedReason));
    return;
  }

  const info = parseAmountInfo(ctx.message);
  const pending = pendingQuestion(ctx.history);
  let intent = detectIntent(ctx.message);
  if (intent === 'unknown' && pending === 'amount' && info) intent = 'tuition';

  if (intent === 'balance') {
    const bal = await invokeTool(emit, ctx.userId, 'get_balance', {}, ctx.instructionSource);
    say(emit, `${bal.summary} Your balance is a sandbox figure. Nothing has been sent.`);
    return;
  }
  if (intent === 'fx') {
    const fx = await invokeTool(emit, ctx.userId, 'fx_window', {}, ctx.instructionSource);
    say(emit, `${fx.summary}. This is not a forecast.`);
    return;
  }
  if (intent === 'credit') {
    const plan = await invokeTool(
      emit,
      ctx.userId,
      'build_credit_plan',
      { corridor: 'BD-MY', totalAmount: info ? info.amount : undefined, currency: info ? info.currency : undefined },
      ctx.instructionSource,
    );
    say(emit, `${plan.summary} This is guidance, not financial advice.`);
    return;
  }
  if (intent === 'unknown') {
    if (pending === 'amount' && info && !info.explicit) {
      say(emit, `Is ${info.amount} in BDT or USD? Tell me the currency and I'll prepare the payment.`);
      return;
    }
    say(emit, 'I can check balances, compare routes, check compliance, look at recent FX, or draft a payment. Tell me what you need.');
    return;
  }

  // Tuition intent.
  if (!info) {
    say(emit, 'How much would you like to send? Tell me the amount, for example "৳2,40,000" or "2000 USD".');
    return;
  }
  if (!info.explicit) {
    const onlyNumber = /^\s*\d[\d,]*\s*$/.test(ctx.message.trim());
    if (pending === 'amount' || !onlyNumber) {
      say(emit, `Is ${info.amount} in BDT or USD? Tell me the currency and I'll prepare the payment.`);
      return;
    }
    say(emit, 'I can check balances, compare routes, check compliance, look at recent FX, or draft a payment. Tell me what you need.');
    return;
  }
  await tuitionFlow(ctx, info);
}
