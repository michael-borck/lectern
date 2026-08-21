(async () => {
  // this page is served at /<deck>/
  const deck = location.pathname.split('/').filter(Boolean)[0];
  document.title = deck;

  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  const hasKey = key !== null;
  let confirmedPresenter = false; // only true once the server accepts the key

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
    // navigate locally when a key is given; server-side the key is
    // re-checked and the role confirmed via the 'state' message
    controls: hasKey,
    progress: hasKey,
    keyboard: hasKey,
    touch: hasKey,
    overview: hasKey,
  });

  const hud = document.getElementById('hud');
  const badge = document.getElementById('badge');
  const conn = document.getElementById('conn');

  if (hasKey) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'f') {
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
  const keyParam = hasKey ? `&key=${encodeURIComponent(key)}` : '';
  const wsUrl = `${wsProto}://${location.host}/sync?deck=${encodeURIComponent(deck)}${keyParam}`;
  let ws = null;

  function applyIndex(i) {
    if (Reveal.getIndices().h !== i) Reveal.slide(i);
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        confirmedPresenter = msg.role === 'presenter';
        if (confirmedPresenter) {
          hud.hidden = false;
          badge.textContent = 'PRESENTER';
          badge.classList.remove('bad');
        } else if (hasKey) {
          // a key was given but the server rejected it — make it obvious
          hud.hidden = false;
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
      setTimeout(connect, 800 + Math.random() * 800);
    };
  }
  connect();

  Reveal.on('slidechanged', (e) => {
    if (confirmedPresenter && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'goto', index: e.indexh }));
    }
  });
})();
