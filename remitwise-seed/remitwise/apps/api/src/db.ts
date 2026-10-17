import { MongoClient, Db } from 'mongodb';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;
  const uri = process.env.MONGO_URL;
  if (!uri) throw new Error('MONGO_URL is not set');
  client = new MongoClient(uri);
  await client.connect();
  const dbName = process.env.MONGO_APP_DB || 'remitwise';
  db = client.db(dbName);
  return db;
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}
