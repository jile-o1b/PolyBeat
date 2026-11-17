/* ==========================================================================
   state.js · 工程状态（页 / 方块 / 音符）、撤销、序列化
   模型：pages[] → 每页 16 个方块 → 每个方块 = 一拍，含 n 个音符位
   ========================================================================== */

const Project = (function () {
  const BLOCKS_PER_PAGE = 16;

  const state = {
    tempos: [{ beat: 1, offset: 0, bpm: 100 }],  // 速度表，第一项永远是起点（第 1 拍 0 处）
    pages: [],
    page: 0,
    sel: null,          // 当前页里的方块下标 0..15
    master: 0.9,
  };

  const listeners = [];
  const undoStack = [];
  const MAX_UNDO = 80;
  let clipboard = null;
  let durCache = null;

  function on(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); }
  function emit(type, payload) { listeners.forEach((fn) => fn(type, payload)); }

  /* -------------------------------------------------------------- 基本属性 */

  function pageCount() { return state.pages.length; }
  function pageAt(p) { return state.pages[p] || null; }
  function blockAt(p, i) {
    const page = state.pages[p];
    return page ? page[i] || null : null;
  }
  function currentPage() { return state.pages[state.page] || []; }
  function selectedBlock() {
    if (state.sel == null) return null;
    return blockAt(state.page, state.sel);
  }

  function beatDur() { return 60 / bpmAtPos(0); }
  function totalBeats() { return state.pages.length * BLOCKS_PER_PAGE; }
  function slotDur(block) { return beatDur() / (block ? block.n : 1); }

  /* ------------------------------------------------------------ 速度表 */

  /** BPM 范围：下限 4（再低 MIDI 的 24 位速度就写不下了），上限 2000（够超高 BPM 谱面用） */
  const BPM_MIN = 4;
  const BPM_MAX = 2000;

  /** BPM 保留两位小数，不要四舍五入——谱面里的 174.5 这类速度要原样保留 */
  function clampBpm(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 120;
    return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(n * 100) / 100));
  }

  /** 标记在整曲里的绝对位置，单位是“拍”（0 基，可以是小数） */
  function tempoPos(m) { return (m.beat - 1) + m.offset; }

  function sortTempos() {
    state.tempos.sort((a, b) => tempoPos(a) - tempoPos(b));
    durCache = null;
  }

  /** 保证表里第一项是起点（第 1 拍 0 处） */
  function ensureStartTempo(fallbackBpm) {
    sortTempos();
    if (!state.tempos.length) {
      state.tempos.push({ beat: 1, offset: 0, bpm: clampBpm(fallbackBpm == null ? 100 : fallbackBpm) });
      return;
    }
    if (!(state.tempos[0].beat === 1 && state.tempos[0].offset < 1e-9)) {
      state.tempos.unshift({ beat: 1, offset: 0, bpm: state.tempos[0].bpm });
    }
  }

  /** 某个绝对位置（0 基拍）生效的 BPM */
  function bpmAtPos(pos) {
    let bpm = state.tempos.length ? state.tempos[0].bpm : 100;
    for (let i = 0; i < state.tempos.length; i++) {
      const m = state.tempos[i];
      if (tempoPos(m) <= pos + 1e-9) bpm = m.bpm;
      else break;
    }
    return bpm;
  }

  /** 1 基拍号上的 BPM（顶部显示用） */
  function bpmAtBeat(beat) {
    return bpmAtPos(Math.max(0, (beat | 0) - 1));
  }

  /** 把一拍切成若干段（遇到拍内变速就在那里断开） */
  function beatSegments(beat0) {
    const segs = [];
    let cur = 0;
    let bpm = bpmAtPos(beat0);
    for (let i = 0; i < state.tempos.length; i++) {
      const p = tempoPos(state.tempos[i]);
      if (p > beat0 + 1e-9 && p < beat0 + 1 - 1e-9) {
        segs.push({ from: cur, to: p - beat0, bpm });
        cur = p - beat0;
        bpm = state.tempos[i].bpm;
      }
    }
    segs.push({ from: cur, to: 1, bpm });
    return segs;
  }

  /** 在一拍内从拍首走到 frac 位置需要多少秒 */
  function timeInBeat(segs, frac) {
    let t = 0;
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      if (frac <= sg.from + 1e-12) break;
      const to = Math.min(frac, sg.to);
      if (to > sg.from) t += (to - sg.from) * 60 / sg.bpm;
      if (frac <= sg.to + 1e-12) break;
    }
    return t;
  }

  /** 一拍实际多长（秒），含拍内变速 */
  function beatSeconds(beat0) {
    return timeInBeat(beatSegments(beat0), 1);
  }

  function totalDur() {
    if (durCache != null) return durCache;
    let t = 0;
    const beats = totalBeats();
    for (let b = 0; b < beats; b++) t += beatSeconds(b);
    durCache = t;
    return t;
  }

  /** 从第 0 拍到第 beat0 拍经过了多少秒（配音乐用） */
  function secondsAtBeat(beat0) {
    let t = 0;
    const end = Math.max(0, Math.min(totalBeats(), beat0 | 0));
    for (let b = 0; b < end; b++) t += beatSeconds(b);
    return t;
  }

  /* 位置写法：1:1/2 = 第 1 拍的 1/2 处 */
  const OFFSET_NAMES = [
    [0, '0'], [1 / 8, '1/8'], [1 / 6, '1/6'], [1 / 4, '1/4'], [1 / 3, '1/3'],
    [3 / 8, '3/8'], [1 / 2, '1/2'], [5 / 8, '5/8'], [2 / 3, '2/3'],
    [3 / 4, '3/4'], [5 / 6, '5/6'], [7 / 8, '7/8'],
  ];

  function formatOffset(o) {
    for (const [v, name] of OFFSET_NAMES) {
      if (Math.abs(o - v) < 1e-6) return name;
    }
    return o.toFixed(2);
  }

  function formatTempoPos(beat, offset) {
    return `${beat}:${formatOffset(offset)}`;
  }

  function parseTempoPos(text) {
    const s = String(text == null ? '' : text).trim().replace(/：/g, ':');
    if (!s) return null;
    const m = s.match(/^(\d+)(?:\s*:\s*(.*))?$/);
    if (!m) return null;
    const beat = parseInt(m[1], 10);
    if (!(beat >= 1)) return null;

    let offset = 0;
    const rest = (m[2] || '').trim();
    if (rest) {
      const fm = rest.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      if (fm) {
        const den = Number(fm[2]);
        if (!(den > 0)) return null;
        offset = Number(fm[1]) / den;
      } else if (/^\d+(?:\.\d+)?$/.test(rest)) {
        offset = Number(rest);
      } else {
        return null;
      }
    }
    if (!(offset >= 0 && offset < 1)) return null;
    return { beat, offset };
  }

  /** 增 / 改一个速度标记；同一位置只保留一个 */
  function setTempo(beat, offset, bpm) {
    const b = Math.max(1, Math.min(totalBeats(), Math.round(Number(beat) || 1)));
    let off = Number(offset) || 0;
    off = Math.max(0, Math.min(0.9999, off));
    const value = clampBpm(bpm);

    const idx = state.tempos.findIndex((m) => m.beat === b && Math.abs(m.offset - off) < 1e-9);
    if (idx >= 0) state.tempos[idx].bpm = value;
    else state.tempos.push({ beat: b, offset: off, bpm: value });

    ensureStartTempo();
    durCache = null;
    emit('tempo');
    emit('tempos');
    return { beat: b, offset: off, bpm: value };
  }

  /** 删一个标记；第一项是起点，不能删 */
  function removeTempo(index) {
    if (index <= 0 || index >= state.tempos.length) return false;
    state.tempos.splice(index, 1);
    ensureStartTempo();
    durCache = null;
    emit('tempo');
    emit('tempos');
    return true;
  }

  /** 顶部 BPM 框：改的是“当前这一拍”的速度 */
  function setBpmAtBeat(beat, bpm) {
    return setTempo(beat, 0, bpm);
  }

  /* ------------------------------------------------------------ 统计 */

  function countHits() {
    let n = 0;
    state.pages.forEach((page) => page.forEach((blk) => {
      blk.on.forEach((v, i) => { if (v && i < blk.n) n++; });
    }));
    return n;
  }

  function countActiveBlocks() {
    let n = 0;
    state.pages.forEach((page) => page.forEach((blk) => {
      if (blk.on.some((v, i) => v && i < blk.n)) n++;
    }));
    return n;
  }

  /* ---------------------------------------------------------------- 撤销 */

  function snapshot() {
    return JSON.stringify({
      tempos: state.tempos,
      master: state.master,
      pages: state.pages,
    });
  }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    emit('undo', undoStack.length);
  }

  function canUndo() { return undoStack.length > 0; }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return false;
    const o = JSON.parse(prev);
    state.tempos = Array.isArray(o.tempos) && o.tempos.length ? o.tempos : [{ beat: 1, offset: 0, bpm: 100 }];
    ensureStartTempo();
    state.master = o.master;
    state.pages = o.pages;
    durCache = null;
    if (state.page >= state.pages.length) state.page = state.pages.length - 1;
    if (state.sel != null && !selectedBlock()) state.sel = null;
    emit('reload');
    return true;
  }

  /* ------------------------------------------------------------ 编辑操作 */

  function select(i) {
    if (state.sel === i) return;
    state.sel = i;
    emit('selection');
  }

  function toggleSlot(i, s) {
    const blk = blockAt(state.page, i);
    if (!blk || s < 0 || s >= blk.n) return false;
    blk.on[s] = !blk.on[s];
    emit('block', { p: state.page, i });
    return true;
  }

  function setCount(i, n) {
    const blk = blockAt(state.page, i);
    if (!blk) return false;
    const changed = resizeBlock(blk, n);
    if (changed) emit('block', { p: state.page, i, resized: true });
    return changed;
  }

  function setVel(i, v) {
    const blk = blockAt(state.page, i);
    if (!blk) return false;
    blk.vel = clamp01(v);
    emit('block', { p: state.page, i });
    return true;
  }

  function fillBlock(i, mode) {
    const blk = blockAt(state.page, i);
    if (!blk) return;
    blk.on = blk.on.map((v) => {
      if (mode === 'on') return true;
      if (mode === 'off') return false;
      return !v;
    });
    emit('block', { p: state.page, i });
  }

  function copyBlock(i) {
    const blk = blockAt(state.page, i);
    if (!blk) return false;
    clipboard = JSON.parse(JSON.stringify(blk));
    return true;
  }

  function pasteBlock(i) {
    const blk = blockAt(state.page, i);
    if (!blk || !clipboard) return false;
    blk.inst = clipboard.inst;
    blk.n = clipboard.n;
    blk.on = clipboard.on.slice();
    blk.vel = clipboard.vel;
    emit('block', { p: state.page, i, resized: true });
    return true;
  }

  function hasClipboard() { return !!clipboard; }

  /* ---------------------------------------------------------------- 页 */

  function gotoPage(p) {
    const next = Math.max(0, Math.min(state.pages.length - 1, p | 0));
    if (next === state.page) return false;
    state.page = next;
    emit('page');
    return true;
  }

  function addPage() {
    state.pages.push(Array.from({ length: BLOCKS_PER_PAGE }, () => emptyBlock()));
    state.page = state.pages.length - 1;
    durCache = null;
    emit('pages');
    return state.page;
  }

  function dupPage() {
    const src = state.pages[state.page];
    const copy = JSON.parse(JSON.stringify(src));
    state.pages.splice(state.page + 1, 0, copy);
    state.page += 1;
    durCache = null;
    emit('pages');
    return state.page;
  }

  function delPage() {
    if (state.pages.length <= 1) return false;
    state.pages.splice(state.page, 1);
    state.page = Math.min(state.page, state.pages.length - 1);
    durCache = null;
    emit('pages');
    return true;
  }

  /* ------------------------------------------------------------ 速度 / 音量 */

  /** 整曲起始速度（= 速度表第一项），改它等于改第一项 */
  function setBpm(v) {
    return setTempo(1, 0, v);
  }
  function setMaster(v) {
    state.master = Math.max(0, Math.min(1, v));
  }

  /* ------------------------------------------------------------ 序列化 */

  function toJSON() {
    return {
      app: 'PolyBeat',
      version: 4,
      tempos: state.tempos,
      master: state.master,
      page: state.page,
      pages: state.pages,
    };
  }

  function sanitizeBlock(raw) {
    if (!raw || typeof raw !== 'object') return emptyBlock();
    const n = Math.max(1, Math.min(MAX_SLOTS, Number(raw.n) || 1));
    const on = Array.isArray(raw.on) ? raw.on : [];
    const out = [];
    for (let i = 0; i < n; i++) out.push(!!on[i]);
    return {
      n,
      on: out,
      vel: clamp01(raw.vel),
    };
  }

  function sanitizeTempos(raw, beats) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const beat = Math.round(Number(item.beat));
      let offset = Number(item.offset);
      if (!(beat >= 1) || !Number.isFinite(offset)) return;
      if (offset < 0) offset = 0;
      if (offset >= 1) offset = 0;
      const bpmRaw = Number(item.bpm);
      if (!(bpmRaw >= BPM_MIN && bpmRaw <= BPM_MAX)) return;
      const bpm = Math.round(bpmRaw * 100) / 100;
      out.push({
        beat: Math.min(beats, beat),
        offset,
        bpm,
      });
    });
    out.sort((a, b) => tempoPos(a) - tempoPos(b));
    // 同一位置去重（后来的覆盖前面的）
    const dedup = [];
    out.forEach((m) => {
      const i = dedup.findIndex((x) => x.beat === m.beat && Math.abs(x.offset - m.offset) < 1e-9);
      if (i >= 0) dedup[i] = m;
      else dedup.push(m);
    });
    return dedup;
  }

  function fromJSON(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('工程文件格式不正确');
    const pages = Array.isArray(raw.pages) ? raw.pages.slice(0, 64) : [];
    if (!pages.length) throw new Error('工程文件里没有页面');

    state.master = Math.max(0, Math.min(1, Number(raw.master) || 0.9));
    state.pages = pages.map((page) => {
      const blocks = Array.isArray(page) ? page.slice(0, BLOCKS_PER_PAGE) : [];
      const out = blocks.map(sanitizeBlock);
      while (out.length < BLOCKS_PER_PAGE) out.push(emptyBlock());
      return out;
    });
    state.tempos = sanitizeTempos(raw.tempos, totalBeats());
    // 兼容旧工程：只有 bpm 字段
    if (!state.tempos.length && raw.bpm != null) {
      state.tempos = [{ beat: 1, offset: 0, bpm: clampBpm(raw.bpm) }];
    }
    ensureStartTempo(Number(raw.bpm) || 100);
    state.page = Math.max(0, Math.min(state.pages.length - 1, Number(raw.page) || 0));
    state.sel = null;
    durCache = null;
    undoStack.length = 0;
    emit('reload');
  }

  function loadPreset(key) {
    const p = PRESETS[key];
    if (!p) return;

    state.pages = JSON.parse(JSON.stringify(p.pages)).map((page) => {
      const out = page.slice(0, BLOCKS_PER_PAGE).map(sanitizeBlock);
      while (out.length < BLOCKS_PER_PAGE) out.push(emptyBlock());
      return out;
    });
    state.tempos = Array.isArray(p.tempos)
      ? JSON.parse(JSON.stringify(p.tempos))
      : [{ beat: 1, offset: 0, bpm: clampBpm(p.bpm) }];
    ensureStartTempo(p.bpm);
    state.page = 0;
    state.sel = null;
    durCache = null;
    undoStack.length = 0;
    emit('reload');
  }

  /** 导入谱面：用解析结果替换整首（不清理撤销栈，调用方可以自己 pushUndo） */
  function loadChart(chart) {
    const pages = Array.isArray(chart && chart.pages) ? chart.pages.slice(0, 64) : [];
    if (!pages.length) throw new Error('谱面是空的');

    state.pages = pages.map((page) => {
      const blocks = Array.isArray(page) ? page.slice(0, BLOCKS_PER_PAGE) : [];
      const out = blocks.map(sanitizeBlock);
      while (out.length < BLOCKS_PER_PAGE) out.push(emptyBlock());
      return out;
    });
    state.tempos = sanitizeTempos(chart.tempos || [], totalBeats());
    ensureStartTempo(120);
    state.page = 0;
    state.sel = null;
    durCache = null;
    emit('reload');
  }

  /** 全新的空工程：一页 16 个空方块，每个 1 个音符点、都没有击打 */
  function newProject() {
    state.tempos = [{ beat: 1, offset: 0, bpm: 100 }];
    state.master = 0.9;
    state.pages = [
      Array.from({ length: BLOCKS_PER_PAGE }, () => emptyBlock()),
    ];
    state.page = 0;
    state.sel = null;
    durCache = null;
    undoStack.length = 0;
    emit('reload');
  }

  function clearAll() {
    state.pages = state.pages.map(() => (
      Array.from({ length: BLOCKS_PER_PAGE }, () => emptyBlock())
    ));
    emit('reload');
  }

  return {
    state, on, emit,
    BLOCKS_PER_PAGE,
    pageCount, pageAt, blockAt, currentPage, selectedBlock,
    beatDur, totalBeats, totalDur, slotDur,
    bpmAtPos, bpmAtBeat, beatSegments, timeInBeat, beatSeconds, secondsAtBeat,
    setTempo, removeTempo, setBpmAtBeat, parseTempoPos, formatTempoPos, clampBpm,
    countHits, countActiveBlocks,
    snapshot, pushUndo, canUndo, undo,
    select, toggleSlot, setCount, setVel, fillBlock,
    copyBlock, pasteBlock, hasClipboard,
    gotoPage, addPage, dupPage, delPage,
    setBpm, setMaster,
    toJSON, fromJSON, loadPreset, newProject, loadChart, clearAll,
  };
})();
