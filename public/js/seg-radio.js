// Segmented radio buttons: highlight the picked one as it changes. On a role's page, Custom opens
// that section's checkboxes.
document.addEventListener('change', (e) => {
  if (!e.target.matches('.perm-seg input[type="radio"]')) return;
  e.target.closest('.perm-seg').querySelectorAll('.seg-item').forEach((l) => l.classList.toggle('on', l.contains(e.target) ? e.target.checked : false));
  const block = e.target.closest('[data-perm]');
  const panel = block && block.querySelector('[data-custom]');
  if (panel) panel.hidden = e.target.value !== 'custom';
});
