(async () => {
  // this page is served at /<deck>/
  const deck = location.pathname.split('/').filter(Boolean)[0];
  document.title = deck;

  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  const isPresenter = key !== null;

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
    // viewers watch; only the presenter can navigate
    controls: isPresenter,
    progress: isPresenter,
    keyboard: isPresenter,
    touch: isPresenter,
    overview: isPresenter,
  });

  if (isPresenter) {
    document.getElementById('hud').hidden = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'f') {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      }
    });
  }

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const keyParam = isPresenter ? `&key=${encodeURIComponent(key)}` : '';
  const wsUrl = `${wsProto}://${location.host}/sync?deck=${encodeURIComponent(deck)}${keyParam}`;
  let ws = null;

  function applyIndex(i) {
    if (Reveal.getIndices().h !== i) Reveal.slide(i);
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'goto' || msg.type === 'state') applyIndex(msg.index);
      if (msg.type === 'viewers') document.getElementById('viewers').textContent = msg.count;
    };
    ws.onclose = () => setTimeout(connect, 800 + Math.random() * 800);
  }
  connect();

  Reveal.on('slidechanged', (e) => {
    if (isPresenter && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'goto', index: e.indexh }));
    }
  });
})();
