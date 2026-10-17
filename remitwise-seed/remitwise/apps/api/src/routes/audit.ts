import { Router } from 'express';
import { getDb } from '../db.js';
import { ObjectId } from 'mongodb';

const r = Router();
r.get('/', async (req: any, res) => {
  const db = await getDb();
  const a = await db.collection('audit_log').find({ userId: req.user.sub }).sort({ ts: -1 }).limit(100).toArray();
  res.json(a);
});
export default r;
