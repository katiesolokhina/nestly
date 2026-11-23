// A role's page: each section's Shown/Hidden switch, opening a section to its parts, and the short
// line under its name ("3 allowed · 1 view only · 2 off") as choices change.
(() => {
  const HIDDEN = 'Hidden: not in the menu, search, Today or notifications';
  const tally = (kind, v) => (['no', 'hidden'].includes(v) || (kind === 'scope' && v === 'none') ? 'off' : v === 'view' || (kind === 'main' && v === 'none') ? 'view' : 'on');
  const summary = (sec) => {
    const n = { on: 0, view: 0, off: 0 };
    sec.querySelectorAll('select[data-kind]').forEach((s) => { n[tally(s.dataset.kind, s.value)]++; });
    return [n.on && `${n.on} allowed`, n.view && `${n.view} view only`, n.off && `${n.off} off`].filter(Boolean).join(' · ');
  };
  const setOpen = (sec, open) => {
    const btn = sec.querySelector('[data-perm-toggle]');
    sec.querySelector('.perm-parts').hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    sec.classList.toggle('open', open);
  };
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-perm-toggle]');
    if (!btn) return;
    const sec = btn.closest('[data-perm]');
    setOpen(sec, btn.getAttribute('aria-expanded') !== 'true');
  });
  document.addEventListener('change', (e) => {
    const sec = e.target.closest('[data-perm]');
    if (!sec) return;
    const show = sec.querySelector('[data-perm-show]').checked;
    if (e.target.matches('[data-perm-show]')) {
      sec.querySelector('[data-switch-text]').textContent = show ? 'Shown' : 'Hidden';
      sec.querySelector('[data-perm-toggle]').disabled = !show;
      setOpen(sec, show);
    }
    sec.querySelector('[data-perm-sum]').textContent = show ? summary(sec) : HIDDEN;
  });
})();
