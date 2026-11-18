/* ==========================================================================
   audio.js · 采样播放引擎
   所有打击都用同一段采样（hit.wav，已内嵌在 js/hit.js）。
   节拍器的“哒”仍然用振荡器临时合成。
   ========================================================================== */

const Synth = (function () {
  let ctx = null;
  let hitBus, transport, comp;
  let buffer = null;
  let loading = null;
  let peak = 0;
  let hitVol = 0.9;

  let musicBuffer = null;
  let musicGain = null;
  let musicSrc = null;
  let musicEl = null;          // 变速播放用（保持音高）
  let musicURL = null;
  let musicTimer = 0;
  let musicSpeed = 1;
  let musicName = '';
  let musicVol = 0.7;
  let musicStarts = 0;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 20;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.14;

    // 打击音总线：只影响打击音，伴奏走自己的音量
    hitBus = ctx.createGain();
    hitBus.gain.value = hitVol;

    transport = ctx.createGain();
    transport.gain.value = 1;

    hitBus.connect(transport);
    transport.connect(comp);
    comp.connect(ctx.destination);
    return ctx;
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /** 载入打击采样。优先读同目录的 hit.wav（需要 http 环境），
      file:// 下浏览器不允许读本地文件，就退回内嵌的副本。 */
  function load() {
    if (buffer) return Promise.resolve(buffer);
    if (loading) return loading;
    const ac = ensure();

    loading = (async () => {
      let bytes = null;

      // file:// 下浏览器禁止读本地文件（会报 CORS），直接用内嵌副本
      if (location.protocol !== 'file:') {
        try {
          const res = await fetch('hit.wav', { cache: 'no-store' });
          if (res.ok) bytes = await res.arrayBuffer();
        } catch (e) {
          // http 环境读不到也退回内嵌副本
        }
      }
      if (!bytes || bytes.byteLength < 44) {
        if (!window.HIT_WAV_BASE64) throw new Error('缺少打击音文件');
        bytes = base64ToArrayBuffer(window.HIT_WAV_BASE64);
      }
      buffer = await ac.decodeAudioData(bytes.slice(0));
      try {
        const d = buffer.getChannelData(0);
        let p = 0;
        for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
        peak = p;
      } catch (e) { peak = 0; }
      return buffer;
    })();

    loading.catch((err) => {
      console.warn('打击音载入失败', err);
      loading = null;
    });

    return loading;
  }

  /** 排一次击打：time 是 AudioContext 时间（音量交给打击音总线） */
  function play(time) {
    if (!ctx || !buffer) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const g = ctx.createGain();
    g.gain.value = 0.85 * 0.92;

    src.connect(g);
    g.connect(hitBus);
    src.start(Math.max(time, ctx.currentTime));
    return true;
  }

  /* ---------------------------------------------------------------- 音乐 */

  function musicChannel() {
    ensure();
    if (!musicGain) {
      musicGain = ctx.createGain();
      musicGain.gain.value = musicVol;
      musicGain.connect(transport);
    }
    return musicGain;
  }

  /** 解码并保存一首伴奏 */
  function loadMusic(arrayBuffer, name) {
    const ac = ensure();
    return Promise.resolve()
      .then(() => ac.decodeAudioData(arrayBuffer.slice(0)))
      .then((buf) => {
        musicBuffer = buf;
        musicName = name || '音乐';
        musicChannel();

        // 变速播放用 <audio>（浏览器会保持音高），1x 仍然走 AudioBuffer 精确排期
        if (musicURL) URL.revokeObjectURL(musicURL);
        musicURL = URL.createObjectURL(new Blob([arrayBuffer], { type: mimeOf(musicName) }));
        musicEl = new Audio(musicURL);
        musicEl.preload = 'auto';
        musicEl.preservesPitch = true;
        musicEl.mozPreservesPitch = true;
        musicEl.webkitPreservesPitch = true;
        musicEl.playbackRate = musicSpeed;
        musicEl.volume = musicVol;

        return { duration: buf.duration, name: musicName };
      });
  }

  function mimeOf(name) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.wav')) return 'audio/wav';
    if (n.endsWith('.mp3')) return 'audio/mpeg';
    if (n.endsWith('.m4a') || n.endsWith('.aac')) return 'audio/mp4';
    if (n.endsWith('.flac')) return 'audio/flac';
    return 'audio/ogg';
  }

  /** 从音乐的 offsetSec 处开始播；给出 when = AudioContext 时间
      offsetSec 为负表示音乐要比这一拍晚一点进 */
  function startMusic(when, offsetSec) {
    if (!musicBuffer) return false;

    let startAt = when;
    let off = offsetSec || 0;
    if (off < 0) {
      startAt = when - off;
      off = 0;
    }
    off = Math.max(0, Math.min(Math.max(0, musicBuffer.duration - 0.02), off));

    // 变速时用 <audio>：playbackRate 会保持音高
    if (musicSpeed !== 1) {
      if (!musicEl) return false;
      stopMusic();
      musicStarts++;
      const fire = () => {
        try {
          musicEl.preservesPitch = true;
          musicEl.playbackRate = musicSpeed;
          musicEl.currentTime = off;
          const p = musicEl.play();
          if (p && p.catch) p.catch(() => {});
        } catch (e) { console.warn('音乐启动失败', e); }
      };
      const delay = Math.max(0, (startAt - ctx.currentTime) * 1000);
      if (delay > 8) musicTimer = setTimeout(fire, delay);
      else fire();
      return true;
    }

    const ch = musicChannel();
    stopMusic();

    const src = ctx.createBufferSource();
    src.buffer = musicBuffer;
    src.connect(ch);

    try {
      src.start(Math.max(startAt, ctx.currentTime), off);
    } catch (e) {
      console.warn('音乐启动失败', e);
      return false;
    }
    musicSrc = src;
    musicStarts++;
    return true;
  }

  function stopMusic() {
    if (musicTimer) { clearTimeout(musicTimer); musicTimer = 0; }
    if (musicEl && !musicEl.paused) {
      try { musicEl.pause(); } catch (e) { /* 忽略 */ }
    }
    if (!musicSrc) return;
    try { musicSrc.stop(); } catch (e) { /* 已经停了 */ }
    try { musicSrc.disconnect(); } catch (e) { /* 忽略 */ }
    musicSrc = null;
  }

  /** 播放速度（保持音高）；1 = 原速 */
  function setMusicSpeed(v) {
    musicSpeed = Math.max(0.0625, Math.min(4, Number(v) || 1));
    if (musicEl) {
      musicEl.preservesPitch = true;
      musicEl.playbackRate = musicSpeed;
    }
    return musicSpeed;
  }

  function setMusicVolume(v) {
    musicVol = Math.max(0, Math.min(1, v));
    if (musicGain) musicGain.gain.setTargetAtTime(musicVol, ctx.currentTime, 0.02);
    if (musicEl) musicEl.volume = musicVol;
  }

  /** 节拍器 */
  function click(time, accent) {    ensure();
    const t = Math.max(time, ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(accent ? 1600 : 1050, t);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.3 : 0.16, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);

    o.connect(g);
    g.connect(transport);   // 节拍器跟走带走，不跟打击音量走
    o.start(t);
    o.stop(t + 0.06);
  }

  return {
    ensure,
    load,
    play,
    click,
    loadMusic,
    startMusic,
    stopMusic,
    setMusicVolume,
    setMusicSpeed,
    preview() {
      return load().then(() => play(ensure().currentTime + 0.01));
    },
    now() { return ctx ? ctx.currentTime : 0; },
    resume() {
      ensure();
      if (ctx.state === 'suspended') return ctx.resume();
      return Promise.resolve();
    },
    /** 打击音量：只影响 hit.wav 那条总线，伴奏不受影响 */
    setHitVolume(v) {
      ensure();
      hitVol = Math.max(0, Math.min(1, v));
      hitBus.gain.setTargetAtTime(hitVol, ctx.currentTime, 0.02);
    },
    setRunning(on) {
      ensure();
      transport.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.008);
    },
    get ready() { return !!buffer; },
    get duration() { return buffer ? buffer.duration : 0; },
    get peak() { return peak; },
    get hasMusic() { return !!musicBuffer; },
    get musicName() { return musicName; },
    get musicDuration() { return musicBuffer ? musicBuffer.duration : 0; },
    get musicStarts() { return musicStarts; },
    get musicSpeed() { return musicSpeed; },
    get musicPlaying() { return !!(musicEl && !musicEl.paused) || !!musicSrc; },
    get state() { return ctx ? ctx.state : 'closed'; },
  };
})();
