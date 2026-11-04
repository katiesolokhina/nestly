// Uploaded receipts and photos. Household members only, and private files only for their owner.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Upload = require('../models/Upload');
const { filePath } = require('../lib/uploads');

const router = express.Router();

router.get('/files/:id', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Not found');
    const upload = await Upload.findOne({ _id: req.params.id, householdId: req.user.householdId });
    if (!upload || (upload.private && String(upload.createdBy) !== req.user.id)) return res.status(404).send('Not found');
    res.set({ 'Content-Type': upload.type, 'Cache-Control': 'private, max-age=3600' });
    res.set('Content-Disposition', `inline; filename="${upload.name.replace(/"/g, '')}"`);
    // The browser's built-in PDF viewer can be blocked by the page security policy. The type was
    // verified from the file's bytes at upload, so this response can't be treated as a web page.
    if (upload.type === 'application/pdf') res.removeHeader('Content-Security-Policy');
    res.sendFile(filePath(upload), (err) => { if (err && !res.headersSent) res.status(404).send('Not found'); });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
