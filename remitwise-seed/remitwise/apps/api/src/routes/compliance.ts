import { Router } from 'express';
import { ComplianceCheckSchema } from '../validate.js';
import { checkCompliance } from '../services/compliance.js';
import { audit } from '../audit.js';

const r = Router();
r.post('/', async (req: any, res) => {
  try {
    const input = ComplianceCheckSchema.parse(req.body);
    const decision = await checkCompliance(req.user.sub, input);
    await audit({
      event: 'check_compliance',
      tier: 'T1',
      outcome: decision.decision,
      decision: decision.decision,
      userId: req.user.sub,
      inputs: input,
      ruleResults: decision.ruleResults,
      notEnforced: decision.notEnforced,
    });
    res.json(decision);
  } catch (e) {
    res.status(400).json({ error: 'bad request' });
  }
});
export default r;
