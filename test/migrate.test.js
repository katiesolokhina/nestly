// Startup changes to existing databases.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDatabase } = require('./helpers');
const PantryItem = require('../models/PantryItem');
const { migrate } = require('../lib/migrate');

test('pantry items stop being one per name', async (t) => {
  const db = await startDatabase('nestly_test_migrate');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  // A database from before: the unique index in place of today's.
  await PantryItem.createCollection();
  await PantryItem.init();
  await PantryItem.collection.dropIndex('householdId_1_key_1');
  await PantryItem.collection.createIndex({ householdId: 1, key: 1 }, { unique: true, name: 'householdId_1_key_1' });
  const h = new mongoose.Types.ObjectId();
  const doc = { householdId: h, byName: 'K', name: 'Milk', key: 'milk' };
  await PantryItem.create(doc);
  await assert.rejects(PantryItem.create(doc), /duplicate key/);
  await migrate();
  await PantryItem.create(doc);
  assert.equal(await PantryItem.countDocuments({ key: 'milk' }), 2);
  await migrate(); // safe to run again
  const idx = (await PantryItem.collection.indexes()).find((i) => i.key.householdId === 1 && i.key.key === 1);
  assert.ok(idx && !idx.unique);
});
