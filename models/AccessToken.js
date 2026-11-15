const crypto = require('crypto');
const mongoose = require('mongoose');

// One-time links: household invites and password resets.
// Only a SHA-256 hash of the token is stored, so a database leak can't be turned into
// working links. The raw token exists once: in the link shown to the admin.
const accessTokenSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['invite', 'reset'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // empty when made by a server script
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // reset: whose password
    label: { type: String, trim: true, maxlength: 40 },             // invite: who it's for
    role: { type: String, default: 'member' },                      // invite: the role they join with
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// MongoDB deletes expired links on its own.
accessTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

accessTokenSchema.statics.issue = async function ({ kind, householdId, createdBy, userId, label, role, days }) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const doc = await this.create({
    kind, householdId, createdBy, userId, label, role,
    tokenHash: hash(raw),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  });
  return { raw, doc };
};

// Finds a usable link without consuming it (for showing the form).
accessTokenSchema.statics.peek = function (kind, raw) {
  if (typeof raw !== 'string' || raw.length < 20) return null;
  return this.findOne({ kind, tokenHash: hash(raw), usedAt: null, expiresAt: { $gt: new Date() } });
};

// Atomically consumes a link: only one request can ever win it.
accessTokenSchema.statics.claim = function (kind, raw) {
  if (typeof raw !== 'string' || raw.length < 20) return null;
  return this.findOneAndUpdate(
    { kind, tokenHash: hash(raw), usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { returnDocument: 'after' }
  );
};

module.exports = mongoose.model('AccessToken', accessTokenSchema);
