/* ==========================================================================
   data.js · 颜色、方块构造、音符点排布、示例节奏
   全部方块共用同一个打击音（hit.wav），所以这里没有乐器表。
   ========================================================================== */

const MAX_SLOTS = 8;

/* 颜色：方块里的音符数量决定颜色 */
const COUNT_COLORS = [
  null,
  '#ff5c6c', // 1 个音符 · 红
  '#ff9f43', // 2 · 橙
  '#ffd166', // 3 · 黄
  '#7ee787', // 4 · 绿
  '#22d3ee', // 5 · 青
  '#6f9bff', // 6 · 蓝
  '#b392f0', // 7 · 紫
  '#ff79c6', // 8 · 粉
];

function colorForCount(n) {
  return COUNT_COLORS[Math.max(1, Math.min(MAX_SLOTS, n | 0))];
}

function clamp01(v) {
  return Math.max(0.05, Math.min(1, Number(v) || 0.85));
}

/* --------------------------------------------------------------------------
   方块：{ n, on[] }
   n     这一拍分成几份（1–8）
   on    n 个布尔值，true = 击打
   -------------------------------------------------------------------------- */
function makeBlock(n, pattern) {
  const count = Math.max(1, Math.min(MAX_SLOTS, n | 0 || 1));
  const on = [];
  for (let i = 0; i < count; i++) on.push(!!(pattern && pattern[i] === 'x'));
  return { n: count, on };
}

function emptyBlock() {
  return makeBlock(1, '.');
}

/** 简写：b(2, 'x.') —— 一拍两音，只打前半 */
function b(n, pattern) {
  return makeBlock(n, pattern);
}

function blockHits(block) {
  return block.on.reduce((n, v) => n + (v ? 1 : 0), 0);
}

/** 改音符数量时默认全部击打（之后可以逐个关掉） */
function resizeBlock(block, n) {
  const next = Math.max(1, Math.min(MAX_SLOTS, n | 0 || 1));
  if (next === block.n) return false;
  block.n = next;
  block.on = new Array(next).fill(true);
  return true;
}

/* --------------------------------------------------------------------------
   方块里音符点的排布（返回每个点的圆心与直径，都是 0–1 的相对值）
   1 个 = 中心一点；2 个 = 左右；3 个 = 等边三角形；
   4 个 = 正方形四角；5 个以上 = 正多边形
   -------------------------------------------------------------------------- */
const DOT_SIZES = [0, 0.38, 0.30, 0.27, 0.25, 0.24, 0.21, 0.19, 0.18];

function dotLayout(n) {
  const count = Math.max(1, Math.min(MAX_SLOTS, n | 0 || 1));
  const d = DOT_SIZES[count] || 0.18;

  if (count === 1) return [{ x: 0.5, y: 0.5, d }];
  if (count === 2) {
    return [
      { x: 0.27, y: 0.5, d },
      { x: 0.73, y: 0.5, d },
    ];
  }

  // 4 个用 45° 起始，落成正方形四角；3 个与 5 个以上从正上方开始
  const start = count === 4 ? Math.PI / 4 : -Math.PI / 2;
  const r = count <= 4 ? 0.29 : 0.31;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = start + (i * Math.PI * 2) / count;
    pts.push({
      x: 0.5 + Math.cos(a) * r,
      y: 0.5 + Math.sin(a) * r,
      d,
    });
  }

  // 击打顺序 = 看得见的顺序：先上后下，同一高度从左到右
  pts.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 1e-6) return a.y - b.y;
    if (Math.abs(a.x - b.x) > 1e-6) return a.x - b.x;
    return 0;
  });
  return pts;
}

/* --------------------------------------------------------------------------
   示例节奏（每页 16 个方块 = 4 小节 × 4 拍；不够 16 个自动补空）
   -------------------------------------------------------------------------- */
function padPage(blocks) {
  const out = blocks.slice(0, 16);
  while (out.length < 16) out.push(emptyBlock());
  return out;
}

const PRESETS = {
  basic: {
    name: '基本四拍 · 100 BPM',
    bpm: 100,
    pages: [padPage([
      b(1, 'x'), b(2, 'x.'), b(1, 'x'), b(2, 'x.'),
      b(1, 'x'), b(2, 'x.'), b(1, 'x'), b(4, 'x.x.'),
      b(2, 'x.'), b(2, 'x.'), b(1, 'x'), b(2, 'xx'),
      b(1, 'x'), b(3, 'x..'), b(2, 'xx'), b(4, 'x.x.'),
    ])],
  },

  triplet: {
    name: '三连音 · 96 BPM',
    bpm: 96,
    pages: [padPage([
      b(3, 'x..'), b(3, 'xxx'), b(3, 'x.x'), b(3, 'xxx'),
      b(3, 'x..', 0.95), b(3, 'xxx', 0.6), b(3, 'x.x'), b(3, 'xx.'),
      b(3, 'x.x'), b(6, 'x.x.x.'), b(3, 'x.x'), b(3, 'xxx', 0.55),
      b(1, 'x', 1), b(3, 'x.x', 0.75), b(6, 'x.x.x.'), b(3, 'xxx', 0.5),
    ])],
  },

  broken: {
    name: '碎拍 · 128 BPM',
    bpm: 128,
    pages: [
      padPage([
        b(2, 'x.'), b(4, 'x.x.'), b(2, 'xx'), b(4, '.x.x'),
        b(4, 'x..x'), b(8, 'x.x.x.x.'), b(2, 'x.'), b(4, 'x.x.'),
        b(3, 'x.x'), b(4, 'xxxx', 0.55), b(4, 'x.x.'), b(6, 'xx.xx.'),
        b(1, 'x'), b(4, 'x.x.', 0.8), b(8, 'x.x.x.x.'), b(1, 'x', 0.7),
      ]),
      padPage([
        b(2, 'x.'), b(4, 'x.x.'), b(2, 'xx'), b(4, '.x.x'),
        b(4, 'x..x'), b(8, 'x.x.x.x.'), b(2, 'x.'), b(2, '.x', 0.6),
        b(3, 'x.x'), b(4, 'xxxx', 0.55), b(4, 'x.x.'), b(3, 'x.x', 0.65),
        b(1, 'x'), b(4, 'x..x', 0.8), b(8, 'x.x.x.x.'), b(1, 'x', 0.7),
      ]),
    ],
  },

  empty: {
    name: '空白工程',
    bpm: 100,
    pages: [padPage([])],
  },
};
