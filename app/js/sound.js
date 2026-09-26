/* Typing sounds, synthesized once into AudioBuffers. No audio files. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const ROWS = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];

  let ctx = null;
  let master = null;
  let profile = 'typewriter';
  let volume = 0.35;
  const cache = {};
  let shared = null;
  let lastAt = 0;

  /* Synthesis helpers: write into a Float32Array at sample rate sr. */
  function click(d, sr, t0, tau, amp, a) {
    const i0 = Math.max(0, Math.round(t0 * sr));
    let y = 0;
    for (let i = i0; i < d.length; i++) {
      const env = amp * Math.exp(-(i - i0) / sr / tau);
      if (env < 0.001) break;
      y += a * (Math.random() * 2 - 1 - y);
      d[i] += y * env;
    }
  }

  function thump(d, sr, t0, f0, f1, tau, amp) {
    const i0 = Math.max(0, Math.round(t0 * sr));
    let phase = 0;
    for (let i = i0; i < d.length; i++) {
      const t = (i - i0) / sr;
      const env = amp * Math.exp(-t / tau);
      if (env < 1e-4) break;
      phase += 2 * Math.PI * (f1 + (f0 - f1) * Math.exp(-t / 0.012)) / sr;
      d[i] += Math.sin(phase) * env;
    }
  }

  function tone(d, sr, t0, f, tau, amp) {
    const i0 = Math.max(0, Math.round(t0 * sr));
    for (let i = i0; i < d.length; i++) {
      const t = (i - i0) / sr;
      const env = amp * Math.min(1, t / 0.002) * Math.exp(-t / tau);
      if (t > 0.002 && env < 1e-4) break;
      d[i] += Math.sin(2 * Math.PI * f * t) * env;
    }
  }

  // Render `draw` into a buffer of `len` seconds, scaled so the peak equals `norm`.
  function make(len, norm, draw) {
    const sr = ctx.sampleRate;
    const d = new Float32Array(Math.ceil(len * sr));
    draw(d, sr);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) for (let i = 0; i < d.length; i++) d[i] *= norm / peak;
    const b = ctx.createBuffer(1, d.length, sr);
    b.getChannelData(0).set(d);
    return b;
  }

  const jitter = (x) => (Math.random() * 2 - 1) * x;
  const times = (n, fn) => Array.from({ length: n }, (_, k) => fn(k));

  const PROFILES = {
    typewriter: () => ({
      key: times(6, (k) => make(0.08, 0.9, (d, sr) => {
        click(d, sr, 0, 0.0010, 0.9, 0.85);
        thump(d, sr, 0, 190 + 10 * k, 120, 0.018, 0.45);
        click(d, sr, 0.007 + 0.0015 * k, 0.0035, 0.7, 0.5);
      })),
      space: times(2, () => make(0.12, 0.9, (d, sr) => {
        click(d, sr, 0, 0.0012, 0.5, 0.6);
        thump(d, sr, 0, 130, 80, 0.035, 0.7);
        click(d, sr, 0.014 + jitter(0.002), 0.006, 0.5, 0.25);
      })),
      enter: [make(0.30, 0.9, (d, sr) => {
        for (let i = 0; i < 7; i++) click(d, sr, Math.max(0, 0.02 * i + jitter(0.003)), 0.0012, 0.35 - 0.2 * i / 6, 0.9);
        thump(d, sr, 0.17, 150, 90, 0.03, 0.8);
        click(d, sr, 0.17, 0.004, 0.8, 0.5);
      })],
      back: times(2, () => make(0.05, 0.7, (d, sr) => {
        click(d, sr, 0, 0.0008, 0.45, 0.9);
        thump(d, sr, 0, 300, 220, 0.008, 0.2);
      }))
    }),
    soft: () => ({
      key: times(6, (k) => make(0.06, 0.8, (d, sr) => {
        click(d, sr, 0, 0.004, 0.8, 0.18);
        thump(d, sr, 0, 240 + 12 * k, 170, 0.012, 0.55);
      })),
      space: [make(0.09, 0.8, (d, sr) => { click(d, sr, 0, 0.006, 0.7, 0.12); thump(d, sr, 0, 170, 110, 0.02, 0.7); })],
      enter: [make(0.10, 0.85, (d, sr) => { click(d, sr, 0, 0.006, 1, 0.12); thump(d, sr, 0, 150, 100, 0.028, 0.9); })],
      back: [make(0.05, 0.6, (d, sr) => { click(d, sr, 0, 0.003, 0.6, 0.25); thump(d, sr, 0, 300, 240, 0.008, 0.3); })]
    })
  };

  function build() {
    if (!ctx) return;
    if (!shared) {
      shared = {
        bell: [make(1.3, 0.5, (d, sr) => {
          tone(d, sr, 0, 1850, 0.6, 1);
          tone(d, sr, 0, 4410, 0.25, 0.35);
          tone(d, sr, 0, 5920, 0.12, 0.15);
          click(d, sr, 0, 0.001, 0.3, 0.9);
        })],
        coin: [make(0.30, 0.45, (d, sr) => {
          tone(d, sr, 0, 1568, 0.08, 0.6);
          tone(d, sr, 0.045, 2093, 0.12, 0.6);
        })]
      };
    }
    if (PROFILES[profile] && !cache[profile]) cache[profile] = PROFILES[profile]();
  }

  function unlock() {
    if (ctx && ctx.state === 'running') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) {
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { return; }
      Sound.ctx = ctx;
      master = ctx.createGain();
      master.gain.value = volume * 0.6;
      master.connect(ctx.destination);
    }
    if (ctx.state !== 'running' && ctx.resume) ctx.resume().catch(() => {});
    build();
  }

  function kindForKey(e) {
    if (e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.key === 'Enter') return 'enter';
    if (e.key === 'Backspace' || e.key === 'Delete') return 'back';
    if (e.key === ' ') return 'space';
    if (e.key === 'Tab' || (typeof e.key === 'string' && e.key.length === 1)) return 'key';
    return null;
  }

  function panForKey(e) {
    if (e.key === ' ') return 0;
    if (e.key === 'Enter' || e.key === 'Backspace') return 0.35;
    const c = String(e.key || '').toLowerCase();
    if (c.length !== 1) return 0;
    for (const row of ROWS) {
      const i = row.indexOf(c);
      if (i >= 0) return (i / (row.length - 1) - 0.5) * 0.7;
    }
    return 0;
  }

  function play(kind, opts) {
    if (profile === 'off' || !ctx) return;
    const o = opts || {};
    const now = performance.now();
    if (o.repeat && now - lastAt < 50) return;
    const list = (shared && shared[kind]) || (cache[profile] && cache[profile][kind]);
    if (!list || !list.length) return;
    lastAt = now;
    if (kind !== 'bell' && kind !== 'coin') Sound.lastKeyAt = now;
    const src = ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = 1 + jitter(0.04);
    const gain = ctx.createGain();
    gain.gain.value = (0.8 + Math.random() * 0.2) * (o.repeat ? 0.6 : 1) * (o.gain != null ? o.gain : 1);
    src.connect(gain);
    let out = gain;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, o.pan || 0));
      gain.connect(pan);
      out = pan;
    }
    out.connect(master);
    src.start(ctx.currentTime);
  }

  const Sound = TDW.Sound = {
    ctx: null,
    lastKeyAt: 0,
    init(settings) {
      profile = settings.sound || 'typewriter';
      volume = typeof settings.volume === 'number' ? settings.volume : 0.35;
      window.addEventListener('pointerdown', unlock, { capture: true, once: false });
      window.addEventListener('keydown', unlock, { capture: true, once: false });
    },
    setProfile(p) { profile = p; build(); },
    setVolume(v) {
      volume = v;
      if (master) master.gain.value = v * 0.6;
    },
    unlock,
    kindForKey,
    panForKey,
    play
  };
})();
