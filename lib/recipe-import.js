// Reads a recipe from a web page (or pasted text) so it can be reviewed before saving.
//
// Fetching a page someone typed in is done carefully, because the server makes the request:
// only http(s) on the usual ports, never to private or local addresses (checked on every
// connection, so a DNS trick can't sneak past), at most 4 redirects, 3 MB, and 12 seconds.

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const { parseIngredient } = require('./ingredients');

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 12000;

class ImportError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

// Every connection looks up the name itself and refuses private addresses.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return cb(new ImportError('That address can’t be reached from Nestly.'));
    if (options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new ImportError('Enter the full link, starting with https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ImportError('Enter the full link, starting with https://');
  if (url.port && !['80', '443'].includes(url.port)) throw new ImportError('That address can’t be reached from Nestly.');
  if (url.username || url.password) throw new ImportError('Enter the link without a username or password.');
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new ImportError('That address can’t be reached from Nestly.');
  return url;
}

function getOnce(url, accept) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Nestly recipe import)',
        accept,
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.8',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url) });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new ImportError(res.statusCode === 403 || res.statusCode === 401
          ? 'That site doesn’t let apps read its recipes. Paste the recipe text instead.'
          : 'That page couldn’t be opened. Check the link, or paste the recipe text instead.'));
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); reject(new ImportError('That page is too big to read.')); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ body: Buffer.concat(chunks), type: String(res.headers['content-type'] || '') }));
      stream.on('error', () => reject(new ImportError('That page couldn’t be read.')));
    });
    req.on('timeout', () => { req.destroy(); reject(new ImportError('That site took too long to answer. Try again, or paste the recipe text.')); });
    req.on('error', (err) => reject(err.userFacing ? err : new ImportError('That page couldn’t be opened. Check the link, or paste the recipe text instead.')));
  });
}

async function safeFetch(raw, accept = 'text/html,application/xhtml+xml') {
  let url = checkUrl(raw);
  for (let i = 0; i <= 4; i += 1) {
    const res = await getOnce(url, accept);
    if (!res.redirect) return { ...res, url };
    url = checkUrl(res.redirect.href);
  }
  throw new ImportError('That link redirects too many times.');
}

// ---------- Reading the page ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const isRecipe = (o) => o && typeof o === 'object' && [].concat(o['@type'] || []).some((t) => String(t).toLowerCase() === 'recipe');

function findRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = findRecipe(n, depth + 1); if (hit) return hit; }
    return null;
  }
  if (isRecipe(node)) return node;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
    const hit = findRecipe(node[k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

// "PT1H30M" -> "1 hr 30 min"
function duration(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/i);
  if (!m) return '';
  const total = (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0);
  if (!total) return '';
  const h = Math.floor(total / 60);
  const min = total % 60;
  return [h ? `${h} hr` : '', min ? `${min} min` : ''].filter(Boolean).join(' ');
}

function steps(instr, depth = 0) {
  if (!instr || depth > 4) return [];
  if (typeof instr === 'string') return instr.replace(/<(br|\/p|\/li)\s*\/?>/gi, '\n').split(/\n+/).map(clean).filter(Boolean);
  if (Array.isArray(instr)) return instr.flatMap((s) => steps(s, depth + 1));
  if (typeof instr === 'object') {
    if (instr.itemListElement) {
      const inner = steps(instr.itemListElement, depth + 1);
      return instr.name && inner.length ? [`${clean(instr.name)}:`, ...inner] : inner;
    }
    return steps(instr.text || instr.name || '', depth + 1);
  }
  return [];
}

function imageUrl(img, base) {
  const first = Array.isArray(img) ? img[0] : img;
  const raw = typeof first === 'string' ? first : first && (first.url || first.contentUrl);
  if (!raw) return '';
  try {
    const u = new URL(raw, base);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

// Pulls the recipe out of a page's structured data, which nearly every recipe site includes.
function extractRecipe(html, base) {
  const blocks = [...String(html).matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, json] of blocks) {
    let data;
    try {
      data = JSON.parse(json.trim().replace(/^<!--|-->$/g, ''));
    } catch {
      continue;
    }
    const r = findRecipe(data);
    if (!r) continue;
    const yieldText = [].concat(r.recipeYield || []).map(clean).find((y) => /\D/.test(y)) || [].concat(r.recipeYield || []).map(clean)[0] || '';
    return {
      title: clean(r.name).slice(0, 120),
      servings: (/^\d+$/.test(yieldText) ? `${yieldText} servings` : yieldText).slice(0, 40),
      time: (duration(r.totalTime) || duration(r.cookTime) || duration(r.prepTime)).slice(0, 40),
      ingredients: [].concat(r.recipeIngredient || r.ingredients || []).map(clean).filter(Boolean).slice(0, 80).map(parseIngredient).filter(Boolean),
      steps: steps(r.recipeInstructions).slice(0, 60).map((s) => s.slice(0, 2000)),
      notes: '',
      link: base,
      photoUrl: imageUrl(r.image, base),
    };
  }
  return null;
}

async function importFromLink(raw) {
  const page = await safeFetch(raw);
  if (!/html|xml|text\/plain/i.test(page.type)) throw new ImportError('That link isn’t a web page.');
  const recipe = extractRecipe(page.body.toString('utf8'), page.url.href);
  if (!recipe || (!recipe.ingredients.length && !recipe.steps.length)) {
    throw new ImportError('Couldn’t find a recipe on that page. Paste the recipe text instead.');
  }
  return recipe;
}

// Fetches a recipe photo, with the same safety checks. Returns a buffer, or null if it can't.
async function fetchPhoto(raw) {
  try {
    const res = await safeFetch(raw, 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5');
    return res.body.length ? res.body : null;
  } catch {
    return null;
  }
}

// ---------- Pasted text ----------
const ING_HEAD = /^\W*ingredients?\b\W*$/i;
const STEP_HEAD = /^\W*(instructions?|directions?|method|steps|preparation|how to make( it)?)\b\W*$/i;
const NOTE_HEAD = /^\W*(notes?|tips?)\b\W*$/i;
const STARTS_WITH_AMOUNT = /^[\s•\-*–·]*([\d¼½¾⅓⅔⅛]|a pinch|a dash|pinch|dash)/i;

// Splits pasted recipe text into a title, ingredients, and steps. Headings like "Ingredients"
// and "Instructions" help; without them, lines starting with an amount count as ingredients.
function parsePasted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 300);
  let title = '';
  const ingredients = [];
  const stepLines = [];
  const notes = [];
  let mode = null;
  const hasHeads = lines.some((l) => ING_HEAD.test(l)) || lines.some((l) => STEP_HEAD.test(l));
  lines.forEach((line, i) => {
    if (ING_HEAD.test(line)) { mode = 'ing'; return; }
    if (STEP_HEAD.test(line)) { mode = 'step'; return; }
    if (NOTE_HEAD.test(line)) { mode = 'note'; return; }
    if (!title && i === 0 && !STARTS_WITH_AMOUNT.test(line) && line.length <= 120) { title = line; return; }
    const target = mode || (hasHeads ? null : STARTS_WITH_AMOUNT.test(line) && line.length < 100 ? 'ing' : 'step');
    if (target === 'ing') ingredients.push(line);
    else if (target === 'step') stepLines.push(line);
    else if (target === 'note') notes.push(line);
    else if (!mode) stepLines.push(line);
  });
  return {
    title: title.slice(0, 120),
    servings: '',
    time: '',
    ingredients: ingredients.slice(0, 80).map(parseIngredient).filter(Boolean),
    steps: stepLines.map((s) => s.replace(/^(step\s*)?\d+[.):]\s*/i, '').replace(/^[•\-*–·]\s*/, '')).filter(Boolean).slice(0, 60),
    notes: notes.join('\n').slice(0, 2000),
    link: '',
    photoUrl: '',
  };
}

module.exports = { importFromLink, fetchPhoto, extractRecipe, parsePasted, duration, isPrivateAddress, checkUrl, ImportError };
