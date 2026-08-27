(async () => {
  // viewer URL: /j/<code>/   ·   presenter URL: /<handle>/<deck>/?present
  const segs = location.pathname.split('/').filter(Boolean);
  const joinCode = segs[0] === 'j' ? segs[1] : null;
  const deckKey = joinCode ? null : `${segs[0]}/${segs[1]}`;
  document.title = joinCode ? 'lectern — live' : segs[1];

  const params = new URLSearchParams(location.search);
  const wantsPresent = !joinCode && params.has('present'); // server already enforced ownership
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
    overview: wantsPresent,
    // keyboard/touch on for everyone so viewers can free-browse;
    // b/c/f/p/q are ours — disable any reveal defaults for them
    keyboard: { 66: null, 67: null, 70: null, 80: null, 81: null },
    touch: true,
  });

  const hud = document.getElementById('hud');
  const badge = document.getElementById('badge');
  const conn = document.getElementById('conn');
  const qrOverlay = document.getElementById('qr-overlay');
  const endedOverlay = document.getElementById('ended-overlay');
  const blankOverlay = document.getElementById('blank-overlay');
  const blankBadge = document.getElementById('blank-badge');
  const waitingOverlay = document.getElementById('waiting-overlay');
  const waitingTitle = document.getElementById('waiting-title');
  const waitingSub = document.getElementById('waiting-sub');
  const catchupBtn = document.getElementById('catchup');
  const penBadge = document.getElementById('pen-badge');
  const inkCanvas = document.getElementById('ink');
  const inkCtx = inkCanvas.getContext('2d');

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null;

  function wsSend(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // --- sync state ---
  let presenterIndex = 0; // where the presenter currently is
  let detached = false; // viewer browsed away from the presenter (free-browse)
  let applyingRemote = false; // slidechanged events caused by us, not the user
  let blankOn = false;
  let everHadPresenter = false;

  // --- ink (pen): Map<slideIndex, Map<strokeId, {id,color,width,pts:[[x,y]..]}>> ---
  // points are normalized to the slide box (0..1) so they align at any screen size
  const inkBySlide = new Map();
  const PEN_COLOR = '#ff3b30';
  const PEN_WIDTH = 0.004; // fraction of slide width
  let penOn = false;
  let drawing = null; // {id, slide, stroke} while pointer is down
  let strokeSeq = 0;
  let inkDirtyFrom = 0; // points in drawing.stroke.pts not yet sent
  let inkFlushScheduled = false;

  function sizeInkCanvas() {
    const dpr = window.devicePixelRatio || 1;
    inkCanvas.width = innerWidth * dpr;
    inkCanvas.height = innerHeight * dpr;
    inkCanvas.style.width = innerWidth + 'px';
    inkCanvas.style.height = innerHeight + 'px';
    inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', () => {
    sizeInkCanvas();
    redrawInk();
  });
  sizeInkCanvas();

  function slideRect() {
    const el = Reveal.getCurrentSlide();
    return el ? el.getBoundingClientRect() : null;
  }
  const toNorm = (x, y, r) => [(x - r.left) / r.width, (y - r.top) / r.height];
  const toScreen = (p, r) => [r.left + p[0] * r.width, r.top + p[1] * r.height];
  const roundPts = (pts) => pts.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]);

  // draw stroke points [from..end] (from<=1 redraws the whole stroke)
  function drawStroke(stroke, r, from) {
    const pts = stroke.pts;
    inkCtx.fillStyle = inkCtx.strokeStyle = stroke.color;
    if (pts.length === 1) {
      const [x, y] = toScreen(pts[0], r);
      inkCtx.beginPath();
      inkCtx.arc(x, y, (stroke.width * r.width) / 2, 0, 7);
      inkCtx.fill();
      return;
    }
    inkCtx.lineCap = 'round';
    inkCtx.lineJoin = 'round';
    inkCtx.lineWidth = stroke.width * r.width;
    inkCtx.beginPath();
    const [sx, sy] = toScreen(pts[Math.max(0, from - 1)], r);
    inkCtx.moveTo(sx, sy);
    for (let i = Math.max(1, from); i < pts.length; i++) {
      const [x, y] = toScreen(pts[i], r);
      inkCtx.lineTo(x, y);
    }
    inkCtx.stroke();
  }

  function redrawInk() {
    inkCtx.clearRect(0, 0, innerWidth, innerHeight);
    const r = slideRect();
    if (!r) return;
    const strokes = inkBySlide.get(Reveal.getIndices().h);
    if (!strokes) return;
    for (const s of strokes.values()) drawStroke(s, r, 1);
  }

  function receiveInk(msg) {
    let strokes = inkBySlide.get(msg.slide);
    if (!strokes) inkBySlide.set(msg.slide, (strokes = new Map()));
    let s = strokes.get(msg.id);
    if (!s) strokes.set(msg.id, (s = { id: msg.id, color: msg.color || PEN_COLOR, width: msg.width || PEN_WIDTH, pts: [] }));
    const from = s.pts.length;
    for (const p of msg.pts) s.pts.push(p);
    if (msg.slide === Reveal.getIndices().h) {
      const r = slideRect();
      if (r) drawStroke(s, r, Math.max(1, from));
    }
  }

  function clearInk(slide) {
    if (slide < 0) inkBySlide.clear();
    else inkBySlide.delete(slide);
    redrawInk();
  }

  // after a ws (re)connect, bring viewers back in line with our ink:
  // wipe their state, then replay every stroke we still hold
  function resyncInk() {
    wsSend({ type: 'ink-clear', slide: -1 });
    for (const [slide, strokes] of inkBySlide)
      for (const s of strokes.values())
        wsSend({ type: 'ink', id: s.id, slide, color: s.color, width: s.width, pts: roundPts(s.pts), done: true });
  }

  function flushInk(final) {
    inkFlushScheduled = false;
    if (!drawing || !ws || ws.readyState !== 1) return;
    const pts = drawing.stroke.pts.slice(inkDirtyFrom);
    if (!pts.length && !final) return;
    inkDirtyFrom = drawing.stroke.pts.length;
    wsSend({ type: 'ink', id: drawing.id, slide: drawing.slide, color: PEN_COLOR, width: PEN_WIDTH, pts: roundPts(pts), done: !!final });
  }
  function scheduleInkFlush() {
    if (!inkFlushScheduled) {
      inkFlushScheduled = true;
      requestAnimationFrame(() => flushInk(false));
    }
  }

  inkCanvas.addEventListener('pointerdown', (e) => {
    if (!penOn || !confirmedPresenter || drawing) return;
    const r = slideRect();
    if (!r) return;
    e.preventDefault();
    inkCanvas.setPointerCapture(e.pointerId);
    const slide = Reveal.getIndices().h;
    const id = `${Date.now()}-${++strokeSeq}`;
    const stroke = { id, color: PEN_COLOR, width: PEN_WIDTH, pts: [toNorm(e.clientX, e.clientY, r)] };
    let strokes = inkBySlide.get(slide);
    if (!strokes) inkBySlide.set(slide, (strokes = new Map()));
    strokes.set(id, stroke);
    drawing = { id, slide, stroke };
    inkDirtyFrom = 0;
    drawStroke(stroke, r, 1);
    scheduleInkFlush();
  });

  inkCanvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const r = slideRect();
    if (!r) return;
    const p = toNorm(e.clientX, e.clientY, r);
    const last = drawing.stroke.pts[drawing.stroke.pts.length - 1];
    const dx = p[0] - last[0];
    const dy = p[1] - last[1];
    if (dx * dx + dy * dy < 1e-6) return; // sub-pixel jitter
    drawing.stroke.pts.push(p);
    drawStroke(drawing.stroke, r, drawing.stroke.pts.length - 1);
    scheduleInkFlush();
  });

  const endStroke = () => {
    if (!drawing) return;
    flushInk(true);
    drawing = null;
  };
  inkCanvas.addEventListener('pointerup', endStroke);
  inkCanvas.addEventListener('pointercancel', endStroke);

  function setPen(on) {
    penOn = on;
    inkCanvas.classList.toggle('on', on);
    penBadge.hidden = !on;
  }

  // --- blank / waiting / free-browse UI state ---

  function setBlank(on) {
    blankOn = on;
    if (joinCode) blankOverlay.hidden = !on;
    else blankBadge.hidden = !on;
  }

  function setPresenterOnline(on) {
    if (!joinCode) return;
    if (on) {
      everHadPresenter = true;
      waitingOverlay.hidden = true;
      return;
    }
    waitingTitle.textContent = everHadPresenter ? 'The presenter disconnected' : 'The presentation hasn’t started yet';
    waitingSub.textContent = everHadPresenter ? 'Waiting for them to reconnect…' : 'The presenter will begin shortly.';
    waitingOverlay.hidden = false;
  }

  function updateCatchup() {
    if (!joinCode || !detached) {
      catchupBtn.hidden = true;
      return;
    }
    catchupBtn.textContent = `Presenter is on slide ${presenterIndex + 1} of ${slides.length} — tap to catch up`;
    catchupBtn.hidden = false;
  }

  catchupBtn.addEventListener('click', () => {
    detached = false;
    applyingRemote = true;
    Reveal.slide(presenterIndex);
    applyingRemote = false;
    updateCatchup();
    redrawInk();
  });

  function applyIndex(i) {
    presenterIndex = i;
    if (detached) {
      updateCatchup();
      return;
    }
    if (Reveal.getIndices().h !== i) {
      applyingRemote = true;
      Reveal.slide(i);
      applyingRemote = false;
    }
  }

  // --- presenter chrome (QR share, end, keys) ---

  if (wantsPresent) {
    hud.hidden = false;
    badge.textContent = 'CONNECTING…';

    // QR share overlay: code + join URL come from the deck's live session
    const me = await (await fetch('/api/me')).json();
    const myDeck = (me.decks || []).find((x) => `${x.handle}/${x.slug}` === deckKey);
    const code = myDeck && myDeck.code;
    const joinUrl = code ? `${location.origin}/j/${code}/` : `${location.origin}/${deckKey}/`;
    const qr = qrcode(0, 'M');
    qr.addData(joinUrl);
    qr.make();
    const qrSvg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    document.getElementById('qr-img').innerHTML = qrSvg;
    document.getElementById('qr-code').textContent = code || '';
    document.getElementById('qr-url').textContent = joinUrl;

    const toggleQr = () => (qrOverlay.hidden = !qrOverlay.hidden);
    document.getElementById('share-btn').addEventListener('click', toggleQr);
    qrOverlay.addEventListener('click', toggleQr);

    // QR join panel (lowercase q): same code in a persistent left column;
    // body gets a left margin so reveal rescales the slide into the right side
    const qrPanel = document.getElementById('qr-panel');
    document.getElementById('qr-panel-img').innerHTML = qrSvg;
    document.getElementById('qr-panel-code').textContent = code || '';
    document.getElementById('qr-panel-url').textContent = joinUrl;

    const toggleQrPanel = () => {
      qrPanel.hidden = !qrPanel.hidden;
      document.body.classList.toggle('qr-split', !qrPanel.hidden);
      Reveal.layout(); // slide box moved — rescale, then re-align ink
      redrawInk();
    };

    document.getElementById('end-btn').addEventListener('click', async () => {
      if (!confirm('End this presentation for all viewers?')) return;
      const me2 = await (await fetch('/api/me')).json();
      const d = (me2.decks || []).find((x) => `${x.handle}/${x.slug}` === deckKey);
      if (d) await fetch(`/api/decks/${d.id}/stop`, { method: 'POST' });
      location.href = '/dashboard';
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'q') toggleQrPanel(); // lowercase: persistent join column
      if (e.key === 'Q') toggleQr(); // uppercase (shift): full-screen share
      if (e.key === 'f' && qrOverlay.hidden) {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      }
      if (!confirmedPresenter) return;
      if (e.key === 'p') setPen(!penOn);
      if (e.key === 'c') {
        const slide = Reveal.getIndices().h;
        inkBySlide.delete(slide);
        redrawInk();
        wsSend({ type: 'ink-clear', slide });
      }
      if (e.key === 'b') {
        setBlank(!blankOn);
        wsSend({ type: 'blank', on: blankOn });
      }
    });
  }

  function setConnected(on) {
    conn.classList.toggle('off', !on);
    conn.title = on ? 'connected' : 'reconnecting…';
  }

  function connect() {
    const chan = joinCode
      ? `code=${encodeURIComponent(joinCode)}`
      : `deck=${encodeURIComponent(deckKey)}`;
    ws = new WebSocket(`${wsProto}://${location.host}/sync?${chan}`);
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
        setBlank(!!msg.blank);
        setPresenterOnline(!!msg.presenter);
        if (confirmedPresenter) {
          // we may have missed things while disconnected — re-announce everything
          wsSend({ type: 'goto', index: Reveal.getIndices().h });
          resyncInk();
        }
      }
      if (msg.type === 'goto') applyIndex(msg.index);
      if (msg.type === 'blank') setBlank(!!msg.on);
      if (msg.type === 'presenter') setPresenterOnline(!!msg.connected);
      if (msg.type === 'ink' && !confirmedPresenter) receiveInk(msg);
      if (msg.type === 'ink-clear' && !confirmedPresenter) clearInk(msg.slide);
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
    if (confirmedPresenter) wsSend({ type: 'goto', index: e.indexh });
    else if (!applyingRemote && e.indexh !== presenterIndex) {
      // viewer navigated on their own — detach until they catch up
      detached = true;
      updateCatchup();
    }
    redrawInk();
  });
})();
