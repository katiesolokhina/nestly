// Tick, delete, and star without reloading the page. The row changes right away and the server
// catches up in the background, so there's no wait and a second tap on the same row is ignored.
// Forms opt in with data-quick="bought" | "remove" | "star". Without JavaScript they post as usual.
(function () {
  if (!window.fetch || !window.URLSearchParams) return;
  const HEADERS = { 'X-Requested-With': 'fetch', Accept: 'application/json' };
  let undoTimer = null;

  function undoBar(undo) {
    document.querySelectorAll('.undo-bar').forEach((b) => b.remove());
    clearTimeout(undoTimer);
    if (!undo) return;
    const bar = document.createElement('div');
    bar.className = 'undo-bar float';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = undo.text;
    const form = document.createElement('form');
    form.method = 'post';
    form.action = `/activity/${undo.id}/undo`;
    const back = document.createElement('input');
    back.type = 'hidden';
    back.name = 'back';
    back.value = location.pathname + location.search;
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'link-btn undo-btn';
    btn.textContent = 'Undo';
    form.append(back, btn);
    bar.append(text, form);
    document.body.append(bar);
    undoTimer = setTimeout(() => bar.remove(), 8000);
  }

  // "5 items" style counts on the page, one less each time a row goes.
  function countDown() {
    document.querySelectorAll('[data-count]').forEach((c) => {
      const n = Math.max(0, (parseInt(c.dataset.count, 10) || 0) - 1);
      c.dataset.count = n;
      c.textContent = `${n} ${n === 1 ? c.dataset.one : c.dataset.many}`;
    });
  }

  function tidy(group) {
    // An aisle with nothing left in it goes too, and an empty list says so.
    if (group && group.matches('[data-group]') && !group.querySelector('[data-swipe]')) group.remove();
    document.querySelectorAll('[data-list]').forEach((list) => {
      if (list.querySelector('[data-swipe]') || list.querySelector('.empty-note')) return;
      const p = document.createElement('p');
      p.className = 'muted small center empty-note';
      p.textContent = list.dataset.empty || 'Nothing here right now.';
      list.append(p);
    });
  }

  function collapse(el) {
    el.style.height = `${el.offsetHeight}px`;
    void el.offsetHeight; // start the animation from the current height
    el.classList.add('leaving');
    el.style.height = '0px';
    countDown();
    setTimeout(() => {
      const group = el.closest('[data-group]');
      el.remove();
      tidy(group);
    }, 220);
  }

  // A ticked item shows up under Bought, without waiting for a reload.
  function addBought(row, id) {
    const card = document.getElementById('bought-card');
    const tpl = document.getElementById('bought-row');
    if (!card || !tpl || !id) return;
    const node = tpl.content.firstElementChild.cloneNode(true);
    const name = row.querySelector('.row-title').textContent;
    node.querySelector('form').action = `/s/shopping/${id}/toggle`;
    node.querySelector('.check').setAttribute('aria-label', `Move ${name} back to the list`);
    const edit = node.querySelector('[data-edit]');
    edit.href = `/s/shopping/${id}/edit`;
    edit.setAttribute('aria-label', `Edit ${name}`);
    node.querySelector('.row-title').textContent = name;
    const meta = row.querySelector('.row-meta');
    node.querySelector('.row-meta').textContent = meta ? meta.textContent : '';
    node.querySelector('[data-receipt]').href = `/s/shopping/${id}/edit#receipt`;
    card.querySelector('[data-bought-list]').prepend(node);
    card.hidden = false;
  }

  // The staples card on Saved items follows the stars.
  async function refreshStaples() {
    const card = document.getElementById('staples');
    if (!card) return;
    try {
      const res = await fetch(location.pathname + location.search, { credentials: 'same-origin' });
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const fresh = doc.getElementById('staples');
      if (fresh) card.replaceWith(fresh);
    } catch { /* it'll be right on the next visit */ }
  }

  async function send(form, body) {
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        body,
        headers: HEADERS,
        credentials: 'same-origin',
      });
      if (!(res.headers.get('content-type') || '').includes('application/json')) {
        // Signed out, view only, or something went wrong: show what the server says.
        if (res.redirected) location.href = res.url;
        else location.reload();
        return null;
      }
      return await res.json(); // {gone: true} means it was already done: the row is gone either way
    } catch {
      location.reload(); // offline or a dropped connection: show the list as it really is
      return null;
    }
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    const kind = form.dataset && form.dataset.quick;
    if (!kind) return;
    e.preventDefault();
    const el = form.closest('[data-swipe]') || form.closest('.row');
    if (!el || el.dataset.busy) return;
    el.dataset.busy = '1';
    const id = (form.action.match(/\/([a-f0-9]{24})\//) || [])[1];
    const body = new URLSearchParams(new FormData(form)); // before the star flips its own value

    if (kind === 'remove') collapse(el);
    if (kind === 'bought') {
      const check = form.querySelector('.check');
      check.classList.add('on');
      check.querySelector('i').textContent = '✓';
      setTimeout(() => collapse(el), 250); // long enough to see the tick
    }
    if (kind === 'star') {
      const on = form.querySelector('[name="on"]');
      const star = form.querySelector('.star');
      const nowOn = on.value === '1';
      star.classList.toggle('on', nowOn);
      star.textContent = nowOn ? '★' : '☆';
      star.setAttribute('aria-pressed', String(nowOn));
      on.value = nowOn ? '0' : '1';
    }

    const data = await send(form, body);
    if (!data) return;
    if (kind === 'bought' && data.ok) addBought(el, id);
    if (kind === 'star') {
      delete el.dataset.busy;
      refreshStaples();
    }
    undoBar(data.undo);
  });
})();
