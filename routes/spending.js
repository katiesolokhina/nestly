// Spending: where the money went, from shopping prices and paid bills.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { visible } = require('../lib/changes');
const { spending } = require('../lib/spending');
const { money } = require('../lib/bills');
const { currency } = require('../lib/prefs');
const { todayIn, monthLabel, shiftMonth } = require('../lib/dates');

const router = express.Router();

router.get('/spending', requireAuth, async (req, res, next) => {
  try {
    const shopping = req.sees('shopping');
    const bills = req.sees('bills');
    if (!shopping && !bills) return res.status(404).send('Not found');
    const thisMonth = todayIn(req.user.timezone).slice(0, 7);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '') && req.query.month <= thisMonth ? req.query.month : thisMonth;
    const data = await spending({ scope: visible(req.user), tz: req.user.timezone, month, shopping, bills });
    const cur = currency(req.household);
    res.render('spending', {
      active: 'more',
      ...data,
      shopping,
      bills,
      month,
      label: monthLabel(month),
      prev: shiftMonth(month, -1),
      next: month < thisMonth ? shiftMonth(month, 1) : null,
      m: (cents) => money(cents, cur),
      short: (ym) => monthLabel(ym).slice(0, 3),
      monthLabel,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
