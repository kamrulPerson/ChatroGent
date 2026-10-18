// Number formatting for agent-visible text and tool summaries.
//
// BDT uses Indian-style grouping (2,40,000) because that is how our users read
// taka; destination currencies use plain thousands separators with two decimals.

const inIN = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inIN2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const us = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtBDT(n: number): string {
  return inIN.format(n);
}

export function fmtBDT2(n: number): string {
  return inIN2.format(n);
}

export function fmtUsd(n: number): string {
  return us.format(n);
}

export function fmtMoney(n: number, currency: string): string {
  return currency === 'BDT' ? inIN2.format(n) : us.format(n);
}

// "BDT 2,40,000" / "MYR 33,249.09"
export function fmtAmount(n: number, currency: string): string {
  return `${currency} ${fmtMoney(n, currency)}`;
}
