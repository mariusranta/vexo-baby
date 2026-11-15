'use strict';

// The feed reads the existing wearable pipeline. It never opens the microphone or writes care events.
(() => {
  const byId = (id) => document.getElementById(id);
  const history = byId('feedHistory');
  const partial = byId('feedPartial');
  const empty = byId('feedEmpty');
  const scroller = byId('feedScroll');
  const status = byId('feedStatus');
  const dot = byId('feedDot');
  const storageKey = 'k';
  const query = new URLSearchParams(location.search);
  let key = query.get('k') || '';
  try {
    if (query.has('k')) localStorage.setItem(storageKey, key);
    else key = localStorage.getItem(storageKey) || '';
  } catch { /* A supplied key still works for this tab when storage is unavailable. */ }
  if (query.has('k')) {
    query.delete('k');
    window.history.replaceState(null, '', location.pathname + (query.size ? '?' + query.toString() : '') + location.hash);
  }

  const seen = new Set();
  let newestBand = null;
  let currentBand = null;
  let lastBandText = '';
  let lastBandFinal = false;
  let timer = null;
  let controller = null;
  let active = false;
  let stopped = false;

  // Follow the newest words unless the reader has just scrolled up to look at something older.
  let readerScrolled = 0;
  for (const name of ['wheel', 'touchmove']) scroller.addEventListener(name, () => { readerScrolled = Date.now(); }, { passive: true });
  function isAtEnd() { return Date.now() - readerScrolled > 6000 || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 45; }
  function toEnd() { scroller.scrollTop = scroller.scrollHeight; requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; }); }
  // In a loud room a sentence never ends, so the live line keeps growing: show only its newest words.
  const newest = (text) => { const words = text.split(/\s+/); return words.length > 32 ? '… ' + words.slice(-32).join(' ') : text; };
  function append(text, id) {
    if (!text || seen.has(id)) return;
    seen.add(id);
    const entry = document.createElement('p');
    entry.className = 'feed-entry';
    entry.textContent = text;
    history.append(entry);
    // Retain a small on-screen window rather than an unbounded transcript in memory.
    while (history.children.length > 6) history.firstElementChild.remove();
    if (seen.size > 200) seen.delete(seen.values().next().value);
  }
  function setState(label, receiving = false) {
    status.textContent = label;
    dot.classList.toggle('receiving', receiving);
  }
  function render(data, events) {
    const follow = isAtEnd();
    const band = data.band || {};
    const heard = typeof band.heard === 'string' ? band.heard.trim() : '';
    const age = Number(band.heard_seconds_ago);
    const fresh = heard && band.heard_seconds_ago != null && Number.isFinite(age) && age < 60;

    // A band result's text can evolve over several polls. Commit each final result once.
    if (fresh) {
      if (heard !== lastBandText || Boolean(band.heard_final) !== lastBandFinal) {
        if (heard !== lastBandText && lastBandFinal) currentBand = null;
        lastBandText = heard;
        lastBandFinal = Boolean(band.heard_final);
        if (!currentBand) currentBand = 'band-' + Date.now();
        if (lastBandFinal) {
          append(heard, currentBand);
          newestBand = heard;
          partial.hidden = true;
        } else {
          partial.textContent = newest(heard);
          partial.hidden = false;
        }
      }
      // Restore an unchanged partial after a temporary network interruption, but
      // do not leave it looking live once the bridge disappears.
      if (!band.heard_final) {
        partial.textContent = newest(heard);
        partial.hidden = !band.online;
      }
    } else {
      partial.hidden = true;
    }

    // Older bridges expose finalized speech only through the recorded event's raw text.
    // Use it only when live band transcripts are not available in this API response.
    if (!data.band) {
      const recorded = events
        .filter((event) => event.source === 'band-voice' && typeof event.raw === 'string' && event.raw.trim())
        .sort((a, b) => Number(a.id) - Number(b.id));
      let previous = null;
      const notes = [];
      for (const event of recorded) {
        const text = event.raw.trim();
        const sameNote = previous && previous.raw.trim() === text && Math.abs(Number(event.at) - Number(previous.at)) < 5000;
        if (!sameNote) notes.push({ text, id: 'event-' + event.id });
        previous = event;
      }
      for (const note of notes.slice(-6)) append(note.text, note.id);
    }
    empty.hidden = history.children.length > 0 || !partial.hidden;
    setState(band.online ? 'Live transcription' : history.children.length || newestBand ? 'Recent speech' : 'Waiting for speech', Boolean(band.online));
    if (follow) toEnd();
  }
  async function get(path, signal) {
    const response = await fetch(path, { headers: { 'x-key': key }, cache: 'no-store', signal });
    if (!response.ok) {
      const error = new Error('Feed unavailable');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  async function poll() {
    if (active || stopped || document.hidden) return;
    active = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const [data, timeline] = await Promise.all([
        get('/api/status', controller.signal),
        get('/api/timeline?hours=1', controller.signal),
      ]);
      if (!stopped) render(data, Array.isArray(timeline.events) ? timeline.events : []);
    } catch (error) {
      if (!stopped) {
        partial.hidden = true;
        empty.hidden = history.children.length > 0;
        setState(error.status === 401 ? 'Connection needed' : 'Waiting for connection');
      }
    } finally {
      clearTimeout(timeout);
      active = false;
      controller = null;
      if (!stopped && !document.hidden) timer = setTimeout(poll, 2000);
    }
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.hidden) controller?.abort();
    else poll();
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); controller?.abort(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { stopped = false; poll(); } });
  poll();
})();
