const dbName = process.env.MONGO_APP_DB || 'remitwise';
const appUser = process.env.MONGO_APP_USER || 'rwapp';
const appPwd = process.env.MONGO_APP_PASSWORD || 'rwappw';

const target = db.getSiblingDB(dbName);

// collections
const collections = [
  'users',
  'accounts',
  'student_files',
  'documents',
  'proposals',
  'transfers',
  'alerts',
  'audit_log',
  'routes',
  'fx_rates',
  'compliance_rules',
];
collections.forEach((c) => {
  if (!target.getCollectionNames().includes(c)) {
    target.createCollection(c);
  }
});

// validators
target.runCommand({
  collMod: 'proposals',
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['status'],
      properties: {
        status: {
          enum: ['pending', 'confirmed', 'cancelled', 'expired', 'executed'],
        },
        payloadHash: {
          bsonType: ['string', 'null'],
          pattern: '^[a-fA-F0-9]{64}$',
        },
      },
    },
  },
  validationLevel: 'moderate',
});

target.runCommand({
  collMod: 'transfers',
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['status'],
      properties: {
        status: {
          enum: ['pending', 'completed', 'failed', 'reversed'],
        },
      },
    },
  },
  validationLevel: 'moderate',
});

target.runCommand({
  collMod: 'audit_log',
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['tier'],
      properties: {
        tier: {
          enum: ['T1', 'T2', 'T3', 'SYS'],
        },
      },
    },
  },
  validationLevel: 'moderate',
});

// indexes
// users
target.users.createIndex({ email: 1 }, { unique: true });
// accounts
target.accounts.createIndex({ userId: 1, currency: 1 }, { unique: true });
// documents
target.documents.createIndex({ userId: 1, type: 1 }, { unique: true });
// student_files
target.student_files.createIndex({ userId: 1 }, { unique: true });
// proposals
target.proposals.createIndex({ userId: 1, createdAt: -1 });
target.proposals.createIndex({ status: 1, expiresAt: 1 });
// transfers
target.transfers.createIndex({ proposalId: 1 });
target.transfers.createIndex({ createdAt: -1 });
// alerts
target.alerts.createIndex({ userId: 1, status: 1 });
// audit_log
target.audit_log.createIndex({ ts: -1 });
target.audit_log.createIndex({ userId: 1 });

// roles and user
const roleName = 'remitwise_app_role';
try {
  db.getSiblingDB(dbName).createRole({
    role: roleName,
    privileges: [
      { resource: { db: dbName, collection: 'users' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: dbName, collection: 'accounts' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: dbName, collection: 'student_files' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: dbName, collection: 'documents' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: dbName, collection: 'proposals' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: dbName, collection: 'transfers' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: dbName, collection: 'alerts' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: dbName, collection: 'audit_log' }, actions: ['find', 'insert'] },
      { resource: { db: dbName, collection: 'routes' }, actions: ['find', 'insert', 'update', 'remove'] },
      { resource: { db: dbName, collection: 'fx_rates' }, actions: ['find', 'insert', 'update', 'remove'] },
      { resource: { db: dbName, collection: 'compliance_rules' }, actions: ['find', 'insert', 'update', 'remove'] },
    ],
    roles: [],
  });
} catch (e) {}

try {
  db.getSiblingDB(dbName).createUser({
    user: appUser,
    pwd: appPwd,
    roles: [{ role: roleName, db: dbName }],
  });
} catch (e) {}
