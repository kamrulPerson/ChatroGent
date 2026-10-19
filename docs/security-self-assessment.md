# Security self-assessment (sandbox)

This is a hackathon sandbox. It simulates money movement; it is not a production
payment system. This note records the security-relevant gaps we know about so a
reviewer can see we are not claiming more than we built. Tests are described in
`docs/TEST_CASES.md`; agent design in `docs/agent-design.md`.

Citations below give a **file path plus the function or constant name**, never a
line number (line numbers go stale).

## 1. Permission tiers (T1/T2/T3)

Tier enforcement lives in `remitwise-seed/remitwise/apps/api/src/agent/tools.ts`
in the constants `TOOL_TIERS` and `ALLOWLIST`. `remitwise-seed/remitwise/apps/api/src/agent/exec.ts`
function `invokeTool` reads `TOOL_TIERS[name]` for every call and writes that tier
into the audit row.

| Tier | What it can do | Tools | Where it is enforced |
| --- | --- | --- | --- |
| T1 | Read-only queries; creates nothing | `get_balance`, `compare_routes`, `check_compliance`, `fx_window` | `tools.ts` constants `TOOL_TIERS`, `ALLOWLIST`; `exec.ts` function `invokeTool` (tier lookup + audit). |
| T2 | Propose/prepare; creates records but never moves money | `build_credit_plan`, `propose_payment`, `set_alert` | `tools.ts` constant `TOOL_TIERS`; `propose_payment` → `tools.ts` function `proposePayment` → `src/services/proposals.ts` function `createProposal` (writes a `pending` proposal only); `set_alert` → `tools.ts` function `setAlert` (inserts `status: 'pending'`, `active: false`); `build_credit_plan` → `tools.ts` function `buildCreditPlan` (compute-only). |
| T3 | Execute — **gate only** | `execute_payment` | `tools.ts` constant `TOOL_TIERS` maps it to `T3`; `tools.ts` function `executePayment` returns `"Awaiting your confirmation"` with `data.status = 'awaiting_user_confirmation'` and performs **no** debit. Money actually moves only in `src/routes/proposals.ts` route `POST /:id/confirm`, after the user approves with the approval hash. |

The agent's T3 tool is a gate, not an executor. The transfer happens in the
server-side confirm flow using the authenticated user's token and the single-use
approval hash.

## 2. Controls table

| Control | What it prevents | Where in code | Which test covers it |
| --- | --- | --- | --- |
| Server-side user identity from the verified token | Cross-user access; client-supplied user IDs | `src/server.ts` function `authRequired` verifies the bearer token and sets `req.user`. `src/agent/tools.ts` function `validateToolArgs` rejects any `userId` key with the message "userId is not accepted; it comes from the session". No tool schema in `tools.ts` constant `toolSpecs` exposes `userId`. `src/routes/proposals.ts` route `POST /:id/confirm` scopes every query with `uid(req)` / `req.user.sub`. | `test/agent.ts` `before()` creates a fresh user through `POST /api/auth/login` and every agent test runs against it; tests (a) and (u) assert audit rows carry `userId`. |
| Zod validation + `"$"` key rejection | Model-invented fields; Mongo operator injection through tool arguments | `src/agent/tools.ts` function `hasIllegalKey` (rejects any key starting with `$`, depth-capped), function `validateToolArgs` (rejects non-object/array/non-JSON, rejects `userId`, then `schema.safeParse` on `.strict()` schemas). HTTP bodies use `src/validate.ts`. | `test/agent.ts` test (c) asserts unknown tool, `userId` and `$` key are all rejected; test (o) shows a zod rejection triggers the offline retry. |
| Tool allowlist | Arbitrary/unauthorised function calls | `src/agent/tools.ts` constant `ALLOWLIST` and function `isKnownTool`; `validateToolArgs` returns `unknown tool: <name>` for anything outside it. | `test/agent.ts` test (c) rejects `delete_everything`; tests (p) and (s) show only allowed tools run and a compliance block stops the loop. |
| T3 gate + single-use approval hash | Automatic execution; replayed confirmation | Gate: `src/agent/tools.ts` function `executePayment`. Hash: `src/services/proposals.ts` functions `payloadHashOf` / `canonical` (SHA-256 over sorted keys of the normalised input plus `userId`). Confirm: `src/routes/proposals.ts` route `POST /:id/confirm` — compares `payloadHash` to the supplied hash, re-runs compliance, then does the single-use `pending → confirmed` transition with `updateOne({ _id, status: 'pending' })`. A second confirm is refused by the `p.status !== 'pending'` guard (HTTP 400 `not_pending`); the `claimed.modifiedCount === 0` → 409 `already_confirmed` path only fires if two confirms race. | `test/agent.ts` test (a) — second confirm is rejected and the balance does not move twice; test (b) — the gate leaves balance and transfer count unchanged; tests (l) and (n) assert the 64-hex hash format. **Verified by running:** the second confirm in `docs/evidence/t3-gate.md` returned HTTP 400 `{"error":"not_pending","status":"executed"}`. |
| `INJ_01` (prompt injection) | Acting on pasted or untrusted instructions | Detection: `src/agent/injection.ts` function `detectInjection` (pasted flag + `PATTERNS` regex list), functions `injectionRefusal` / `INJ01_PASTED` / `INJ01_TYPED` for the exact wording. Enforcement: `src/services/compliance.ts` function `evaluateRule`, case `INJ_01` returns `blocked` unless `instructionSource === 'user_typed'`; also re-checked at confirm time in `src/routes/proposals.ts`. Loop override: `src/agent/loop.ts` replaces the model's text with the refusal when `verdict.untrusted` or `injBlocked`. | `test/agent.ts` test (d) — pasted refusal logged to `audit_log`, nothing executed; test (A13) — typed vs pasted wording; test (e) — injection text inside a tool result is not obeyed. |
| Server-side conversation history (last 8) | Browser-seeded assistant/tool context | `src/agent/session.ts` constants `MAX_MESSAGES` (8) and `TTL_MS` (30 min), functions `getHistory` / `appendTurn`; `src/routes/chat.ts` schema `ChatSchema` is `.strict()` and accepts only `{ message, pasted }`, and rebuilds history via `getHistory(userId)` — the client can never supply assistant or tool messages. | `test/agent.ts` test (A10) exercises follow-ups through `history`. |
| Output checks (false "sent" claim, unverified figures) | Model fabricating completion or inventing numbers | `src/agent/loop.ts` functions `outputVerdict`, `checkOutput`, `collectNumbers`, `isAllowedNumber`, `stripRuleIds`; on failure it substitutes `safeFallback` / `explainBlock` and audits an `output_check` event with the reason. | `test/agent.ts` test (i) blocks a false "payment sent" claim and an unreturned figure; test (v) keeps a grouped Indian-format tool figure, replaces an unreturned one and asserts the logged reason; tests (e) and (A13) assert false claims are removed. |
| Redaction layer | Leaking keys/tokens into logs, audit, events or responses | `src/agent/redact.ts` constant `PATTERNS` and functions `redactString`, `redactValue`, `logSafe`, `errorSafe` (also masks fields named `apikey` / `authorization` / `password` / `passwordhash` / `token`, and the live `LLM_API_KEY` value). Applied in `src/agent/exec.ts` (`invokeTool`), `src/agent/loop.ts` (`runLlm`, `streamText`), `src/agent/llm.ts` (provider errors), `src/routes/chat.ts`. | `test/agent.ts` test (j) asserts the fake key never appears in an error, a nested tool result, streamed SSE events, or `audit_log`. |
| Audit log is append-only at the DB role level | Tampering with or hiding audit entries | `src/audit.ts` function `audit` only `insertOne`s. The privilege is a database grant, not application code: `remitwise-seed/remitwise/infra/mongo-init/01-init.js` creates role `remitwise_app_role` with `actions: ['find', 'insert']` on `audit_log` (no `update`, no `remove`) and a validator requiring `tier` in `T1/T2/T3/SYS`. **Proved by running:** two attempts as the API's own DB user (its `MONGO_URL` from the container environment, never printed) both failed with `MongoServerError` code `13`, count unchanged at 37, zero tampered docs. Evidence: `docs/evidence/audit-log-append-only.md`. | `test/smoke.sh` includes `PASS audit_log append-only (update denied)`; `test/agent.ts` test (u) asserts one audit row per tool call with `userId`, `inputs`, `rulesVersion`. |
| Rate limiting | Login brute force and endpoint abuse | `src/server.ts` — `limiter` (100/min global), `authLimiter` (10/min on `POST /api/auth/login`), `confirmLimiter` (30/min on `POST /api/proposals/:id/confirm`); `src/routes/chat.ts` `chatLimiter` (20/min per user). | **Verified by running:** 11 rapid `POST /api/auth/login` calls returned `400 400 400 400 400 400 400 400 400 400 429` with body "Too many requests, please try again later." |
| Fail-fast guard for the default dev secret | Shipping to production with `SESSION_SECRET=devsecret` | `src/server.ts` — if `NODE_ENV === 'production'` and `usingDefaultSecret`, logs `Refusing to start: NODE_ENV=production requires a non-default SESSION_SECRET.` and `process.exit(1)`; in development/unset it logs a warning and boots so a judge's default `docker compose up` works. | **Verified by running:** `docker compose run --rm -e NODE_ENV=production api npm start` printed the refusal and exited `1`. |

## 3. Known-risk list

| Risk | Severity | What could happen | Current mitigation | Status |
| --- | --- | --- | --- | --- |
| Sample data only (routes, FX, fees, estimates) | Medium | A reviewer could mistake sandbox figures for live market data | UI and agent text label rows `Sample data (illustrative)` and show a snapshot date — `src/agent/tools.ts` function `routeDataLabel`, `src/agent/fallback.ts`, `ConfirmCard.tsx`; README states rates, routes and fees are sample/illustrative | Accepted for sandbox |
| Demo credentials and the default dev secret in the sandbox build | High | Anyone who can reach the API with a default-secret build can forge a session; the demo logins are public | `src/server.ts` refuses to start under `NODE_ENV=production` with the default secret (verified by running); warns loudly in development (verified by running). Demo accounts are labelled "demo only, sandbox" in the README | Partially mitigated — acceptable for a localhost judge/demo only |
| Rules reported as `not_enforced` / `not_applicable` in a real confirmation payload | Medium | A reviewer could assume every rule runs on every payment | Statuses come from `src/services/compliance.ts` function `evaluateRule` (`skip()` → `not_enforced`, `na()` → `not_applicable`); `src/agent/explain.ts` function `checkCount` excludes both from the denominator; `ConfirmCard.tsx` + `src/format.ts` function `ruleStatusLabel` show all rules with the label "not enforced in this sandbox" | Accepted for sandbox — exact list below |
| In-memory session history resets on restart | Low | Chat context is lost on API restart; no shared store for multi-instance runs | `src/agent/session.ts` keeps a process-local `Map`; README documents that restarting the API clears sessions | Accepted for sandbox |
| No delegated approval — only the account holder can confirm | Medium | Guardian/third-party approval flows cannot be modelled | Proposals and transfers are keyed to the authenticated user's ObjectId; `payloadHashOf` folds `userId` into the hash and every confirm query filters by `uid(req)`. `approverName` on the card comes from the authenticated user record (`src/agent/tools.ts` function `proposePayment`) | Mitigated by design (account holder only) |
| No real KYC provider — tiers and documents are seeded | Medium | Real KYC/AML is never exercised | `src/services/compliance.ts` cases `KYC_01` and `DOC_01` read the seeded `kycTier` and document statuses through `buildContext`; nothing calls an external identity provider | Accepted for sandbox |
| The LLM free tier may log prompts, so only sandbox data is sent | Medium | Prompt content could be retained by a third-party provider | `src/agent/llm.ts` function `resolveProvider` never builds a live provider under `NODE_ENV=test`, and `AGENT_TEST_MODE=1` forces offline; messages and tool results are redacted before send; keys are never logged; startup logs key presence only (`logProviderStartup`) | Partially mitigated — redaction plus offline default; follow the README guidance and send sandbox data only |
| Small-model reliability | Low | Hallucinated tool arguments or invented text | Zod + `"$"` rejection with a single offline retry **before** any side effect (`src/agent/loop.ts`, only when `result.data.code === 'invalid_arguments'` and `!sideEffectDone`); injection detection; output checks replace untrusted text; `MAX_ITERATIONS` caps the loop; deterministic `ScriptedProvider` and an offline fallback exist | Partially mitigated |
| No penetration test performed | Medium | Unknown edge cases remain | Explicitly not performed. The controls above reduce the attack surface (auth, validation, allowlist, redaction, rate limits, append-only audit) | Accepted for sandbox |
| Alerts are stored and displayed — nothing monitors rates and nothing is sent | Low | A reviewer could assume alerts fire automatically and notify them | **Verified by reading the code:** there is no scheduler, no cron, no polling loop and no notification sender anywhere in `src/` (searched `setInterval`, `cron`, `schedule`, `notify`, `notification` — no matches in the API). `set_alert` inserts `status: 'pending'`, `active: false`; `src/routes/alerts.ts` implements only `GET /` and `POST /` (no activate/update/delete endpoint). The web "Turn on alert" button (`ChatPage.tsx` function `activateAlert`) only changes local React state and the dashboard draws a target line on the chart (`FxChart`) | Accepted for sandbox — alerts **only store and display a target; they do not notify** |

### Rules in a real confirmation payload (exact statuses)

Source: a real `propose_payment` run (tool `runTool('propose_payment', …)` with
`corridor: 'BD-MY'`, `amount: 1000 USD`, `purpose: 'tuition'`,
`coveragePeriodMonths: 12`, `isFirstRelease: true`) against a freshly created
user with **zero** completed transfers — i.e. what a judge sees on a clean
`docker compose up` before the first payment. Total rules returned on the card: **18**.

- **`enforced` (15):** `INJ_01`, `KYC_01`, `PURPOSE_01`, `PURPOSE_02`, `DOC_01`,
  `AMT_01`, `AMT_02`, `MIN_AMT`, `BEN_01`, `BANK_01`, `FOLLOW_01`, `VEL_01`,
  `PAYER_01`, `AUDIT_01`, `CANCEL_01`
- **`not_applicable` (2):** `BEN_02` (only applies to `living`/`incidental`
  purposes), `ADV_01` (only applies to `advance_fee`)
- **`not_enforced` (1):** `ANOM_01` (no completed-transfer history to compare
  against)

After the same user completes one transfer, `ANOM_01` becomes `enforced` and the
payload becomes **16 enforced / 0 not_enforced / 2 not_applicable** (checked by
running `propose_payment` for `tier2@demo.remitwise`, which currently has 2
completed transfers). `test/smoke.sh` asserts exactly this transition
(`PASS ANOM_01/VEL_01 enforced once history exists`).

### `ANOM_01` in detail

- **What it should do:** flag an amount far above what the user normally sends
  (spec rule `ANOM_01`, product policy multiplier `anomalyMultiplier`, default 3x).
- **What it needs:** `ctx.user.medianTransferUSD`, built by
  `src/services/compliance.ts` function `buildContext` from the last 50
  `completed` transfers whose `quoteSnapshot.amountUSD` is a positive number
  (sorted, median).
- **Why it is `not_enforced` here:** the demo seed inserts users, accounts,
  student files and documents but **no** completed transfers, so the median is
  `null` and `evaluateRule` case `ANOM_01` returns `skip('no transfer history to compare')`
  rather than a false pass. It is excluded from the "N of M applicable checks"
  count (`src/agent/explain.ts` function `checkCount`) and labelled "not enforced
  in this sandbox" in the card's expanded list (`ConfirmCard.tsx`,
  `src/format.ts` function `ruleStatusLabel`).
- **When it turns on:** after the same user completes at least one transfer.
- **Fix for production:** always provide a baseline (seeded representative
  history, a KYC-declared expected amount, or a corridor/default threshold) so no
  first payment escapes anomaly screening.

## 4. Tests mapped to controls

Full case list: `docs/TEST_CASES.md`. The agent suite is
`remitwise-seed/remitwise/apps/api/test/agent.ts` (28 tests, verified by running).

| Control | Test case(s) | What it verifies |
| --- | --- | --- |
| Server-side user identity | (a), (u), (t) | Fresh per-run user via login; confirm uses the bearer token; audit rows carry `userId`; the debit is bound to that user |
| Zod + `"$"` rejection | (c), (o) | `validateToolArgs` rejects unknown tool, `userId`, `$` key; a zod-only failure retries once offline before any side effect |
| Tool allowlist | (c), (p), (s) | Unknown tool rejected; only allowed tools run; a compliance block stops the loop |
| T3 gate + single-use approval hash | (a), (b), (l), (n) | The gate moves no money; a second confirm is refused; hash is 64 hex chars; debit == card == receipt == transfer |
| `INJ_01` | (d), (A13), (e) | Pasted refusal logged and nothing executed; exact typed/pasted wording; injection inside a tool result is not obeyed |
| Server-side history | (A10) | Follow-ups work from the stored last-8 window |
| Output checks | (i), (v) | False "sent" claim replaced; unreturned figure replaced with the reason logged; grouped tool figures kept |
| Redaction | (j), (aa) | No fake key in errors, nested results, SSE events or `audit_log`; a repeated `Date` value serializes to ISO instead of `[Circular]` |
| Audit log (append-only role) | (u), (d), (v) plus `smoke.sh` | One row per tool call with `userId`/`inputs`/`rulesVersion`; `smoke.sh` reports `PASS audit_log append-only (update denied)` |
| Rate limiting | **not covered by the automated suites** | Verified by running 11 rapid login calls → 11th returned 429 |
| Fail-fast default secret | **not covered by the automated suites** | Verified by running `NODE_ENV=production` → exit 1 with the refusal message |

## Verification status of this document

**Verified by running a command or test in this session**

- `npx tsc --noEmit` → exit `0`
- `npm run test:unit` → `# tests 6`, `# pass 6`, `# fail 0`
- `npm run test:agent` → `# tests 28`, `# pass 28`, `# fail 0`
- `bash remitwise-seed/remitwise/apps/api/test/smoke.sh` → `PASS=34 FAIL=0`
  (including `PASS audit_log append-only (update denied)` and
  `PASS ANOM_01/VEL_01 enforced once history exists`)
- `cd remitwise-web && npm run build` → `✓ built in 977ms`
- Append-only audit proof: `updateOne` → `MongoServerError` code `13`,
  `deleteOne` → `MongoServerError` code `13`, count `37 → 37`, tampered docs `0`
  (saved as `docs/evidence/audit-log-append-only.md`)
- Real confirmation payload rule statuses: `15 enforced / 1 not_enforced (ANOM_01)
  / 2 not_applicable (BEN_02, ADV_01)`, total `18`; and `16/0/2` for
  `tier2@demo.remitwise` with 2 completed transfers
- Rule count in `compliance_rules` = `18` (`INJ_01,KYC_01,PURPOSE_01,PURPOSE_02,DOC_01,AMT_01,AMT_02,MIN_AMT,BEN_01,BEN_02,ADV_01,BANK_01,FOLLOW_01,AUDIT_01,CANCEL_01,VEL_01,ANOM_01,PAYER_01`)
- Production fail-fast: `NODE_ENV=production` → `Refusing to start: NODE_ENV=production requires a non-default SESSION_SECRET.`, exit `1`
- Rate limiting: 11 rapid logins → `400 ×10` then `429`
- Absence of any alert scheduler/notification: searched the API source for
  `setInterval`, `cron`, `schedule`, `notify`, `notification`, `poll` — no matches;
  `src/routes/alerts.ts` has only `GET /` and `POST /`

**Verified by reading the code only (not executed)**

- The T1/T2/T3 mapping and allowlist (`tools.ts` constants `TOOL_TIERS`, `ALLOWLIST`)
- The `$`-key and `userId` rejection logic (`tools.ts` functions `hasIllegalKey`, `validateToolArgs`) — behaviour is covered by test (c), but I did not re-run it in this session beyond the suite totals above
- The approval-hash construction (`proposals.ts` functions `payloadHashOf`, `canonical`)
- The injection pattern list (`injection.ts` constant `PATTERNS`)
- The redaction pattern list (`redact.ts` constant `PATTERNS`)
- The audit field set (`audit.ts` function `audit`) and the Mongo role grants (`infra/mongo-init/01-init.js`)
- The session window and TTL (`session.ts` constants `MAX_MESSAGES`, `TTL_MS`)
- The output-check regexes (`loop.ts` function `outputVerdict`)
- The rule evaluators other than the ones exercised above (`compliance.ts` function `evaluateRule`)
- The claim that alerts only store and display a target (no scheduler, no notification) — established by search and by reading `src/routes/alerts.ts` and `ChatPage.tsx` function `activateAlert`; no alert firing was ever executed because no such code path exists

## Additional notes

- **Real rule count: 18.** `src/services/compliance.ts` constant `EVAL_ORDER`
  lists 17 rules; the 18th, `ADV_01`, is appended from the `compliance_rules`
  collection by function `checkCompliance` (it appends DB rules not already in
  the known set) and is evaluated by case `ADV_01`. The DB holds 18 documents
  (verified by running). The earlier illustrative "23 of 24" was never real.
- **Real outcome names:** `src/services/compliance.ts` type
  `Outcome = 'pass' | 'needs_documents' | 'escalate_to_bank' | 'blocked'`.
- **Fee ceiling:** `MIN_AMT` returns structured `detail` (`feeBdt`, `feeUsd`,
  `spreadPct`, `totalPct` to 3 decimals, `maxFeePct`, `minWorkableUsd`,
  `minWorkableBdt`) from `evaluateRule` case `MIN_AMT`; `src/agent/explain.ts`
  functions `causeOf` / `nextStepOf` / `shortBlockLabel` produce the plain
  wording ("just over the 5% limit") and never call it "below minimum".
  Covered by tests (r) and (w).
- **Routes, fees and rates are SAMPLE data** (BD-MY: fee 2500 BDT, spread 1.5%,
  USD/BDT 122.85, MYR/BDT 29.10). They are labelled illustrative throughout the
  UI and the agent text.
- **No live LLM requests in tests:** `AGENT_TEST_MODE=1` plus `setTestProvider`
  with `ScriptedProvider`; `resolveProvider` refuses to build a live provider
  under `NODE_ENV=test`.
