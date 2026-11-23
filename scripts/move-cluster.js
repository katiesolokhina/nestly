// Copies every database on one MongoDB cluster to another: for moving Nestly, Questly, and the
// TriSolo site to a cluster closer to the server. It only reads from the old cluster, so nothing
// there changes, and it refuses to copy into a database that already has data.
//
//   node scripts/move-cluster.js            # asks for the old and new connection strings
//   node scripts/move-cluster.js --check    # compares document counts on both, copies nothing
//
// Paste the connection strings when asked (they don't end up in your shell history). Stop the apps
// first (pm2 stop ...) so nothing is written to the old cluster mid-copy.
const readline = require('node:readline/promises');
const { MongoClient } = require('mongoose').mongo;

const SKIP_DBS = new Set(['admin', 'local', 'config']);
const SKIP_COLLECTIONS = new Set(['sessions']); // logins: people just sign in again
const BATCH = 1000;
const check = process.argv.includes('--check');

async function ask(rl, label) {
  const v = (await rl.question(label)).trim();
  if (!/^mongodb(\+srv)?:\/\//.test(v)) throw new Error('That doesn’t look like a connection string (it should start with mongodb+srv:// or mongodb://).');
  return v;
}

async function collectionsOf(db) {
  return (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.') && !SKIP_COLLECTIONS.has(n))
    .sort();
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const fromUri = process.env.FROM_URI || (await ask(rl, 'Old cluster connection string: '));
  const toUri = process.env.TO_URI || (await ask(rl, 'New cluster connection string: '));
  if (fromUri === toUri) throw new Error('The old and new connection strings are the same.');

  const from = await MongoClient.connect(fromUri);
  const to = await MongoClient.connect(toUri);
  try {
    const dbs = (await from.db().admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).filter((n) => !SKIP_DBS.has(n));
    if (!dbs.length) throw new Error('The old cluster has no databases to copy.');
    console.log(`Databases: ${dbs.join(', ')}`);

    // Nothing is copied unless every target database is empty (so a second run can't double up).
    if (!check) {
      for (const name of dbs) {
        const busy = [];
        for (const c of await collectionsOf(to.db(name))) if (await to.db(name).collection(c).estimatedDocumentCount()) busy.push(c);
        if (busy.length) throw new Error(`The new cluster already has data in ${name} (${busy.join(', ')}). Nothing was copied.`);
      }
      const ok = (await rl.question(`Copy ${dbs.length} database${dbs.length === 1 ? '' : 's'} to the new cluster? Type yes: `)).trim().toLowerCase();
      if (ok !== 'yes') throw new Error('Stopped. Nothing was copied.');
    }

    let mismatch = 0;
    for (const name of dbs) {
      const src = from.db(name);
      const dst = to.db(name);
      for (const c of await collectionsOf(src)) {
        if (!check) {
          let batch = [];
          for await (const doc of src.collection(c).find({})) {
            batch.push(doc);
            if (batch.length >= BATCH) { await dst.collection(c).insertMany(batch, { ordered: false }); batch = []; }
          }
          if (batch.length) await dst.collection(c).insertMany(batch, { ordered: false });
          // The same indexes (unique ones matter: they stop duplicates).
          const indexes = (await src.collection(c).indexes()).filter((i) => i.name !== '_id_');
          for (const { v, ns, key, name: indexName, ...options } of indexes) await dst.collection(c).createIndex(key, { ...options, name: indexName });
        }
        const [a, b] = await Promise.all([src.collection(c).countDocuments(), dst.collection(c).countDocuments()]);
        if (a !== b) mismatch += 1;
        console.log(`  ${a === b ? 'ok ' : 'DIFF'} ${name}.${c}: ${a} → ${b}`);
      }
    }
    console.log(mismatch ? `\n${mismatch} collection(s) differ. Don’t switch the apps over yet.` : `\nAll counts match.${check ? '' : ' Now point each app’s MONGODB_URI at the new cluster and restart it.'}`);
    if (mismatch) process.exitCode = 1;
  } finally {
    rl.close();
    await Promise.all([from.close(), to.close()]);
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
