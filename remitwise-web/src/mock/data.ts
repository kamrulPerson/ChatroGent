import type { AuditEvent, ChatItem, Transfer, AlertRule } from '../types';

// SAMPLE DATA for the wireframe. Replace with GET /api/dashboard.
export const balances = [
  { currency: 'BDT', label: 'Family taka account', amount: 310000, symbol: '৳' },
  { currency: 'MYR', label: 'Student card (Kuala Lumpur)', amount: 4120.5, symbol: 'RM ' },
];

export const fxSeries: number[] = Array.from({ length: 30 }, (_, i) =>
  Number((28.9 + 0.35 * Math.sin(i / 4) + 0.012 * i - 0.1).toFixed(2)),
);

export const documents = [
  { name: 'Application form', done: true },
  { name: 'Admission letter', done: true },
  { name: "University's cost estimate", done: true },
  { name: 'Attested certificates', done: true },
  { name: 'Valid passport', done: true },
];

export const initialTransfers: Transfer[] = [
  { id: 't1', date: '2026-09-02', recipient: 'University of Malaya (sample)', amountBDT: 180000, status: 'Completed' },
];

export const initialAlerts: AlertRule[] = [];

export const initialAudit: AuditEvent[] = [
  { id: 'a0', time: '09:00:00', event: 'Session started', tier: 'SYS', outcome: 'ok' },
];

export const initialChat: ChatItem[] = [
  {
    kind: 'agent',
    id: 'welcome',
    text:
      "Hi, I'm RemitWise. I can compare routes for tuition payments, help you decide when to convert, and plan how to build credit abroad. I can read and propose. I never send money without your confirmation.",
  },
];
