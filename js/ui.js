/* ==========================================================================
   ui.js · 方块网格、多边形音符点、底部编辑面板、播放高亮
   ========================================================================== */

const UI = (function () {
  const el = {};
  let blockEls = [];
  let dotEls = [];         // [blockIndex][dotIndex] -> element
  let builtPage = -1;
  let playingBlock = -1;
  let tailOn = false;      // 谱面放完、等音乐放完的空拍阶段

  const BLOCKS = Project.BLOCKS_PER_PAGE;
  const ANIM_MS = 380;

  /* ------------------------------------------------------------ 元素缓存 */

  function cache() {
    el.boardWrap = document.getElementById('boardWrap');
    el.boardCol = document.getElementById('boardCol');
    el.boardStage = document.getElementById('boardStage');
    el.board = document.getElementById('board');
    el.boardStrip = document.getElementById('boardStrip');
    el.stageBg = document.getElementById('stageBg');
    el.beatHeads = document.getElementById('beatHeads');
    el.barLabels = document.getElementById('barLabels');
    el.legend = document.getElementById('legend');
    el.pageTitle = document.getElementById('pageTitle');
    el.stage = document.querySelector('.stage');
    el.statusMsg = document.getElementById('statusMsg');
    el.toast = document.getElementById('toast');

    el.editor = document.getElementById('editor');
    el.notePad = document.getElementById('notePad');
    el.padCap = document.getElementById('padCap');
    el.edPos = document.getElementById('edPos');
    el.edBadge = document.getElementById('edBadge');
    el.countPicker = document.getElementById('countPicker');
    el.statPages = document.getElementById('statPages');
    el.statHits = document.getElementById('statHits');
    el.statDur = document.getElementById('statDur');

    el.bpm = document.getElementById('bpm');
    el.btnTempo = document.getElementById('btnTempo');
    el.tempoPanel = document.getElementById('tempoPanel');
    el.tempoList = document.getElementById('tempoList');
    el.tempoPos = document.getElementById('tempoPos');
    el.tempoBpm = document.getElementById('tempoBpm');
    el.tempoAdd = document.getElementById('tempoAdd');
    el.tempoHere = document.getElementById('tempoHere');
    el.tempoCount = document.getElementById('tempoCount');
    el.chartPicker = document.getElementById('chartPicker');
    el.pickerList = document.getElementById('pickerList');
    el.pickerSub = document.getElementById('pickerSub');
    el.pickerCancel = document.getElementById('pickerCancel');
    el.tempoClose = document.getElementById('tempoClose');
    el.btnPlay = document.getElementById('btnPlay');
    el.playIco = document.getElementById('playIco');
    el.playTxt = document.getElementById('playTxt');
    el.btnMetro = document.getElementById('btnMetro');
    el.pageNow = document.getElementById('pageNow');
    el.pageTotal = document.getElementById('pageTotal');
    el.preset = document.getElementById('preset');
    el.hitVol = document.getElementById('hitVol');
    el.hitVolVal = document.getElementById('hitVolVal');
  }

  /* ---------------------------------------------------------------- 图例 */

  function buildLegend() {
    el.legend.innerHTML = '';
    const cap = document.createElement('span');
    cap.className = 'legend-cap';
    cap.textContent = '音符数';
    el.legend.appendChild(cap);
    for (let n = 1; n <= MAX_SLOTS; n++) {
      const chip = document.createElement('span');
      chip.className = 'legend-chip';
      chip.style.setProperty('--c', colorForCount(n));
      chip.innerHTML = `<i></i>${n}`;
      chip.title = `一拍里 ${n} 个音符`;
      el.legend.appendChild(chip);
    }
  }

  /* ---------------------------------------------------------------- 网格 */

  function build(pageIdx) {
    const total = Project.pageCount();
    const want = pageIdx == null ? Project.state.page : pageIdx;
    const target = Math.max(0, Math.min(total - 1, want | 0));
    const page = Project.pageAt(target) || [];
    builtPage = target;

    el.beatHeads.innerHTML = '';
    for (let beat = 1; beat <= 4; beat++) {
      const s = document.createElement('span');
      s.textContent = String(beat);
      el.beatHeads.appendChild(s);
    }

    el.barLabels.innerHTML = '';
    for (let bar = 1; bar <= 4; bar++) {
      const s = document.createElement('span');
      s.textContent = String(bar);
      el.barLabels.appendChild(s);
    }

    el.board.innerHTML = '';
    blockEls = [];
    dotEls = [];

    for (let i = 0; i < BLOCKS; i++) {
      el.board.appendChild(buildBlock(i, page[i]));
    }

    renderAllBlocks();
    renderEditor();
    updateStats();
    renderPageTitle();
    layout();
    renderSides();

    // 重建后把当前正在响的方块补回高亮
    if (playingBlock >= 0 && blockEls[playingBlock]) {
      blockEls[playingBlock].classList.add('is-play');
    }
  }

  /** 一个方块卡片（不含交互状态） */
  function makeCard(blk) {
    const card = document.createElement('div');
    card.className = 'block' + (blk.on.some((v, s) => v && s < blk.n) ? '' : ' is-empty');
    card.style.setProperty('--c', colorForCount(blk.n));

    const dots = document.createElement('div');
    dots.className = 'dots';
    const stage = document.createElement('div');
    stage.className = 'dot-stage';
    dots.appendChild(stage);
    card.appendChild(dots);
    return { card, stage };
  }

  /** 往 .dot-stage 里铺音符点，返回点元素数组 */
  function fillDots(stage, blk) {
    stage.innerHTML = '';
    const els = [];
    dotLayout(blk.n).forEach((p, s) => {
      const dot = document.createElement('span');
      dot.className = 'dot' + (blk.on[s] ? ' is-on' : '');
      dot.style.left = (p.x * 100).toFixed(2) + '%';
      dot.style.top = (p.y * 100).toFixed(2) + '%';
      dot.style.width = (p.d * 100).toFixed(2) + '%';
      stage.appendChild(dot);
      els.push(dot);
    });
    return els;
  }

  function buildBlock(i, blk) {
    const { card, stage } = makeCard(blk);
    card.dataset.i = String(i);
    blockEls[i] = card;
    dotEls[i] = fillDots(stage, blk);
    return card;
  }

  function renderDots(i, blk) {
    const card = blockEls[i];
    if (!card) return;
    const wrap = card.querySelector('.dot-stage');
    if (!wrap) return;
    dotEls[i] = fillDots(wrap, blk);
  }

  /* ------------------------------------------------------- 页面切换动画 */

  /** 把某一页画进容器（不登记交互元素，给「等待中的下一页」用） */
  function renderStaticPage(container, pageIdx) {
    const page = Project.pageAt(pageIdx) || [];
    container.innerHTML = '';
    for (let i = 0; i < BLOCKS; i++) {
      const blk = page[i] || { n: 1, on: [false] };
      const { card, stage } = makeCard(blk);
      fillDots(stage, blk);
      container.appendChild(card);
    }
  }

  /** 左右两侧的待命页（7 层：-3 … +3） */
  function renderSides() {
    const page = builtPage;
    const total = Project.pageCount();
    [...el.boardStrip.children].forEach((layer, k) => {
      if (layer === el.board) return;
      const idx = page + (k - 3);
      if (idx < 0 || idx >= total) layer.innerHTML = '';
      else renderStaticPage(layer, idx);
    });
  }

  let animating = false;
  let animTimer = 0;
  let animEndHandler = null;
  let animBase = 0;
  let animTarget = 0;
  let animDir = 0;
  let animSteps = 1;

  const SHIFT_CLASSES = ['is-left', 'is-left2', 'is-left3', 'is-right', 'is-right2', 'is-right3'];

  function shiftClass(steps, dir) {
    return (dir > 0 ? 'is-left' : 'is-right') + (steps > 1 ? String(steps) : '');
  }

  function finishAnim() {
    if (!animating) return;
    animating = false;
    clearTimeout(animTimer);
    if (animEndHandler) {
      el.boardStrip.removeEventListener('transitionend', animEndHandler);
      animEndHandler = null;
    }

    const to = animTarget;
    const target = Project.state.page;
    const pending = target !== to && Math.abs(target - to) === 1;

    // 关键：复位这一帧关掉过渡，否则透明度和位移会再“弹”一次（看起来就是闪一下）
    el.boardStrip.classList.add('no-anim');
    el.boardStrip.classList.remove('is-animating');
    el.boardStrip.classList.remove(...SHIFT_CLASSES);
    build(to);

    requestAnimationFrame(() => {
      el.boardStrip.classList.remove('no-anim');
      if (pending) {
        void el.boardStrip.offsetWidth;
        animatePage(to, target, target > to ? 1 : -1, 1);
      } else if (target !== to) {
        build();
      }
    });
  }

  /** 整条胶片平移 steps 格 */
  function animatePage(from, to, dir, steps) {
    animating = true;
    animBase = from;
    animTarget = to;
    animDir = dir;
    animSteps = steps || 1;
    builtPage = to;
    clearTimeout(animTimer);

    if (!animEndHandler) {
      animEndHandler = (e) => {
        if (e && e.target !== el.boardStrip) return;
        if (e && e.propertyName && e.propertyName !== 'transform') return;
        finishAnim();
      };
      el.boardStrip.addEventListener('transitionend', animEndHandler);
    }

    el.boardStrip.classList.add('is-animating');
    void el.boardStrip.offsetWidth;        // 让起始位置先落地
    el.boardStrip.classList.add(shiftClass(animSteps, animDir));

    // transitionend 万一不触发（比如标签页切走），留个兜底
    animTimer = setTimeout(finishAnim, ANIM_MS + 160);
  }

  /** 整条工程被替换（导入、切示例、增删页）：立刻重建，不播动画 */
  function reloadHard() {
    if (animating) {
      animating = false;
      clearTimeout(animTimer);
      if (animEndHandler) {
        el.boardStrip.removeEventListener('transitionend', animEndHandler);
        animEndHandler = null;
      }
    }
    el.boardStrip.classList.add('no-anim');
    el.boardStrip.classList.remove('is-animating', ...SHIFT_CLASSES);
    build();
    requestAnimationFrame(() => el.boardStrip.classList.remove('no-anim'));
  }

  /** 页变了就播动画；正在播就换更大的目标，让带子直接补间过去 */
  function reload() {
    const target = Project.state.page;
    const total = Project.pageCount();

    if (animating) {
      const delta = target - animBase;          // 相对这一格动画的起点
      const sameDir = delta !== 0 && (delta > 0) === (animDir > 0);
      const steps = Math.min(3, Math.abs(delta));
      if (!sameDir || steps === 0) return;      // 反方向：等这格播完
      if (steps === animSteps) return;          // 距离没变

      // 立刻把目标改到更远的格，浏览器会从当前位置继续补间
      animSteps = steps;
      animTarget = target;
      builtPage = target;
      el.boardStrip.classList.remove(...SHIFT_CLASSES);
      el.boardStrip.classList.add(shiftClass(steps, animDir));
      clearTimeout(animTimer);
      animTimer = setTimeout(finishAnim, ANIM_MS + 160);
      return;
    }

    if (target === builtPage || builtPage < 0 || total <= 1) {
      build();
      return;
    }

    const delta = target - builtPage;
    if (delta === 1 || delta === -1) animatePage(builtPage, target, delta > 0 ? 1 : -1, 1);
    else if (Math.abs(delta) <= 3) animatePage(builtPage, target, delta > 0 ? 1 : -1, Math.abs(delta));
    else build();                 // 跨太多页（比如循环回开头）就直接切
  }

  function renderBlock(i) {
    const blk = Project.blockAt(builtPage, i);
    const card = blockEls[i];
    if (!blk || !card) return;

    card.style.setProperty('--c', colorForCount(blk.n));
    renderDots(i, blk);

    const anyHit = blk.on.some((v, s) => v && s < blk.n);
    card.classList.toggle('is-empty', !anyHit);
    card.classList.toggle('is-sel', Project.state.sel === i);
  }

  function renderAllBlocks() {
    for (let i = 0; i < BLOCKS; i++) renderBlock(i);
    applySelection();
  }

  function applySelection() {
    for (let i = 0; i < BLOCKS; i++) {
      const card = blockEls[i];
      if (card) card.classList.toggle('is-sel', Project.state.sel === i);
    }
  }

  function renderPageTitle() {
    const st = Project.state;
    el.pageTitle.textContent = `第 ${st.page + 1} 页 · 4 小节 · 16 拍` + (tailOn ? ' · 空拍中' : '');
    el.pageNow.textContent = String(st.page + 1);
    el.pageTotal.textContent = String(Project.pageCount());
  }

  /** 谱面放完、等音乐放完的那段：停在最后一页，不打高亮，画面略微变淡 */
  function setTail(on) {
    const next = !!on;
    if (next === tailOn) return;
    tailOn = next;
    if (el.stage) el.stage.classList.toggle('is-tail', next);
    renderPageTitle();
    if (next) setPlayingBlock(-1);
  }

  /* ------------------------------------------------------------ 底部编辑面板 */

  function buildEditorControls() {
    el.countPicker.innerHTML = '';
    for (let n = 1; n <= MAX_SLOTS; n++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'count-btn';
      btn.dataset.n = String(n);
      btn.textContent = String(n);
      btn.style.setProperty('--c', colorForCount(n));
      btn.title = `一拍分 ${n} 份`;
      el.countPicker.appendChild(btn);
    }
  }

  function renderNotePad(blk) {
    el.notePad.innerHTML = '';
    el.notePad.classList.toggle('is-empty', !blk);
    if (!blk) {
      el.padCap.textContent = '未选中方块';
      el.notePad.style.removeProperty('--c');
      return;
    }

    el.notePad.style.setProperty('--c', colorForCount(blk.n));
    const pts = dotLayout(blk.n);
    pts.forEach((p, s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad-dot' + (blk.on[s] ? ' is-on' : '');
      b.dataset.s = String(s);
      b.style.left = (p.x * 100).toFixed(2) + '%';
      b.style.top = (p.y * 100).toFixed(2) + '%';
      b.style.width = (Math.max(p.d, 0.18) * 100).toFixed(2) + '%';
      b.textContent = String(s + 1);
      b.title = `第 ${s + 1} 个音符 · ${blk.on[s] ? '击打' : '不击打'}`;
      el.notePad.appendChild(b);
    });
    el.padCap.textContent = `${blk.n} 个音符 · 点圆点切换击打`;
  }

  function renderEditor() {
    const i = Project.state.sel;
    const blk = i == null ? null : Project.selectedBlock();

    el.editor.classList.toggle('is-idle', !blk);
    renderNotePad(blk);
    updateStats();

    if (!blk) {
      el.edPos.textContent = '点上方一个方块，在这里设置它的音符';
      el.edBadge.hidden = true;
      return;
    }

    const bar = Math.floor(i / 4) + 1;
    const beat = (i % 4) + 1;
    el.edPos.textContent = `第 ${Project.state.page + 1} 页 · 第 ${bar} 小节 · 第 ${beat} 拍`;
    el.edBadge.hidden = false;

    el.editor.style.setProperty('--c', colorForCount(blk.n));
    el.countPicker.style.setProperty('--c', colorForCount(blk.n));

    el.countPicker.querySelectorAll('.count-btn').forEach((b) => {
      b.classList.toggle('is-on', Number(b.dataset.n) === blk.n);
    });
  }

  function updateStats() {
    el.statPages.textContent = String(Project.pageCount());
    el.statHits.textContent = String(Project.countHits());
    el.statDur.textContent = Project.totalDur().toFixed(2) + 's';
  }

  /* ---------------------------------------------------------------- 尺寸 */

  function layout() {
    const wrapW = el.boardWrap.clientWidth;
    const wrapH = el.boardWrap.clientHeight;
    const size = Math.max(220, Math.min(wrapW - 46, wrapH - 20));
    el.boardCol.style.setProperty('--size', size + 'px');
  }

  /* ------------------------------------------------------------ BPM 列表 */

  function setBpmInput(v) {
    if (document.activeElement === el.bpm) return;
    el.bpm.value = String(v);
  }

  function renderTempoList() {
    if (!el.tempoList) return;
    const list = Project.state.tempos;
    el.tempoCount.textContent = `${list.length} 项`;

    el.tempoList.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'tp-empty';
      li.textContent = '速度表是空的（不应该发生）';
      el.tempoList.appendChild(li);
      return;
    }

    list.forEach((m, idx) => {
      const li = document.createElement('li');
      li.className = 'tp-row' + (idx === 0 ? ' is-start' : '');

      const pos = document.createElement('span');
      pos.className = 'tp-pos';
      pos.textContent = Project.formatTempoPos(m.beat, m.offset);
      pos.title = `第 ${m.beat} 拍 · ${Project.formatTempoPos(m.beat, m.offset)}`;

      const bpm = document.createElement('input');
      bpm.type = 'number';
      bpm.min = '4';
      bpm.max = '2000';
      bpm.step = '0.01';
      bpm.className = 'tp-bpm';
      bpm.value = String(m.bpm);
      bpm.dataset.i = String(idx);
      bpm.title = 'BPM';

      li.append(pos, bpm);

      if (idx === 0) {
        const tag = document.createElement('span');
        tag.className = 'tp-start';
        tag.textContent = '起点';
        tag.title = '整曲起始速度';
        li.appendChild(tag);
      } else {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tp-del';
        del.dataset.i = String(idx);
        del.textContent = '×';
        del.title = '删除这一项';
        li.appendChild(del);
      }

      el.tempoList.appendChild(li);
    });
  }

  function placeTempoPanel() {
    const r = el.btnTempo.getBoundingClientRect();
    el.tempoPanel.hidden = false;
    const w = el.tempoPanel.offsetWidth || 336;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left - 24));
    el.tempoPanel.style.left = left + 'px';
    el.tempoPanel.style.top = (r.bottom + 8) + 'px';
  }

  let tempoOutside = null;

  function openTempoPanel() {
    renderTempoList();
    placeTempoPanel();
    el.tempoPos.focus();
    tempoOutside = (e) => {
      if (!el.tempoPanel.contains(e.target) && !el.btnTempo.contains(e.target)) closeTempoPanel();
    };
    setTimeout(() => document.addEventListener('pointerdown', tempoOutside, true), 0);
  }

  function closeTempoPanel() {
    el.tempoPanel.hidden = true;
    if (tempoOutside) {
      document.removeEventListener('pointerdown', tempoOutside, true);
      tempoOutside = null;
    }
  }

  function currentBeatNo() {
    const sel = Project.state.sel;
    return Project.state.page * Project.BLOCKS_PER_PAGE + (sel == null ? 0 : sel) + 1;
  }

  function bindTempo() {
    el.btnTempo.addEventListener('click', () => {
      if (el.tempoPanel.hidden) openTempoPanel();
      else closeTempoPanel();
    });

    el.tempoClose.addEventListener('click', closeTempoPanel);

    el.tempoHere.addEventListener('click', () => {
      const beat = currentBeatNo();
      el.tempoPos.value = Project.formatTempoPos(beat, 0);
      el.tempoBpm.value = String(Project.bpmAtBeat(beat));
      el.tempoPos.focus();
    });

    const add = () => {
      const parsed = Project.parseTempoPos(el.tempoPos.value);
      if (!parsed) {
        toast('位置写法不对，例如 1:1/2');
        el.tempoPos.focus();
        return;
      }
      if (parsed.beat > Project.totalBeats()) {
        toast(`超出范围：整曲只有 ${Project.totalBeats()} 拍`);
        return;
      }
      const bpmRaw = Number(el.tempoBpm.value);
      const bpm = Number.isFinite(bpmRaw) && bpmRaw > 0 ? bpmRaw : Project.bpmAtBeat(parsed.beat);
      Project.pushUndo();
      Project.setTempo(parsed.beat, parsed.offset, bpm);
      toast(`${Project.formatTempoPos(parsed.beat, parsed.offset)} → ${Project.clampBpm(bpm)} BPM`);
    };

    el.tempoAdd.addEventListener('click', add);
    el.tempoPos.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    el.tempoBpm.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

    el.tempoList.addEventListener('change', (e) => {
      const input = e.target.closest('.tp-bpm');
      if (!input) return;
      const idx = Number(input.dataset.i);
      const m = Project.state.tempos[idx];
      if (!m) return;
      Project.pushUndo();
      Project.setTempo(m.beat, m.offset, Number(input.value));
    });

    el.tempoList.addEventListener('click', (e) => {
      const btn = e.target.closest('.tp-del');
      if (!btn) return;
      const idx = Number(btn.dataset.i);
      Project.pushUndo();
      Project.removeTempo(idx);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.tempoPanel.hidden) closeTempoPanel();
    });
  }

  /* ---------------------------------------------------------------- 播放 */

  function setPlayingBlock(i) {    if (i === playingBlock) return;
    if (playingBlock >= 0 && blockEls[playingBlock]) {
      blockEls[playingBlock].classList.remove('is-play');
    }
    playingBlock = i;
    if (i >= 0 && blockEls[i]) blockEls[i].classList.add('is-play');
  }

  function flashDot(i, s) {
    const dot = dotEls[i] && dotEls[i][s];
    if (!dot) return;
    dot.classList.add('is-hit');
    setTimeout(() => dot.classList.remove('is-hit'), 200);
  }

  function resetPlayhead() {
    setPlayingBlock(-1);
  }

  /* ---------------------------------------------------------------- 提示 */

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1900);
  }

  let statusTimer = 0;
  function status(msg) {
    el.statusMsg.textContent = msg;
    el.statusMsg.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.statusMsg.classList.remove('show'), 1500);
  }

  /* ------------------------------------------------------------ 事件绑定 */

  function blockIndexFromEvent(e) {
    const card = e.target.closest('.block');
    return card ? Number(card.dataset.i) : null;
  }

  function bindBoard() {
    el.board.addEventListener('pointerdown', (e) => {
      const i = blockIndexFromEvent(e);
      if (i == null) return;
      e.preventDefault();
      Project.select(i);
    });

    el.board.addEventListener('wheel', (e) => {
      const i = blockIndexFromEvent(e);
      if (i == null) return;
      const blk = Project.blockAt(Project.state.page, i);
      if (!blk) return;
      const next = blk.n + (e.deltaY > 0 ? -1 : 1);
      if (next < 1 || next > MAX_SLOTS) return;
      e.preventDefault();
      Project.pushUndo();
      Project.select(i);
      Project.setCount(i, next);
    }, { passive: false });

    el.board.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.block')) e.preventDefault();
    });
  }

  function previewBlock(i) {
    const blk = Project.blockAt(Project.state.page, i);
    if (!blk) return;
    const on = blk.on.some((v, s) => v && s < blk.n);
    if (!on) return;
    Synth.preview();
  }

  function bindEditor() {
    el.countPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('.count-btn');
      if (!btn) return;
      const i = Project.state.sel;
      if (i == null) return;
      Project.pushUndo();
      Project.setCount(i, Number(btn.dataset.n));
      previewBlock(i);
    });

    el.notePad.addEventListener('click', (e) => {
      const btn = e.target.closest('.pad-dot');
      if (!btn) return;
      const i = Project.state.sel;
      if (i == null) return;
      Project.pushUndo();
      Project.toggleSlot(i, Number(btn.dataset.s));
      const blk = Project.blockAt(Project.state.page, i);
      if (blk.on[Number(btn.dataset.s)]) previewBlock(i);
    });

    const doFill = (mode) => () => {
      const i = Project.state.sel;
      if (i == null) return;
      Project.pushUndo();
      Project.fillBlock(i, mode);
    };
    document.getElementById('btnAllOn').addEventListener('click', doFill('on'));
    document.getElementById('btnAllOff').addEventListener('click', doFill('off'));
    document.getElementById('btnInvert').addEventListener('click', doFill('invert'));

    document.getElementById('btnClearBlock').addEventListener('click', () => {
      const i = Project.state.sel;
      if (i == null) return;
      Project.pushUndo();
      Project.fillBlock(i, 'off');
      toast('这个方块已经全部设为不击打');
    });

    document.getElementById('btnCopyBlock').addEventListener('click', () => {
      const i = Project.state.sel;
      if (i == null) return;
      if (Project.copyBlock(i)) toast('方块已复制');
    });

    document.getElementById('btnPasteBlock').addEventListener('click', () => {
      const i = Project.state.sel;
      if (i == null) return;
      if (!Project.hasClipboard()) { toast('还没有复制过方块'); return; }
      Project.pushUndo();
      Project.pasteBlock(i);
      toast('已粘贴');
    });
  }

  /* ------------------------------------------------------------ 谱面选择窗 */

  /** 一包里多个谱面时弹窗让用户选，返回 Promise<下标 | null> */
  function showChartPicker(items, subtitle) {
    return new Promise((resolve) => {
      el.pickerList.innerHTML = '';
      el.pickerSub.textContent = subtitle || '';
      el.chartPicker.hidden = false;

      let done = false;
      const finish = (idx) => {
        if (done) return;
        done = true;
        el.chartPicker.hidden = true;
        el.pickerCancel.onclick = null;
        document.removeEventListener('keydown', onKey, true);
        resolve(idx);
      };
      const onKey = (e) => { if (e.key === 'Escape') finish(null); };
      document.addEventListener('keydown', onKey, true);
      el.pickerCancel.onclick = () => finish(null);

      items.forEach((it, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'picker-item';
        const b = document.createElement('b');
        b.textContent = it.label;
        const s = document.createElement('small');
        s.textContent = it.file;
        btn.append(b, s);
        btn.addEventListener('click', () => finish(idx));
        el.pickerList.appendChild(btn);
      });
    });
  }

  /* --------------------------------------------------------- 示例节奏下拉 */

  /** pkgItems 非空时，下拉里多出「包内谱面」一组 */
  function buildPresetOptions(pkgItems) {
    const sel = el.preset;
    sel.innerHTML = '';

    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = pkgItems && pkgItems.length ? '包内谱面…' : '示例节奏…';
    sel.appendChild(ph);

    if (pkgItems && pkgItems.length) {
      const g = document.createElement('optgroup');
      g.label = '包内谱面';
      pkgItems.forEach((it, i) => {
        const o = document.createElement('option');
        o.value = 'zip:' + i;
        o.textContent = it.label;
        g.appendChild(o);
      });
      sel.appendChild(g);
    }

    const g2 = document.createElement('optgroup');
    g2.label = '示例节奏';
    Object.keys(PRESETS).forEach((k) => {
      const o = document.createElement('option');
      o.value = 'preset:' + k;
      o.textContent = PRESETS[k].name;
      g2.appendChild(o);
    });
    sel.appendChild(g2);
  }

  /* -------------------------------------------------------------- 初始化 */

  let resizeTimer = 0;

  function init() {
    cache();
    buildLegend();
    buildEditorControls();
    bindBoard();
    bindEditor();
    bindTempo();

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 80);
    });

    buildPresetOptions(null);
    build();
  }

  /* ------------------------------------------------------------ 谱面背景 */

  /** 设置 / 清除谱面背景（模糊 + 压暗的曲绘），传 null 清除 */
  function setStageBg(url) {
    if (!el.stageBg) return;
    if (url) {
      el.stageBg.style.backgroundImage = `url("${url}")`;
      el.stageBg.classList.add('is-on');
    } else {
      el.stageBg.classList.remove('is-on');
      el.stageBg.style.backgroundImage = '';
    }
  }

  return {
    init, build, reload, reloadHard,
    renderBlock, renderAllBlocks, applySelection,
    renderEditor, renderPageTitle, updateStats, layout,
    renderTempoList, setBpmInput,
    showChartPicker, buildPresetOptions, setStageBg,
    setPlayingBlock, flashDot, resetPlayhead, setTail,
    toast, status,
    get playingBlock() { return playingBlock; },
  };
})();
