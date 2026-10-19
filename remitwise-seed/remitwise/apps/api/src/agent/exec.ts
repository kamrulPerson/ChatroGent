// Shared tool invocation used by both the scripted/LLM loop and the offline
// fallback, so validation, event emission, redaction and audit logging cannot
// drift between the two paths.

import { runTool, validateToolArgs, TOOL_TIERS, type Tier, type ToolResult } from './tools.js';
import { audit } from '../audit.js';
import { redactValue, redactString } from './redact.js';
import { policy } from '../config.js';
import type { Emit } from './events.js';

let counter = 0;
export function makeCallId(): string {
  counter += 1;
  return `tc_${Date.now().toString(36)}_${counter}`;
}

export interface InvokeResult extends ToolResult {
  args: any;
}

export async function invokeTool(
  emit: Emit,
  userId: string,
  name: string,
  rawArgs: unknown,
  instructionSource: string,
  id: string = makeIdFor(name),
): Promise<ToolResult> {
  const tier = TOOL_TIERS[name] || 'T1';
  const v = validateToolArgs(name, rawArgs);
  if (!v.ok) {
    const safeError = redactString(v.error);
    // Distinguish bad arguments (a contract/zod failure the caller may safely
    // retry) from an unknown tool name (a model hallucination). Only the former
    // triggers the offline retry in loop.ts.
    const code = v.error.startsWith('unknown tool') ? 'unknown_tool' : 'invalid_arguments';
    emit({ type: 'tool_call', id, tool: name, tier, args: redactValue(rawArgs ?? {}) });
    emit({ type: 'tool_result', id, tool: name, status: 'error', summary: safeError, data: { error: safeError, code } });
    await audit({
      event: 'agent_tool_call',
      tier,
      toolName: name,
      outcome: 'blocked',
      decision: 'blocked',
      ruleId: 'AGENT_ARG_01',
      userId,
      inputs: redactValue(rawArgs ?? {}),
      rulesVersion: policy.rulesVersion,
    });
    return { status: 'error', summary: safeError, data: { error: safeError, code } };
  }

  emit({ type: 'tool_call', id, tool: name, tier, args: redactValue(v.value) });
  const result = await runTool(name, userId, v.value, { instructionSource });
  emit({
    type: 'tool_result',
    id,
    tool: name,
    status: result.status,
    // The trace shows the short label when the tool provides one; the full
    // explanation is only ever emitted once, in the answer text.
    summary: redactString(result.trace || result.summary),
    data: redactValue(result.data),
  });
  const outcome = result.status === 'done' ? 'pass' : result.status === 'blocked' ? 'blocked' : 'error';
  // A T3 gate returns a normal result shape but no money moved: record it as
  // "awaiting_confirmation" (a neutral label) rather than a pass or a hard block,
  // so the Activity log reads honestly without implying a refusal.
  const gated = name === 'execute_payment' && result.data?.status === 'awaiting_user_confirmation';
  await audit({
    event: 'agent_tool_call',
    tier,
    toolName: name,
    outcome: gated ? 'awaiting_confirmation' : outcome,
    decision: gated ? 'awaiting_confirmation' : outcome === 'pass' ? 'pass' : 'blocked',
    ruleId: gated ? 'AGENT_T3_GATE' : 'AGENT_TOOL',
    userId,
    inputs: redactValue(v.value),
    rulesVersion: policy.rulesVersion,
  });
  return result;
}

function makeIdFor(name: string): string {
  return `tc_${name}_${Math.random().toString(36).slice(2, 8)}`;
}
