(async () => {
  const decksEl = document.getElementById('decks');
  const whoEl = document.getElementById('who');
  let me = null;

  async function api(path, opts = {}) {
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
    return data;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function render() {
    whoEl.textContent = `${me.user.email} · /${me.user.handle}`;
    const decks = me.decks;
    decksEl.innerHTML = decks.length
      ? decks
          .map((d) => {
            const thumb =
              d.status === 'ready' && d.thumb
                ? `<img src="${d.url}slides/${encodeURIComponent(d.thumb)}" alt="" loading="lazy">`
                : d.status === 'converting'
                  ? 'Converting…'
                  : d.status === 'error'
                    ? 'Conversion failed'
                    : '';
            const state =
              d.status === 'converting'
                ? 'converting…'
                : d.status === 'error'
                  ? `<span class="err">${esc(d.error || 'error')}</span>`
                  : `${d.slides} slides`;
            const mainBtn =
              d.status !== 'ready'
                ? `<button class="presentbtn" disabled>Present</button>`
                : d.live
                  ? `<button class="stopbtn" data-stop="${d.id}">Stop</button>`
                  : `<button class="presentbtn" data-present="${d.id}">Present</button>`;
            return `
      <div class="card ${d.live ? 'live' : ''}">
        <div class="thumb">${thumb}</div>
        <div class="meta">
          <div class="title">${esc(d.title)}${d.live ? '<span class="livebadge">LIVE</span>' : ''}</div>
          <div class="sub2">${state} · /${esc(d.handle)}/${esc(d.slug)}</div>
          <div class="actions">
            ${mainBtn}
            <button class="delbtn" data-del="${d.id}" title="Delete deck">✕</button>
          </div>
        </div>
      </div>`;
          })
          .join('')
      : '<p class="empty">No decks yet — upload one above.</p>';
  }

  async function refresh() {
    me = await api('/api/me');
    render();
    // poll while anything is converting
    if (me.decks.some((d) => d.status === 'converting')) setTimeout(refresh, 3000);
  }

  document.getElementById('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('upload-error');
    errEl.hidden = true;
    const btn = document.getElementById('upload-btn');
    const file = document.getElementById('file').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('title', document.getElementById('title').value);
    fd.append('file', file);
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      await api('/api/decks', { method: 'POST', body: fd });
      document.getElementById('file').value = '';
      document.getElementById('title').value = '';
      await refresh();
      setTimeout(refresh, 3000); // pick up converting -> ready
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Upload';
    }
  });

  decksEl.addEventListener('click', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.present) {
        const r = await api(`/api/decks/${t.dataset.present}/live`, { method: 'POST' });
        location.href = `${r.url}?present`;
      } else if (t.dataset.stop) {
        await api(`/api/decks/${t.dataset.stop}/stop`, { method: 'POST' });
        await refresh();
      } else if (t.dataset.del) {
        if (!confirm('Delete this deck permanently?')) return;
        await api(`/api/decks/${t.dataset.del}`, { method: 'DELETE' });
        await refresh();
      }
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });

  try {
    await refresh();
  } catch {
    location.href = '/login?next=/dashboard';
  }
})();
