# ChatroGent

A sandbox "fintech agent" for a Bangladeshi student heading to Kuala Lumpur:
it compares remittance routes, checks the rules, and prepares a simulated
payment — but never moves money without an explicit tap.

All money movement is **simulated**. Route data comes from a collected dataset,
and every row carries a source and a date (rows without a real source are shown
as **Sample data (illustrative)**).

See `docs/flows.md` (product flows), `docs/agent-design.md` (how the agent
works) and `docs/TEST_CASES.md` (what is tested).

## Stack

- **MongoDB** (seeded), **API** (`apps/api`, TypeScript/Express, SSE chat), web
  app (`remitwise-web`, Vite + React) — see `docker-compose.yml`.

## Quickstart

```bash
cp .env.example .env          # dev defaults; LLM_* optional
docker compose up -d --build  # mongo + seed + api
cd remitwise-web && npm install && npm run dev
```

The seed is idempotent (`4 users, 6 routes, 150 fx rates, 18 rules`). Demo logins
use password `demo1234`:

| Email | Scenario |
| --- | --- |
| `tier2@demo.remitwise` | happy path |
| `tier2expired@demo.remitwise` | expired passport (`DOC_01` fails) |
| `tier1@demo.remitwise` | low-value transfers only |
| `tier0@demo.remitwise` | unverified, blocked |

## LLM modes

- **Offline (default).** With no `LLM_API_KEY`, the agent uses a deterministic
  fallback that runs the same Flow 1 tool sequence. Good for demos and CI.
- **Live.** Set all three of `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` to use
  any OpenAI-compatible endpoint. Preset model: `openai/gpt-oss-20b` (a
  higher-quality alternative is `openai/gpt-oss-120b`). The startup log prints
  key presence and the base host, never the key.

## Conversation memory

Chat history is kept **server-side, in-process**: only the last 8 messages per
user, expiring after 30 minutes idle. The browser sends only
`{ message, pasted }` — it cannot inject assistant or tool messages. Because the
store is in-process, **restarting the API clears all sessions**; do this after a
database reset if a stale conversation lingers.

Sessions themselves are stateless bearer tokens, so a **database reset or
reseed** (`docker compose down -v`, or `npm run seed`) replaces the demo users and
existing sessions stop working. The web app clears the stored token on any HTTP
401 and returns you to the login screen, so you can simply sign in again.

## Tests

```bash
docker compose exec -T api npm run test:unit
docker compose exec -T api npm run test:agent
bash remitwise-seed/remitwise/apps/api/test/smoke.sh
cd remitwise-web && npm run build
```

See `docs/TEST_CASES.md` for what each suite covers. The automated suite never
calls the live provider: the `test:unit` and `test:agent` scripts set
`AGENT_TEST_MODE=1`, and the provider factory refuses to build a live provider
under `NODE_ENV=test` even if a key is present.

## Known limitations

- The stock `.env` ships `SESSION_SECRET=devsecret`. With `NODE_ENV=development`
  (the compose default) the API logs a clear startup warning but still boots, so a
  judge's `docker compose up` works; under `NODE_ENV=production` it refuses to
  start (exit 1) until you set a long random `SESSION_SECRET`. Either way the
  default secret is forgeable, so it is not safe to expose beyond localhost.
