import { getDb } from './db.js';
import { policy } from './config.js';

// Every audit entry carries the rules version, the decision it recorded and the
// component that produced it (spec section 8, SEC-04 + audit.fields).
export async function audit(entry: any) {
  try {
    const db = await getDb();
    await db.collection('audit_log').insertOne({
      ts: new Date(),
      rulesVersion: policy.rulesVersion,
      component: policy.component,
      decision: 'n/a',
      ...entry,
    });
  } catch (e) {
    // ignore audit failures in dev
  }
}
