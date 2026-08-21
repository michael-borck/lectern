(async () => {
  // this page is served at /<deck>/
  const deck = location.pathname.split('/').filter(Boolean)[0];
  document.title = deck;

  const params = new URLSearchParams(location.search);
  let currentKey = params.get('key'); // ?key=... still works, skips the prompt
  const wantsPresent = params.has('present') || currentKey !== null;
  let confirmedPresenter = false; // only true once the server accepts the key
  let intentionalClose = false;

  const slides = await (await fetch('slides.json')).json();
  const container = document.querySelector('.slides');
  container.innerHTML = slides.length
    ? slides
        .map((f) => `<section><img src="slides/${encodeURIComponent(f)}" alt=""></section>`)
        .join('')
    : '<section><p>No slides yet — drop PNGs into this deck’s folder and reload.</p></section>';

  await Reveal.initialize({
    hash: false,
    transition: 'fade',
    transitionSpeed: 'fast',
    width: 1600,
    height: 900,
    margin: 0.02,
    center: true,
    // presenter mode always gets local navigation; a valid key only
    // controls whether slide moves are broadcast to viewers
    controls: wantsPresent,
    progress: wantsPresent,
    keyboard: wantsPresent,
    touch: wantsPresent,
    overview: wantsPresent,
  });

  const hud = document.getElementById('hud');
  const badge = document.getElementById('badge');
  const conn = document.getElementById('conn');
  const overlay = document.getElementById('key-overlay');
  const keyForm = document.getElementById('key-form');
  const keyInput = document.getElementById('key-input');

  function askKey() {
    overlay.hidden = false;
    keyInput.value = '';
    keyInput.focus();
  }

  keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const k = keyInput.value.trim();
    if (!k) return;
    currentKey = k;
    overlay.hidden = true;
    badge.textContent = 'CONNECTING…';
    reconnect();
  });

  function cancelKey() {
    overlay.hidden = true;
  }
  document.getElementById('key-cancel').addEventListener('click', cancelKey);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) cancelKey();
  });

  // clicking KEY REJECTED / ENTER KEY lets you try again
  badge.addEventListener('click', () => {
    if (wantsPresent && !confirmedPresenter) askKey();
  });

  if (wantsPresent) {
    hud.hidden = false;
    badge.textContent = currentKey ? 'CONNECTING…' : 'ENTER KEY';
    badge.classList.add('bad');
    if (!currentKey) askKey();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'f' && overlay.hidden) {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      }
    });
  }

  function setConnected(on) {
    conn.classList.toggle('off', !on);
    conn.title = on ? 'connected' : 'reconnecting…';
  }

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null;

  function applyIndex(i) {
    if (Reveal.getIndices().h !== i) Reveal.slide(i);
  }

  function connect() {
    const keyParam = currentKey ? `&key=${encodeURIComponent(currentKey)}` : '';
    ws = new WebSocket(`${wsProto}://${location.host}/sync?deck=${encodeURIComponent(deck)}${keyParam}`);
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        confirmedPresenter = msg.role === 'presenter';
        if (confirmedPresenter) {
          badge.textContent = 'PRESENTER';
          badge.classList.remove('bad');
        } else if (wantsPresent && currentKey) {
          badge.textContent = 'KEY REJECTED';
          badge.classList.add('bad');
        }
        applyIndex(msg.index);
      }
      if (msg.type === 'goto') applyIndex(msg.index);
      if (msg.type === 'viewers') document.getElementById('viewers').textContent = msg.count;
    };
    ws.onclose = () => {
      setConnected(false);
      if (!intentionalClose) setTimeout(connect, 800 + Math.random() * 800);
      intentionalClose = false;
    };
  }

  function reconnect() {
    if (ws && ws.readyState <= 1) {
      intentionalClose = true;
      ws.close();
    }
    connect();
  }
  connect();

  Reveal.on('slidechanged', (e) => {
    if (confirmedPresenter && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'goto', index: e.indexh }));
    }
  });
})();
