// Redaction layer.
//
// Applied before anything is written (logs, audit, errors) or sent (SSE
// payloads, API responses). Callers must never have to remember to redact:
// use redactString()/redactValue() at the boundary.

const MASK = '[REDACTED]';

// Secret-looking patterns. Order matters: the more specific prefixes first so a
// short pattern cannot partially mask a longer token.
const PATTERNS: RegExp[] = [
  /gsk_[A-Za-z0-9]+/g,
  /sk-or-[A-Za-z0-9-]+/g,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+\S+/gi,
  // JWT-looking triplets. Require long segments so amounts like "1.2.3" are
  // never treated as tokens.
  /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let liveKeyRe: RegExp | null = null;
let liveKeyLast: string | null = null;

function keyPattern(): RegExp | null {
  const key = process.env.LLM_API_KEY;
  if (!key || key.length < 6) return null;
  if (liveKeyRe && liveKeyLast === key) return liveKeyRe;
  liveKeyRe = new RegExp(escapeRegExp(key), 'g');
  liveKeyLast = key;
  return liveKeyRe;
}

export function redactString(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, MASK);
  const keyRe = keyPattern();
  if (keyRe) out = out.replace(keyRe, MASK);
  return out;
}

export function redactValue(value: any, seen = new WeakSet<object>()): any {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    // Never carry a key-holding field through, even if its value dodges the
    // string patterns.
    if (/^(api[_-]?key|apikey|authorization|password|passwordhash|token)$/i.test(k)) {
      out[k] = MASK;
    } else {
      out[k] = redactValue(v, seen);
    }
  }
  return out;
}

// Safe console helpers that redact every argument.
export function logSafe(...args: any[]): void {
  console.log(...args.map((a) => (typeof a === 'string' ? redactString(a) : redactValue(a))));
}
export function errorSafe(...args: any[]): void {
  console.error(...args.map((a) => (typeof a === 'string' ? redactString(a) : redactValue(a))));
}
