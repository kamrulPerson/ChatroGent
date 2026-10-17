export type Tier = 'T1' | 'T2' | 'T3';

export interface ToolStep {
  id: string;
  tool: string;
  tier: Tier;
  summary: string;
  status: 'pending' | 'running' | 'done' | 'blocked';
}

export interface Route {
  id: string;
  name: string;
  feeBDT: number;
  spreadPct: number;
  etaDays: number;
  note: string;
  currency: string;
  net: number | null;
  quotable: boolean;
  reason?: string | null;
  totalCostPct: number;
  dataType?: string;
  dateCollected?: string;
}

export interface RuleView {
  ruleId: string;
  outcome: 'pass' | 'needs_documents' | 'escalate_to_bank' | 'blocked';
  status: 'enforced' | 'not_enforced' | 'not_applicable';
  passed: boolean;
  userMessage: string;
  reason: string;
}

export interface Proposal {
  id: string;
  amountBDT: number;
  recipient: string;
  route: Route;
  checks: string[];
  status: 'pending' | 'confirmed' | 'cancelled' | 'failed';
  approvalHash?: string;
  notEnforced?: string[];
  rules?: RuleView[];
}

export interface Receipt {
  ref: string;
  amountBDT: number;
  receive: number | null;
  currency: string;
  recipient: string;
  routeName: string;
  time: string;
}

export interface AlertRule {
  id: string;
  pair: string;
  target: number;
  fallbackDate: string;
  status: 'proposed' | 'active';
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string }
  | { kind: 'notice'; id: string; text: string }
  | { kind: 'trace'; id: string; steps: ToolStep[] }
  | { kind: 'routes'; id: string; routes: Route[]; bestId: string; source?: string; snapshot?: string }
  | { kind: 'proposal'; id: string; proposal: Proposal }
  | { kind: 'receipt'; id: string; receipt: Receipt }
  | { kind: 'alert'; id: string; alert: AlertRule };

export interface AuditEvent {
  id: string;
  time: string;
  event: string;
  tool?: string;
  tier: Tier | 'SYS';
  outcome: string;
}

export interface Transfer {
  id: string;
  date: string;
  recipient: string;
  amountBDT: number;
  status: 'Completed' | 'Pending';
}
