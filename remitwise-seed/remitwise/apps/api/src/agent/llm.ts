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

// --- Live OpenAI-compatible provider ----------------------------------------

const DEFAULT_MODEL = process.env.LLM_MODEL || '';

function toOpenAiMessages(messages: LlmMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content ?? '', tool_call_id: m.tool_call_id, name: m.name };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

function toOpenAiTools(tools: ToolSpec[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Minimal client for any OpenAI-compatible /chat/completions endpoint (Groq,
// Gemini's OpenAI compatibility layer, OpenRouter, ...). The key is read from
// the environment only and never logged.
export class OpenAICompatProvider implements LlmProvider {
  readonly name = 'openai-compat';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(messages: LlmMessage[], tools: ToolSpec[], opts: CompleteOpts): Promise<LlmTurn> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: toOpenAiMessages(messages),
          tools: toOpenAiTools(tools),
          tool_choice: 'auto',
          max_tokens: opts.maxTokens,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch (err: any) {
      const e: any = new Error(redactString('llm request failed'));
      e.code = err?.name === 'AbortError' ? 'timeout' : 'provider_error';
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const e: any = new Error(redactString(`llm http ${res.status}`));
      e.code = String(res.status);
      throw e;
    }

    const body: any = await res.json();
    const msg = body?.choices?.[0]?.message || {};
    const toolCalls: LlmToolCall[] = (msg.tool_calls || []).map((tc: any, i: number) => ({
      id: tc.id || `call_${i}`,
      name: tc.function?.name || tc.name || '',
      arguments: tc.function?.arguments ?? tc.arguments ?? '{}',
    }));
    return { content: msg.content ?? null, toolCalls };
  }
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
  // Never reach the network from the automated suite even if a key leaks in.
  if (process.env.AGENT_TEST_MODE === '1') return { provider: null, mode: 'offline' };

  const key = process.env.LLM_API_KEY;
  const base = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  const wouldBeLive = !!(key && base && model);

  // Belt and braces: under NODE_ENV=test (and without the explicit offline
  // switch) we refuse to build a live provider even if a key is present, so an
  // automated run can never accidentally hit the network.
  if (process.env.NODE_ENV === 'test' && wouldBeLive) {
    throw new Error('refusing to create a live LLM provider under test');
  }
  if (wouldBeLive) {
    return { provider: new OpenAICompatProvider(base, key, model), mode: 'llm' };
  }
  return { provider: null, mode: 'offline' };
}

// Startup log: key presence, base host and whether a model is selected. Never
// the key itself.
export function logProviderStartup(): void {
  const keyPresent = hasKey();
  console.log(`LLM key present: ${keyPresent ? 'yes' : 'no'}; base host: ${baseUrlHost()}`);
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  // Same condition resolveProvider() uses: a live provider is only built when
  // all three of key, base URL and model are set (and not under test mode).
  const testMode = process.env.AGENT_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
  if (keyPresent && process.env.LLM_BASE_URL && model && !testMode) {
    console.log(`LLM live provider enabled with model: ${model}`);
  } else {
    console.log('LLM live provider not configured; running in offline mode.');
  }
}
