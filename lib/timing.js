// How long each request takes and how many database calls it makes. Slow ones are logged
// (see them with `pm2 logs nestly`), and every page says so in a Server-Timing header, which
// shows in the browser's developer tools under Network.
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const store = new AsyncLocalStorage();
const SLOW_MS = Number(process.env.SLOW_MS) || 800;

// Counts every query, insert, update, and aggregate made during the request.
mongoose.plugin((schema) => {
  const count = function () { const t = store.getStore(); if (t) t.db += 1; };
  ['find', 'findOne', 'countDocuments', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'distinct'].forEach((op) => schema.pre(op, count));
  schema.pre('aggregate', count);
  schema.pre('save', count);
  schema.pre('insertMany', count);
});

function timing(req, res, next) {
  const t = { start: process.hrtime.bigint(), db: 0 };
  const ms = () => Number(process.hrtime.bigint() - t.start) / 1e6;
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${ms().toFixed(0)};desc="${t.db} database calls"`);
    return writeHead.apply(this, args);
  };
  res.on('finish', () => {
    const took = ms();
    if (took >= SLOW_MS && !/^\/(css|js|icons|brand)\//.test(req.path)) {
      console.warn(`Slow: ${req.method} ${req.path} took ${took.toFixed(0)} ms with ${t.db} database calls`);
    }
  });
  store.run(t, next);
}

// One round trip to the database, timed: how far away it is.
async function pingMs() {
  const start = process.hrtime.bigint();
  await mongoose.connection.db.admin().ping();
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

module.exports = { timing, pingMs };
