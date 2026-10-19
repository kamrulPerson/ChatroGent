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

## Agent integration (`test/agent.ts`, 28 tests)

| Test | Asserts |
| --- | --- |
| **a** Flow 1 end to end | one transfer created; the receipt and stored transfer carry the card's `amountBDT`; the balance is debited by that figure exactly once; a second confirm never moves money again |
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
| **t** non-round debit | ৳73,500 and ৳1,23,456 each debit exactly the card `amountBDT`, once, and the receipt and stored transfer agree (regression guard for the balance bug); runs last so its confirmed transfers do not trip the 24h velocity rule for other tests |
| **u** audit rows | a Flow 1 run writes one `agent_tool_call` row per tool call, each with the user id, redacted inputs and the rules version; the gated `execute_payment` is recorded as `awaiting_confirmation` (a neutral label, not a block) |
| **v** output-check reason | a figure written with Indian grouping is kept; a figure no tool returned is replaced and the reason is logged as an `output_check` row |
| **w** fee-ceiling boundary | ৳71,429 reaches the confirmation card, ৳71,428 is refused with the same plain message, which reads "just over the 5% limit" — never "5.0% above the 5% limit" |
| **x** check-count scope | the trace and the card count only enforced rules; `not_applicable` and `not_enforced` are excluded and the denominator never exceeds 18 (the full rule set) |
| **y** offline credit routing | the `credit` keyword reaches `build_credit_plan`; the offline path uses the BD-MY corridor; a non-BD-MY corridor with a total returns the "isn't in the supported list yet" notice |
| **z** startup-log honesty | with a key, base URL and model set, `logProviderStartup` under test mode prints "running in offline mode" and never claims a live provider is enabled |
| **aa** redaction of `Date` | the same `Date` instance used twice serializes to ISO (not `[Circular]`) and a secret nested inside an object/array is still masked |

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
