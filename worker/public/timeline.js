'use strict';
// The menu in the top left: today's key moments, newest first. It reads the same care log as
// everything else (/api/timeline and /api/status) and folds it into the moments that matter:
// a cry with how long it lasted and what ended it, a nap as one line, each feed and diaper.
(() => {
  const $ = (id) => document.getElementById(id);
  let key = '';
  try { key = localStorage.getItem('k') || ''; } catch { /* no storage */ }
  const panel = $('timeline'), shade = $('timelineShade'), button = $('menuButton');
  let timer = null;

  const get = (path) => fetch('/api' + path, { headers: { 'x-key': key }, cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const span = (minutes) => {
    const m = Math.max(0, Math.round(minutes));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  };
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const amount = (e) => (e.amount != null ? e.amount + (e.unit ? ' ' + e.unit : '') : '');

  /** The raw log, oldest first -> the moments worth reading, newest first. */
  function moments(events, status) {
    const out = [];
    let cry = null, nap = null;
    for (const e of events) {
      if (e.type === 'cry_start') cry = e;
      else if (e.type === 'cry_end' && cry) {
        const episode = (status.episodes || []).find((x) => Math.abs(x.at - cry.at) < 2000);
        out.push({ at: cry.at, kind: 'cry', title: 'Cried for ' + span(Math.max(1, (e.at - cry.at) / 60000)),
          detail: episode && episode.calmed_by ? 'Calmed by ' + episode.calmed_by.replace(/[()]/g, '').replace(/^feed/, 'a feed:').replace(/^soothe/, 'soothing:').replace(/^diaper/, 'a diaper change:').replace(/^sleep_start.*/, 'falling asleep') : 'Settled without a logged cause' });
        cry = null;
      } else if (e.type === 'sleep_start') nap = e;
      else if (e.type === 'sleep_end') {
        if (nap) out.push({ at: nap.at, kind: 'sleep', title: 'Slept ' + span((e.at - nap.at) / 60000), detail: 'Woke at ' + clock(e.at), who: e.who });
        else out.push({ at: e.at, kind: 'sleep', title: 'Woke up', detail: e.detail && e.detail !== 'woke up' ? e.detail : '', who: e.who });
        nap = null;
      } else if (e.type === 'feed') out.push({ at: e.at, kind: 'feed', title: 'Fed' + (amount(e) ? ' ' + amount(e) : ''), detail: e.detail || '', who: e.who, heard: e.source === 'band-voice' });
      else if (e.type === 'diaper') out.push({ at: e.at, kind: 'diaper', title: 'Diaper changed', detail: e.detail || '', who: e.who, heard: e.source === 'band-voice' });
      else if (e.type === 'soothe') out.push({ at: e.at, kind: 'soothe', title: 'Soothed', detail: e.detail || '', who: e.who, heard: e.source === 'band-voice' });
      else if (e.type === 'medicine') out.push({ at: e.at, kind: 'note', title: 'Medicine' + (amount(e) ? ' ' + amount(e) : ''), detail: e.detail || '', who: e.who });
      else if (e.type === 'note') out.push({ at: e.at, kind: 'note', title: 'Note', detail: e.detail || e.raw || '', who: e.who, heard: e.source === 'band-voice' });
    }
    if (nap) out.push({ at: nap.at, kind: 'sleep', title: 'Asleep now', detail: 'for ' + span((Date.now() - nap.at) / 60000), who: nap.who, live: true });
    if (cry) out.push({ at: cry.at, kind: 'cry', title: 'Crying now', detail: 'for ' + span(Math.max(1, (Date.now() - cry.at) / 60000)) + (status.reason && status.reason.cause ? ' · probably ' + status.reason.cause : ''), live: true });
    return out.sort((a, b) => b.at - a.at);
  }

  async function refresh() {
    try {
      const [status, log] = await Promise.all([get('/status'), get('/timeline?hours=24')]);
      const reason = status.reason || {};
      $('timelineNow').replaceChildren(
        el('p', 'now-state' + (status.crying ? ' cry' : ''), status.crying ? 'Crying for ' + span(Math.max(1, status.crying_minutes)) : status.asleep ? 'Asleep for ' + span(status.asleep_minutes) : 'Awake and calm'),
        el('p', 'now-reason', reason.cause ? (status.crying ? 'Probably ' : 'Next, probably ') + reason.cause + (reason.try_first ? '. ' + reason.try_first.replace(/^./, (c) => c.toUpperCase()) + '.' : '') : ''));
      const stat = (value, label) => { const box = el('div', 'stat'); box.append(el('b', null, value), el('span', null, label)); return box; };
      $('timelineStats').replaceChildren(
        stat(status.last_feed_minutes_ago == null ? '–' : span(status.last_feed_minutes_ago), 'since last feed'),
        stat(span(status.sleep_minutes_24h || 0), 'sleep, 24 h'),
        stat(String(status.cries_24h || 0), status.cries_24h === 1 ? 'cry today' : 'cries today'));
      const list = moments(log.events || [], status);
      $('timelineList').replaceChildren(...(list.length ? list : [{ at: Date.now(), kind: 'note', title: 'Nothing logged yet', detail: 'Say what happened near the band.' }]).map((m) => {
        const row = el('li', 'moment ' + m.kind + (m.live ? ' live' : ''));
        const body = el('div', 'moment-body');
        body.append(el('b', null, m.title));
        if (m.detail) body.append(el('span', 'moment-detail', m.detail));
        const by = [m.who, m.heard ? 'said to the band' : m.kind === 'cry' ? 'heard by the band' : ''].filter(Boolean).join(' · ');
        if (by) body.append(el('span', 'moment-by', by));
        row.append(el('time', null, clock(m.at)), el('i', 'moment-dot'), body);
        return row;
      }));
    } catch (problem) {
      $('timelineNow').replaceChildren(el('p', 'now-reason', problem.message === '401' ? 'Open the link with the access key first.' : 'The care log is not reachable right now.'));
    }
  }

  function open(show) {
    panel.hidden = shade.hidden = false;
    requestAnimationFrame(() => { panel.classList.toggle('open', show); shade.classList.toggle('open', show); });
    button.setAttribute('aria-expanded', String(show));
    clearInterval(timer);
    if (show) { refresh(); timer = setInterval(refresh, 3000); }
    else setTimeout(() => { if (!panel.classList.contains('open')) panel.hidden = shade.hidden = true; }, 320);
  }
  button.addEventListener('click', () => open(!panel.classList.contains('open')));
  $('timelineClose').addEventListener('click', () => open(false));
  shade.addEventListener('click', () => open(false));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') open(false); });
})();
