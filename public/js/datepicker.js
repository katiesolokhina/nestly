// Nestly's date picker, used for every date field. The real <input type="date"> stays in the form
// (hidden), so saving, min/max and the "No date" buttons work as before; a button shows the date and
// opens a sheet with month and year dropdowns, quick picks, a month grid, and a box to type it.
// The calendar page's month name opens the same sheet to jump to any month and year.
(() => {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : null);
  const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  const short = (s) => { const d = parse(s); return d ? `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}` : ''; };
  const nice = (s) => { const d = parse(s); return d ? `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}` : ''; };
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => { if (k === 'text') n.textContent = v; else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v); });
    kids.forEach((k) => n.append(k));
    return n;
  };

  // Quick picks, by what the date is for.
  function quickFor(input) {
    const name = `${input.name} ${input.id}`.toLowerCase();
    const t = today();
    const at = (days = 0, months = 0, years = 0) => iso(new Date(t.getFullYear() + years, t.getMonth() + months, t.getDate() + days));
    if (/bought|paid|from|to\b/.test(name)) return [['Today', at()], ['Yesterday', at(-1)], ['A week ago', at(-7)]];
    if (/expire/.test(name)) return [['+1 week', at(7)], ['+2 weeks', at(14)], ['+1 month', at(0, 1)], ['+6 months', at(0, 6)], ['+1 year', at(0, 0, 1)]];
    const sat = (6 - t.getDay() + 7) % 7 || 7;
    return [['Today', at()], ['Tomorrow', at(1)], ['Saturday', at(sat)], ['Next week', at(7)], ['Next month', at(0, 1)]];
  }

  // One sheet for the whole page, filled in for whichever field opened it.
  let sheet;
  let state; // { mode: 'date'|'month', input, y, m, picked, onPick }
  function build() {
    sheet = el('dialog', { class: 'dp', 'aria-label': 'Pick a date' });
    sheet.innerHTML = `
      <form method="dialog" class="dp-body">
        <div class="dp-head"><div><span class="dp-label"></span><strong class="dp-picked"></strong></div><button type="button" class="link-btn link-danger dp-none">No date</button></div>
        <div class="dp-quick"></div>
        <div class="dp-nav">
          <button type="button" class="dp-step" data-step="-1" aria-label="Previous month">‹</button>
          <label class="sr-only" for="dp-month">Month</label><select id="dp-month" class="dp-month"></select>
          <label class="sr-only" for="dp-year">Year</label><select id="dp-year" class="dp-year"></select>
          <button type="button" class="dp-step" data-step="1" aria-label="Next month">›</button>
        </div>
        <div class="dp-grid" role="grid"></div>
        <div class="dp-months"></div>
        <div class="field dp-typed"><label for="dp-typed">Or type it</label><input id="dp-typed" type="text" inputmode="numeric" placeholder="MM/DD/YYYY" autocomplete="off"></div>
        <div class="dp-foot"><button type="button" class="btn btn-ghost dp-cancel">Cancel</button><button type="button" class="btn btn-primary dp-done">Done</button></div>
      </form>`;
    document.body.append(sheet);
    const q = (s) => sheet.querySelector(s);
    MONTHS.forEach((name, i) => q('.dp-month').append(el('option', { value: i, text: name })));
    q('.dp-month').addEventListener('change', (e) => { state.m = +e.target.value; render(); });
    q('.dp-year').addEventListener('change', (e) => { state.y = +e.target.value; render(); });
    sheet.querySelectorAll('.dp-step').forEach((b) => b.addEventListener('click', () => {
      const k = +b.dataset.step * (state.mode === 'month' ? 12 : 1);
      const d = new Date(state.y, state.m + k, 1);
      state.y = d.getFullYear(); state.m = d.getMonth(); render();
    }));
    q('.dp-cancel').addEventListener('click', () => sheet.close());
    q('.dp-none').addEventListener('click', () => { state.onPick(''); sheet.close(); });
    q('.dp-done').addEventListener('click', () => {
      const typed = readTyped(q('.dp-typed input').value);
      if (typed === null) { q('.dp-typed input').setCustomValidity('Type it as MM/DD/YYYY'); q('.dp-typed input').reportValidity(); return; }
      if (typed) state.picked = typed;
      state.onPick(state.picked || '');
      sheet.close();
    });
    q('.dp-typed input').addEventListener('input', (e) => e.target.setCustomValidity(''));
    q('.dp-typed input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q('.dp-done').click(); } });
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); }); // tap outside
  }
  // '' when blank, null when it isn't a date, else YYYY-MM-DD.
  function readTyped(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const d = new Date(y, +m[1] - 1, +m[2]);
    return d.getMonth() === +m[1] - 1 ? iso(d) : null;
  }
  const inRange = (s) => (!state.min || s >= state.min) && (!state.max || s <= state.max);

  function render() {
    const q = (s) => sheet.querySelector(s);
    const isMonth = state.mode === 'month';
    q('.dp-label').textContent = state.label;
    q('.dp-picked').textContent = isMonth ? `${MONTHS[state.m]} ${state.y}` : nice(state.picked) || 'No date';
    q('.dp-none').hidden = isMonth || state.required;
    q('.dp-typed').hidden = isMonth;
    q('.dp-grid').hidden = isMonth;
    q('.dp-months').hidden = !isMonth;
    q('.dp-month').hidden = isMonth;
    q('.dp-done').hidden = isMonth;
    sheet.querySelectorAll('.dp-step').forEach((b) => { b.setAttribute('aria-label', `${+b.dataset.step < 0 ? 'Previous' : 'Next'} ${isMonth ? 'year' : 'month'}`); });
    // Years: a wide range (birthdays), kept inside min and max.
    const ys = q('.dp-year');
    const now = today().getFullYear();
    const lo = Math.max(state.min ? +state.min.slice(0, 4) : now - 100, Math.min(state.y, now - 100));
    const hi = Math.min(state.max ? +state.max.slice(0, 4) : now + 30, Math.max(state.y, now + 30));
    ys.replaceChildren(...Array.from({ length: hi - lo + 1 }, (_, i) => el('option', { value: lo + i, text: lo + i })));
    ys.value = state.y;
    q('.dp-month').value = state.m;
    // Quick picks.
    q('.dp-quick').replaceChildren(...(isMonth ? [['This month', iso(today())]] : quickFor(state.input)).filter(([, v]) => isMonth || inRange(v)).map(([l, v]) => {
      const b = el('button', { type: 'button', class: 'chip', text: l });
      b.addEventListener('click', () => {
        const d = parse(v);
        if (isMonth) { state.onPick(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); sheet.close(); return; }
        state.picked = v; state.y = d.getFullYear(); state.m = d.getMonth(); render();
      });
      return b;
    }));
    if (isMonth) {
      q('.dp-months').replaceChildren(...MONTHS.map((name, i) => {
        const on = i === state.m && state.y === state.startY;
        const b = el('button', { type: 'button', class: `dp-mo${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', text: name.slice(0, 3) });
        b.addEventListener('click', () => { state.onPick(`${state.y}-${pad(i + 1)}`); sheet.close(); });
        return b;
      }));
      return;
    }
    // The month grid.
    const first = new Date(state.y, state.m, 1).getDay();
    const len = new Date(state.y, state.m + 1, 0).getDate();
    const cells = DAYS.map((d) => el('span', { class: 'dp-dow', 'aria-hidden': 'true', text: d.charAt(0) }));
    for (let i = 0; i < first; i++) cells.push(el('span'));
    const t = iso(today());
    for (let n = 1; n <= len; n++) {
      const v = `${state.y}-${pad(state.m + 1)}-${pad(n)}`;
      const b = el('button', { type: 'button', class: `dp-day${v === state.picked ? ' on' : ''}${v === t ? ' now' : ''}`, 'aria-label': nice(v), 'aria-pressed': v === state.picked ? 'true' : 'false', disabled: !inRange(v), text: n });
      b.addEventListener('click', () => { state.picked = v; render(); });
      cells.push(b);
    }
    q('.dp-grid').replaceChildren(...cells);
  }

  function open(opts) {
    if (!sheet) build();
    const start = parse(opts.value) || parse(opts.min) || today();
    state = { ...opts, picked: opts.value || '', y: start.getFullYear(), m: start.getMonth(), startY: start.getFullYear() };
    sheet.querySelector('.dp-typed input').value = '';
    render();
    sheet.showModal();
  }

  // Each date field: hidden, with a button that shows its date and opens the sheet.
  const labelOf = (input) => {
    const l = input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    return (l && l.textContent.trim()) || input.getAttribute('aria-label') || 'Date';
  };
  const done = new WeakSet();
  function wire(input) {
    if (done.has(input) || input.dataset.native !== undefined) return;
    done.add(input);
    // A copied row brings a copy of the button: replace it with one wired to this field.
    if (input.nextElementSibling && input.nextElementSibling.classList.contains('dp-field')) input.nextElementSibling.remove();
    const label = labelOf(input); // read before the label is pointed at the button
    const btn = el('button', { type: 'button', class: 'dp-field', 'aria-haspopup': 'dialog' });
    const show = () => {
      btn.textContent = input.value ? short(input.value) : input.placeholder || 'Pick a date';
      btn.classList.toggle('empty', !input.value);
      btn.setAttribute('aria-label', `${label}: ${input.value ? nice(input.value) : 'no date'}. Change`);
    };
    input.classList.add('dp-native');
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.after(btn);
    // The label now points at the button.
    if (input.id) document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).forEach((l) => { l.htmlFor = ''; l.addEventListener('click', () => btn.focus()); });
    btn.addEventListener('click', () => open({
      mode: 'date', input, label, value: input.value, min: input.min, max: input.max, required: input.required,
      onPick: (v) => { input.value = v; show(); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); },
    }));
    ['input', 'change'].forEach((ev) => input.addEventListener(ev, show));
    // Scripts that set the value directly (copying a row, "No date") are caught too.
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', { configurable: true, get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); show(); } });
    show();
  }
  const scan = (root) => root.querySelectorAll('input[type="date"]').forEach(wire);
  scan(document);
  // Rows added later (another use-by date line) get one too.
  new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches('input[type="date"]')) wire(n); else scan(n); } }))).observe(document.body, { childList: true, subtree: true });

  // The calendar page: tap the month name to jump to any month and year.
  document.querySelectorAll('[data-month-jump]').forEach((btn) => {
    btn.addEventListener('click', () => open({
      mode: 'month', label: 'Go to', value: `${btn.dataset.monthJump}-01`,
      onPick: (ym) => { location.href = btn.dataset.href.replace('MONTH', ym).replace('DAY', `${ym}-01`); },
    }));
  });
})();
