const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Recipe = require('../models/Recipe');
const Upload = require('../models/Upload');
const CatalogItem = require('../models/CatalogItem');
const { recordChange, visible } = require('../lib/changes');
const { pick } = require('../lib/lists');
const { parseFiles, saveUpload } = require('../lib/uploads');
const { addToCatalog } = require('../lib/catalog');
const { itemName, ingredientText, splitIngredient, BEFORE } = require('../lib/ingredients');
const { importFromLink, fetchPhoto, parsePasted, socialOf } = require('../lib/recipe-import');

const router = express.Router();
router.use('/s/recipes', requireAuth, requireSection('recipes'));
const SECTION = 'Recipes';
const withPhoto = parseFiles(['photo']);
const isHttp = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = (v) => [].concat(v == null ? [] : v).map((x) => String(x));

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Recipe.findOne({ _id: req.params.id, ...visible(req.user) });
}

const blank = (req) => ({ _id: null, title: '', category: 'Uncategorized', tags: [], servings: '', time: '', ingredients: [], steps: [], notes: '', link: '', photoId: null, photoUrl: '', private: false });

function readForm(req) {
  const b = req.body || {};
  const qtys = list(b.ingQty);
  const types = list(b.ingType);
  const preps = list(b.ingPrep);
  const ingredients = list(b.ingName)
    .map((name, i) => ({ qty: String(qtys[i] || '').trim().slice(0, 40), type: String(types[i] || '').trim().slice(0, 40), name: name.trim().slice(0, 120), prep: String(preps[i] || '').trim().slice(0, 60) }))
    .filter((x) => x.name)
    .slice(0, 80);
  const link = String(b.link || '').trim().slice(0, 1000);
  const values = {
    title: String(b.title || '').trim().slice(0, 120),
    category: pick(req.household, 'recipeCats', b.category),
    tags: [...new Set(list(b.tags))].filter((t) => req.household.recipeTags.includes(t)),
    servings: String(b.servings || '').trim().slice(0, 40),
    time: String(b.time || '').trim().slice(0, 40),
    ingredients,
    steps: String(b.steps || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 60).map((s) => s.slice(0, 2000)),
    notes: String(b.notes || '').trim().slice(0, 2000),
    link,
    private: b.private === 'on' && req.perms.private,
  };
  let error = req.uploadError || null;
  if (!values.title) error = 'Enter a name for the recipe.';
  else if (link && !isHttp(link)) error = 'Enter a full link that starts with https://';
  const photoUrl = isHttp(String(b.photoUrl || '')) ? String(b.photoUrl).slice(0, 1000) : '';
  return { values, error, photoUrl };
}

// Types this household has used ("red", "thigh"), for suggestions and for splitting imports.
const usedTypes = (req) => Recipe.distinct('ingredients.type', { householdId: req.user.householdId }).then((t) => t.filter(Boolean).sort((a, b) => a.localeCompare(b)));

async function formView(req, item, error, extra = {}) {
  const [photo, catalog, types] = await Promise.all([
    item.photoId ? Upload.findById(item.photoId).lean() : null,
    CatalogItem.find({ householdId: req.user.householdId }, { name: 1 }).sort({ name: 1 }).lean(),
    usedTypes(req),
  ]);
  return { active: 'recipes', item, error: error || null, photo, catalog, types: [...new Set([...types, ...BEFORE])].sort((a, b) => a.localeCompare(b)), imported: false, ...extra };
}

// Uploaded photo, removed photo, or the photo from an imported page.
async function applyPhoto(req, item, photoUrl) {
  if ((req.body || {}).removePhoto === 'on') item.photoId = null;
  const f = (req.files || {}).photo;
  if (f) {
    item.photoId = (await saveUpload(req.user, f[0], { isPrivate: item.private, imagesOnly: true }))._id;
  } else if (photoUrl && !item.photoId) {
    const buffer = await fetchPhoto(photoUrl);
    if (buffer) {
      try {
        item.photoId = (await saveUpload(req.user, { buffer, originalname: 'recipe-photo' }, { isPrivate: item.private, imagesOnly: true }))._id;
      } catch (e) {
        if (!e.userFacing) throw e; // not a photo we accept: save the recipe without it
      }
    }
  }
  if (item.photoId) await Upload.updateOne({ _id: item.photoId, householdId: req.user.householdId }, { $set: { private: item.private } });
}

// ---------- List ----------
router.get('/s/recipes', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    const category = req.household.recipeCats.includes(req.query.category) || req.query.category === 'Uncategorized' ? req.query.category : '';
    const tag = req.household.recipeTags.includes(req.query.tag) ? req.query.tag : '';
    const filter = { ...visible(req.user) };
    if (category) filter.category = category;
    if (tag) filter.tags = tag;
    if (q) filter.$and = [{ $or: [{ title: new RegExp(escapeRe(q), 'i') }, { 'ingredients.name': new RegExp(escapeRe(q), 'i') }, { 'ingredients.type': new RegExp(escapeRe(q), 'i') }, { tags: new RegExp(escapeRe(q), 'i') }] }];
    const items = await Recipe.find(filter, { title: 1, category: 1, tags: 1, time: 1, servings: 1, photoId: 1, private: 1 }).collation({ locale: 'en' }).sort({ title: 1 }).lean();
    res.render('recipes/list', { active: 'recipes', items, q, category, tag });
  } catch (err) {
    next(err);
  }
});

// ---------- Add ----------
router.get('/s/recipes/new', async (req, res, next) => {
  try {
    res.render('recipes/form', await formView(req, blank(req)));
  } catch (err) {
    next(err);
  }
});

const importView = (extra) => ({ active: 'recipes', error: null, link: '', text: '', pasteLink: '', shared: '', ...extra });

router.get('/s/recipes/import', (req, res) => {
  res.render('recipes/import', importView({}));
});

// Android's share menu sends links here ("Share → Nestly" from Instagram, TikTok, a browser...).
// It only fills in the import page; nothing is fetched until Get recipe is tapped.
router.get('/share', requireAuth, requireSection('recipes'), (req, res) => {
  const text = String(req.query.text || '').slice(0, 20000);
  const urlParam = String(req.query.url || '').trim();
  const inText = (text.match(/https?:\/\/[^\s"'<>]+/) || [])[0] || '';
  const link = (isHttp(urlParam) ? urlParam : inText).slice(0, 1000);
  const rest = text.replace(link, '').trim();
  const from = socialOf(link);
  res.render('recipes/import', importView({
    link,
    pasteLink: link,
    text: rest.length > 40 ? rest : '',
    shared: link ? `Shared${from ? ` from ${{ instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' }[from]}` : ''}. Tap Get recipe, or paste the caption below.` : 'Shared text is below. Tap Read recipe.',
  }));
});

// Reads a link or pasted text into the form for review. Nothing is saved until Save.
router.post('/s/recipes/import', async (req, res, next) => {
  const link = String(req.body.link || '').trim().slice(0, 1000);
  const text = String(req.body.text || '').slice(0, 20000);
  try {
    let found;
    if (req.body.mode === 'text') {
      found = parsePasted(text);
      if (!found.ingredients.length && !found.steps.length) {
        return res.status(422).render('recipes/import', importView({ error: 'Paste the recipe, with its ingredients and steps.', text, pasteLink: link }));
      }
      if (isHttp(link)) found.link = link; // e.g. the Instagram post the caption came from
    } else {
      found = await importFromLink(link);
    }
    const { photoUrl, ...rest } = found;
    // Best guess at each ingredient's type and prep, to check on the form.
    const types = await usedTypes(req);
    rest.ingredients = (rest.ingredients || []).map((i) => splitIngredient(i, { preps: req.household.prepStyles, types }));
    res.render('recipes/form', await formView(req, { ...blank(req), ...rest, photoUrl }, null, { imported: true }));
  } catch (err) {
    if (!err.userFacing) return next(err);
    res.status(422).render('recipes/import', importView({ error: err.message, link, text, pasteLink: err.social ? link : '' }));
  }
});

router.post('/s/recipes', withPhoto, async (req, res, next) => {
  try {
    const { values, error, photoUrl } = readForm(req);
    if (error) return res.status(422).render('recipes/form', await formView(req, { ...blank(req), ...values, photoUrl }, error));
    const item = new Recipe({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    try {
      await applyPhoto(req, item, photoUrl);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('recipes/form', await formView(req, { ...blank(req), ...values, photoUrl }, e.message));
    }
    await item.save();
    if (!item.private) await addToCatalog(req.user, req.household, item.ingredients.map((i) => itemName(i)));
    await recordChange(req, { kind: 'create', model: 'Recipe', doc: item, section: SECTION, text: `added the recipe ${item.title}`, label: item.title });
    res.redirect(`/s/recipes/${item._id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- One recipe ----------
router.get('/s/recipes/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const photo = item.photoId ? await Upload.findById(item.photoId).lean() : null;
    let source = '';
    try { source = item.link ? new URL(item.link).hostname.replace(/^www\./, '') : ''; } catch { /* shown without a site name */ }
    res.render('recipes/show', { active: 'recipes', item, photo, source, ingredientText, mealsOn: req.perms.level('meals') === 'edit', shoppingOn: req.perms.level('shopping') === 'edit' });
  } catch (err) {
    next(err);
  }
});

router.get('/s/recipes/:id/edit', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    res.render('recipes/form', await formView(req, { ...item.toObject(), photoUrl: '' }));
  } catch (err) {
    next(err);
  }
});

router.post('/s/recipes/:id', withPhoto, async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('recipes/form', await formView(req, { ...item.toObject(), ...values, photoUrl: '' }, error));
    const before = item.toObject();
    if (String(item.createdBy) !== req.user.id) values.private = item.private;
    item.set(values);
    try {
      await applyPhoto(req, item, '');
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('recipes/form', await formView(req, { ...before, ...values, photoUrl: '' }, e.message));
    }
    await item.save();
    if (!item.private) await addToCatalog(req.user, req.household, item.ingredients.map((i) => itemName(i)));
    await recordChange(req, { kind: 'update', model: 'Recipe', doc: item, before, section: SECTION, text: `edited the recipe ${item.title}`, label: item.title });
    res.redirect(`/s/recipes/${item._id}`);
  } catch (err) {
    next(err);
  }
});

// Copy: a new recipe to change without touching the original (for a variation, say).
router.post('/s/recipes/:id/copy', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { _id, createdAt, updatedAt, __v, ...rest } = item.toObject();
    const copy = await Recipe.create({ ...rest, title: `${item.title} (copy)`.slice(0, 120), createdBy: req.user._id, byName: req.user.name, private: item.private });
    await recordChange(req, { kind: 'create', model: 'Recipe', doc: copy, section: SECTION, text: `copied the recipe ${item.title}`, label: copy.title });
    res.redirect(`/s/recipes/${copy._id}/edit`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/recipes/:id/delete', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const before = item.toObject();
    await item.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'Recipe', doc: item, before, section: SECTION, text: `deleted the recipe ${item.title}`, label: item.title });
    res.redirect('/s/recipes');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
