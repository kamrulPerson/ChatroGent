# Test cases

Run everything from the repo root (compose must be up: `docker compose up -d`).

| Command | What it covers |
| --- | --- |
| `docker compose exec -T api npm run test:unit` | quote/math (`services/convert.ts`) |
| `docker compose exec -T api npm run test:agent` | agent integration (below) |
| `bash remitwise-seed/remitwise/apps/api/test/smoke.sh` | HTTP endpoints end to end |
| `cd remitwise-web && npm run build` | web typecheck + production build |

Tests run in `AGENT_TEST_MODE=1` (set by the `test:unit`/`test:agent` scripts).
In that mode `resolveProvider` never returns a live provider and
`ScriptedProvider` supplies deterministic turns, so no network calls are made. As
a second guard, the provider factory throws under `NODE_ENV=test` if it would
otherwise build a live provider (test **q**). The demo users/balances come from
the idempotent seed; each agent test uses its own throwaway user where it needs
to mutate state.

## Agent integration (`test/agent.ts`, 20 tests)

| Test | Asserts |
| --- | --- |
| **a** Flow 1 end to end | one transfer created, debited once, receipt returned |
| **b** T3 gate | `execute_payment` alone leaves balance and transfers unchanged |
| **c** tool validation | bad/unknown/`$`-prefixed arguments are rejected |
| **d** pasted injection | `INJ_01` failed, logged, nothing executed |
| **e** injection in a tool result | injected text in a tool result is not obeyed |
| **f** loop cap | a model that keeps calling tools stops after 6 rounds |
| **g** provider failure / 429 | degrades to offline Flow 1, no raw error |
| **h** `set_alert` | refuses a fallback that cannot beat the deadline |
| **i** output checks | blocks false completion claims and ungrounded numbers |
| **j** redaction | a fake key is redacted in errors, tool results, user messages, SSE and audit |
| **l** ৳2,40,000 prompt | parses, converts to USD, groups digits (Indian) |
| **m** no amount | offline fallback asks for an amount and runs no tools |
| **A10** offline follow-ups | a viable amount reaches the confirm card; a fee-ceiling refusal is plain (no rule id, not "below minimum"); a bare number asks "BDT or USD"; a bare number with no context falls back to help |
| **A13** injection wording | typed injection is refused safely; pasted uses the exact spec wording |
| **n** beneficiary derived | a model-supplied `beneficiaryType:"student"` is rejected; the retry reaches the confirm card with the institution (Universiti Malaya) as recipient and `BEN_01` passes |
| **o** zod failure retry | a tool call rejected by zod retries once through the offline path and Flow 1 still reaches the card |
| **p** compliance block | a block is **not** retried offline (no offline meta, no card); the final text is written by the plain-language mapper |
| **q** provider factory guard | under `NODE_ENV=test` it throws rather than build a live provider; the explicit offline switch returns no provider |
| **r** fee ceiling | the refusal names the fee, its share of the amount and a minimum workable amount; sending just above that minimum reaches the card |
| **s** block suppresses routes | a compliance block emits no routes or proposal card and stops the loop (the model is not asked again) |

## Unit (`test/unit.ts`, 6 tests)

Gross conversion through USD/BDT, `net = (gross − fee/pairRate) − spread`,
`sendBDT = amountUSD × usdPerBdt`, small transfers not quotable, larger
transfers quotable, and each corridor using its own currency pair.

## Smoke (`smoke.sh`, 34 checks)

Login/session, balance, routes compare, conversion, fx window, compliance
refusal paths (documents, daily cap, expired proposal), missing-rate refusal,
CORS allow-list, and audit-log append-only enforcement.

## Manual live check (not part of CI)

With `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` set, run Flow 1 once in the
UI and confirm the model returns tool calls. Keep live calls to a minimum
(free-tier budget); the automated suite never uses the live provider.
