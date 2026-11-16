// Small changes to existing databases, run once at startup. Each is safe to run again.
const PantryItem = require('../models/PantryItem');

async function migrate() {
  // Pantry items used to be one per name (a unique index). Now the same thing can be kept as
  // separate items, so the old index goes; Mongoose makes the new, non-unique one.
  try {
    const indexes = await PantryItem.collection.indexes();
    const old = indexes.find((i) => i.unique && i.key && i.key.householdId === 1 && i.key.key === 1);
    if (old) {
      await PantryItem.collection.dropIndex(old.name);
      await PantryItem.createIndexes();
      console.log('Migrated: pantry items can now repeat a name.');
    }
  } catch (err) {
    if (err.codeName !== 'NamespaceNotFound') console.error('Pantry index migration failed:', err.message);
  }
}

module.exports = { migrate };
