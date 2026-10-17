// Shared tool invocation used by both the scripted/LLM loop and the offline
// fallback, so validation, event emission, redaction and audit logging cannot
// drift between the two paths.

import { runTool, validateToolArgs, TOOL_TIERS, type Tier, type ToolResult } from './tools.js';
import { audit } from '../audit.js';
import { redactValue, redactString } from './redact.js';
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
    emit({ type: 'tool_call', id, tool: name, tier, args: redactValue(rawArgs ?? {}) });
    emit({ type: 'tool_result', id, tool: name, status: 'error', summary: safeError, data: { error: safeError } });
    await audit({ event: 'agent_tool_call', tier, toolName: name, outcome: 'blocked', decision: 'blocked', ruleId: 'AGENT_ARG_01' });
    return { status: 'error', summary: safeError, data: { error: safeError } };
  }

  emit({ type: 'tool_call', id, tool: name, tier, args: redactValue(v.value) });
  const result = await runTool(name, userId, v.value, { instructionSource });
  emit({ type: 'tool_result', id, tool: name, status: result.status, summary: redactString(result.summary), data: redactValue(result.data) });
  const outcome = result.status === 'done' ? 'pass' : result.status === 'blocked' ? 'blocked' : 'error';
  await audit({
    event: 'agent_tool_call',
    tier,
    toolName: name,
    outcome,
    decision: outcome === 'pass' ? 'pass' : 'blocked',
    ruleId: 'AGENT_TOOL',
    inputs: redactValue(v.value),
    summary: result.summary,
  });
  return result;
}

function makeIdFor(name: string): string {
  return `tc_${name}_${Math.random().toString(36).slice(2, 8)}`;
}
