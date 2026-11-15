// What the household spent: shopping items with a price (when they were bought) and paid bills
// (when they were paid), by month, store, tag, and bill category.
const ShoppingItem = require('../models/ShoppingItem');
const Bill = require('../models/Bill');
const { shiftMonth } = require('./dates');

const localDay = (date, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);

// Totals by a key, biggest first, with each as a share of the biggest (for the bars).
function rank(rows, keyOf, centsOf) {
  const m = new Map();
  rows.forEach((r) => { const k = keyOf(r); m.set(k, (m.get(k) || 0) + centsOf(r)); });
  const list = [...m].map(([name, cents]) => ({ name, cents })).sort((a, b) => b.cents - a.cents);
  const top = list.length ? list[0].cents : 0;
  return list.map((x) => ({ ...x, pct: top ? Math.max(2, Math.round((x.cents / top) * 100)) : 0 }));
}

// month: YYYY-MM. Looks at the 6 months ending with it.
async function spending({ scope, tz, month, shopping, bills }) {
  const first = shiftMonth(month, -5);
  const from = new Date(`${shiftMonth(first, 0)}-01T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1); // a day early: time zones
  const [items, paid] = await Promise.all([
    shopping ? ShoppingItem.find({ ...scope, bought: true, price: { $ne: null }, boughtAt: { $gte: from } }, { name: 1, price: 1, store: 1, tag: 1, boughtAt: 1, key: 1 }).lean() : [],
    bills ? Bill.find({ ...scope, paid: true, paidOn: { $gte: `${first}-01` } }, { name: 1, cents: 1, category: 1, paidOn: 1 }).lean() : [],
  ]);
  const shop = items
    .map((i) => ({ ...i, day: localDay(i.boughtAt, tz), cents: Math.round(i.price * 100) }))
    .filter((i) => i.day >= `${first}-01`);
  const inMonth = (d) => d.slice(0, 7) === month;
  const months = [...Array(6)].map((_, i) => shiftMonth(first, i)).map((ym) => ({
    ym,
    shopping: shop.filter((i) => i.day.slice(0, 7) === ym).reduce((n, i) => n + i.cents, 0),
    bills: paid.filter((b) => b.paidOn.slice(0, 7) === ym).reduce((n, b) => n + b.cents, 0),
  }));
  const top = Math.max(1, ...months.map((m) => m.shopping + m.bills));
  months.forEach((m) => { m.total = m.shopping + m.bills; m.pctShop = Math.round((m.shopping / top) * 100); m.pctBills = Math.round((m.bills / top) * 100); });
  const shopNow = shop.filter((i) => inMonth(i.day));
  const billsNow = paid.filter((b) => inMonth(b.paidOn));
  return {
    months,
    now: months[months.length - 1],
    before: months[months.length - 2],
    byStore: rank(shopNow, (i) => (i.store === 'Any store' ? 'Any store' : i.store), (i) => i.cents),
    byTag: rank(shopNow, (i) => (i.tag === 'Unassigned' ? 'No tag' : i.tag), (i) => i.cents),
    topItems: rank(shopNow, (i) => i.name, (i) => i.cents).slice(0, 8),
    byCategory: rank(billsNow, (b) => b.category, (b) => b.cents),
    counted: shopNow.length,
  };
}

module.exports = { spending };
