'use strict';

const $ = (id) => document.getElementById(id);
const LABEL = { feed: 'Fed', diaper: 'Diaper changed', sleep_start: 'Fell asleep', sleep_end: 'Woke up', cry_start: 'Crying started', cry_end: 'Crying stopped', soothe: 'Soothed', medicine: 'Medicine recorded', note: 'Care note' };
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const storage = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* The connection still works for this tab. */ } },
};
const params = new URLSearchParams(location.search);
// Read both values before removing credentials from the address bar.
let key = params.get('k') || storage.get('k');
let who = params.get('who') || storage.get('who');
if (params.has('k')) storage.set('k', key);
if (params.has('who')) storage.set('who', who);
if (params.has('k') || params.has('who')) {
  params.delete('k'); params.delete('who');
  history.replaceState(null, '', location.pathname + (params.size ? '?' + params.toString() : '') + location.hash);
}

let mode = 'ask';
let busy = false;
let listening = false;
let recognition = null;
let syncing = false;
let generation = 0;
let synced = false;
let lastSync = null;
let spokenReply = null;

function minutes(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'Not recorded';
  const total = Math.max(0, Math.round(Number(value)));
  return total < 60 ? total + ' min' : Math.floor(total / 60) + ' h' + (total % 60 ? ' ' + total % 60 + ' min' : '');
}
function clock(at) { return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}
async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-key': key, 'content-type': 'application/json' },
      body: body ? JSON.stringify({ ...body, tz: TZ, who: who || undefined }) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'Add the shared access key in connection settings.' : 'The care log could not complete this request. Please try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request took too long. Check your connection.');
    if (error instanceof TypeError) throw new Error('The care log is unreachable. Check your connection.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function scrollChat() { $('conversationScroll').scrollTop = $('conversationScroll').scrollHeight; }
function addMessage(role, text, label) {
  $('welcome').hidden = true;
  const row = element('div', 'message-row ' + role);
  const avatar = element('span', 'message-avatar' + (role === 'user' ? ' user-avatar' : ''), role === 'user' ? (who || 'You').slice(0, 1).toUpperCase() : 'w');
  avatar.setAttribute('aria-hidden', 'true');
  row.append(avatar);
  const content = element('div', 'message-content');
  const speaker = element('span', 'message-label', label || (role === 'user' ? who || 'You' : 'Waby'));
  speaker.append(element('span', 'label-detail', clock(Date.now())));
  content.append(speaker);
  const bubble = element('div', 'message-bubble', text);
  content.append(bubble);
  row.append(content);
  $('messages').append(row);
  scrollChat();
  return { row, content, bubble };
}
function resizeInput() {
  $('message').style.height = 'auto';
  $('message').style.height = Math.min($('message').scrollHeight, 136) + 'px';
}
function showLiveTranscript() {
  const text = $('message').value.trim();
  $('liveTranscript').hidden = !text;
  $('liveTranscriptText').textContent = text;
  const label = element('span', 'label-detail', listening ? 'Speaking' : 'Ready to send');
  $('liveTranscriptLabel').replaceChildren(who || 'You', label);
  if (text) { $('welcome').hidden = true; scrollChat(); }
}
function updateControls() {
  $('sendButton').disabled = busy || listening || !$('message').value.trim();
  $('micButton').disabled = busy || !SpeechRecognition || !window.isSecureContext;
  $('startVoice').disabled = busy;
  $('startVoiceLabel').textContent = listening ? 'Finish speaking' : SpeechRecognition && window.isSecureContext ? 'Tap to speak' : 'Type a message';
  $('startVoice').setAttribute('aria-pressed', String(listening));
  $('startVoice').setAttribute('aria-label', listening ? 'Stop voice input' : SpeechRecognition && window.isSecureContext ? 'Start voice input' : 'Type a message');
  document.body.classList.toggle('thinking', busy);
  $('message').readOnly = busy || listening;
  $('askMode').disabled = busy || listening;
  $('logMode').disabled = busy || listening;
  $('settingsButton').disabled = busy;
  document.querySelectorAll('.suggestion').forEach((button) => { button.disabled = busy || listening; });
  $('messages').setAttribute('aria-busy', String(busy));
}
function setMode(next) {
  mode = next;
  const isAsk = mode === 'ask';
  $('askMode').classList.toggle('active', isAsk);
  $('logMode').classList.toggle('active', !isAsk);
  $('askMode').setAttribute('aria-pressed', String(isAsk));
  $('logMode').setAttribute('aria-pressed', String(!isAsk));
  $('message').maxLength = isAsk ? 500 : 1000;
  if ($('message').value.length > $('message').maxLength) $('message').value = $('message').value.slice(0, $('message').maxLength);
  $('message').placeholder = isAsk ? 'Or put it into words…' : 'What care did you give?';
  $('composerHint').textContent = isAsk ? "Answers come from your baby's recorded care." : 'Review your words. Send to save this care note.';
  $('sendButton').setAttribute('aria-label', isAsk ? 'Send question' : 'Save care note');
  updateControls();
}
// Spoken replies use the Deepgram voice from our API: the same voice whether the question
// was typed here or spoken to the band. Phones only let a page make sound after a tap, so
// ticking "Spoken replies" plays a silent clip that unlocks this player.
const player = new Audio();
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
player.addEventListener('playing', () => {
  if (player.src.startsWith('data:')) return;
  document.body.classList.add('speaking');
  $('voiceStatus').textContent = 'Waby is speaking.';
});
for (const name of ['ended', 'error', 'pause']) player.addEventListener(name, () => {
  document.body.classList.remove('speaking');
  if (!player.src.startsWith('data:')) $('voiceStatus').textContent = name === 'error' ? 'The voice could not play. The answer is on screen.' : statusLine;
});
// Phones refuse sound that starts without a tap, and an <audio> player has to be allowed again
// for every new clip on some of them. A Web Audio engine does not: once any tap on the page has
// started it, it stays allowed, so an answer to a question asked through the band can play by itself.
let engine = null, source = null;
const tell = (msg) => fetch('/api/clientlog', { method: 'POST', headers: { 'x-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {});
function unlockSound() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';       // iPhone: play even with the silent switch on
    const Engine = window.AudioContext || window.webkitAudioContext;
    if (Engine && !engine) { engine = new Engine(); tell('sound engine started by a tap'); }
    if (engine && engine.state !== 'running') engine.resume();
  } catch { engine = null; }
}
document.addEventListener('pointerdown', unlockSound);
document.addEventListener('keydown', unlockSound);
function stopSpeaking() {
  spokenReply = null;
  document.body.classList.remove('speaking');
  player.pause();
  if (source) { try { source.onended = null; source.stop(); } catch { /* it had ended already */ } source = null; }
}
async function speak(text, id) {
  if (!$('readAloud').checked || listening || !text) { tell('not spoken (spoken replies ' + ($('readAloud').checked ? 'on' : 'OFF') + ', listening ' + listening + ')'); return; }
  stopSpeaking();
  const url = '/api/speech?' + (id ? 'id=' + id : 'text=' + encodeURIComponent(String(text).slice(0, 300))) + '&k=' + encodeURIComponent(key);
  if (!engine) {                                       // no tap yet, or no Web Audio: the plain player
    player.src = url;
    player.play().then(() => tell('played with the audio tag'))
      .catch((p) => { $('voiceStatus').textContent = 'Tap anywhere on the page once to allow sound.'; tell('FAILED audio tag: ' + p.name + ' ' + p.message); });
    return;
  }
  try {
    if (engine.state !== 'running') await engine.resume();
    const bytes = await (await fetch(url)).arrayBuffer();
    const sound = await new Promise((ok, no) => engine.decodeAudioData(bytes, ok, no));
    const mine = source = engine.createBufferSource();
    mine.buffer = sound;
    mine.connect(engine.destination);
    mine.onended = () => { if (source === mine) { source = null; document.body.classList.remove('speaking'); $('voiceStatus').textContent = statusLine; } };
    mine.start();
    document.body.classList.add('speaking');
    $('voiceStatus').textContent = 'Waby is speaking.';
    tell('played with the engine (' + engine.state + '): ' + String(text).slice(0, 40));
  } catch (p) {
    $('voiceStatus').textContent = 'The voice could not play. The answer is on screen.';
    tell('FAILED engine: ' + (p && p.name) + ' ' + (p && p.message));
  }
}

// ---- The band: what it hears, what it answers, and crying it detects. All from /status.
let statusLine = 'Ready when you are';
let lastSpeak = null;                 // null until the first sync, so an old answer is not replayed on load
let bandTranscript = false;
const handled = new Set();            // answers this page asked for itself and has shown already
function handleBand(status) {
  const band = status.band || {};
  document.body.classList.toggle('baby-crying', Boolean(status.crying));
  document.body.classList.toggle('band-online', Boolean(band.online));
  const reason = status.reason || {};
  statusLine = status.crying ? 'Crying detected' + (reason.cause ? ' · probably ' + reason.cause : '')
    : band.online ? 'Band is listening' + (band.cry_score ? ' · cry ' + Math.round(band.cry_score * 100) + '%' : '') : 'Ready when you are';
  if (!busy && !listening && !document.body.classList.contains('speaking')) $('voiceStatus').textContent = statusLine;
  $('connectionText').textContent = band.online ? (band.name || 'Band') + ' connected' : 'Care log connected';

  // The words the band is hearing right now, in the place where your own dictation shows.
  const hearing = band.online && band.heard && band.heard_seconds_ago != null && band.heard_seconds_ago < 6;
  if (hearing && !listening && !$('message').value.trim()) {
    bandTranscript = true;
    $('liveTranscript').hidden = false;
    $('liveTranscriptText').textContent = band.heard.split(' ').slice(-28).join(' ');
    $('liveTranscriptLabel').replaceChildren('Heard by the band', element('span', 'label-detail', 'Live'));
    $('welcome').hidden = true;
  } else if (bandTranscript && !listening) { bandTranscript = false; $('liveTranscript').hidden = true; }

  // Something new to say: an answer to a question spoken to the band, or crying that just started.
  const speakNow = status.speak;
  if (lastSpeak === null) { lastSpeak = speakNow ? speakNow.id : 0; return; }
  if (!speakNow || speakNow.id === lastSpeak || busy) return;        // busy: our own request is still out; look again next time
  lastSpeak = speakNow.id;
  if (handled.has(speakNow.id) || speakNow.seconds_ago > 60) return;
  if (speakNow.question) addMessage('user', speakNow.question, 'Heard by the band');
  addMessage('assistant', speakNow.text, speakNow.kind === 'cry' ? 'Waby · crying detected' : 'Waby');
  speak(speakNow.text, speakNow.id);
}

async function send(text, action = mode, showUser = true, suppliedSource = 'phone') {
  if (busy || listening || !text.trim()) return;
  text = text.trim().slice(0, action === 'ask' ? 500 : 1000);
  busy = true;
  stopSpeaking();
  $('liveTranscript').hidden = true;
  $('voiceStatus').textContent = action === 'ask' ? 'Finding a little context…' : 'Adding to your care log…';
  if (showUser) addMessage('user', text, action === 'log' ? (who || 'You') + ' · Care note' : undefined);
  $('message').value = '';
  resizeInput();
  updateControls();
  const pending = addMessage('pending', action === 'ask' ? 'Looking through the care log…' : 'Saving your care note…');
  try {
    let answer;
    if (action === 'ask') {
      const data = await api('/ask', { question: text });
      if (typeof data.answer !== 'string' || !data.answer.trim()) throw new Error('No answer was returned. Please try again.');
      answer = data.answer;
      if (data.speak_id) handled.add(data.speak_id);
    } else {
      const data = await api('/notes', { text, source: suppliedSource });
      const events = Array.isArray(data.events) ? data.events : [];
      if (data.speak_id) handled.add(data.speak_id);
      answer = events.length ? 'Added to the care log:\n' + events.map((event) => {
        const amount = event.amount != null ? ' · ' + event.amount + (event.unit ? ' ' + event.unit : '') : '';
        return (LABEL[event.type] || 'Care event') + amount + (event.detail ? ' · ' + event.detail : '');
      }).join('\n') : data.answer || "I couldn't identify a care event in that note. Nothing was added. Try describing the care you gave.";
      await refresh();
    }
    pending.row.className = 'message-row assistant';
    pending.bubble.textContent = answer;
    $('voiceStatus').textContent = statusLine;
    speak(answer);
  } catch (error) {
    pending.row.className = 'message-row error';
    $('voiceStatus').textContent = 'Your message needs a little attention.';
    pending.bubble.textContent = action === 'log'
      ? 'I could not confirm that your note was saved. Check Recent moments before sending it again. ' + error.message
      : error.message;
    const retry = element('button', 'retry-button', error.status === 401 ? 'Connection settings' : action === 'ask' ? 'Try again' : 'Restore note to review');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (busy || listening) return;
      if (error.status === 401) { openSettings(); return; }
      retry.remove();
      if (action === 'ask') { pending.row.remove(); send(text, action, false, suppliedSource); }
      else { setMode('log'); $('message').value = text; resizeInput(); updateControls(); $('message').focus(); }
    });
    pending.content.append(retry);
  } finally {
    busy = false;
    updateControls();
    scrollChat();
    // Avoid opening a mobile keyboard after a spoken question.
    if (window.matchMedia('(pointer: fine)').matches) $('message').focus();
  }
}

function renderTimeline(events) {
  const container = $('timeline');
  if (!events.length) { container.replaceChildren(element('p', 'empty-context', 'A fresh start. Your recorded care will appear here.')); return; }
  const rows = events.slice().reverse().map((event) => {
    const row = element('div', 'timeline-row');
    if (event.type === 'cry_start') row.classList.add('cry_start');
    row.append(element('span', 'timeline-marker'));
    const copy = element('div', 'timeline-copy');
    copy.append(element('b', '', LABEL[event.type] || 'Care event'));
    const details = [event.amount != null ? event.amount + (event.unit ? ' ' + event.unit : '') : '', event.detail, event.who].filter(Boolean);
    if (details.length) copy.append(element('p', '', details.join(' · ')));
    const source = event.source === 'band-voice' ? ' · spoken to band' : event.source === 'band-auto' ? ' · band detection' : '';
    const time = element('time', '', clock(event.at) + source);
    if (Number.isFinite(Number(event.at))) time.dateTime = new Date(Number(event.at)).toISOString();
    copy.append(time); row.append(copy); return row;
  });
  container.replaceChildren(...rows);
}
async function refresh() {
  if (syncing) return;
  syncing = true;
  const version = generation;
  try {
    const [status, timeline] = await Promise.all([api('/status?tz=' + encodeURIComponent(TZ)), api('/timeline?hours=24')]);
    if (version !== generation) return;
    const events = Array.isArray(timeline.events) ? timeline.events : [];
    synced = true; lastSync = new Date();
    $('connection').className = 'connection online';
    handleBand(status);
    $('babyState').classList.toggle('crying', Boolean(status.crying));
    $('stateText').textContent = !events.length ? 'No care recorded yet' : status.crying ? 'Crying recorded' : status.asleep ? 'Sleep recorded' : 'No active crying recorded';
    $('stateDetail').textContent = !events.length ? 'Add a care note to get started.' : status.crying ? 'Started ' + minutes(status.crying_minutes) + ' ago' : status.asleep ? 'Started ' + minutes(status.asleep_minutes) + ' ago' : 'Based on the latest care entries.';
    $('fed').textContent = status.last_feed_minutes_ago == null ? 'Not recorded' : minutes(status.last_feed_minutes_ago) + ' ago';
    $('diaper').textContent = status.last_diaper_minutes_ago == null ? 'Not recorded' : minutes(status.last_diaper_minutes_ago) + ' ago';
    $('slept').textContent = events.length ? minutes(status.sleep_minutes_24h) + ' recorded' : 'Not recorded';
    const reason = status.reason || {};
    $('insights').hidden = !status.crying || !reason.cause;
    $('cause').textContent = reason.cause ? 'Possible explanation: ' + reason.cause : '';
    $('tryFirst').textContent = reason.try_first ? 'Suggested next step: ' + reason.try_first : '';
    $('confidence').textContent = reason.confidence ? 'Model / rule confidence: ' + reason.confidence : '';
    $('evidence').replaceChildren(...(Array.isArray(reason.evidence) ? reason.evidence : []).map((text) => element('li', '', text)));
    $('updatedAt').textContent = 'Updated ' + clock(lastSync);
    renderTimeline(events);
  } catch (error) {
    if (version !== generation) return;
    $('connection').className = 'connection error';
    $('connectionText').textContent = error.status === 401 ? 'Access key needed' : 'Care log offline';
    $('stateText').textContent = synced ? 'Showing the last sync' : 'Care log unavailable';
    $('stateDetail').textContent = error.status === 401 ? 'Open connection settings to add your key.' : 'We will reconnect automatically.';
    $('updatedAt').textContent = lastSync ? 'Last sync ' + clock(lastSync) : 'Not synced yet';
    $('insights').hidden = true;
  } finally {
    syncing = false;
    if (version !== generation) refresh();
  }
}

function initializeVoice() {
  if (!SpeechRecognition || !window.isSecureContext) {
    $('voiceStatus').textContent = 'Voice input is unavailable here. You can type to Waby.';
    $('micButton').title = 'Voice input requires a supported browser and HTTPS or localhost.';
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;
  let prefix = '', voiceError = false;
  recognition.onstart = () => { $('voiceStatus').textContent = 'Listening… Tap the microphone to finish.'; };
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results).map((result) => result[0].transcript).join(' ');
    $('message').value = (prefix + transcript).slice(0, $('message').maxLength);
    resizeInput();
    showLiveTranscript();
  };
  recognition.onerror = (event) => {
    voiceError = true;
    const errors = { 'not-allowed': 'Microphone access was denied. You can type your message.', 'service-not-allowed': 'The speech service is unavailable. You can type your message.', 'audio-capture': 'No microphone was found. You can type your message.', 'no-speech': 'No speech was heard. Try again or type below.', network: 'Voice input could not connect. Try typing instead.', aborted: 'Voice input stopped. You can review your words below.' };
    $('voiceStatus').textContent = errors[event.error] || 'Voice input stopped. Try again or type below.';
  };
  recognition.onend = () => {
    listening = false;
    document.body.classList.remove('listening');
    $('micButton').setAttribute('aria-pressed', 'false');
    $('micButton').setAttribute('aria-label', 'Start voice input');
    if (!voiceError) $('voiceStatus').textContent = 'Review your words, then ' + (mode === 'log' ? 'send to save your care note.' : 'send to ask Waby.');
    showLiveTranscript();
    updateControls();
  };
  $('micButton').addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    if (busy) return;
    stopSpeaking();
    prefix = $('message').value.trim() ? $('message').value.trim() + ' ' : '';
    voiceError = false;
    listening = true;
    document.body.classList.add('listening');
    $('micButton').setAttribute('aria-pressed', 'true');
    $('micButton').setAttribute('aria-label', 'Stop voice input');
    $('voiceStatus').textContent = 'Starting the microphone…';
    updateControls();
    try { recognition.start(); } catch {
      voiceError = true;
      $('voiceStatus').textContent = 'Could not start voice input. Please try again.';
      recognition.onend();
    }
  });
}
function openSettings() {
  if (busy) return;
  if (listening) recognition.stop();
  stopSpeaking();
  $('accessKey').value = key;
  $('caregiverName').value = who;
  $('settingsDialog').showModal();
}
$('settingsButton').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => $('settingsDialog').close());
$('settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const nextKey = $('accessKey').value.trim();
  if (nextKey !== key) {
    generation++; synced = false; lastSync = null;
    $('messages').replaceChildren(); $('welcome').hidden = false;
    $('liveTranscript').hidden = true;
    $('message').value = '';
    resizeInput(); updateControls();
    $('timeline').replaceChildren(element('p', 'empty-context', 'Connecting to your care log…'));
    for (const id of ['fed', 'slept', 'diaper']) $(id).textContent = '—';
    $('insights').hidden = true;
    $('stateText').textContent = 'Connecting to the log';
    $('stateDetail').textContent = 'Waiting for recorded activity.';
    $('updatedAt').textContent = 'Not synced yet';
  }
  key = nextKey; who = $('caregiverName').value.trim();
  storage.set('k', key); storage.set('who', who);
  $('settingsDialog').close(); refresh();
});
$('askMode').addEventListener('click', () => setMode('ask'));
$('startVoice').addEventListener('click', () => {
  if (SpeechRecognition && window.isSecureContext) $('micButton').click();
  else $('message').focus();
});
$('logMode').addEventListener('click', () => setMode('log'));
$('message').addEventListener('input', () => {
  $('liveTranscript').hidden = true;
  resizeInput(); updateControls();
});
$('message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); if (!$('sendButton').disabled) $('chatForm').requestSubmit();
  }
});
$('chatForm').addEventListener('submit', (event) => { event.preventDefault(); send($('message').value); });
document.querySelectorAll('.suggestion').forEach((button) => button.addEventListener('click', () => {
  setMode('ask'); send(button.dataset.question, 'ask');
}));
$('readAloud').addEventListener('change', () => {
  if (!$('readAloud').checked) { stopSpeaking(); $('voiceStatus').textContent = 'Spoken replies off.'; return; }
  unlockSound();                                            // this tap is what lets the page speak later
  $('voiceStatus').textContent = 'Spoken replies on.';
  speak('Spoken replies are on.');                          // you should hear this
});
$('contextToggle').addEventListener('click', () => {
  if (listening) recognition.stop();
  stopSpeaking();
  $('contextToggle').setAttribute('aria-expanded', 'true');
  $('careContext').showModal();
});
$('closeContext').addEventListener('click', () => $('careContext').close());
$('careContext').addEventListener('close', () => $('contextToggle').setAttribute('aria-expanded', 'false'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (listening) recognition.stop(); stopSpeaking(); }
  else refresh();
});
window.addEventListener('pagehide', () => { if (listening) recognition.abort(); stopSpeaking(); });
initializeVoice(); updateControls(); refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 1500);
