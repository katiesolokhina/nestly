// Uploaded receipts and photos. Household members only, and private files only for their owner.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Upload = require('../models/Upload');
const { filePath } = require('../lib/uploads');

const router = express.Router();

async function findUpload(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  const upload = await Upload.findOne({ _id: req.params.id, householdId: req.user.householdId });
  if (!upload || (upload.private && String(upload.createdBy) !== req.user.id)) return null;
  return upload;
}

// Only paths inside Nestly, so the Back link can't send someone to another site.
const safeBack = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/s/shopping');

// A page inside the app, so Back returns to where you were instead of closing an installed app.
router.get('/files/:id/view', requireAuth, async (req, res, next) => {
  try {
    const upload = await findUpload(req);
    if (!upload) return res.status(404).send('Not found');
    res.render('file', { active: 'shopping', upload, back: safeBack(req.query.back) });
  } catch (err) {
    next(err);
  }
});

router.get('/files/:id', requireAuth, async (req, res, next) => {
  try {
    const upload = await findUpload(req);
    if (!upload) return res.status(404).send('Not found');
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.set({ 'Content-Type': upload.type, 'Cache-Control': 'private, max-age=3600' });
    res.set('Content-Disposition', `${disposition}; filename="${upload.name.replace(/"/g, '')}"`);
    // The browser's built-in PDF viewer can be blocked by the page security policy. The type was
    // verified from the file's bytes at upload, so this response can't be treated as a web page.
    if (upload.type === 'application/pdf') res.removeHeader('Content-Security-Policy');
    res.sendFile(filePath(upload), (err) => { if (err && !res.headersSent) res.status(404).send('Not found'); });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
