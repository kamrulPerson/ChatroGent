# RemitWise (ChatroGent)

RemitWise is a sandbox banking agent for a Bangladeshi student in Kuala Lumpur: it
compares remittance routes, checks the compliance rules that apply to a payment,
and prepares a simulated tuition transfer. Every step is agent-driven but every
consequence is explicit — money moves only when you tap **Confirm**, and the tool
that would move it (`execute_payment`) is a T3 gate that debits nothing by itself.
All money movement is simulated and all market data is sample data.

Demo video, rules and evidence live alongside this repo
(`docs/flows.md`, `docs/agent-design.md`, `docs/TEST_CASES.md`,
`docs/security-self-assessment.md`, `docs/evidence/`).

## Features

- **Tuition remittance (Flow 1)** — plan a BD→MY tuition payment: routes, fee
  breakdown, documents, and a confirmation card you must approve.
- **FX timing and alerts (Flow 2)** — rate history and a target rate for a
  corridor. **Alerts only store and display a target. Nothing monitors rates and
  nothing sends a notification** — there is no scheduler or sender anywhere in the
  API, and the web "Turn on alert" switch changes only that page's state.
- **Credit-building plan (Flow 3)** — a suggested transfer schedule that keeps the
  student's profile building history abroad (advice only, no obligation).
- **Compliance rules** — 18 rules evaluated server-side on every proposal and
  re-checked at confirm time; the card shows exactly which rules ran, which are
  not applicable here, and which are not enforced in this sandbox.
- **Permission tiers T1/T2/T3** — T1 reads (`get_balance`, `compare_routes`,
  `check_compliance`, `fx_window`), T2 prepares (`build_credit_plan`,
  `propose_payment`, `set_alert`), T3 executes (`execute_payment`, gated).
- **Audit log** — one append-only row per tool call with user, inputs, rule version
  and outcome. Append-only is enforced by a **database role grant** (find+insert
  only), not by application code — proof in `docs/evidence/audit-log-append-only.md`.

## Quick start

```bash
cp .env.example .env
docker compose up --build -d
cd remitwise-web && npm install && npm run dev
```

Then open **http://localhost:5173**.

Health check:

```bash
curl http://localhost:4000/api/health
# {"ok":true,"db":"up"}
```

The seed is idempotent and inserts `4 users, 6 routes, 150 fx rates, 18 rules`.

## Demo users — demo only, sandbox

Password for all four: **`demo1234`** (set by `DEMO_PASSWORD` in `.env.example`).
These accounts are for this sandbox demo only; the credentials are public.

| Email | Scenario |
| --- | --- |
| `tier2@demo.remitwise` | happy path |
| `tier2expired@demo.remitwise` | expired passport (`DOC_01` fails) |
| `tier1@demo.remitwise` | low-value transfers only |
| `tier0@demo.remitwise` | unverified, blocked |

## LLM modes

- **Offline (default).** An **empty `LLM_API_KEY` means offline mode** — the agent
  runs a deterministic fallback that performs the same tool sequence. Good for
  demos, CI and a judge's first run. `.env.example` ships with the key empty, so
  `cp .env.example .env` gives you offline mode.
- **Live.** Set all three of `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` to use any
  OpenAI-compatible endpoint. Provider presets (all are OpenAI-compatible
  `/chat/completions` APIs — base URLs not contacted from this sandbox, treat as
  unverified here):
  - **Groq** — `https://api.groq.com/openai/v1` (the value shipped in
    `.env.example`), model `openai/gpt-oss-20b`.
  - **Gemini** (OpenAI compatibility layer) — `https://generativelanguage.googleapis.com/v1beta/openai/`
    with any `gemini-*` chat model.
  - **OpenRouter** — `https://openrouter.ai/api/v1` with any `openrouter/*` model.
- The startup log prints **key presence and the base host only, never the key**
  (`agent/llm.ts` function `logProviderStartup`).

## Tests

Run from the repo root. Every command below was executed in this session and its
output is reported as-is.

```bash
docker compose exec -T api npx tsc --noEmit          # exit 0
docker compose exec -T api npm run test:unit         # tests 6, pass 6, fail 0
docker compose exec -T api npm run test:agent        # tests 25, pass 25, fail 0
bash remitwise-seed/remitwise/apps/api/test/smoke.sh # PASS=34 FAIL=0
cd remitwise-web && npm run build                    # ✓ built in 922ms
```

`docs/TEST_CASES.md` says what each suite covers. No suite calls a live
provider: the scripts set `AGENT_TEST_MODE=1`, and `resolveProvider` refuses to
build a live provider under `NODE_ENV=test` even if a key is present.

## Repo layout

| Path | What it is |
| --- | --- |
| `docker-compose.yml` | three services: `mongo`, `seed` (idempotent import of `data/`), `api` |
| `.env.example` | all configuration keys; copy to `.env` |
| `remitwise-seed/remitwise/apps/api/` | TypeScript/Express API, SSE chat, compliance engine, agent layer, tests |
| `remitwise-seed/remitwise/data/` | `compliance_rules.json`, `routes.csv`, `fx_history.csv` (sample data) |
| `remitwise-seed/remitwise/infra/mongo-init/` | DB roles, validators and indexes (including the append-only `audit_log` grant) |
| `remitwise-web/` | Vite + React frontend (login, chat, dashboard, audit) |
| `docs/` | flows, agent design, test cases, security self-assessment, evidence |
| `scripts/export-evidence.sh` | collects a timestamped evidence bundle into `evidence/` |

## Security design (6 bullets)

- **Identity comes from the server.** The verified bearer token sets
  `req.user`; no tool schema accepts a `userId` (`tools.ts`
  function `validateToolArgs` rejects the key outright), so the model cannot act
  as another user.
- **Validation before side effects.** Every tool call is checked by Zod
  `.strict()` schemas, and any key starting with `$` (Mongo operator injection) is
  rejected first (`tools.ts` functions `hasIllegalKey` / `validateToolArgs`).
- **Allowlisted tools, tiered by blast radius.** Only the eight tools in
  `tools.ts` constant `ALLOWLIST` can run, each mapped to T1/T2/T3 in `TOOL_TIERS`;
  `execute_payment` is a T3 gate that debits nothing.
- **Single-use approval.** Money moves only in `POST /api/proposals/:id/confirm`
  after the user's approval hash matches the server-computed SHA-256 and the
  proposal makes a one-shot `pending → confirmed` transition. A second confirm of
  the same proposal is refused (HTTP 400 `not_pending`); the 409
  `already_confirmed` path only fires if two confirms race.
- **Prompt-injection and output controls.** `INJ_01` blocks pasted instructions,
  history is rebuilt server-side (last 8 messages per user), untrusted/false
  model text is replaced, and everything logged is passed through the redaction
  layer (`agent/redact.ts`) so keys never reach logs, audit rows or SSE events.
- **Abuse limits and append-only audit.** Rate limits on login/chat/confirm
  (11th rapid login → `429`), `NODE_ENV=production` refuses to boot with the
  default `SESSION_SECRET`, and `audit_log` is append-only by DB role —
  update and delete attempts as the API's own DB user both fail with Mongo
  error `13` (see `docs/evidence/audit-log-append-only.md`).

## Data disclaimer

Money movement, routes, FX rates, fees, KYC tiers and documents are **sample /
illustrative sandbox data** (BD-MY example: fee 2500 BDT, spread 1.5%, USD/BDT
122.85, MYR/BDT 29.10). Rows without a real source are labelled **Sample data
(illustrative)** in the UI, and the agent's text says so too. Nothing here is
live market data, live KYC or a real payment.

## Known limitations

- The stock `.env` ships `SESSION_SECRET=devsecret`. In development (the compose
  default) the API logs a clear startup warning and boots, so a judge's
  `docker compose up` works; under `NODE_ENV=production` it refuses to start
  (exit 1) until you set a long random `SESSION_SECRET`. Either way the default
  secret is forgeable, so this build must not be exposed beyond localhost.
- **Alerts do not notify.** They are stored and displayed only; nothing watches
  rates and no notification is ever sent (see Features).
- `ANOM_01` is `not_enforced` on a clean seed (no transfer history to compare
  against) and turns `enforced` after the user's first completed transfer — the
  real per-rule list is in `docs/security-self-assessment.md`.
- No live KYC provider, no pen test, no delegated/guardian approval — only the
  account holder can confirm.
- The LLM free tier may log prompts, so send sandbox data only.

## Sessions and how they reset

Chat history is server-side and in-process: the last 8 messages per user, 30
minutes idle, and **restarting the API clears all sessions** (`agent/session.ts`).
The browser sends only `{ message, pasted }`, never assistant or tool messages.

Sessions are stateless bearer tokens, so a **database reset or reseed**
(`docker compose down -v`, or `npm run seed`) replaces the demo users and old
tokens stop working. The web app clears the stored token on any HTTP 401 and
returns you to the login screen — sign in again with `demo1234`.
