// Per-user conversation memory, kept server-side.
//
// The client sends only { message, pasted }; it never supplies assistant or tool
// messages, so the model's context cannot be seeded by the browser. We store only
// the redacted user text and the assistant's final text, cap the window, and
// expire it after a short idle period. Everything is in-process, so a restart
// clears it (documented in the README).

import { redactString } from './redact.js';

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_MESSAGES = 8;
const TTL_MS = 30 * 60 * 1000;

interface Session {
  messages: SessionMessage[];
  updatedAt: number;
}

const sessions = new Map<string, Session>();

function fresh(userId: string): Session | null {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > TTL_MS) {
    sessions.delete(userId);
    return null;
  }
  return s;
}

export function getHistory(userId: string): SessionMessage[] {
  const s = fresh(userId);
  return s ? s.messages.slice(-MAX_MESSAGES) : [];
}

export function appendTurn(userId: string, userText: string, assistantText: string): void {
  const s = fresh(userId) || { messages: [], updatedAt: 0 };
  if (userText) s.messages.push({ role: 'user', content: redactString(userText) });
  if (assistantText) s.messages.push({ role: 'assistant', content: redactString(assistantText) });
  s.messages = s.messages.slice(-MAX_MESSAGES);
  s.updatedAt = Date.now();
  sessions.set(userId, s);
}

export function clearSession(userId: string): void {
  sessions.delete(userId);
}

// Test hook.
export function _resetSessions(): void {
  sessions.clear();
}
