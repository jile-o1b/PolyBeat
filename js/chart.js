/* ==========================================================================
   chart.js · 谱面格式适配
   支持：
     RPE（Re:PhiEdit）——BPMList 是真正的变速表，note 时间 = [整数拍, 分子/分母]
     Phigros Official（formatVersion 1/3，简称 fv3）——每条判定线自带 bpm，
       note 时间单位是 128 分音符（1.875 / bpm 秒）
      Rizline（fileVersion + lines）——note 的 time 单位是 tick，
        1 tick = 60 / bPM 秒，也就是一拍；bpmShifts 的 value 是相对 bPM 的比例
   输出：可以直接喂给 PolyBeat 的 pages / tempos
   ========================================================================== */

const ChartImport = (function () {
  const PAGE_BLOCKS = 16;     // 每页 16 个方块
  const MAX_PAGES = 64;       // 工程上限
  const MAX_SLOTS = 8;        // 一拍最多几个音符
  const TIME_EPS = 1e-4;      // 同一时间的判定阈值（拍）
  const BPM_MIN = 4;          // 和 state.js 保持一致
  const BPM_MAX = 2000;       // 超高 BPM 谱面（比如 999、1200）也要能读进来

  /* ------------------------------------------------------------- 小工具 */

  function clampBpm(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 120;
    return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(n * 100) / 100));
  }

  /** RPE 的 beat = [整数部分, 分子, 分母] */
  function rpeBeat(arr) {
    if (!Array.isArray(arr)) return 0;
    const a = Number(arr[0]) || 0;
    const b = Number(arr[1]) || 0;
    const c = Number(arr[2]);
    const frac = c ? b / c : 0;
    return a + frac;
  }

  /* --------------------------------------------------------------- 识别 */

  function detect(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // Rizline：没有 judgeLineList，音符挂在 lines[].notes 上
    if (Array.isArray(obj.lines) && (obj.bPM != null || Array.isArray(obj.bpmShifts))) {
      return 'riz';
    }
    if (!Array.isArray(obj.judgeLineList)) return null;
    if (Array.isArray(obj.BPMList) || Array.isArray(obj.bpmList)) return 'rpe';
    if (obj.META || obj.chartTime != null) return 'rpe';
    if (obj.formatVersion != null) return 'fv3';
    // Phigros 官方谱面没有 BPMList，靠判定线的 bpm 字段认
    const first = obj.judgeLineList[0];
    if (first && first.bpm != null) return 'fv3';
    return null;
  }

  /* ---------------------------------------------------------------- RPE */

  function parseRPE(obj) {
    const rawList = obj.BPMList || obj.bpmList || [];
    const bpmList = rawList
      .map((e) => ({ beat: rpeBeat(e && e.startTime), bpm: Number(e && e.bpm) }))
      .filter((e) => isFinite(e.beat) && e.bpm > 0)
      .sort((a, b) => a.beat - b.beat);

    const notes = [];
    (obj.judgeLineList || []).forEach((line) => {
      if (!line) return;
      const pools = [];
      if (Array.isArray(line.notes)) pools.push(line.notes);
      if (Array.isArray(line.notesAbove)) pools.push(line.notesAbove);
      if (Array.isArray(line.notesBelow)) pools.push(line.notesBelow);

      pools.forEach((pool) => {
        pool.forEach((n) => {
          if (!n) return;
          if (Number(n.isFake) === 1) return;   // 假音符不发声
          const beat = rpeBeat(n.startTime);
          if (!isFinite(beat) || beat < 0) return;
          notes.push({ beat, type: Number(n.type) || 1 });
        });
      });
    });

    return {
      format: 'RPE',
      label: `RPE v${(obj.META && obj.META.RPEVersion) || '?'}`,
      bpmList: bpmList.length ? bpmList : [{ beat: 0, bpm: 120 }],
      notes,
      meta: obj.META || {},
      // 音乐对齐：offset 为负表示音乐应在谱面前 |offset| ms 开始
      offsetSec: -((Number(obj.META && obj.META.offset) || 0) / 1000),
    };
  }

  /* ---------------------------------------------------- Phigros Official */

  function parseFV3(obj) {
    const lines = obj.judgeLineList || [];

    // 基准 BPM：出现次数最多的那条线的 bpm
    const count = new Map();
    lines.forEach((L) => {
      const b = Number(L && L.bpm);
      if (!(b > 0)) return;
      count.set(b, (count.get(b) || 0) + 1);
    });
    let baseBpm = 120;
    let best = -1;
    count.forEach((c, b) => {
      if (c > best || (c === best && b < baseBpm)) { best = c; baseBpm = b; }
    });

    const notes = [];
    lines.forEach((line) => {
      if (!line) return;
      const bpm = Number(line.bpm) > 0 ? Number(line.bpm) : baseBpm;
      const unitSec = 1.875 / bpm;          // 128 分音符 = 1.875 / bpm 秒
      const pools = [];
      if (Array.isArray(line.notesAbove)) pools.push(line.notesAbove);
      if (Array.isArray(line.notesBelow)) pools.push(line.notesBelow);
      if (Array.isArray(line.notes)) pools.push(line.notes);

      pools.forEach((pool) => {
        pool.forEach((n) => {
          if (!n) return;
          if (Number(n.isFake) === 1) return;
          const t = Number(n.time);
          if (!isFinite(t)) return;
          const sec = t * unitSec;
          const beat = (sec * baseBpm) / 60;
          if (!isFinite(beat) || beat < 0) return;
          notes.push({ beat, type: Number(n.type) || 1 });
        });
      });
    });

    return {
      format: 'fv3',
      label: `Phigros Official v${obj.formatVersion != null ? obj.formatVersion : '?'}`,
      bpmList: [{ beat: 0, bpm: baseBpm }],
      notes,
      meta: obj,
      // 音乐对齐：offset 为正表示谱面比音乐快 → 第 1 拍时音乐还没到 0
      offsetSec: -(Number(obj.offset) || 0),
    };
  }

  /* -------------------------------------------------------------- Rizline */

  function parseRiz(obj) {
    const baseBpm = Number(obj.bPM) > 0 ? Number(obj.bPM) : 120;

    // tick 就是拍：1 tick = 60 / bPM 秒；bpmShifts 的 value 是相对 bPM 的比例
    const bpmList = [];
    (Array.isArray(obj.bpmShifts) ? obj.bpmShifts : []).forEach((s) => {
      if (!s) return;
      const tick = Number(s.time);
      const ratio = Number(s.value);
      if (!isFinite(tick) || tick < 0) return;
      const bpm = baseBpm * (isFinite(ratio) && ratio > 0 ? ratio : 1);
      if (!(bpm > 0)) return;
      bpmList.push({ beat: tick, bpm });
    });
    if (!bpmList.length) bpmList.push({ beat: 0, bpm: baseBpm });
    bpmList.sort((a, b) => a.beat - b.beat);

    // 音符：每条线的 notes，time 单位是 tick；Hold 的尾巴在 otherInformations 里，这里只算头
    const notes = [];
    (obj.lines || []).forEach((line) => {
      if (!line || !Array.isArray(line.notes)) return;
      line.notes.forEach((n) => {
        if (!n) return;
        const tick = Number(n.time);
        if (!isFinite(tick) || tick < 0) return;
        notes.push({ beat: tick, type: Number(n.type) || 0 });
      });
    });

    return {
      format: 'riz',
      label: `Rizline v${obj.fileVersion != null ? obj.fileVersion : '?'}`,
      bpmList,
      notes,
      meta: { name: obj.songsName || '' },
      // offset 单位秒，目前谱面里都是 0
      offsetSec: -(Number(obj.offset) || 0),
    };
  }

  /* ------------------------------------------------------------ 时间分析 */

  /**
   * 把松散的音符时间压成「每拍几个音符 + 哪些要击打」
   * 返回 pages: [ [{n, on[]}] × 16 ] × N
   */
  function build(chart) {
    const sorted = chart.notes
      .slice()
      .sort((a, b) => a.beat - b.beat);

    // 同一时间只算一个
    const uniq = [];
    let merged = 0;
    sorted.forEach((n) => {
      const last = uniq[uniq.length - 1];
      if (last && Math.abs(n.beat - last.beat) < TIME_EPS) { merged++; return; }
      uniq.push(n);
    });

    // 每拍收集「拍内位置」
    const buckets = new Map();
    uniq.forEach((n) => {
      const b = Math.floor(n.beat + 1e-9);
      const off = n.beat - b;
      const arr = buckets.get(b) || [];
      if (!arr.some((o) => Math.abs(o - off) < TIME_EPS)) {
        arr.push(off);
      } else {
        merged++;
      }
      buckets.set(b, arr);
    });

    const maxBeat = uniq.length ? Math.floor(uniq[uniq.length - 1].beat + 1e-9) + 1 : 1;
    const limitBeats = MAX_PAGES * PAGE_BLOCKS;
    const totalBeats = Math.max(1, Math.min(limitBeats, maxBeat));
    const truncated = maxBeat > limitBeats;

    const pages = [];
    let usedSlots = 0;
    let noteCount = 0;
    let maxError = 0;
    let worstBeat = -1;

    for (let p = 0; p < Math.ceil(totalBeats / PAGE_BLOCKS); p++) {
      const page = [];
      for (let i = 0; i < PAGE_BLOCKS; i++) {
        const beat = p * PAGE_BLOCKS + i;
        const offsets = buckets.get(beat);
        if (!offsets || !offsets.length) {
          page.push({ n: 1, on: [false] });
          continue;
        }

        // 选一个能把所有位置都对上的最小细分数
        let chosen = null;
        for (let n = 1; n <= MAX_SLOTS; n++) {
          let err = 0;
          const slots = new Set();
          offsets.forEach((o) => {
            const k = Math.round(o * n);
            err = Math.max(err, Math.abs(o - k / n));
            slots.add(Math.min(n - 1, Math.max(0, k)));
          });
          if (!chosen || err < chosen.err - 1e-9 ||
              (Math.abs(err - chosen.err) < 1e-9 && n < chosen.n)) {
            chosen = { n, err, slots };
          }
        }

        if (chosen.err > maxError) { maxError = chosen.err; worstBeat = beat; }

        const on = new Array(chosen.n).fill(false);
        chosen.slots.forEach((k) => { on[k] = true; });
        page.push({ n: chosen.n, on });
        usedSlots += chosen.slots.size;
        noteCount += chosen.slots.size;
      }
      pages.push(page);
    }

    // 变速表：拍（0 基）→ 1 基拍 + 拍内偏移
    const tempos = [];
    chart.bpmList.forEach((e) => {
      const b = Math.floor(e.beat + 1e-9);
      const offset = Math.round((e.beat - b) * 1e6) / 1e6;
      const bpm = clampBpm(e.bpm);
      const idx = tempos.findIndex((t) => t.beat === b + 1 && Math.abs(t.offset - offset) < 1e-9);
      if (idx >= 0) tempos[idx].bpm = bpm;
      else tempos.push({ beat: b + 1, offset, bpm });
    });
    tempos.sort((a, b) => (a.beat + a.offset) - (b.beat + b.offset));

    return {
      pages,
      tempos,
      stats: {
        format: chart.label,
        formatKey: chart.format,
        rawNotes: chart.notes.length,
        merged,
        hits: noteCount,
        beats: totalBeats,
        pages: pages.length,
        tempos: tempos.length,
        truncated,
        maxError,
        worstBeat,
        offsetSec: chart.offsetSec || 0,
        name: (chart.meta && (chart.meta.name || (chart.meta.META && chart.meta.META.name))) || '',
        level: (chart.meta && (chart.meta.level || (chart.meta.META && chart.meta.META.level))) || '',
      },
    };
  }

  /** 主入口：JSON 文本 → PolyBeat 工程片段 */
  function fromJSONText(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error('不是合法的 JSON 文件');
    }
    const fmt = detect(obj);
    if (!fmt) throw new Error('认不出这个谱面格式（RPE / Phigros 官方 / Rizline 之外）');
    let chart;
    if (fmt === 'rpe') chart = parseRPE(obj);
    else if (fmt === 'riz') chart = parseRiz(obj);
    else chart = parseFV3(obj);
    if (!chart.notes.length) throw new Error('这个谱面里没有可用的音符');
    return build(chart);
  }

  return { fromJSONText, detect, parseRPE, parseFV3, parseRiz, build };
})();
