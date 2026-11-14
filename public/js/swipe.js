// Swipe a shopping item left to show Delete; swipe far to delete it straight away.
// Every delete can be undone from the bar that appears, or from Activity.
(function () {
  const rows = document.querySelectorAll('[data-swipe]');
  if (!rows.length) return;
  const OPEN = 96;
  let open = null;
  const set = (el, x, animate) => {
    const row = el.lastElementChild;
    if (x) el.classList.add('swiping');
    else setTimeout(() => { if (!row.style.transform) el.classList.remove('swiping'); }, animate ? 220 : 0);
    row.style.transition = animate ? 'transform .2s ease' : 'none';
    row.style.transform = x ? `translateX(${x}px)` : '';
  };
  const close = (el) => { if (el) set(el, 0, true); if (open === el) open = null; };

  rows.forEach((el) => {
    const form = el.querySelector('.swipe-delete');
    let startX = 0; let startY = 0; let dx = 0; let tracking = false; let swiping = false; let base = 0;
    el.addEventListener('touchstart', (e) => {
      if (open && open !== el) close(open);
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY; dx = 0; tracking = true; swiping = false;
      base = open === el ? -OPEN : 0;
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const mx = t.clientX - startX;
      const my = t.clientY - startY;
      if (!swiping) {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { tracking = false; return; } // scrolling
        if (Math.abs(mx) < 10) return;
        swiping = true;
      }
      dx = Math.min(0, base + mx);
      set(el, dx, false);
    }, { passive: true });
    el.addEventListener('touchend', () => {
      if (!tracking || !swiping) { tracking = false; return; }
      tracking = false;
      const width = el.offsetWidth;
      if (-dx > width * 0.55) {
        set(el, -width, true);
        setTimeout(() => form.submit(), 180);
      } else if (-dx > 40) {
        set(el, -OPEN, true);
        open = el;
      } else {
        close(el);
      }
      // A swipe isn't a tap: don't open the item or tick it.
      const block = (e) => { e.preventDefault(); e.stopPropagation(); };
      el.addEventListener('click', block, { capture: true });
      setTimeout(() => el.removeEventListener('click', block, { capture: true }), 400);
    });
  });
  document.addEventListener('touchstart', (e) => { if (open && !open.contains(e.target)) close(open); }, { passive: true });
})();
