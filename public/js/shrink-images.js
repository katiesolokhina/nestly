// Shrinks photos picked in inputs marked data-shrink (to 1600 px, JPEG) before they're sent, so
// screenshots upload quickly on a phone. Formats the browser can't draw (HEIC) go as they are.
(function () {
  const MAX = 1600;
  async function shrink(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }
  document.querySelectorAll('input[type="file"][data-shrink]').forEach((input) => {
    const note = input.closest('.field') && input.closest('.field').querySelector('[data-shrink-note]');
    const max = Number(input.dataset.maxFiles) || 10;
    const first = note ? note.textContent : '';
    input.addEventListener('change', async () => {
      let files = [...input.files];
      if (files.length > max) { files = files.slice(0, max); if (note) note.textContent = `Only the first ${max} will be sent.`; } else if (note) note.textContent = first;
      if (!window.DataTransfer) return;
      const dt = new DataTransfer();
      for (const f of await Promise.all(files.map(shrink))) dt.items.add(f);
      input.files = dt.files;
    });
  });
})();
