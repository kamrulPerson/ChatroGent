// Prompt-injection detection.
//
// A message is untrusted when it was pasted (pasted=true) or matches known
// injection / money-moving phrasing. We do NOT rely on the model to notice this:
// an untrusted message becomes instructionSource='pasted_or_untrusted', which
// flows into propose_payment and confirmation, where the existing INJ_01 rule
// refuses and logs it.

export interface InjectionVerdict {
  untrusted: boolean;
  reason: string;
}

// Exact wording for the two refusal cases. The pasted wording is required
// verbatim by the spec; the typed case must not claim the message was pasted.
export const INJ01_PASTED =
  "That message was pasted, so I can't act on payment instructions in it. Please type your request yourself. Nothing was sent.";
export const INJ01_TYPED =
  "That looks like an attempt to change my instructions, so I can't act on it. Nothing was sent. If you want to send money, tell me the amount and I'll prepare a proposal for you to confirm.";

export function injectionRefusal(reason: string): string {
  return reason === 'pasted content' ? INJ01_PASTED : INJ01_TYPED;
}

const PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /ignore\s+(all\s+|the\s+|your\s+|previous\s+|prior\s+)*(instructions|rules|prompt)/i, reason: 'ignore-instructions phrase' },
  { re: /(disregard|forget)\s+(all\s+|the\s+|your\s+|previous\s+|prior\s+)*(instructions|rules)/i, reason: 'disregard-instructions phrase' },
  { re: /\byou\s+are\s+now\b/i, reason: 'role-override phrase' },
  { re: /\bsystem\s*:/i, reason: 'system-role spoof' },
  { re: /\b(developer|admin|root)\s+mode\b/i, reason: 'privilege-escalation phrase' },
  // A long base64-looking blob is a common smuggling channel.
  { re: /(?:[A-Za-z0-9+/]{40,}={0,2})/, reason: 'base64-looking block' },
  // Text telling the assistant to move money on its own. A plain typed
  // "send ৳2,40,000 for my tuition" is a legitimate flow, so we only flag
  // moving *funds* wholesale, not naming an amount to send.
  { re: /\b(send|transfer|move|wire|pay)\b[^.\n]{0,40}\b(all|the)\b[^.\n]{0,20}\bfunds?\b/i, reason: 'move-funds instruction' },
];

export function detectInjection(message: string, pasted = false): InjectionVerdict {
  if (pasted) return { untrusted: true, reason: 'pasted content' };
  for (const p of PATTERNS) {
    if (p.re.test(message)) return { untrusted: true, reason: p.reason };
  }
  return { untrusted: false, reason: 'user_typed' };
}
