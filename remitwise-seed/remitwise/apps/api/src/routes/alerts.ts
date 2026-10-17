import { Router } from 'express';
import { getDb } from '../db.js';
import { AlertSchema, validate } from '../validate.js';
import { audit } from '../audit.js';
import { ObjectId } from 'mongodb';

const r = Router();
r.get('/', async (req: any, res) => {
  const db = await getDb();
  const a = await db.collection('alerts').find({ userId: new ObjectId(req.user.sub) }).toArray();
  res.json(a);
});
r.post('/', async (req: any, res) => {
  try {
    const body = AlertSchema.parse(req.body);
    const db = await getDb();
    const doc = { ...body, userId: new ObjectId(req.user.sub), status: 'proposed', createdAt: new Date() };
    await db.collection('alerts').insertOne(doc);
    await audit({ event: 'alert_created', tier: 'T2', outcome: 'ok', userId: req.user.sub, inputs: body });
    res.json(doc);
  } catch (e) {
    res.status(400).json({ error: 'bad request' });
  }
});
export default r;
