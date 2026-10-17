import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { getDb } from './db.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import routesRouter from './routes/routes.js';
import fxRouter from './routes/fx.js';
import alertsRouter from './routes/alerts.js';
import auditRouter from './routes/audit.js';
import complianceRouter from './routes/compliance.js';
import proposalsRouter from './routes/proposals.js';
import { verifyToken } from './auth.js';
import { audit } from './audit.js';
import { policy } from './config.js';

const app = express();
const PORT = Number(process.env.API_PORT) || 4000;

app.use(helmet());
// Explicit allow-list from env. Never '*'.
app.use(cors({ origin: policy.corsOrigins, credentials: false }));
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({ windowMs: 60_000, max: 100 });
app.use(limiter);
const authLimiter = rateLimit({ windowMs: 60_000, max: 10 });
app.use('/api/auth/login', authLimiter);
const confirmLimiter = rateLimit({ windowMs: 60_000, max: 30 });
app.use('/api/proposals/:id/confirm', confirmLimiter);

app.get('/api/health', async (_req, res) => {
  try {
    const db = await getDb();
    await db.admin().ping();
    return res.json({ ok: true, db: 'up' });
  } catch (e) {
    return res.status(503).json({ ok: false, db: 'down' });
  }
});

app.use('/api/auth', authRouter);

function authRequired(req: any, res: any, next: any) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'unauthorized' });
  const payload = verifyToken(m[1]);
  if (!payload) return res.status(401).json({ error: 'unauthorized' });
  req.user = payload;
  next();
}

app.use('/api/me', authRequired, meRouter);
app.use('/api/routes', authRequired, routesRouter);
app.use('/api/fx', authRequired, fxRouter);
app.use('/api/alerts', authRequired, alertsRouter);
app.use('/api/audit', authRequired, auditRouter);
app.use('/api/compliance', authRequired, complianceRouter);
app.use('/api/proposals', authRequired, proposalsRouter);

app.use((err: any, req: any, res: any, next: any) => {
  console.error(err);
  res.status(400).json({ error: 'bad request' });
});

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
