import type { Route } from '../types';

// SAMPLE DATA. Replace with the collected dataset (routes.csv) via the API.
// Mid-market rate is a placeholder, not a live quote.
export const MID_RATE = 28.9; // BDT per MYR

const templates = [
  { id: 'wire', name: 'Bank wire (SWIFT)', feeBDT: 2500, spreadPct: 1.4, etaDays: 3, note: 'Works for any institution' },
  { id: 'portal', name: "Bank to university's named payment portal", feeBDT: 1200, spreadPct: 0.9, etaDays: 2, note: 'Only if your admission documents name this processor' },
  { id: 'card', name: 'Education card payment', feeBDT: 1800, spreadPct: 1.1, etaDays: 1, note: 'Only if the university accepts cards' },
];

export function buildRoutes(amountBDT: number): Route[] {
  return templates
    .map((t) => {
      const net = ((amountBDT - t.feeBDT) / MID_RATE) * (1 - t.spreadPct / 100);
      const totalCostPct = (t.feeBDT / amountBDT) * 100 + t.spreadPct;
      return { ...t, currency: 'MYR', net, quotable: net > 0, totalCostPct };
    })
    .sort((a, b) => a.totalCostPct - b.totalCostPct);
}
