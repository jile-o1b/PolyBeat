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
  const BPM_MAX = 12000;      // 上限放宽：谱面里有 1024、甚至 9999999 这种演出用的假 BPM

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

  /* -------------------------------------------------------------- Arcaea */

  /** 认一下是不是 .aff 文本：有 AudioOffset 头或者 timing(...) 语句 */
  function looksLikeAFF(text) {
    const head = String(text || '').slice(0, 4000);
    return /(^|\n)\s*AudioOffset\s*:/i.test(head) || /(^|\n)\s*timing\s*\([^)]*\)/i.test(head);
  }

  /**
   * Arcaea 的 .aff：纯文本，时间单位是毫秒。
   *   AudioOffset:x       音乐整体前移 -x / 后移 +x 毫秒
   *   timing(ms,bpm,beats)
   *   (t,lane)            地面 Note（lane 1–4）
   *   hold(t1,t2,lane)    Hold，只算头
   *   arc(t1,t2,x1,x2,ease,y1,y2,color,fx,skyline)[arctap(t),...]
   *   timinggroup(...){ ... };  组内自带 timing，noinput 那组是演出用的
   */
  function parseAFF(text) {
    const lines = String(text || '').split(/\r?\n/);
    let offsetMs = 0;
    const timings = [];        // 主时间轴
    const rawNotes = [];       // { ms, kind }
    let groupDepth = 0;
    let skipGroup = false;
    let lastArc = null;        // 用来把首尾相接的 arc 段并成一条

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (/^AudioOffset\s*:/i.test(line)) {
        const m = line.match(/^AudioOffset\s*:\s*(-?\d+(?:\.\d+)?)/i);
        if (m) offsetMs = Math.round(Number(m[1]));
        continue;
      }
      if (/^TimingPointDensityFactor\s*:/i.test(line)) continue;

      if (/^timinggroup\s*\(/i.test(line)) {
        groupDepth++;
        if (groupDepth === 1) skipGroup = /noinput/i.test(line);
        continue;
      }
      if (groupDepth > 0 && /^\}\s*;?/.test(line)) {
        groupDepth = Math.max(0, groupDepth - 1);
        if (groupDepth === 0) skipGroup = false;
        continue;
      }

      // timing(ms, bpm, beats)
      const mt = line.match(/^timing\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
      if (mt) {
        // 只有主时间轴的 timing 拿来算拍子；组内的流速不同，不参与
        if (groupDepth === 0) {
          const ms = Math.round(Number(mt[1]));
          const raw = Number(mt[2]);
          // 和 build() 用同一个范围夹：谱面里偶尔有 9999999 这种演出用的假 BPM，
          // 不夹的话后面所有音符的拍号会飞出去（还会被页数上限截断）。
          if (raw > 0) timings.push({ ms, bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, raw)), rawBpm: raw });
        }
        continue;
      }
      if (skipGroup) continue;

      // hold(t1,t2,lane)
      const mh = line.match(/^hold\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*\d+\s*\)/i);
      if (mh) {
        rawNotes.push({ ms: Math.round(Number(mh[1])), kind: 'hold' });
        continue;
      }

      // arc(...)：首尾相接的段并成一条，只在头上一击
      const ma = line.match(/^arc\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,([^)]*)\)/i);
      if (ma) {
        const t1 = Math.round(Number(ma[1]));
        const rest = ma[3].split(',');
        // 参数顺序：x1,x2,ease,y1,y2,color,fx,skyline
        const x1 = Number(rest[0]);
        const x2 = Number(rest[1]);
        const y1 = Number(rest[3]);
        const y2 = Number(rest[4]);
        const skyline = String(rest[7] || '').trim().toLowerCase() === 'true';

        // skyline 为 true 的弧只是天空 Note 的判定线，本身不产生判定（官方物量为 0）
        const prev = lastArc;
        const joined = !skyline && prev && Math.abs(t1 - prev.t2) < 10 &&
          Math.abs(y1 - prev.y2) < 0.001 && Math.abs(x1 - prev.x2) < 0.1;
        if (!skyline && !joined) rawNotes.push({ ms: t1, kind: 'arc' });
        lastArc = { t2: Math.round(Number(ma[2])), x2, y2 };
        // arctap(...) = 天空 Note，每个都是一下
        const taps = line.match(/\[([^\]]*)\]/);
        if (taps) {
          const re = /arctap\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/gi;
          let m2;
          while ((m2 = re.exec(taps[1]))) {
            rawNotes.push({ ms: Math.round(Number(m2[1])), kind: 'arctap' });
          }
        }
        continue;
      }

      // 地面 Note：(t,lane);
      const mg = line.match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*\d+\s*\)\s*;?/);
      if (mg) {
        rawNotes.push({ ms: Math.round(Number(mg[1])), kind: 'tap' });
      }
    }

    if (!rawNotes.length) throw new Error('这个 .aff 里没有可用的音符');
    if (!timings.length) {
      // 极端情况：没有主时间轴，就当 120 BPM
      timings.push({ ms: 0, bpm: 120 });
    }
    timings.sort((a, b) => a.ms - b.ms);

    // 毫秒 → 拍：按 timing 分段积分
    const segs = [];
    let beat = 0;
    let prev = null;
    timings.forEach((t) => {
      if (prev) {
        if (t.ms <= prev.ms) return;      // 同一时刻重复的 timing 只留第一条
        beat += (t.ms - prev.ms) * prev.bpm / 60000;
      }
      segs.push({ ms: t.ms, beat, bpm: t.bpm });
      prev = t;
    });

    const beatAt = (ms) => {
      let seg = segs[0];
      for (const s of segs) { if (s.ms <= ms) seg = s; else break; }
      return Math.max(0, seg.beat + (ms - seg.ms) * seg.bpm / 60000);
    };

    const notes = rawNotes.map((n) => ({ beat: beatAt(n.ms), type: 1 }));

    return {
      format: 'aff',
      label: 'Arcaea .aff',
      bpmList: segs.map((s) => ({ beat: s.beat, bpm: s.bpm })),
      notes,
      meta: { name: '' },
      // AudioOffset 为正表示物件时间比音乐晚 x ms → 音乐在谱面时间 0 时还差 x ms
      offsetSec: -offsetMs / 1000,
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
    // 先把拍号吸附到 1/64 拍：毫秒取整、浮点误差会让 2.0 变成 1.997，
    // 那样会被算成"第 1 拍的 0.997 处"，再量化就掉到拍首，整整差一拍。
    const SNAP = 1 / 64;
    const buckets = new Map();
    uniq.forEach((n) => {
      const snapped = Math.round(n.beat / SNAP) * SNAP;
      let b = Math.floor(snapped + 1e-9);
      let off = snapped - b;
      // 拍尾那 1/16 里的音（≥15/16）归到下一拍开头：
      // 一拍只有 1/8 的格子，落在 0.94 附近的音放"7/8"和放"下一拍"误差差不多，
      // 但归到下一拍不会让整拍错位，量化误差也更小。
      if (off >= 15 / 16 - 1e-9) { b += 1; off = 0; }
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
            // 误差要按"实际落到的格子"算：k 顶到 n 时会被夹回 n-1，
            // 如果还用 k/n 当参照，就会以为它贴在拍尾、其实落到了拍首。
            const k = Math.round(o * n);
            const slot = Math.min(n - 1, Math.max(0, k));
            err = Math.max(err, Math.abs(o - slot / n));
            slots.add(slot);
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
    if (!fmt) throw new Error('认不出这个谱面格式（RPE / Phigros / Rizline / Arcaea 之外）');
    let chart;
    if (fmt === 'rpe') chart = parseRPE(obj);
    else if (fmt === 'riz') chart = parseRiz(obj);
    else chart = parseFV3(obj);
    if (!chart.notes.length) throw new Error('这个谱面里没有可用的音符');
    return build(chart);
  }

  /** 主入口：任意文本（JSON 或 .aff）→ PolyBeat 工程片段 */
  function fromText(text) {
    if (looksLikeAFF(text)) {
      const chart = parseAFF(text);
      return build(chart);
    }
    return fromJSONText(text);
  }

  return {
    fromJSONText, fromText, detect, looksLikeAFF,
    parseRPE, parseFV3, parseRiz, parseAFF, build,
  };
})();
