const lakh = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const two = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Destination currency symbols. Anything unknown falls back to the code so we
// never silently show the wrong symbol.
const SYMBOLS: Record<string, string> = {
  BDT: '৳',
  MYR: 'RM ',
  USD: '$',
  GBP: '£',
  CAD: 'CA$',
  AUD: 'A$',
};

export const symbolFor = (currency: string) => SYMBOLS[currency] ?? currency + ' ';

export const fmtBDT = (n: number) => symbolFor('BDT') + lakh.format(n);
export const fmtMoney = (n: number, currency = 'MYR') => symbolFor(currency) + two.format(n);
export const fmtMYR = (n: number) => fmtMoney(n, 'MYR');
// A rule is only a tick when it actually ran and passed. Rules that could not be
// evaluated are shown as "not enforced" and rules that do not apply to this
// scenario are shown as "not applicable" - never as a silent pass.
export function ruleStatusLabel(r: {
  status: 'enforced' | 'not_enforced' | 'not_applicable';
  passed: boolean;
}): { mark: string; label: string; tone: 'ok' | 'warn' | 'muted' | 'bad' } {
  if (r.status === 'not_enforced') return { mark: '!', label: 'not enforced in this sandbox', tone: 'warn' };
  if (r.status === 'not_applicable') return { mark: '-', label: 'not applicable', tone: 'muted' };
  return r.passed ? { mark: '✓', label: 'passed', tone: 'ok' } : { mark: '×', label: 'failed', tone: 'bad' };
}

export const uid = () => Math.random().toString(36).slice(2, 9);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const nowTime = () => new Date().toLocaleTimeString('en-GB');
