# Agent layer design

The agent turns a student's message into a safe, explainable, simulated money
action. It is deliberately boring where it matters: the model only ever *asks
for tools*, all numbers come from the database, an untrusted message can never
trigger a payment, and money only moves after the user taps **Confirm**.

## Request lifecycle

```
POST /api/chat { message, pasted }
        │
        ▼
  detectInjection(message, pasted)  ──► instructionSource
        │                               (user_typed | pasted_or_untrusted)
        ▼
  resolveProvider()
    ├─ no key/model           → offline (deterministic fallback.ts)
    └─ key + base + model     → live OpenAI-compatible provider
        │
        ▼
  runLlm: buffer → check → stream
    • history from server-side session (never from the client)
    • up to MAX_ITERATIONS (6) tool rounds
    • tools are buffered; text is emitted first, then cards
        │
        ▼
  checkOutput()  ──►  SSE: meta, tool_call, tool_result, card, text, done
```

Any provider failure (HTTP error, timeout, 429, loop cap) degrades to the same
offline flow — the user sees a normal answer, never a raw stack trace.

## Providers (`agent/llm.ts`)

- `LlmProvider` is the only seam. Two implementations ship:
  - **`OpenAICompatProvider`** — POSTs to `${LLM_BASE_URL}/chat/completions`
    with a bearer token, maps `tools`/`tool_calls`, and enforces a per-call
    timeout. Works with any OpenAI-compatible endpoint (Groq, and others).
  - **`ScriptedProvider`** — deterministic turns for tests. It cannot be
    selected in production (`getTestProvider` requires `NODE_ENV!=production`
    and `AGENT_TEST_MODE=1`), and `resolveProvider` returns offline whenever
    `AGENT_TEST_MODE=1`, so the test suite never reaches the network.
- Live mode needs all three of `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`.
- `logProviderStartup()` prints key presence and the base host only — never the
  key. Preset model: `openai/gpt-oss-20b` (see `.env.example`).

## Tools and tiers (`agent/tools.ts`, `agent/exec.ts`)

| Tool | Tier | Notes |
| --- | --- | --- |
| `get_balance` | T1 read | balances and profile status |
| `compare_routes` | T1 read | ranked routes with fee, FX margin, ETA |
| `check_compliance` | T1 read | 18-rule evaluation |
| `fx_window` | T1 read | best/worst/current rate window |
| `build_credit_plan` | T2 propose | milestone plan, no application |
| `set_alert` | T2 propose | pending alert rule, never auto-activates |
| `propose_payment` | T2 propose | builds a signed proposal |
| `execute_payment` | T3 execute | gated by the user's confirmation |

Every argument schema is `.strict()`: unknown keys and `$`-prefixed keys are
rejected. `execute_payment` never moves money on its own — it only validates a
proposal + approval hash. There is no user-supplied `userId`; identity comes
from the session.

**Beneficiary type is derived, not supplied.** Neither `check_compliance` nor
`propose_payment` accepts a `beneficiaryType` from the model. The server derives
it from the purpose (and the student file): tuition, fees and insurance →
`institution`; living and incidental → `student_card`. A model that tries to
supply one is rejected by the strict schema and the request is retried offline
(see below), so a wrong guess can never block a valid tuition payment.

## Failure handling: which failures retry offline

Only a tool call that fails **argument validation (zod)** — before any
side-effecting tool has run — aborts the model path and retries once through the
deterministic offline flow (`loop.ts` throws, `runAgent` degrades to
`fallback.ts`). A **compliance rule block is never retried**: it stops the loop,
emits no routes or proposal card (a block is not an offer), and its final text is
written by the same plain-language mapper the offline flow uses (below). Provider
errors, timeouts and 429s also degrade to the offline flow.

## Plain-language mapper (`agent/explain.ts`)

Every compliance block — live or offline — is rendered by `explainBlock()`: a
cause in one sentence and a next step in one sentence, with no rule IDs and no
"N of 18 checks" wording. The same module's `safeFallback()` is used when the
model's own text fails the output check, so the replacement is never a
concatenation of raw tool summaries. The fee-ceiling case (rule `MIN_AMT`) is
described from the rule's own figures — the fee, its share of the amount and the
smallest amount that clears the cap on that route — and is never called
"below minimum", because that branch did not fire.

## Route consistency & provenance (A1, A12)

`services/routes.ts` ranks routes by final amount received for a corridor and
amount, and classifies data as illustrative: a row is *real* only when
`sourceUrl` is a non-`example.*` host. `propose_payment` always uses the same
`rankRoutes` winner the chatbot described, and cards carry a
`Sample data (illustrative)` label when applicable, so the numbers on screen
match the numbers in the proposal.

## Safety: injection & untrusted input (A7, A13)

`agent/injection.ts` classifies a message as untrusted when it is pasted or when
it contains instruction-like text (e.g. "ignore the rules"). Untrusted input:

- is wrapped as data, not instructions (`wrapUntrusted`);
- forces `instructionSource='pasted_or_untrusted'` and trips rule `INJ_01`;
- is refused deterministically — the loop overrides the model's final text with
  `injectionRefusal(reason)` even if the model tried to comply.

The refusal text is plain and contains no rule IDs.

## Session memory (A9)

`agent/session.ts` keeps the last 8 messages per user in-process, with a 30-min
idle TTL. The client sends **only** `{ message, pasted }`; it can never seed
assistant or tool messages. Stored text is redacted. Memory is in-process, so
restarting the API clears it (see README).

## Output checks (`loop.ts`)

Nothing is streamed until the turn finishes:

1. **No false completion** — a claim that money was "sent/completed" is
   replaced unless an `execute_payment` actually completed this turn.
2. **Numbers must be grounded** — every number in the answer must appear in a
   tool result from this turn; otherwise the answer falls back to the tool
   summaries.

## Redaction (`agent/redact.ts`)

Keys and secrets are scrubbed from user messages, tool results, SSE payloads,
logs, and audit entries. This is why keys can never leak into the transcript.

## Compliance engine

`services/compliance.ts` evaluates the 18 rules in
`data/compliance_rules.json` against a context built from the DB (balances,
documents, route fees, FX). Failures return a plain-language message, the rule
id (for the audit/log, not the chat text), and an alternative where one exists.
Sandbox thresholds live in `config.ts` and are documented in `.env.example`.
