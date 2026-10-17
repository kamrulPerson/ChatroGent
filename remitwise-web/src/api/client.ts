// Real API boundary. Pages call these functions; when VITE_USE_MOCK=true the
// pages keep using the in-memory wireframe mocks instead (see `useMock`).

export const useMock = import.meta.env.VITE_USE_MOCK === 'true';

const TOKEN_KEY = 'rw_token';
let token = (typeof localStorage !== 'undefined' && localStorage.getItem(TOKEN_KEY)) || '';

export function setToken(t: string) {
  token = t;
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err: any = new Error(body?.error || 'request_failed');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export interface RuleResult {
  ruleId: string;
  outcome: 'pass' | 'needs_documents' | 'escalate_to_bank' | 'blocked';
  status: 'enforced' | 'not_enforced' | 'not_applicable';
  passed: boolean;
  userMessage: string;
  reason: string;
}

export interface Decision {
  decision: 'pass' | 'needs_documents' | 'escalate_to_bank' | 'blocked';
  ruleResults: RuleResult[];
  notEnforced: string[];
  rulesVersion: string;
  component: string;
}

export interface InstructionInput {
  corridor: string;
  amountUSD: number;
  purpose?: string;
  studyLevel?: string;
  coveragePeriodMonths?: number;
  isFirstRelease?: boolean;
  beneficiaryType?: string;
  namedInInstitutionDocs?: boolean;
  bankBranchId?: string;
  payerName?: string;
  instructionSource?: 'user_typed' | 'pasted_or_untrusted';
  note?: string;
  routeProvider?: string;
}

export interface Quote {
  provider: string;
  feeBDT: number;
  spreadPct: number;
  etaDays: number;
  dataType: string;
  dateCollected: string;
  currency: string;
  pair: string;
  rate: number;
  usdPerBdt: number;
  sendBDT: number;
  gross: number;
  net: number;
  netUsd: number;
}

export interface ProposeResponse {
  id: string;
  approvalHash: string;
  expiresAt: string;
  decision: 'pass';
  quote: Quote;
  ruleResults: RuleResult[];
  notEnforced: string[];
}

export interface DashboardData {
  kycTier: number;
  balances: { currency: string; amount: number }[];
  documents: { type: string; status: string; verified: boolean }[];
  alerts: { id: string; pair: string; target: number; fallbackDate: string; status: string }[];
  transfers: { id: string; date: string; amountUSD: number | null; amountBDT: number | null; status: string }[];
  fxSeries: { date: string; rate: number }[];
  rulesVersion: string;
}

export interface FxWindow {
  pair: string;
  days: number;
  dataPoints: number;
  best: { date: string; rate: number };
  worst: { date: string; rate: number };
  current: { date: string; rate: number };
  average: number;
  currentVsAverage: number;
  dataType: string;
}

// --- Agent chat (SSE) --------------------------------------------------------

export type ChatEvent =
  | { type: 'meta'; mode: 'llm' | 'offline' }
  | { type: 'tool_call'; id: string; tool: string; tier: string; args: any }
  | { type: 'tool_result'; id: string; tool: string; status: 'done' | 'blocked' | 'error'; summary: string; data: any }
  | { type: 'card'; card: any }
  | { type: 'text'; delta: string }
  | { type: 'done'; mode: 'llm' | 'offline' }
  | { type: 'error'; message: string };

// POST /api/chat and decode the SSE stream. Every frame is `event: <type>` plus
// a `data:` JSON line; we surface the parsed payload through onEvent as it
// arrives (tools stream their steps, the final text streams in deltas).
async function chatStream(
  message: string,
  pasted: boolean,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, pasted }),
    signal,
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(t || `chat failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()));
      } catch {
        // ignore malformed frame
      }
    }
  }
}

async function doLogin(email: string, password: string) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || 'login_failed');
  setToken(body.token);
  return body;
}

export function hasToken(): boolean {
  return !!token;
}

export function logout() {
  token = '';
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

// Optional sandbox convenience auto-login. It only runs when VITE_DEMO_AUTOLOGIN
// is exactly "true" and the email/password come from the gitignored local .env.
// There are no credentials in source.
export async function autoLogin(): Promise<boolean> {
  if (import.meta.env.VITE_DEMO_AUTOLOGIN !== 'true') return false;
  const email = import.meta.env.VITE_DEMO_EMAIL;
  const password = import.meta.env.VITE_DEMO_PASSWORD;
  if (!email || !password) return false;
  try {
    await doLogin(email, password);
    return true;
  } catch {
    return false;
  }
}

export const api = {
  useMock,
  login: doLogin,

  chat: chatStream,

  dashboard: async (): Promise<DashboardData> => request('/api/me/dashboard'),

  fxWindow: async (pair = 'MYR/BDT', days = 30): Promise<FxWindow> =>
    request(`/api/fx/window?pair=${encodeURIComponent(pair)}&days=${days}`),

  compareRoutes: async (corridor: string, amountUSD: number): Promise<any[]> =>
    request(`/api/routes/compare?corridor=${encodeURIComponent(corridor)}&amountUSD=${amountUSD}`),

  checkCompliance: async (input: InstructionInput): Promise<Decision> =>
    request('/api/compliance', { method: 'POST', body: JSON.stringify(input) }),

  propose: async (input: InstructionInput): Promise<ProposeResponse> =>
    request('/api/proposals', { method: 'POST', body: JSON.stringify(input) }),

  confirmProposal: async (
    id: string,
    approvalHash: string,
    instructionSource: 'user_typed' | 'pasted_or_untrusted' = 'user_typed',
  ): Promise<{ receiptId: string; status: string; amountBDT: number }> =>
    request(`/api/proposals/${id}/confirm`, { method: 'POST', body: JSON.stringify({ approvalHash, instructionSource }) }),

  cancelProposal: async (id: string): Promise<{ ok: boolean; status: string }> =>
    request(`/api/proposals/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),

  getProposal: async (id: string): Promise<any> => request(`/api/proposals/${id}`),

  audit: async (): Promise<any[]> => request('/api/audit'),
};
