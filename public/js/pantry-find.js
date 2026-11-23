// Pantry "Find or add": filters the list as you type (by name, or a tag it starts), and offers
// "+ Add" for a name that isn't there, which opens the full add form with it filled in.
(() => {
  const box = document.querySelector('[data-pantry-find]');
  if (!box) return;
  const add = document.querySelector('[data-find-add]');
  const tagNote = document.querySelector('[data-find-tag]');
  const codeNote = document.querySelector('[data-find-code]');
  const rows = [...document.querySelectorAll('[data-find-row]')];
  const tags = [...new Set(rows.flatMap((r) => (r.dataset.tags ? r.dataset.tags.split('|') : [])))];
  const run = () => {
    const q = box.value.trim().toLowerCase();
    const tag = q ? tags.find((t) => t.startsWith(q)) : '';
    let exact = false;
    rows.forEach((r) => {
      const hit = !q || r.dataset.name.includes(q) || (tag && r.dataset.tags.split('|').includes(tag));
      r.hidden = !hit;
      if (r.dataset.name === q) exact = true;
    });
    document.querySelectorAll('[data-find-group]').forEach((g) => { g.hidden = ![...g.querySelectorAll('[data-find-row]')].some((r) => !r.hidden); });
    const none = document.querySelector('[data-find-none]');
    if (none && rows.length) none.hidden = rows.some((r) => !r.hidden);
    // A barcode number: Enter (or the link) looks it up like a scan.
    const code = /^\d{8,14}$/.test(q.replace(/[\s-]/g, ''));
    if (add) {
      add.hidden = !q || exact || Boolean(tag) || code;
      add.querySelector('[data-find-name]').textContent = box.value.trim();
      const u = new URL(add.href, location.href);
      u.searchParams.set('name', box.value.trim());
      add.href = u.pathname + u.search;
    }
    if (codeNote) codeNote.hidden = !code;
    if (code && none) none.hidden = true;
    if (tagNote) {
      tagNote.hidden = !tag;
      if (tag) tagNote.querySelector('[data-find-tag-name]').textContent = tag.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  };
  box.addEventListener('input', run);
  // Enter with a new name goes straight to adding it.
  box.form.addEventListener('submit', (e) => {
    if (add && !add.hidden) { e.preventDefault(); location.href = add.href; }
  });
})();

// The ⋯ menu and the Filter panel close when you tap anywhere else.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.more-menu[open], details.filter-pop[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});
