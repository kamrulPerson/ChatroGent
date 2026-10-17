// Agent orchestration.
//
// Buffer -> check -> stream. Nothing the model produces is emitted until the
// whole turn is complete and the output checks pass. The loop can run at most
// MAX_ITERATIONS tool rounds; when the provider fails or a budget cap trips we
// fall back to the deterministic offline flow rather than surfacing an error.

import type { LlmProvider } from './llm.js';
import { resolveProvider } from './llm.js';
import { toolSpecs } from './tools.js';
import { systemPrompt, wrapUntrusted } from './prompts.js';
import { detectInjection, type InjectionVerdict } from './injection.js';
import { invokeTool } from './exec.js';
import { runFallback } from './fallback.js';
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
  const { provider, mode } = resolveProvider();

  if (!provider) {
    emit({ type: 'meta', mode: 'offline' });
    await runFallback({ userId, message, instructionSource, emit });
    emit({ type: 'done', mode: 'offline' });
    return;
  }

  emit({ type: 'meta', mode: 'llm' });
  try {
    await runLlm(req, provider, instructionSource, verdict);
    emit({ type: 'done', mode: 'llm' });
  } catch (err) {
    // Provider failure / 429 / timeout / budget cap: degrade to offline, same
    // Flow 1 behaviour, never a raw error to the user.
    emit({ type: 'meta', mode: 'offline' });
    await runFallback({ userId, message, instructionSource, emit });
    emit({ type: 'done', mode: 'offline' });
  }
}

async function runLlm(req: AgentRequest, provider: LlmProvider, instructionSource: string, _verdict: InjectionVerdict): Promise<void> {
  const { userId, message, emit } = req;
  const history = (req.history || [])
    .slice(-8)
    .map((h) => ({ role: h.role, content: redactString(h.content) }));

  const messages = [
    { role: 'system', content: systemPrompt() },
    ...history,
    { role: 'user', content: wrapUntrusted('student message', redactString(message)) },
  ] as any[];

  const allowed: number[] = [];
  const summaries: string[] = [];
  let transferCompleted = false;
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
      if (result.card) emit({ type: 'card', card: result.card });
      collectNumbers(result.summary, allowed);
      collectNumbers(JSON.stringify(redactValue(result.data)), allowed);
      summaries.push(result.summary);
      if (result.data && result.data.status === 'completed') transferCompleted = true;
      messages.push({ role: 'tool', content: JSON.stringify(redactValue(result.data)), tool_call_id: call.id, name: call.name });
    }
  }

  if (final === null) final = 'I stopped after several steps without finishing. Nothing has been sent.';
  const safe = checkOutput(final, allowed, transferCompleted, summaries);
  streamText(emit, redactString(safe));
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
export function checkOutput(text: string, allowed: number[], transferCompleted: boolean, summaries: string[]): string {
  const fallbackSummary = summaries.length ? summaries.join(' ') : 'Here are the results from the tools. Nothing has been sent.';
  const negative = /(nothing|not|never|no)\s+(has been|have been|was|were|been)?\s*(sent|transferred|completed|executed|paid|disbursed)/i;
  const positive = /(has|have)\s+been\s+(sent|transferred|completed|executed|paid|disbursed)|successfully\s+(sent|transferred|completed|executed|paid|disbursed)|payment\s+(sent|completed)/i;
  if (positive.test(text) && !negative.test(text) && !transferCompleted) {
    return `Nothing has been sent. ${fallbackSummary}`;
  }
  const numbers = (text.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/,/g, '')));
  for (const n of numbers) {
    if (Number.isFinite(n) && !isAllowedNumber(n, allowed)) {
      return fallbackSummary;
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
