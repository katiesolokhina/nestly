// Merge page: the kept one isn't renamed into a kind of itself (its kind row hides), the kind-name
// hints follow the kept name, and with one item there's a box to find what to merge it into.
document.querySelectorAll('[data-merge-form]').forEach((form) => {
  const nameOf = (s, target) => {
    const t = target.toLowerCase().split(/\s+/);
    return s.split(/\s+/).filter((w) => !t.includes(w.toLowerCase())).join(' ') || s;
  };
  const update = () => {
    const keep = form.querySelector('input[name="keep"]:checked');
    const target = (form.querySelector('#merge-name').value.trim()) || (keep ? keep.dataset.name : '');
    form.querySelectorAll('[data-merge-kind]').forEach((row) => {
      // The kept one only needs a kind name when it has no kinds yet (it gets one then).
      row.hidden = Boolean(keep && row.dataset.mergeKind === keep.value && row.dataset.hasKinds);
      const input = row.querySelector('input');
      if (target) input.placeholder = nameOf(row.dataset.itemName, target);
      const lab = row.querySelector('label');
      if (!lab.dataset.base) lab.dataset.base = lab.textContent;
      lab.textContent = keep && row.dataset.mergeKind === keep.value ? `${row.dataset.itemName} (kept) →` : lab.dataset.base;
    });
    form.querySelectorAll('.merge-pick').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
  };
  // The main photo starts as the kept one's, until someone picks another.
  let photoPicked = false;
  form.addEventListener('change', (e) => {
    if (e.target.matches('[data-main-photo]')) photoPicked = true;
    else if (e.target.name === 'keep' && !photoPicked) { const p = form.querySelector(`[data-main-photo][value="${e.target.value}"]`); if (p) p.checked = true; }
    update();
  });
  form.addEventListener('input', (e) => { if (e.target.id === 'merge-name') update(); });
  const find = form.querySelector('[data-merge-find]');
  if (find) find.addEventListener('input', () => {
    const q = find.value.trim().toLowerCase();
    form.querySelectorAll('[data-merge-row]').forEach((r) => { r.hidden = Boolean(q) && !r.dataset.search.includes(q); });
  });
  { const k = form.querySelector('input[name="keep"]:checked'); const p = k && form.querySelector(`[data-main-photo][value="${k.value}"]`); if (p) p.checked = true; }
  update();
});
