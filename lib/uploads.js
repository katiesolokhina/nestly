const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const multer = require('multer');
const Upload = require('../models/Upload');

const MAX_BYTES = 10 * 1024 * 1024;
const dir = () => path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));

// The file's real type comes from its first bytes, never from the name the browser sends.
// SVG and HTML are refused because they could run scripts on our origin.
function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1)/.test(b.toString('latin1', 8, 12))) return { type: 'image/heic', ext: 'heic' };
  if (b.length > 5 && b.toString('latin1', 0, 5) === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  return null;
}

const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 2 } });
const many = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 6 } });

// Parses a form with file fields. A rejected file becomes a form error instead of a crash.
// With a prefix, fields named <prefix><anything> are taken too (one file each), e.g. kindPhoto_<code>.
const parseFiles = (fields, { prefix } = {}) => (req, res, next) => {
  const ok = (name) => fields.includes(name) || (prefix && name.startsWith(prefix) && /^[\w-]{1,40}$/.test(name));
  const run = prefix ? many.any() : parser.fields(fields.map((name) => ({ name, maxCount: 1 })));
  run(req, res, (err) => {
    if (!err && prefix && Array.isArray(req.files)) {
      const by = {};
      req.files.forEach((f) => { if (ok(f.fieldname) && !by[f.fieldname]) by[f.fieldname] = [f]; });
      req.files = by;
    }
    if (err instanceof multer.MulterError) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Choose a file under 10 MB.' : 'That file could not be uploaded.';
      req.body = req.body || {};
      return next();
    }
    next(err);
  });
};

// reuse: an identical shared photo already saved in this household is returned instead of a copy
// (pantry and kind photos, so the same picture never shows twice in the main photo picker).
async function saveUpload(user, file, { isPrivate, imagesOnly, reuse = false }) {
  const kind = sniff(file.buffer);
  if (!kind || (imagesOnly && kind.type === 'application/pdf')) {
    const e = new Error(imagesOnly ? 'Choose a JPG, PNG, WebP, or HEIC photo.' : 'Choose a JPG, PNG, WebP, HEIC, or PDF file.');
    e.userFacing = true;
    throw e;
  }
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  if (reuse && !isPrivate) {
    const same = await Upload.findOne({ householdId: user.householdId, hash, private: false }).sort({ createdAt: 1 });
    if (same && (await fs.stat(filePath(same)).then(() => true, () => false))) return same;
  }
  await fs.mkdir(dir(), { recursive: true });
  const name = `${crypto.randomBytes(18).toString('hex')}.${kind.ext}`;
  await fs.writeFile(path.join(dir(), name), file.buffer, { mode: 0o640 });
  return Upload.create({
    householdId: user.householdId,
    createdBy: user._id,
    private: !!isPrivate,
    file: name,
    name: path.basename(String(file.originalname || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file',
    type: kind.type,
    size: file.buffer.length,
    hash,
  });
}

const filePath = (upload) => path.join(dir(), path.basename(upload.file));

async function deleteUploads(filter) {
  const rows = await Upload.find(filter);
  await Promise.all(rows.map((u) => fs.rm(filePath(u), { force: true })));
  await Upload.deleteMany({ _id: { $in: rows.map((u) => u._id) } });
}

module.exports = { parseFiles, saveUpload, filePath, deleteUploads };
