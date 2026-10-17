// LLM provider interface.
//
// Phase 1 ships the provider-neutral interface plus a deterministic
// ScriptedProvider used by tests. The live OpenAI-compatible client and model
// selection are Phase 2 (see agent-layer-prompt.md section 1 / phase split).

import { redactString } from './redact.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmMessage {
  role: Role;
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface LlmTurn {
  content: string | null;
  toolCalls: LlmToolCall[];
}

export interface CompleteOpts {
  maxTokens: number;
  timeoutMs: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(messages: LlmMessage[], tools: ToolSpec[], opts: CompleteOpts): Promise<LlmTurn>;
}

// --- ScriptedProvider (deterministic, for tests) ----------------------------

export interface ScriptedCall {
  name: string;
  arguments?: any;
}
export interface ScriptedTurn {
  content?: string;
  toolCalls?: ScriptedCall[];
}

export interface ScriptedOptions {
  // Number of complete() calls before throwing (provider failure / 429 tests).
  throwAfterCalls?: number;
  // Error code to attach when throwing ('provider_error' | '429' | 'timeout').
  throwCode?: string;
  // Repeat the last scripted turn forever (loop-cap test).
  repeatLast?: boolean;
}

export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  private i = 0;

  constructor(private readonly turns: ScriptedTurn[], private readonly opts: ScriptedOptions = {}) {}

  async complete(): Promise<LlmTurn> {
    if (this.opts.throwAfterCalls !== undefined && this.i >= this.opts.throwAfterCalls) {
      const err: any = new Error(redactString('scripted provider failure'));
      err.code = this.opts.throwCode || 'provider_error';
      throw err;
    }
    let turn: ScriptedTurn | undefined = this.turns[this.i];
    if (!turn) {
      if (this.opts.repeatLast && this.turns.length) {
        turn = this.turns[this.turns.length - 1];
      } else {
        return { content: '', toolCalls: [] };
      }
    }
    this.i += 1;
    const toolCalls: LlmToolCall[] = (turn.toolCalls || []).map((tc, k) => ({
      id: `call_${this.i}_${k}`,
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
    }));
    return { content: turn.content ?? null, toolCalls };
  }
}

// --- Provider resolution -----------------------------------------------------

export type AgentMode = 'llm' | 'offline';

let testProvider: LlmProvider | null = null;

export function setTestProvider(p: LlmProvider | null): void {
  testProvider = p;
}

export function getTestProvider(): LlmProvider | null {
  // Test hook is only honoured outside production.
  return process.env.NODE_ENV !== 'production' && process.env.AGENT_TEST_MODE === '1' ? testProvider : null;
}

export function hasKey(): boolean {
  return !!process.env.LLM_API_KEY;
}

export function baseUrlHost(): string {
  const raw = process.env.LLM_BASE_URL || '';
  try {
    return raw ? new URL(raw).host : '(unset)';
  } catch {
    return '(invalid)';
  }
}

// Resolve the provider for a request. Returns provider=null when the request
// must run in offline mode (handled by fallback.ts).
export function resolveProvider(): { provider: LlmProvider | null; mode: 'llm' | 'offline' } {
  const test = getTestProvider();
  if (test) return { provider: test, mode: 'llm' };
  // Live provider is Phase 2. Until then a configured key still runs offline,
  // and we say so plainly rather than pretending.
  return { provider: null, mode: 'offline' };
}

// Startup log: key presence and base host only. Never the key itself.
export function logProviderStartup(): void {
  const has = hasKey() ? 'yes' : 'no';
  console.log(`LLM key present: ${has}; base host: ${baseUrlHost()}`);
  if (has) console.log('LLM live provider is not implemented until Phase 2; running in offline mode.');
}
