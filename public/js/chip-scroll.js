// Keeps the selected filter visible in a row that scrolls sideways.
document.querySelectorAll('[data-chip-scroll]').forEach((row) => {
  const on = row.querySelector('[aria-current]');
  if (on) row.scrollLeft = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
});
