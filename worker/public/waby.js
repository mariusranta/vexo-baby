'use strict';
// Wires the orb screen to the wristband: Waby's spoken answers, the crying alert, and the
// orb moving with what the band hears. feed.js (the transcript) and orb.js (the motion) are
// Marius's; this file only reads /api/status and plays /api/speech.
(() => {
  const $ = (id) => document.getElementById(id);
  let key = '';
  try { key = localStorage.getItem('k') || ''; } catch { /* no storage: the feed shows that the key is missing */ }
  const button = $('voiceResponse'), label = $('voiceResponseStatus');
  const orb = (value) => { if (window.wabyOrb) window.wabyOrb.level(value); };
  const tell = (msg) => fetch('/api/clientlog', { method: 'POST', headers: { 'x-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ msg: 'orb page: ' + msg }) }).catch(() => {});

  // ---- Sound. Phones refuse sound that starts without a tap. One tap anywhere starts a Web
  // Audio engine that stays allowed, so an answer to a question asked through the band can
  // play by itself later. (The same engine as the /classic page.)
  const player = new Audio();
  let engine = null, source = null, unlocked = false, speaking = false, voiceOn = true;
  function quietClip() {
    const samples = 800, bytes = new Uint8Array(44 + samples), view = new DataView(bytes.buffer);
    const text = (at, word) => [...word].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
    text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true); view.setUint16(34, 8, true); text(36, 'data'); view.setUint32(40, samples, true);
    bytes.fill(128, 44);
    return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...bytes));
  }
  function unlockSound() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';     // iPhone: play even with the silent switch on
      const Engine = window.AudioContext || window.webkitAudioContext;
      if (Engine && !engine) { engine = new Engine(); tell('sound engine started by a tap'); }
      if (engine && engine.state !== 'running') engine.resume();
    } catch { engine = null; }
    if (!unlocked) {
      unlocked = true;
      player.src = quietClip();
      player.play().catch(() => { unlocked = false; });
    }
    paintButton();
  }
  document.addEventListener('pointerdown', unlockSound);
  document.addEventListener('keydown', unlockSound);

  function setSpeaking(on) {
    speaking = on;
    document.body.classList.toggle('speaking', on);
    paintStatus();
  }
  player.addEventListener('playing', () => { if (!player.src.startsWith('data:')) setSpeaking(true); });
  for (const name of ['ended', 'error', 'pause']) player.addEventListener(name, () => { if (!player.src.startsWith('data:')) setSpeaking(false); });
  function stopSpeaking() {
    player.pause();
    if (source) { try { source.onended = null; source.stop(); } catch { /* it had ended already */ } source = null; }
    setSpeaking(false);
  }
  async function speak(text, id) {
    if (!voiceOn || !text) return;
    stopSpeaking();
    const url = '/api/speech?' + (id ? 'id=' + id : 'text=' + encodeURIComponent(String(text).slice(0, 300))) + '&k=' + encodeURIComponent(key);
    try {                                   // the plain player first: it starts while the sound is still arriving
      player.src = url;
      await player.play();
      tell('played with the audio tag');
      return;
    } catch (p) {
      if (!engine) { label.textContent = 'Tap anywhere once to allow sound.'; tell('FAILED audio tag, no engine: ' + p.name); return; }
    }
    try {
      if (engine.state !== 'running') await engine.resume();
      const bytes = await (await fetch(url)).arrayBuffer();
      const sound = await new Promise((ok, no) => engine.decodeAudioData(bytes, ok, no));
      const mine = source = engine.createBufferSource();
      mine.buffer = sound;
      mine.connect(engine.destination);
      mine.onended = () => { if (source === mine) { source = null; setSpeaking(false); } };
      mine.start();
      setSpeaking(true);
      tell('played with the engine');
    } catch (p) { label.textContent = 'The voice could not play. The answer is on screen.'; tell('FAILED engine: ' + (p && p.name)); }
  }

  // ---- The button: voice on or off. (It no longer opens this phone's microphone: the band is the microphone.)
  function paintButton() {
    button.disabled = false;
    button.textContent = !voiceOn ? 'Turn on voice response' : unlocked || engine ? 'Voice response on' : 'Tap to enable voice response';
    button.setAttribute('aria-pressed', String(voiceOn && (unlocked || Boolean(engine))));
  }
  button.addEventListener('click', () => {
    if (unlocked || engine) voiceOn = !voiceOn;          // the first tap only unlocks (the pointerdown above did that)
    if (!voiceOn) stopSpeaking();
    paintButton(); paintStatus();
  });

  // ---- What Waby says, in the transcript.
  // Waby's answer stays pinned above the live transcript, whole, so the words that keep
  // arriving from the room cannot push it out of sight. It stays until the next answer,
  // or for two minutes.
  let saidTimer = null;
  function say(text, kind) {
    const box = $('wabySays');
    box.className = 'waby-says' + (kind === 'cry' ? ' cry' : '') + (text.length > 170 ? ' long' : '');
    box.textContent = text;
    box.hidden = false;
    box.scrollTop = 0;
    clearTimeout(saidTimer);
    saidTimer = setTimeout(() => { box.hidden = true; }, 120000);
    $('feedEmpty').hidden = true;
    const scroller = $('feedScroll');
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  // ---- The band's state, once a second.
  let statusLine = 'Waiting for the band', last = null, hearing = false, crying = false;
  function paintStatus() {
    label.textContent = speaking ? 'Waby is speaking' : statusLine;
  }
  async function poll() {
    try {
      const response = await fetch('/api/status', { headers: { 'x-key': key }, cache: 'no-store' });
      if (!response.ok) { statusLine = response.status === 401 ? 'Open the link with the access key' : 'Care log offline'; paintStatus(); return; }
      const status = await response.json();
      const band = status.band || {}, reason = status.reason || {};
      crying = Boolean(status.crying);
      hearing = Boolean(band.online && band.heard && band.heard_seconds_ago != null && band.heard_seconds_ago < 2);
      document.body.classList.toggle('baby-crying', crying);
      document.body.classList.toggle('band-online', Boolean(band.online));
      statusLine = crying ? 'Crying detected' + (reason.cause ? ' · probably ' + reason.cause : '')
        : band.online ? 'The band is listening' : 'Band offline';
      paintStatus();
      const now = status.speak;
      if (last === null) { last = now ? now.id : 0; return; }          // an old answer is not replayed when the page opens
      if (!now || now.id === last) return;
      last = now.id;
      if (now.seconds_ago > 60) return;
      say(now.text, now.kind);
      speak(now.text, now.id);
    } catch { statusLine = 'Care log offline'; paintStatus(); }
  }

  // The orb moves with Waby's voice, with crying, and a little with speech the band hears.
  setInterval(() => {
    if (speaking) orb(0.45 + Math.random() * 0.45);
    else if (crying) orb(0.75 + Math.random() * 0.25);
    else if (hearing) orb(0.2 + Math.random() * 0.25);
  }, 120);

  paintButton(); paintStatus(); poll();
  setInterval(() => { if (!document.hidden) poll(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
