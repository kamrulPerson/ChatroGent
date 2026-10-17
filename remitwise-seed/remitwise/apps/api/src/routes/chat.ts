import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { runAgent } from '../agent/loop.js';
import { audit } from '../audit.js';
import { detectInjection } from '../agent/injection.js';
import { redactString, redactValue } from '../agent/redact.js';

const r = Router();

const ChatSchema = z
  .object({
    message: z.string().min(1).max(2000),
    pasted: z.boolean().optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }))
      .max(12)
      .optional(),
  })
  .strict();

// 20 chat turns per minute, per authenticated user.
const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.sub || req.ip,
});

r.post('/', chatLimiter, async (req: any, res: any) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad request' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (event: any) => {
    // Last line of defence: every SSE payload is redacted before it leaves.
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(redactValue(event))}\n\n`);
  };

  // Log the inbound turn (redacted, truncated). Untrusted turns are recorded as
  // blocked with the INJ_01 rule id.
  const verdict = detectInjection(parsed.data.message, !!parsed.data.pasted);
  await audit({
    event: 'agent_message',
    tier: 'T3',
    outcome: verdict.untrusted ? 'blocked' : 'pass',
    decision: verdict.untrusted ? 'blocked' : 'pass',
    ruleId: verdict.untrusted ? 'INJ_01' : 'AGENT_MSG',
    reason: verdict.untrusted ? verdict.reason : undefined,
    chars: parsed.data.message.length,
    excerpt: redactString(parsed.data.message).slice(0, 500),
  });

  try {
    await runAgent({
      userId: req.user.sub,
      message: parsed.data.message,
      pasted: parsed.data.pasted,
      history: parsed.data.history,
      emit,
    });
  } catch (e) {
    emit({ type: 'error', message: 'internal error' });
  } finally {
    res.end();
  }
});

export default r;
