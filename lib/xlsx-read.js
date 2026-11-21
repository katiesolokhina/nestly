// Reads the first sheet of an .xlsx file into rows of text, for uploads of files Nestly exported
// (and then edited in Excel, Google Sheets or Numbers). No packages: an .xlsx is a zip of XML.
const zlib = require('node:zlib');

const MAX_ENTRY = 20 * 1024 * 1024;

// The files in a zip, by name (only the few we ask for are inflated).
function unzip(buf, wanted) {
  const out = {};
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const raw = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extra + comment;
    if (!wanted(name)) continue;
    if (raw > MAX_ENTRY) throw new Error('too big');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString('utf8');
  }
  return out;
}

const unescape = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, e, d, h) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()]));
// All the text in <t> elements (rich text keeps its runs in several).
const textOf = (xml) => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => unescape(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function parseSheet(sheet, shared) {
  const rows = [];
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const r = Number((rm[1].match(/\br="(\d+)"/) || [])[1]) || rows.length + 1;
    const cells = [];
    for (const cm of rm[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1];
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
      const t = (attrs.match(/\bt="(\w+)"/) || [])[1] || 'n';
      const inner = cm[2] || '';
      const v = (inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
      let value = '';
      if (t === 's') value = shared[Number(v)] || '';
      else if (t === 'inlineStr') value = textOf(inner);
      else if (v != null) value = unescape(v);
      cells[ref ? colIndex(ref) : cells.length] = value;
    }
    rows[r - 1] = Array.from(cells, (c) => c || '');
  }
  return Array.from(rows, (row) => row || []);
}

// Every sheet, in the workbook's order: [{ name, rows: [[cell, ...], ...] }], cells as strings.
function readXlsx(buf) {
  const files = unzip(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const book = files['xl/workbook.xml'] || '';
  const rels = files['xl/_rels/workbook.xml.rels'] || '';
  const targetOf = (id) => {
    const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1]).find((a) => new RegExp(`\\bId="${id}"`).test(a));
    const t = rel && (rel.match(/\bTarget="([^"]+)"/) || [])[1];
    return t ? `xl/${t.replace(/^\/?xl\//, '').replace(/^\//, '')}` : '';
  };
  const shared = [...(files['xl/sharedStrings.xml'] || '').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));
  const sheets = [...book.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: unescape((m[1].match(/\bname="([^"]*)"/) || [])[1] || ''),
    path: targetOf((m[1].match(/\br:id="([^"]+)"/) || [])[1]),
  })).filter((s) => files[s.path]);
  if (!sheets.length) throw new Error('no sheet');
  return sheets.map((s) => ({ name: s.name, rows: parseSheet(files[s.path], shared) }));
}

module.exports = { readXlsx };
