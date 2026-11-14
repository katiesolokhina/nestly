// Bill form: shows the fields for the chosen split and keeps a running total.
// Without JavaScript, every field shows and the server checks the numbers.
document.querySelectorAll('[data-bill-form]').forEach((form) => {
  const total = form.querySelector('[data-total]');
  const mode = form.querySelector('[data-split-mode]');
  const repeat = form.querySelector('[data-repeat]');
  const priv = form.querySelector('[data-private]');
  const split = form.querySelector('[data-split]');
  const sum = form.querySelector('[data-split-sum]');
  const rows = [...form.querySelectorAll('[data-person]')];
  const cents = (v) => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
  const fmt = (c) => `$${(c / 100).toFixed(2)}`;

  const update = () => {
    form.querySelectorAll('[data-repeat-only]').forEach((el) => { el.hidden = repeat.value === 'none'; });
    split.hidden = Boolean(priv && priv.checked);
    const m = mode.value;
    const on = rows.filter((r) => r.querySelector('[data-person-on]').checked);
    const t = cents(total.value);
    rows.forEach((r) => {
      const picked = r.querySelector('[data-person-on]').checked;
      r.querySelector('[data-person-on]').closest('.split-row').classList.toggle('off', !picked);
      r.querySelector('[data-amt]').hidden = m !== 'amount' || !picked;
      r.querySelector('[data-pct]').hidden = m !== 'percent' || !picked;
      r.querySelector('[data-even]').textContent = '';
    });
    form.querySelector('[data-split-people]').hidden = m === 'none';
    if (m === 'even' && on.length) {
      const base = Math.floor(t / on.length);
      on.forEach((r, i) => { r.querySelector('[data-even]').textContent = fmt(base + (i < t - base * on.length ? 1 : 0)); });
      sum.textContent = '';
    } else if (m === 'amount') {
      const s = on.reduce((n, r) => n + cents(r.querySelector('[data-amt]').value), 0);
      sum.textContent = s === t ? `Adds up to ${fmt(t)}.` : `Adds up to ${fmt(s)} of ${fmt(t)}: ${fmt(Math.abs(t - s))} ${s < t ? 'left' : 'too much'}.`;
    } else if (m === 'percent') {
      const p = on.reduce((n, r) => n + (parseFloat(r.querySelector('[data-pct]').value) || 0), 0);
      sum.textContent = Math.abs(p - 100) < 0.001 ? 'Adds up to 100%.' : `Adds up to ${Math.round(p * 100) / 100}% of 100%.`;
    } else {
      sum.textContent = '';
    }
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
});
