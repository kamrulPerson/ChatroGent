import crypto from 'crypto';

// The insecure signing key used for local sandbox/demo runs. server.ts refuses
// to boot with NODE_ENV=production while this value is in effect.
export const DEFAULT_DEV_SECRET = 'devsecret';

const SECRET = process.env.SESSION_SECRET || DEFAULT_DEV_SECRET;

export function signToken(payload: Record<string, any>, expiresInSec = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

export function verifyToken(token: string): any {
  try {
    const [h, b, s] = token.split('.');
    if (!h || !b || !s) throw new Error('bad');
    const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + b).digest('base64url');
    if (sig !== s) throw new Error('bad sig');
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('exp');
    return payload;
  } catch (e) {
    return null;
  }
}

export function verifyPassword(hash: string, pw: string): boolean {
  try {
    const [salt, stored] = hash.split(':');
    if (!salt || !stored) return false;
    const calc = crypto.scryptSync(pw, salt, 64).toString('hex');
    return calc === stored;
  } catch (e) {
    return false;
  }
}
