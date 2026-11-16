// Small changes to existing databases, run once at startup. Each is safe to run again.
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');

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
  // "Never ask" (notPantry) became "always skip the details" (autoPantry).
  try {
    const { modifiedCount } = await CatalogItem.collection.updateMany({ notPantry: true }, { $set: { autoPantry: true }, $unset: { notPantry: '' } });
    if (modifiedCount) console.log(`Migrated: ${modifiedCount} saved item(s) now go straight to the pantry.`);
  } catch (err) {
    console.error('Saved item migration failed:', err.message);
  }
}

module.exports = { migrate };
