import { Router } from 'express';
import { getDb } from '../db.js';
import { LoginSchema, validate } from '../validate.js';
import { verifyPassword, signToken } from '../auth.js';
import { audit } from '../audit.js';

const r = Router();
r.post('/login', async (req, res) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const db = await getDb();
    const user = await db.collection('users').findOne({ email });
    if (!user || !verifyPassword(user.passwordHash, password)) {
      await audit({ event: 'login_failed', tier: 'SYS', outcome: 'bad_creds', userId: user?._id?.toString() });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = signToken({ sub: user._id.toString(), email: user.email, kycTier: user.kycTier });
    await audit({ event: 'login_success', tier: 'SYS', outcome: 'ok', userId: user._id.toString() });
    return res.json({ token });
  } catch (e) {
    return res.status(400).json({ error: 'bad request' });
  }
});
export default r;
