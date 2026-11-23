// Barcode scanner. Uses the phone's built-in reader when there is one (Android Chrome) and
// otherwise loads ZXing (iPhone Safari, Firefox). The number can always be typed instead.
(function () {
  const dialog = document.querySelector('[data-scanner]');
  if (!dialog) return;
  const mode = dialog.dataset.mode;
  const video = dialog.querySelector('video');
  const view = dialog.querySelector('[data-scan-view]');
  const msg = dialog.querySelector('[data-scan-msg]');
  const manual = dialog.querySelector('[data-scan-manual]');
  const result = dialog.querySelector('[data-scan-result]');
  const found = dialog.querySelector('[data-scan-found]');
  const go = dialog.querySelector('[data-scan-go]');
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
  let stream = null;
  let reader = null;
  let timer = null;
  let busy = false;

  const say = (text) => { msg.textContent = text; };

  function stop() {
    clearTimeout(timer);
    if (reader) { try { reader.reset(); } catch { /* already stopped */ } reader = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null;
  }

  function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/vendor/zxing.min.js';
      s.onload = () => resolve(window.ZXing);
      s.onerror = reject;
      document.head.append(s);
    });
  }

  async function start() {
    busy = false;
    result.hidden = true;
    manual.hidden = false;
    view.hidden = false;
    say('Point the camera at a barcode.');
    const constraints = { video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false };
    try {
      const native = 'BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).some((f) => FORMATS.includes(f));
      if (native) {
        const detector = new window.BarcodeDetector({ formats: FORMATS });
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        await video.play();
        const tick = async () => {
          if (!stream) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length) return onCode(codes[0].rawValue);
          } catch { /* a frame that couldn't be read */ }
          timer = setTimeout(tick, 150);
        };
        tick();
      } else {
        const ZX = await loadZxing();
        const hints = new Map([[ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E]]]);
        reader = new ZX.BrowserMultiFormatReader(hints, 150);
        await reader.decodeFromConstraints(constraints, video, (res) => { if (res) onCode(res.getText()); });
      }
    } catch (err) {
      stop();
      view.hidden = true;
      say(err && err.name === 'NotAllowedError'
        ? 'Nestly can’t use the camera. Allow it in your browser settings, or type the number under the barcode.'
        : 'The camera isn’t available here. Type the number under the barcode instead.');
      manual.querySelector('input').focus();
    }
  }

  async function onCode(raw) {
    const code = String(raw || '').replace(/\D/g, '');
    if (busy || code.length < 8 || code.length > 14) return;
    busy = true;
    stop();
    if (navigator.vibrate) navigator.vibrate(60);
    view.hidden = true;
    say(`Looking up ${code}…`);
    let data;
    try {
      const res = await fetch(`/api/barcode/${code}?for=${mode}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.redirected || !res.ok) throw new Error();
      data = await res.json();
    } catch {
      data = { code, name: '', brand: '', size: '', source: null };
    }
    show(data);
  }

  function show(d) {
    // Pantry: on to the add page, which asks for the date, how many, and (if it's there already)
    // whether to add to it, replace it, or keep it separate.
    if (mode === 'pantry') {
      const found = d.source === 'saved' ? 'You’ve scanned this before.'
        : d.source === 'lookup' ? `Found: ${[d.brand, d.name, d.size].filter(Boolean).join(' · ')}`
          : 'Not found. Type what it is once, and Nestly will remember this barcode.';
      location.href = `/s/pantry/add?${new URLSearchParams({ name: d.name || '', code: d.code, brand: d.brand || '', found })}`;
      return;
    }
    manual.hidden = true;
    result.hidden = false;
    result.elements.code.value = d.code;
    result.elements.brand.value = d.brand || '';
    result.elements.name.value = d.name || '';
    const parts = [];
    if (d.source === 'saved') parts.push(d.kindName ? `You’ve scanned this before: ${d.kindName}.` : 'You’ve scanned this before.');
    else if (d.source === 'lookup') parts.push(`Found: ${[d.brand, d.name, d.size].filter(Boolean).join(' · ')}. Change the name if you like.`);
    else parts.push('Not found. Type what it is once, and Nestly will remember this barcode.');
    if (mode === 'shopping' && d.onList && !d.onList.bought) parts.push(`${d.onList.name} is already on the list.`);
    if (mode === 'shop') {
      const onIt = d.onList && !d.onList.bought;
      result.elements.action.value = onIt ? 'tick' : 'bought';
      go.textContent = onIt ? `Tick off ${d.onList.name}` : 'Not on the list: add it as bought';
    }
    found.textContent = parts.join(' ');
    const warn = dialog.querySelector('[data-scan-warn]');
    if (warn) { warn.textContent = (d.warn || []).join(' · '); warn.hidden = !(d.warn || []).length; }
    const kindBox = dialog.querySelector('[data-scan-kind]');
    if (kindBox) {
      kindBox.hidden = !d.kind;
      kindBox.className = `scan-kind ${d.kind ? d.kind.tone : ''}`;
      kindBox.replaceChildren(...(d.kind ? [Object.assign(document.createElement('strong'), { textContent: d.kind.title }), Object.assign(document.createElement('span'), { textContent: d.kind.text })] : []));
    }
    say('');
    if (!d.name) result.elements.name.focus();
    else if (mode === 'shop' && d.onList && !d.onList.bought) go.focus();
  }

  // "Save, scan next": the page reloads with ?scan=1 and the scanner opens again.
  result.addEventListener('click', (e) => {
    if (e.target.closest('[data-again]')) result.elements.again.value = '1';
    else if (e.target.closest('[data-scan-go]') && mode !== 'shop') result.elements.again.value = '0';
  });
  manual.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = manual.querySelector('input').value.replace(/\D/g, '');
    if (v.length >= 8) { stop(); busy = false; onCode(v); } else say('Barcode numbers are 8 to 14 digits.');
  });
  dialog.querySelector('[data-scan-retry]').addEventListener('click', () => start());
  dialog.querySelector('[data-scan-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stop);

  const open = () => { if (!dialog.open) dialog.showModal(); start(); };
  document.querySelectorAll('[data-scan-open]').forEach((b) => { b.hidden = false; b.addEventListener('click', open); });
  if (new URLSearchParams(location.search).get('scan') === '1') {
    history.replaceState(null, '', location.pathname + location.search.replace(/([?&])scan=1&?/, '$1').replace(/[?&]$/, '') + location.hash);
    open();
  }
})();
