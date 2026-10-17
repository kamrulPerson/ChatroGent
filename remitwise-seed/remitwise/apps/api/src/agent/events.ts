// SSE event contract for POST /api/chat. These shapes feed ToolTrace and the
// existing web cards; the web types are reused where possible.

import type { Tier } from './tools.js';

export type AgentMode = 'llm' | 'offline';

export interface MetaEvent { type: 'meta'; mode: AgentMode }
export interface ToolCallEvent { type: 'tool_call'; id: string; tool: string; tier: Tier; args: any }
export interface ToolResultEvent {
  type: 'tool_result';
  id: string;
  tool: string;
  status: 'done' | 'blocked' | 'error';
  summary: string;
  data: any;
}
export interface CardEvent { type: 'card'; card: any }
export interface TextEvent { type: 'text'; delta: string }
export interface DoneEvent { type: 'done'; mode: AgentMode }
export interface ErrorEvent { type: 'error'; message: string }

export type AgentEvent =
  | MetaEvent
  | ToolCallEvent
  | ToolResultEvent
  | CardEvent
  | TextEvent
  | DoneEvent
  | ErrorEvent;

export type Emit = (event: AgentEvent) => void;
