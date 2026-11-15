// The motion model is independent of audio capture so its settling behavior is testable.
export function stepMotion(state, target, dt) {
  const seconds = Math.min(Math.max(dt, 0), 0.05);
  const input = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : 0;
  const timeConstant = input > state.level ? 0.075 : 0.42;
  let level = state.level + (input - state.level) * (1 - Math.exp(-seconds / timeConstant));
  if (!input && level < 0.001) level = 0;
  const rise = Math.max(0, level - state.level);
  const beat = Math.min(1, state.beat * Math.exp(-seconds / 0.16) + rise * 3);
  return { level, beat: level ? beat : 0, phase: level ? (state.phase + seconds * (2.2 + input * 3.5)) % (Math.PI * 20) : 0 };
}

export function motionPose(state) {
  const { level: a, beat, phase: p } = state;
  const x = Math.sin(p * 0.83) * a * 1.8;
  const y = Math.sin(p * 1.13) * a * 1.5;
  const turn = Math.sin(p * 0.7) * a * 2.2;
  const scale = 1 + a * 0.075 + beat * 0.025;
  const r = (offset, frequency) => (50 + Math.sin(p * frequency + offset) * a * 5).toFixed(3) + '%';
  return { x, y, turn, scale, shape: a ? `${r(0, 1)} ${r(2, 0.8)} ${r(4, 1.1)} ${r(1, 0.9)} / ${r(3, 0.9)} ${r(1, 1.2)} ${r(0, 0.7)} ${r(5, 1)}` : '50%', glow: 0.72 + a * 0.2, glowScale: 1 + a * 0.08 };
}

function initializeOrb() {
  const root = document.querySelector('.presence');
  const glow = document.querySelector('.presence-glow');
  const button = document.getElementById('voiceResponse');
  const label = document.getElementById('voiceResponseStatus');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const supported = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(AudioContext);
  let motion = { level: 0, beat: 0, phase: 0 };
  let target = 0, received = 0, previous = 0, frame = 0, meterFrame = 0;
  let stream = null, context = null, source = null, analyser = null;
  let enabled = false, pending = false, version = 0;

  function paint() {
    const pose = motionPose(motion);
    root.style.setProperty('--orb-x', pose.x.toFixed(3) + 'px');
    root.style.setProperty('--orb-y', pose.y.toFixed(3) + 'px');
    root.style.setProperty('--orb-turn', pose.turn.toFixed(3) + 'deg');
    root.style.setProperty('--orb-scale', pose.scale.toFixed(4));
    root.style.setProperty('--orb-shape', pose.shape);
    glow.style.opacity = String(pose.glow);
    glow.style.transform = `scale(${pose.glowScale.toFixed(4)})`;
  }
  function tick(now) {
    frame = 0;
    if (now - received > 250) target = 0;
    motion = stepMotion(motion, target, previous ? (now - previous) / 1000 : 1 / 60);
    previous = now;
    paint();
    if (motion.level || target) frame = requestAnimationFrame(tick);
    else previous = 0;
  }
  function level(value) {
    if (reduced.matches || document.hidden) return;
    target = Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0;
    received = performance.now();
    if (!frame && (target || motion.level)) frame = requestAnimationFrame(tick);
  }
  function settle() { target = 0; received = 0; if (!frame && motion.level) frame = requestAnimationFrame(tick); }
  function reset() {
    cancelAnimationFrame(frame); frame = 0; previous = 0;
    motion = { level: 0, beat: 0, phase: 0 }; target = 0;
    paint();
  }
  async function stop(message = 'Microphone levels stay on this device.') {
    version++;
    enabled = false; pending = false;
    cancelAnimationFrame(meterFrame); meterFrame = 0;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    source?.disconnect(); source = null;
    analyser?.disconnect(); analyser = null;
    const oldContext = context; context = null;
    if (oldContext && oldContext.state !== 'closed') oldContext.close().catch(() => {});
    button.disabled = !supported;
    button.textContent = 'Enable voice response';
    button.setAttribute('aria-pressed', 'false');
    label.textContent = message;
    settle();
  }
  async function start() {
    if (pending || enabled) return;
    pending = true;
    const requestVersion = ++version;
    button.disabled = true;
    label.textContent = 'Allow microphone access to enable motion.';
    try {
      // Resume the context within the click gesture before waiting for permission.
      context = new AudioContext();
      await context.resume();
      if (requestVersion !== version || document.hidden) return;
      const input = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
      if (requestVersion !== version || document.hidden) { input.getTracks().forEach((track) => track.stop()); return; }
      stream = input;
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      source = context.createMediaStreamSource(stream);
      // Deliberately not connected to the speakers: no feedback or audio playback.
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      const hzPerBin = context.sampleRate / analyser.fftSize;
      let floor = 0.002, lastTime = performance.now();
      enabled = true; pending = false;
      button.disabled = false;
      button.textContent = 'Turn off voice response';
      button.setAttribute('aria-pressed', 'true');
      label.textContent = 'Voice response on · audio stays on this device';
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => { if (enabled) stop('Microphone disconnected.'); }, { once: true }));
      function measure(now) {
        if (!enabled || !analyser) return;
        const dt = Math.min((now - lastTime) / 1000, 0.1); lastTime = now;
        analyser.getFloatTimeDomainData(samples);
        analyser.getFloatFrequencyData(spectrum);
        let sum = 0, total = 0, voice = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        for (let i = 1; i < spectrum.length; i++) {
          const power = Math.pow(10, spectrum[i] / 10);
          total += power;
          if (i * hzPerBin >= 90 && i * hzPerBin <= 3400) voice += power;
        }
        // Adaptive energy gate plus voice-band energy reduces idle room-noise motion.
        // This is an audio-reactive heuristic, not a speech classifier.
        const gate = Math.max(0.004, floor * 2.6);
        const voiced = rms > gate && voice / Math.max(total, 1e-12) > 0.48;
        if (!voiced) {
          const rate = rms < floor ? 0.5 : 4;
          floor += (Math.min(rms, 0.015) - floor) * (1 - Math.exp(-dt / rate));
        }
        const strength = voiced ? Math.min(1, Math.max(0, Math.log10(Math.max(rms / gate, 1)) / 1.1)) : 0;
        level(strength);
        meterFrame = requestAnimationFrame(measure);
      }
      meterFrame = requestAnimationFrame(measure);
    } catch (error) {
      if (requestVersion !== version) return;
      const message = error.name === 'NotAllowedError' ? 'Microphone access was not allowed.' : error.name === 'NotFoundError' ? 'No microphone is available.' : 'Voice response could not start. Try again.';
      await stop(message);
    }
  }
  // The orb is driven by the wristband now (waby.js), not by this phone's microphone: an open
  // microphone makes an iPhone play Waby's voice quietly through the earpiece. start() and
  // stop() above are kept, unused, in case the phone microphone is wanted again.
  window.wabyOrb = { level, settle };
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  window.addEventListener('pagehide', () => { reset(); });
  reduced.addEventListener('change', () => { if (reduced.matches) reset(); });
  paint();
}

if (typeof document !== 'undefined') initializeOrb();
