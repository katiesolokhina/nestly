// Segmented radio buttons: highlight the picked one as it changes.
document.addEventListener('change', (e) => {
  if (!e.target.matches('.perm-seg input[type="radio"]')) return;
  e.target.closest('.perm-seg').querySelectorAll('.seg-item').forEach((l) => l.classList.toggle('on', l.contains(e.target) ? e.target.checked : false));
});
