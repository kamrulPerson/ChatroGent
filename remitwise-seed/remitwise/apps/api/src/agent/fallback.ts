import { invokeTool } from './exec.js';
import { redactString } from './redact.js';
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

function parseAmount(message: string): { amount: number; currency: 'BDT' | 'USD' } {
  const cleaned = message.replace(/,/g, '');
  const bdt = cleaned.match(/(?:৳|bdt|taka)\s*([\d.]+)/i) || cleaned.match(/([\d.]+)\s*(?:৳|bdt|taka)/i);
  if (bdt) return { amount: Number(bdt[1]), currency: 'BDT' };
  const usd = cleaned.match(/(?:usd|\$)\s*([\d.]+)/i) || cleaned.match(/([\d.]+)\s*(?:usd|\$)/i);
  if (usd) return { amount: Number(usd[1]), currency: 'USD' };
  const plain = cleaned.match(/\b(\d{3,})\b/);
  if (plain) return { amount: Number(plain[1]), currency: 'USD' };
  return { amount: 8000, currency: 'USD' };
}

function detectIntent(message: string): Intent {
  const m = message.toLowerCase();
  if (/\b(balance|how much|my account|wallet)\b/.test(m)) return 'balance';
  if (/\b(rate|fx|forecast|exchange|window)\b/.test(m)) return 'fx';
  if (/\b(credit plan|payment plan|installment|build.*plan)\b/.test(m)) return 'credit';
  if (/\b(tuition|university|college|fee|send|transfer|dad|mom|father|mother|pay)\b/.test(m)) return 'tuition';
  return 'unknown';
}

export { detectIntent, parseAmount };

async function tuitionFlow(ctx: FallbackCtx): Promise<void> {
  const { emit } = ctx;
  const { amount, currency } = parseAmount(ctx.message);
  const corridor = 'BD-MY';

  await invokeTool(emit, ctx.userId, 'get_balance', {}, ctx.instructionSource);

  const routes = await invokeTool(emit, ctx.userId, 'compare_routes', { corridor, amount, currency }, ctx.instructionSource);
  if (routes.card) emit({ type: 'card', card: routes.card });

  const compliance = await invokeTool(
    emit,
    ctx.userId,
    'check_compliance',
    { corridor, amount, currency, purpose: 'tuition', beneficiaryType: 'institution' },
    ctx.instructionSource,
  );
  if (compliance.status === 'blocked') {
    say(emit, `This transfer cannot proceed: ${compliance.summary}. Nothing has been sent.`);
    return;
  }

  const prop = await invokeTool(
    emit,
    ctx.userId,
    'propose_payment',
    { corridor, amount, currency, purpose: 'tuition', beneficiaryType: 'institution', coveragePeriodMonths: 6 },
    ctx.instructionSource,
  );
  if (prop.card) emit({ type: 'card', card: prop.card });

  if (prop.status !== 'done') {
    say(emit, `I can't draft that payment: ${prop.summary}. Nothing has been sent.`);
    return;
  }

  const d = prop.data;
  say(
    emit,
    `Best route: ${d.provider} via ${d.pair} at ${d.rate}. ` +
      `You send BDT ${d.sendBDT}; they receive ${d.currency} ${d.net} ` +
      `(fee BDT ${d.feeBDT}, ETA ${d.etaDays} days). ` +
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
