// Agent orchestration.
//
// Buffer -> check -> stream. Nothing the model produces is emitted until the
// whole turn is complete and the output checks pass. The loop can run at most
// MAX_ITERATIONS tool rounds; when the provider fails or a budget cap trips we
// fall back to the deterministic offline flow rather than surfacing an error.

import type { LlmProvider } from './llm.js';
import { resolveProvider } from './llm.js';
import { toolSpecs, TOOL_TIERS } from './tools.js';
import { systemPrompt, wrapUntrusted } from './prompts.js';
import { detectInjection, injectionRefusal, type InjectionVerdict } from './injection.js';
import { invokeTool } from './exec.js';
import { runFallback } from './fallback.js';
import { explainBlock, safeFallback, type RuleFailure } from './explain.js';
import { redactString, redactValue } from './redact.js';
import type { Emit } from './events.js';

const MAX_ITERATIONS = 6;
const MAX_TOKENS = 700;
const TIMEOUT_MS = 20_000;

export interface AgentRequest {
  userId: string;
  message: string;
  pasted?: boolean;
  history?: { role: 'user' | 'assistant'; content: string }[];
  emit: Emit;
}

export async function runAgent(req: AgentRequest): Promise<void> {
  const { userId, message, emit } = req;
  const verdict = detectInjection(message, !!req.pasted);
  const instructionSource = verdict.untrusted ? 'pasted_or_untrusted' : 'user_typed';
  const { provider } = resolveProvider();

  const fallback = () =>
    runFallback({
      userId,
      message,
      instructionSource,
      history: req.history,
      untrustedReason: verdict.untrusted ? verdict.reason : undefined,
      emit,
    });

  if (!provider) {
    emit({ type: 'meta', mode: 'offline' });
    await fallback();
    emit({ type: 'done', mode: 'offline' });
    return;
  }

  emit({ type: 'meta', mode: 'llm' });
  try {
    await runLlm(req, provider, instructionSource, verdict);
    emit({ type: 'done', mode: 'llm' });
  } catch (err) {
    // Provider failure / 429 / timeout / budget cap, or a tool call rejected by
    // argument validation before any side effect: degrade to the deterministic
    // offline flow (same Flow 1 behaviour) rather than surfacing an error.
    emit({ type: 'meta', mode: 'offline' });
    await fallback();
    emit({ type: 'done', mode: 'offline' });
  }
}

// The user's typed message is the instruction channel: it is sent as-is (only
// redacted). Only pasted/untrusted input is fenced as data, so the model never
// treats a normal request as an instruction it must refuse.
function wrapUserMessage(message: string, instructionSource: string): string {
  const clean = redactString(message);
  return instructionSource === 'pasted_or_untrusted' ? wrapUntrusted('student message', clean) : clean;
}

async function runLlm(req: AgentRequest, provider: LlmProvider, instructionSource: string, verdict: InjectionVerdict): Promise<void> {
  const { userId, message, emit } = req;
  const history = (req.history || [])
    .slice(-8)
    .map((h) => ({ role: h.role, content: redactString(h.content) }));

  const messages = [
    { role: 'system', content: systemPrompt() },
    ...history,
    { role: 'user', content: wrapUserMessage(message, instructionSource) },
  ] as any[];

  const allowed: number[] = [];
  const cards: any[] = [];
  let transferCompleted = false;
  let injBlocked = false;
  let sideEffectDone = false;
  let blockFailures: RuleFailure[] | null = null;
  let final: string | null = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const turn = await provider.complete(messages, toolSpecs, { maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS });
    if (!turn.toolCalls.length) {
      final = turn.content || '';
      break;
    }
    messages.push({ role: 'assistant', content: turn.content ?? null, tool_calls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const result = await invokeTool(emit, userId, call.name, call.arguments, instructionSource, call.id);
      // A tool call that fails ONLY because of zod argument validation (e.g. the
      // model invented a field) is retried once via the deterministic offline
      // path so Flow 1 can still reach the card. A compliance block is NOT a
      // validation failure and is never retried. We never retry once this turn
      // has already performed a side effect, to avoid duplicating it.
      if (result.data?.code === 'invalid_arguments' && !sideEffectDone) {
        const e: any = new Error('argument validation failed; retrying offline');
        e.code = 'arg_validation';
        throw e;
      }
      // Buffer cards until after the text so the order is always
      // message -> route card -> confirmation card.
      if (result.card) cards.push(result.card);
      if (Array.isArray(result.data?.failedRules) && result.data.failedRules.includes('INJ_01')) injBlocked = true;
      collectNumbers(result.summary, allowed);
      collectNumbers(JSON.stringify(redactValue(result.data)), allowed);
      if (result.data && result.data.status === 'completed') transferCompleted = true;
      const tier = TOOL_TIERS[call.name];
      if (result.status === 'done' && (tier === 'T2' || tier === 'T3')) sideEffectDone = true;
      // A compliance block (check_compliance or propose_payment) stops the loop:
      // we do not ask the model for more steps and we do not offer a route.
      if (result.status === 'blocked' && Array.isArray(result.data?.failures) && result.data.failures.length) {
        blockFailures = result.data.failures as RuleFailure[];
      }
      messages.push({ role: 'tool', content: JSON.stringify(redactValue(result.data)), tool_call_id: call.id, name: call.name });
    }
    if (blockFailures) break;
  }

  // Injection is refused deterministically regardless of what the model said.
  // A compliance block is written by the same plain-language mapper the offline
  // flow uses; either way the model's own text is discarded.
  if (verdict.untrusted || injBlocked) final = injectionRefusal(verdict.reason);
  else if (blockFailures) final = explainBlock(blockFailures);
  if (final === null) final = 'I stopped after several steps without finishing. Nothing has been sent.';
  // Requirement 5: never offer a route card when the payment is blocked.
  if (blockFailures) cards.length = 0;
  const fallbackText = blockFailures ? explainBlock(blockFailures) : safeFallback();
  const safe = checkOutput(final, allowed, transferCompleted, fallbackText);
  streamText(emit, redactString(stripRuleIds(safe)));
  for (const card of cards) emit({ type: 'card', card: redactValue(card) });
}

// The chat text must never show internal rule identifiers (A4). Strip any that a
// model slips in, along with the now-empty parentheses around them.
function stripRuleIds(text: string): string {
  return text
    .replace(/\s*\(\s*(?:[A-Z]{2,6}_\d{1,3})\s*\)/g, '')
    .replace(/\b[A-Z]{2,6}_\d{1,3}\b/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// --- output checks ----------------------------------------------------------

function collectNumbers(input: string, out: number[]): void {
  const matches = input.match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
  for (const m of matches) {
    const n = Number(m.replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
}

function isAllowedNumber(n: number, allowed: number[]): boolean {
  return allowed.some((a) => Math.abs(a - n) < 0.01);
}

// Buffered output check. Two invariants:
//  (a) never claim a payment moved money unless this turn actually completed a
//      transfer (execute_payment is a T3 gate, so it never will);
//  (b) every number shown must have come from a tool result this turn.
// When the model's text fails either check we replace it with `fallbackText`,
// which is produced by the plain-language mapper (never a concatenation of raw
// tool summaries).
export function checkOutput(text: string, allowed: number[], transferCompleted: boolean, fallbackText: string): string {
  const negative = /(nothing|not|never|no)\s+(has been|have been|was|were|been)?\s*(sent|transferred|completed|executed|paid|disbursed)/i;
  const positive = /(has|have)\s+been\s+(sent|transferred|completed|executed|paid|disbursed)|successfully\s+(sent|transferred|completed|executed|paid|disbursed)|payment\s+(sent|completed)/i;
  if (positive.test(text) && !negative.test(text) && !transferCompleted) {
    return fallbackText;
  }
  const numbers = (text.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/,/g, '')));
  for (const n of numbers) {
    if (Number.isFinite(n) && !isAllowedNumber(n, allowed)) {
      return fallbackText;
    }
  }
  return text;
}

function streamText(emit: Emit, text: string): void {
  const size = 80;
  if (text.length <= size) {
    emit({ type: 'text', delta: text });
    return;
  }
  for (let i = 0; i < text.length; i += size) {
    emit({ type: 'text', delta: text.slice(i, i + size) });
  }
}
