import { test } from 'node:test';
import { computeQuote } from '../src/services/convert.js';

// Seeded rates: USD/BDT 122.85, MYR/BDT 29.10.

// 8000 USD through taka into ringgit. Gross must be 8000 * 122.85 / 29.1.
test('gross converts amountUSD through USD/BDT into the destination currency', () => {
  const q = computeQuote(8000, 122.85, 29.1, 3500, 1.2, 'MYR', 'MYR/BDT');
  const expectedGross = 8000 * 122.85 / 29.1;
  if (Math.abs(q.gross - 33773.2) > 0.5) throw new Error(`gross ${q.gross} != 33773.20`);
  if (Math.abs(q.gross - expectedGross) > 1e-6) throw new Error('gross formula mismatch');
  if (!(q.net < q.gross && q.net > 0)) throw new Error(`net ${q.net} should be positive and below gross ${q.gross}`);
  if (!q.quotable) throw new Error('expected quotable');
});

test('net = (gross - fee/pairRate) minus spread', () => {
  const gross = (8000 * 122.85) / 29.1;
  const expected = (gross - 3500 / 29.1) * (1 - 1.2 / 100);
  const q = computeQuote(8000, 122.85, 29.1, 3500, 1.2, 'MYR', 'MYR/BDT');
  if (Math.abs(q.net - expected) > 0.01) throw new Error(`net ${q.net} != ${expected}`);
});

test('sendBDT is amountUSD * usdPerBdt', () => {
  const q = computeQuote(8000, 122.85, 29.1, 3500, 1.2, 'MYR', 'MYR/BDT');
  if (Math.abs(q.sendBDT - 8000 * 122.85) > 0.01) throw new Error(`sendBDT ${q.sendBDT}`);
});

test('small transfers are not quotable (net <= 0)', () => {
  for (const amt of [5, 12]) {
    const q = computeQuote(amt, 122.85, 29.1, 2500, 1.5, 'MYR', 'MYR/BDT');
    if (q.quotable || q.net > 0) throw new Error(`amount ${amt} should not be quotable (net=${q.net})`);
  }
});

test('a larger transfer is quotable', () => {
  const q = computeQuote(800, 122.85, 29.1, 2500, 1.5, 'MYR', 'MYR/BDT');
  if (!q.quotable || q.net <= 0) throw new Error(`800 USD should be quotable (net=${q.net})`);
});

test('each corridor currency uses its own pair', async () => {
  const { CORRIDOR_META } = await import('../src/services/convert.js');
  const got: Record<string, string> = {
    'BD-MY': CORRIDOR_META['BD-MY'].pair,
    'BD-US': CORRIDOR_META['BD-US'].pair,
    'BD-UK': CORRIDOR_META['BD-UK'].pair,
    'BD-CA': CORRIDOR_META['BD-CA'].pair,
    'BD-AU': CORRIDOR_META['BD-AU'].pair,
  };
  const want: Record<string, string> = { 'BD-MY': 'MYR/BDT', 'BD-US': 'USD/BDT', 'BD-UK': 'GBP/BDT', 'BD-CA': 'CAD/BDT', 'BD-AU': 'AUD/BDT' };
  for (const k of Object.keys(want)) {
    if (got[k] !== want[k]) throw new Error(`${k} pair ${got[k]} != ${want[k]}`);
  }
});
