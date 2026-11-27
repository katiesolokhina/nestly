// Recipe units: the units switch, baker's %, reading a plain "oz", and the converter page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Recipe = require('../models/Recipe');
const { convertQty, convertAmount, perCup } = require('../lib/convert');

const PW = 'correct horse';
const c = (q, m, n, o) => convertQty(q, 1, m, n, o).text;

test('converting amounts', () => {
  assert.equal(c('2 1/4 cups', 'g', 'all-purpose flour'), '270 g');
  assert.equal(c('2 1/4 cups', 'ml', 'all-purpose flour'), '530 ml');
  assert.equal(c('1 cup', 'g', 'unsalted butter, softened'), '227 g', 'grams stay exact for a scale');
  assert.equal(c('1 stick', 'g', 'butter'), '113 g');
  assert.equal(c('1 tsp', 'g', 'baking soda'), '6 g');
  assert.equal(c('1 T', 'ml', 'sugar'), '15 ml');
  assert.equal(c('2-3 tbsp', 'ml', 'olive oil'), '30-44 ml');
  // A plain oz: liquids are fl oz, the rest weight; either can be flipped.
  assert.equal(c('4 oz', 'ml', 'milk'), '120 ml');
  assert.equal(c('4 oz', 'ml', 'milk', { flipOz: true }), '113 g');
  assert.equal(c('12 oz', 'ml', 'chocolate chips'), '340 g');
  assert.equal(convertQty('4 oz', 1, 'ml', 'milk').oz, 'fl');
  // US: metric back to cups (by the ingredient's weight when known), else oz.
  assert.equal(c('250 g', 'us', 'all-purpose flour'), '2 ⅛ cups');
  assert.equal(c('500 ml', 'us', 'milk'), '2 ⅛ cups');
  assert.equal(c('200 g', 'us', 'chicken'), '7 oz');
  // Unknown or not a measure: stays as written.
  assert.equal(c('2 cups', 'g', 'spinach'), null);
  assert.equal(c('2 cloves', 'g', 'garlic'), null);
  assert.equal(c('1 (14 oz) can', 'g', 'tomatoes'), null);
  // Scaled first, then converted.
  assert.equal(convertQty('1 cup', 2, 'g', 'sugar').text, '396 g');
  // Whole words, longest first.
  assert.equal(perCup('peanut butter'), 270);
  assert.equal(perCup('butternut squash'), null);
  // The converter page's sums.
  assert.equal(Math.round(convertAmount(2, 'cup', 'g', 'all-purpose flour').value), 240);
  assert.equal(Math.round(convertAmount(1, 'cup', 'ml', '').value), 237);
  assert.match(convertAmount(1, 'cup', 'g', '').error, /need the ingredient/);
});

test('recipe units switch and converter page', async (t) => {
  const app = await startApp({
    name: 'nestly_test_convert',
    port: 4072,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      const r = await Recipe.create({ householdId: home._id, byName: 'Katie', title: 'Cookies', servings: '24', ingredients: [
        { qty: '2 1/4 cups', name: 'all-purpose flour' }, { qty: '1 cup', name: 'butter' }, { qty: '2', name: 'large eggs' }, { qty: '4 oz', name: 'milk' }, { qty: '', name: 'sea salt, to finish' },
      ] });
      return { id: r.id };
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
  const { id } = app.seeded;

  let page = await katie(`/s/recipes/${id}`);
  assert.match(page.text, /As written/);
  assert.match(page.text, /<strong>2 1\/4 cups<\/strong>/, 'as written by default');
  assert.doesNotMatch(page.text, /Recipe says/);

  page = await katie(`/s/recipes/${id}?u=g`);
  assert.match(page.text, /<strong>270 g<\/strong>/);
  assert.match(page.text, /Recipe says 2 1\/4 cups/);
  assert.match(page.text, /Read as fl oz \(a liquid\)/);

  // Scaled and converted together; links keep both.
  page = await katie(`/s/recipes/${id}?x=2&u=g`);
  assert.match(page.text, /<strong>540 g<\/strong>/);
  assert.match(page.text, /href="\/s\/recipes\/[0-9a-f]+\?x=2&amp;u=ml"/);

  // Flip the milk to weight oz.
  page = await katie(`/s/recipes/${id}?u=ml&oz=3`);
  assert.match(page.text, /<strong>113 g<\/strong> milk/);
  assert.match(page.text, /Read as weight oz/);

  // Baker's %: flour 100%, butter 227/270, eggs 100/270.
  page = await katie(`/s/recipes/${id}?pct=1`);
  assert.match(page.text, /ing-pct flour">100%/);
  assert.match(page.text, />84.1%</);
  assert.match(page.text, />37%</);

  // The converter page.
  page = await katie('/s/recipes/convert?amt=2&from=cup&to=g&ing=all-purpose+flour');
  assert.match(page.text, /2 cups = 240 g/);
  assert.match(page.text, /King Arthur/);
  page = await katie('/s/recipes/convert?flour=1000&b0=Water&p0=70&b1=Salt&p1=2');
  assert.match(page.text, /700 g/);
  assert.match(page.text, /Total dough: <strong>1720 g/);
  assert.match((await katie('/s/recipes')).text, /href="\/s\/recipes\/convert"/);
});
