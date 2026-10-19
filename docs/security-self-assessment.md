# Security self-assessment (sandbox)

This is a hackathon sandbox. It simulates money movement; it is not a production
payment system. This note records the security-relevant gaps we know about so a
reviewer can see we are not claiming more than we built. Tests are described in
`docs/TEST_CASES.md`; agent design in `docs/agent-design.md`.

## Known-risk list

| # | Risk | Why it exists | Mitigation in the sandbox | Residual risk |
| --- | --- | --- | --- | --- |
| 1 | Default dev `SESSION_SECRET` | The stock `.env` ships `SESSION_SECRET=devsecret` so the demo runs with no setup. | `server.ts` refuses to start (exit 1) when `NODE_ENV=production` and the secret is still the default; in `development`/unset it logs a loud warning but boots so a judge's default `docker compose up` works. | Anyone who can reach the API with a default-secret build can forge session tokens. Do not expose beyond localhost; set a long random secret in production. |
| 2 | `ANOM_01` (amount above the user's usual pattern) is reported as **not enforced** ("not enforced in this sandbox") | The rule compares the amount with the user's *median completed-transfer* history. `compliance.ts` computes that median from the last up-to-50 `completed` transfers that carry `quoteSnapshot.amountUSD`; if there is no such history it cannot compare and returns `not_enforced` instead of guessing. The seed creates users and balances but **no transfer history**, so the first payment for every demo user has no baseline. | The rule is excluded from the applicable-check count rather than being shown as a pass, and the confirmation card labels it "not enforced in this sandbox". It becomes enforced once the same user has at least one completed transfer. | A first payment is not screened for anomalous size. A production build should seed or derive a baseline (e.g. KYC-declared expected amount, corridor statistics) so `ANOM_01` is always enforced. |
| 3 | All money movement is simulated | It is a competition sandbox; no real rails. | Clearly labelled in the UI ("Sandbox payment"), the answer text ("nothing has been sent") and the README. | None for the demo; this system must not be pointed at a real account. |
| 4 | Live LLM provider is optional | With `LLM_API_KEY` unset the agent uses a deterministic offline fallback; with a key it calls an OpenAI-compatible endpoint. | The provider factory never builds a live provider under `NODE_ENV=test`, and `AGENT_TEST_MODE=1` forces the scripted/offline path, so the automated suite makes no network calls. Keys are redacted from logs, tool results, errors and SSE. | Model output is untrusted: tool arguments are validated with zod, injection text is refused (`INJ_01`), and an output check drops ungrounded figures. |
| 5 | Chat memory is in-process | The last 8 messages per user are held in memory, not a shared store. | Restart clears sessions; documented in the README. | Not suitable for multi-instance deployments. |

## `ANOM_01` in detail

- **What it should do:** flag an amount that is far above what the user normally
  sends (spec rule `ANOM_01`, product policy multiplier `ANOMALY_MULTIPLIER`,
  default 3x).
- **What it needs:** `ctx.user.medianTransferUSD`, built in `buildContext()` from
  `transfers` where `status: 'completed'` and `quoteSnapshot.amountUSD` is a
  positive number (last 50, sorted, median).
- **Why it is `not_enforced` here:** the demo seed inserts users, accounts,
  student files and documents but no completed transfers, so the median is
  `null` and the evaluator returns `not_enforced` rather than a false pass. It is
  reported with status `not_enforced`, excluded from the "N of M applicable
  checks" count, and labelled "not enforced in this sandbox" in the card's
  expanded list.
- **When it turns on:** after the same user completes at least one transfer, the
  median exists and the rule is enforced on subsequent payments.
- **Fix for production:** always have a baseline for `ANOM_01` (e.g. seed a
  representative history, use a KYC-declared expected amount, or fall back to a
  corridor/default threshold) so no first payment escapes anomaly screening.
