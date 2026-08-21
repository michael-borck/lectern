(async () => {
  // this page is served at /<handle>/<deck>/
  const segs = location.pathname.split('/').filter(Boolean);
  const deckKey = `${segs[0]}/${segs[1]}`;
  document.title = segs[1];

  const params = new URLSearchParams(location.search);
  const wantsPresent = params.has('present'); // server already enforced ownership
  let confirmedPresenter = false;

  const slides = await (await fetch('slides.json')).json();
  const container = document.querySelector('.slides');
  container.innerHTML = slides.length
    ? slides
        .map((f) => `<section><img src="slides/${encodeURIComponent(f)}" alt=""></section>`)
        .join('')
    : '<section><p>No slides yet.</p></section>';

  await Reveal.initialize({
    hash: false,
    transition: 'fade',
    transitionSpeed: 'fast',
    width: 1600,
    height: 900,
    margin: 0.02,
    center: true,
    controls: wantsPresent,
    progress: wantsPresent,
    keyboard: wantsPresent,
    touch: wantsPresent,
    overview: wantsPresent,
  });

  const hud = document.getElementById('hud');
  const badge = document.getElementById('badge');
  const conn = document.getElementById('conn');
  const qrOverlay = document.getElementById('qr-overlay');
  const endedOverlay = document.getElementById('ended-overlay');

  if (wantsPresent) {
    hud.hidden = false;
    badge.textContent = 'CONNECTING…';

    // QR share overlay
    const viewerUrl = `${location.origin}/${deckKey}/`;
    const qr = qrcode(0, 'M');
    qr.addData(viewerUrl);
    qr.make();
    document.getElementById('qr-img').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    document.getElementById('qr-url').textContent = viewerUrl;

    const toggleQr = () => (qrOverlay.hidden = !qrOverlay.hidden);
    document.getElementById('share-btn').addEventListener('click', toggleQr);
    qrOverlay.addEventListener('click', toggleQr);

    document.getElementById('end-btn').addEventListener('click', async () => {
      if (!confirm('End this presentation for all viewers?')) return;
      const me = await (await fetch('/api/me')).json();
      const d = me.decks.find((x) => `${x.handle}/${x.slug}` === deckKey);
      if (d) await fetch(`/api/decks/${d.id}/stop`, { method: 'POST' });
      location.href = '/dashboard';
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'q') toggleQr();
      if (e.key === 'f' && qrOverlay.hidden) {
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
    ws = new WebSocket(`${wsProto}://${location.host}/sync?deck=${encodeURIComponent(deckKey)}`);
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        confirmedPresenter = msg.role === 'presenter';
        if (wantsPresent) {
          badge.textContent = confirmedPresenter ? 'PRESENTER' : 'VIEWER';
          badge.classList.toggle('bad', !confirmedPresenter);
        }
        applyIndex(msg.index);
      }
      if (msg.type === 'goto') applyIndex(msg.index);
      if (msg.type === 'viewers') document.getElementById('viewers').textContent = msg.count;
      if (msg.type === 'ended' && !confirmedPresenter) {
        endedOverlay.hidden = false;
        ws.onclose = null;
        ws.close();
      }
    };
    ws.onclose = (e) => {
      setConnected(false);
      if (e.code === 4003 || e.code === 4004 || e.code === 4000) return; // ended/gone — don't retry
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
