import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { runAgent } from '../agent/loop.js';
import { audit } from '../audit.js';
import { detectInjection } from '../agent/injection.js';
import { redactString, redactValue } from '../agent/redact.js';
import { getHistory, appendTurn } from '../agent/session.js';

const r = Router();

// The client only ever sends the raw user turn. Assistant/tool messages are
// rebuilt server-side from session memory, so the browser cannot inject them.
const ChatSchema = z
  .object({
    message: z.string().min(1).max(2000),
    pasted: z.boolean().optional(),
  })
  .strict();

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.sub || req.ip,
});

r.post('/', async (req: any, res) => {
  let body: z.infer<typeof ChatSchema>;
  try {
    body = ChatSchema.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'bad_request' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const verdict = detectInjection(body.message, !!body.pasted);
  await audit({
    event: 'agent_message',
    tier: 'T3',
    outcome: verdict.untrusted ? 'blocked' : 'pass',
    decision: verdict.untrusted ? 'blocked' : 'pass',
    ruleId: verdict.untrusted ? 'INJ_01' : 'AGENT_MSG',
    reason: verdict.untrusted ? verdict.reason : undefined,
    chars: body.message.length,
    excerpt: redactString(body.message).slice(0, 200),
  });

  const userId = req.user.sub;
  let assistantText = '';
  const capture = (event: any) => {
    if (event.type === 'text' && typeof event.delta === 'string') assistantText += event.delta;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(redactValue(event))}\n\n`);
  };

  try {
    await runAgent({
      userId,
      message: body.message,
      pasted: body.pasted,
      history: getHistory(userId),
      emit: capture,
    });
  } catch {
    capture({ type: 'error', message: 'internal error' });
  } finally {
    appendTurn(userId, body.message, assistantText);
    res.end();
  }
});

export default r;
