/* ==========================================================================
   midi.js · 导出标准 MIDI 文件（SMF format 0）
   一个方块 = 一拍 = 480 tick；块内音符按 n 等分。
   所有击打共用一个音色，统一写成通道 10 的底鼓（GM 36）。
   ========================================================================== */

const MidiExport = (function () {
  const PPQ = 480;
  const BLOCKS = 16;
  const DRUM_CH = 9;      // MIDI 通道 10（0 基）
  const DRUM_NOTE = 36;   // General MIDI Bass Drum 1

  function varlen(n) {
    const bytes = [n & 0x7f];
    n >>= 7;
    while (n > 0) {
      bytes.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    return bytes;
  }

  function str(s) {
    return Array.from(s).map((c) => c.charCodeAt(0));
  }

  function build() {
    const st = Project.state;
    const events = [];
    const push = (tick, bytes) => events.push({ tick: Math.max(0, Math.round(tick)), bytes });

    st.pages.forEach((page, p) => {
      page.forEach((blk, i) => {
        const beatTick = (p * BLOCKS + i) * PPQ;
        const slotTick = PPQ / blk.n;
        const vel = Math.max(1, Math.min(127, Math.round(blk.vel * 127)));
        const len = Math.max(20, slotTick * 0.45);

        for (let s = 0; s < blk.n; s++) {
          if (!blk.on[s]) continue;
          const tick = beatTick + s * slotTick;
          push(tick, [0x90 | DRUM_CH, DRUM_NOTE, vel]);
          push(tick + len, [0x80 | DRUM_CH, DRUM_NOTE, 0x40]);
        }
      });
    });

    // 变速标记 → 速度事件（第一项已经在文件开头写过，跳过 tick 0）
    const tempoBytes = (bpm) => {
      const us = Math.round(60000000 / bpm);
      return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
    };
    st.tempos.forEach((m) => {
      const tick = (m.beat - 1 + m.offset) * PPQ;
      if (tick < 1) return;
      push(tick, tempoBytes(m.bpm));
    });

    // 同一 tick：速度事件 → 关音符 → 开音符
    const rank = (b) => {
      if (b[0] === 0xff) return 0;
      if ((b[0] & 0xf0) === 0x80) return 1;
      return 2;
    };
    events.sort((a, b) => {
      if (a.tick !== b.tick) return a.tick - b.tick;
      return rank(a.bytes) - rank(b.bytes);
    });

    const body = [];
    // 起始速度就是速度表第一项
    const usPerQuarter = Math.round(60000000 / Project.bpmAtBeat(1));
    body.push(...varlen(0), 0xff, 0x51, 0x03,
      (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
    body.push(...varlen(0), 0xff, 0x58, 0x04, 0x04, 0x02, 24, 8);

    const name = str('PolyBeat');
    body.push(...varlen(0), 0xff, 0x03, name.length, ...name);

    let last = 0;
    events.forEach((ev) => {
      body.push(...varlen(ev.tick - last), ...ev.bytes);
      last = ev.tick;
    });
    body.push(...varlen(0), 0xff, 0x2f, 0x00);

    const trackChunk = [
      ...str('MTrk'),
      (body.length >> 24) & 0xff, (body.length >> 16) & 0xff,
      (body.length >> 8) & 0xff, body.length & 0xff,
      ...body,
    ];

    const header = [
      ...str('MThd'),
      0x00, 0x00, 0x00, 0x06,
      0x00, 0x00,
      0x00, 0x01,
      (PPQ >> 8) & 0xff, PPQ & 0xff,
    ];

    return new Uint8Array([...header, ...trackChunk]);
  }

  /** 只生成文件内容，不触发下载 */
  function toBlob() {
    return new Blob([build()], { type: 'audio/midi' });
  }

  /** 文件名：polybeat-日期-时间.mid */
  function filename() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `polybeat-${stamp}.mid`;
  }

  return { build, toBlob, filename, PPQ };
})();
