import { invokeTool } from './exec.js';
import { redactString } from './redact.js';
import { fmtBDT, fmtMoney, fmtUsd } from './format.js';
import type { Emit } from './events.js';

function say(emit: Emit, text: string): void {
  emit({ type: 'text', delta: redactString(text) });
}

export interface FallbackCtx {
  userId: string;
  message: string;
  instructionSource: string;
  emit: Emit;
}

type Intent = 'tuition' | 'balance' | 'fx' | 'credit' | 'unknown';

export interface ParsedAmount {
  amount: number;
  currency: 'BDT' | 'USD';
}

// Returns null when no amount is present. We never invent a default amount: the
// assistant asks the user instead.
export function parseAmount(message: string): ParsedAmount | null {
  const cleaned = message.replace(/,/g, '');
  const bdt = cleaned.match(/(?:৳|bdt|taka)\s*([\d.]+)/i) || cleaned.match(/([\d.]+)\s*(?:৳|bdt|taka)/i);
  if (bdt) {
    const amount = Number(bdt[1]);
    return amount > 0 ? { amount, currency: 'BDT' } : null;
  }
  const usd = cleaned.match(/(?:usd|\$)\s*([\d.]+)/i) || cleaned.match(/([\d.]+)\s*(?:usd|\$)/i);
  if (usd) {
    const amount = Number(usd[1]);
    return amount > 0 ? { amount, currency: 'USD' } : null;
  }
  const plain = cleaned.match(/\b(\d{3,})\b/);
  if (plain) {
    const amount = Number(plain[1]);
    return amount > 0 ? { amount, currency: 'USD' } : null;
  }
  return null;
}

function detectIntent(message: string): Intent {
  const m = message.toLowerCase();
  if (/\b(balance|how much|my account|wallet)\b/.test(m)) return 'balance';
  if (/\b(rate|fx|forecast|exchange|window)\b/.test(m)) return 'fx';
  if (/\b(credit plan|payment plan|installment|build.*plan)\b/.test(m)) return 'credit';
  if (/\b(tuition|university|college|fee|send|transfer|dad|mom|father|mother|pay)\b/.test(m)) return 'tuition';
  return 'unknown';
}

export { detectIntent };

async function tuitionFlow(ctx: FallbackCtx): Promise<void> {
  const { emit } = ctx;
  const parsed = parseAmount(ctx.message);
  if (!parsed) {
    say(emit, 'How much would you like to send? Tell me the amount, for example "৳2,40,000" or "2000 USD".');
    return;
  }
  const { amount, currency } = parsed;
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
      beneficiaryType: 'institution',
      coveragePeriodMonths: 12,
      isFirstRelease: true,
    },
    ctx.instructionSource,
  );
  if (comp.status !== 'done') {
    say(emit, `I can't prepare that payment: compliance returned "${comp.summary}". Nothing has been sent.`);
    return;
  }

  const routes = await invokeTool(emit, ctx.userId, 'compare_routes', { corridor, amount, currency }, ctx.instructionSource);
  if (routes.card) emit({ type: 'card', card: routes.card });

  const prop = await invokeTool(
    emit,
    ctx.userId,
    'propose_payment',
    {
      corridor,
      amount,
      currency,
      purpose: 'tuition',
      beneficiaryType: 'institution',
      coveragePeriodMonths: 12,
      isFirstRelease: true,
    },
    ctx.instructionSource,
  );
  if (prop.card) emit({ type: 'card', card: prop.card });

  if (prop.status !== 'done') {
    say(emit, `I can't draft that payment: ${prop.summary}. Nothing has been sent.`);
    return;
  }

  const d = prop.data;
  const bdtAmount = currency === 'BDT' ? amount : amount * d.usdPerBdt;
  say(
    emit,
    `You asked to send ৳${fmtBDT(bdtAmount)} (about USD ${fmtUsd(d.amountUsd)}). ` +
      `Best route: ${d.provider}. You send BDT ${fmtBDT(d.sendBDT)}; they receive ` +
      `${d.currency} ${fmtMoney(d.net, d.currency)} (fee BDT ${fmtBDT(d.feeBDT)}, ETA ${d.etaDays} days). ` +
      `Routes from the routes dataset (snapshot ${d.dateCollected}). ` +
      `This is a draft; nothing has been sent. Approve the card to send.`,
  );
}

export async function runFallback(ctx: FallbackCtx): Promise<void> {
  const { emit } = ctx;
  const intent = detectIntent(ctx.message);
  if (intent === 'balance') {
    const b = await invokeTool(ctx.emit, ctx.userId, 'get_balance', {}, ctx.instructionSource);
    say(emit, `Your balance is ${b.summary}.`);
    return;
  }
  if (intent === 'fx') {
    const fx = await invokeTool(emit, ctx.userId, 'fx_window', { pair: 'MYR/BDT', days: 30 }, ctx.instructionSource);
    say(emit, `${fx.summary}. This is recent data, not a forecast.`);
    return;
  }
  if (intent === 'credit') {
    say(emit, 'The credit-plan builder is not available in this phase. Nothing has been sent.');
    return;
  }
  if (intent === 'unknown') {
    say(emit, 'I can check balances, compare routes, check compliance, look at recent FX, or draft a payment. Tell me what you need.');
    return;
  }
  await tuitionFlow(ctx);
}
