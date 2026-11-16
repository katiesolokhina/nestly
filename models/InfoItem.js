const mongoose = require('mongoose');
const { titleCase } = require('../lib/titlecase');

// Something worth knowing about the home: the Wi-Fi, the plumber's number, the fridge's model.
// Fields are flexible, so any type the household adds can hold what it needs.
const fieldSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 40, required: true },
    value: { type: String, trim: true, maxlength: 500, default: '' },
    // How it shows: secret is hidden until tapped; phone/email/link/address are tappable.
    kind: { type: String, enum: ['text', 'secret', 'phone', 'email', 'link', 'address', 'date'], default: 'text' },
  },
  { _id: false }
);

const infoSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    type: { type: String, default: 'Other' },
    title: { type: String, required: true, trim: true, maxlength: 80, set: titleCase },
    fields: { type: [fieldSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 5000, default: '' },
    fileIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Upload' }], default: [] },
  },
  { timestamps: true }
);
infoSchema.index({ householdId: 1, type: 1 });

module.exports = mongoose.model('InfoItem', infoSchema);
