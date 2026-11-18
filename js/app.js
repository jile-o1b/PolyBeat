/* ==========================================================================
   app.js · 走带、快捷键、文件读写
   ========================================================================== */

(function () {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = 'polybeat.project.v1';

  let metronomeOn = false;
  let rafId = 0;
  let saveTimer = 0;
  let musicOffset = 0;   // 谱面 offset：音乐相对第 1 拍的位置（秒）

  const Transport = {
    playing: false,
    beat: 0,          // 绝对拍号（0 基，跨页连续）
    lastBeat: 0,      // 最近一次响的拍，用于顶部 BPM 显示
    nextBeat: 0,
    timer: 0,
    events: [],
    cycle: 0,         // 一轮循环多少拍（可能比谱面长，好让音乐放完）
  };

  const LOOKAHEAD = 0.12;
  const TICK_MS = 25;

  /* ---------------------------------------------------------------- 走带 */

  function blockPos(beat0) {
    const perPage = Project.BLOCKS_PER_PAGE;
    const page = Math.floor(beat0 / perPage) % Math.max(1, Project.pageCount());
    return { p: page, i: beat0 % perPage };
  }

  /** 当前播放速度（1 = 原速） */
  function playSpeed() {
    const s = Number(Project.state.speed);
    return isFinite(s) && s > 0 ? s : 1;
  }

  /** 一轮循环多少拍：谱面长度，或音乐放完需要的长度，取大的那个 */
  function cycleLength() {
    const chartBeats = Project.totalBeats();
    if (!Synth.hasMusic || !(Synth.musicDuration > 0)) return chartBeats;
    const endSec = Synth.musicDuration - musicOffset;
    if (!(endSec > 0)) return chartBeats;
    return Math.max(chartBeats, Project.beatAtSeconds(endSec) + 1);
  }

  function refreshCycle() {
    Transport.cycle = cycleLength();
    return Transport.cycle;
  }

  function scheduleBeat(beat0, t) {
    const segs = Project.beatSegments(beat0);
    const speed = playSpeed();
    const dur = Project.timeInBeat(segs, 1) / speed;   // 放慢时每拍占用的真实时间更久
    const chartBeats = Project.totalBeats();
    const tail = beat0 >= chartBeats;          // 谱面放完了，只剩空拍
    const i = beat0 % Project.BLOCKS_PER_PAGE;

    Transport.events.push({
      t, kind: 'beat', beat: beat0, tail, i,
      p: tail ? -1 : Math.floor(beat0 / Project.BLOCKS_PER_PAGE),
      bpm: Project.bpmAtBeat(beat0 + 1),
    });

    if (!tail && i >= 0) {
      const page = Math.floor(beat0 / Project.BLOCKS_PER_PAGE);
      const blk = Project.blockAt(page, i);
      if (blk) {
        for (let s = 0; s < blk.n; s++) {
          if (!blk.on[s]) continue;
          // 拍内的音符位置也要按速度缩放，否则点会按原速打完
          const at = t + Project.timeInBeat(segs, s / blk.n) / speed;
          Synth.play(at);
          Transport.events.push({ t: at, kind: 'slot', p: page, i, s });
        }
      }
    }

    if (metronomeOn) Synth.click(t, i % 4 === 0);
    return dur;
  }

  function scheduler() {
    const now = Synth.now();
    const total = Math.max(1, Transport.cycle || Project.totalBeats());
    let guard = 0;
    while (Transport.nextBeat < now + LOOKAHEAD && guard++ < 128) {
      const beat0 = Transport.beat % total;
      if (beat0 === 0 && Synth.hasMusic) {
        Synth.startMusic(Transport.nextBeat, musicOffset);
      }
      const dur = scheduleBeat(beat0, Transport.nextBeat);
      Transport.nextBeat += dur;
      Transport.beat = (beat0 + 1) % total;
    }
  }

  function frame() {
    if (!Transport.playing) return;
    const now = Synth.now();
    while (Transport.events.length && Transport.events[0].t <= now + 0.02) {
      const ev = Transport.events.shift();
      if (ev.kind === 'beat') {
        Transport.lastBeat = ev.beat;
        if (ev.tail) {
          // 谱面放完了：停在最后一页，不放高亮，等音乐放完
          UI.setTail(true);
        } else {
          UI.setTail(false);
          if (ev.p !== Project.state.page) {
            Project.gotoPage(ev.p);
            UI.resetPlayhead();
          }
          UI.setPlayingBlock(ev.i);
        }
        UI.setBpmInput(ev.bpm);
      } else {
        UI.flashDot(ev.i, ev.s);
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  function play() {
    if (Transport.playing) return;
    if (!Project.countHits()) {
      UI.toast('还没有任何击打音符：先点一个方块，再在下方点圆点');
    }
    Synth.resume()
      .then(() => Synth.load())
      .then(() => {
        Synth.setRunning(true);
        UI.setTail(false);
        refreshCycle();
        Synth.setMusicSpeed(playSpeed());
        Transport.playing = true;
        Transport.beat = Project.state.page * Project.BLOCKS_PER_PAGE;
        Transport.lastBeat = Transport.beat;
        Transport.events = [];
        Transport.nextBeat = Synth.now() + 0.08;

        // 从中间某页开始时，音乐也要从对应位置进
        if (Synth.hasMusic && Transport.beat !== 0) {
          Synth.startMusic(Transport.nextBeat, Project.secondsAtBeat(Transport.beat) + musicOffset);
        }

        clearInterval(Transport.timer);
        Transport.timer = setInterval(scheduler, TICK_MS);
        scheduler();
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(frame);
        $('btnPlay').classList.add('is-playing');
        $('playIco').textContent = '■';
        $('playTxt').textContent = '停止';
        refreshBpmInput();
      })
      .catch((err) => {
        console.error(err);
        UI.toast('打击音载入失败：' + (err && err.message ? err.message : err));
      });
  }

  function stop() {
    if (!Transport.playing) return;
    Transport.playing = false;
    clearInterval(Transport.timer);
    cancelAnimationFrame(rafId);
    Transport.events = [];
    Synth.setRunning(false);
    Synth.stopMusic();
    UI.setTail(false);
    UI.resetPlayhead();
    $('btnPlay').classList.remove('is-playing');
    $('playIco').textContent = '▶';
    $('playTxt').textContent = '播放';
    refreshBpmInput();
  }

  function togglePlay() {
    Transport.playing ? stop() : play();
  }

  function jumpToPage(p) {
    const target = Math.max(0, Math.min(Project.pageCount() - 1, p | 0));
    if (Transport.playing) {
      Transport.beat = target * Project.BLOCKS_PER_PAGE;
      Transport.lastBeat = Transport.beat;
      Transport.events = [];
      Transport.nextBeat = Synth.now() + 0.06;
      UI.setTail(false);
    }
    Project.gotoPage(target);
    refreshBpmInput();
  }

  /* -------------------------------------------------------- 当前拍与 BPM */

  /** 当前“这一拍”的 1 基拍号：播放中跟着走，否则跟着选中的方块 */
  function currentBeatNo() {
    if (Transport.playing) return Transport.lastBeat + 1;
    const sel = Project.state.sel;
    const idx = sel == null ? 0 : sel;
    return Project.state.page * Project.BLOCKS_PER_PAGE + idx + 1;
  }

  function refreshBpmInput() {
    const beat = currentBeatNo();
    UI.setBpmInput(Project.bpmAtBeat(beat));
  }

  /* -------------------------------------------------------------- 自动保存 */

  let storageOk = null;

  function storageAvailable() {
    if (storageOk !== null) return storageOk;
    try {
      const k = '__bb_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
    return storageOk;
  }

  function saveLocal() {
    if (!storageAvailable()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(Project.toJSON()));
      } catch (e) { /* 忽略 */ }
    }, 600);
  }

  /* ------------------------------------------------------------ 控件回填 */

  /** 播放速度按钮和菜单的选中态 */
  function renderSpeedUI() {
    const v = Number(Project.state.speed) || 1;
    $('speedLabel').textContent = `${v}x`;
    $('btnSpeed').classList.toggle('is-slow', v < 1);
    [...$('speedMenu').children].forEach((b) => {
      const on = Number(b.dataset.speed) === v;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    });
  }

  function syncControls() {
    const st = Project.state;
    refreshBpmInput();
    UI.renderTempoList();
    $('boardScale').value = String(Math.round((st.boardScale || 0.86) * 100));
    $('boardScaleVal').textContent = String(Math.round((st.boardScale || 0.86) * 100));
    $('hitVol').value = String(Math.round(st.hitVol * 100));
    $('hitVolVal').textContent = String(Math.round(st.hitVol * 100));
    renderSpeedUI();
    Synth.setMusicSpeed(playSpeed());
    UI.renderPageTitle();
    $('pagePrev').disabled = st.page <= 0;
    $('pageNext').disabled = st.page >= Project.pageCount() - 1;
    $('pageDel').disabled = Project.pageCount() <= 1;
  }

  /* ---------------------------------------------------------------- 绑定 */

  function bind() {
    $('btnPlay').addEventListener('click', togglePlay);

    $('btnRewind').addEventListener('click', () => {
      stop();
      jumpToPage(0);
      Project.select(0);
    });

    $('bpm').addEventListener('change', (e) => {
      const beat = currentBeatNo();
      Project.pushUndo();
      Project.setBpmAtBeat(beat, Number(e.target.value));
      e.target.value = String(Project.bpmAtBeat(beat));
      UI.toast(`第 ${beat} 拍起 ${Project.bpmAtBeat(beat)} BPM`);
    });

    $('btnMetro').addEventListener('click', (e) => {
      metronomeOn = !metronomeOn;
      e.currentTarget.classList.toggle('is-on', metronomeOn);
      e.currentTarget.setAttribute('aria-pressed', String(metronomeOn));
      if (metronomeOn) {
        Synth.resume();
        UI.status('节拍器已开启');
      }
    });

    /* 播放速度：自定义下拉（原生 select 的弹层没法做圆角和展开动画） */
    const speedPicker = $('speedPicker');
    const speedMenu = $('speedMenu');

    function openSpeedMenu(on) {
      speedPicker.classList.toggle('is-open', on);
      $('btnSpeed').setAttribute('aria-expanded', String(on));
      if (on) {
        const cur = speedMenu.querySelector('.speed-opt.is-on') || speedMenu.querySelector('.speed-opt');
        if (cur) cur.focus({ preventScroll: true });
      }
    }

    function applySpeed(next) {
      Project.setSpeed(next);
      Synth.setMusicSpeed(playSpeed());
      renderSpeedUI();

      if (Transport.playing) {
        // 播放中换速度：从当前拍重新对齐，音乐从对应位置接着放
        const beat = Math.max(0, Transport.lastBeat);
        Transport.beat = beat;
        Transport.lastBeat = beat;
        Transport.events = [];
        Transport.nextBeat = Synth.now() + 0.06;
        Synth.stopMusic();
        if (Synth.hasMusic) {
          Synth.startMusic(Transport.nextBeat, Project.secondsAtBeat(beat) + musicOffset);
        }
      }
      UI.status(`播放速度 ${next}x`);
    }

    $('btnSpeed').addEventListener('click', (e) => {
      e.stopPropagation();
      openSpeedMenu(!speedPicker.classList.contains('is-open'));
    });

    speedMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('.speed-opt');
      if (!btn) return;
      applySpeed(Number(btn.dataset.speed) || 1);
      openSpeedMenu(false);
      $('btnSpeed').focus({ preventScroll: true });
    });

    // 点外面 / 按 Esc 关掉
    document.addEventListener('pointerdown', (e) => {
      if (!speedPicker.classList.contains('is-open')) return;
      if (e.target.closest('#speedPicker')) return;
      openSpeedMenu(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && speedPicker.classList.contains('is-open')) {
        openSpeedMenu(false);
        $('btnSpeed').focus({ preventScroll: true });
      }
    });

    $('pagePrev').addEventListener('click', () => jumpToPage(Project.state.page - 1));
    $('pageNext').addEventListener('click', () => jumpToPage(Project.state.page + 1));

    // 页码输入框：输入数字回车（或失焦）跳到那一页
    const commitPageInput = () => {
      const raw = $('pageNow').value.replace(/[^\d]/g, '');
      const total = Project.pageCount();
      const target = Math.max(1, Math.min(total, raw ? parseInt(raw, 10) : 1));
      $('pageNow').value = String(Project.state.page + 1);
      if (target - 1 !== Project.state.page) jumpToPage(target - 1);
    };
    $('pageNow').addEventListener('change', commitPageInput);
    $('pageNow').addEventListener('blur', () => {
      $('pageNow').value = String(Project.state.page + 1);   // 没改成合法页就还原
    });
    $('pageNow').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitPageInput();
        $('pageNow').blur();
      } else if (e.key === 'Escape') {
        $('pageNow').value = String(Project.state.page + 1);
        $('pageNow').blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = e.key === 'ArrowUp' ? 1 : -1;
        jumpToPage(Project.state.page + d);
      }
    });

    $('pageAdd').addEventListener('click', () => {
      Project.pushUndo();
      Project.addPage();
      UI.toast(`已新增第 ${Project.state.page + 1} 页`);
    });

    $('pageDup').addEventListener('click', () => {
      Project.pushUndo();
      Project.dupPage();
      UI.toast(`已复制为第 ${Project.state.page + 1} 页`);
    });

    $('pageDel').addEventListener('click', () => {
      if (Project.pageCount() <= 1) return;
      Project.pushUndo();
      Project.delPage();
      UI.toast('已删除该页');
    });

    $('boardScale').addEventListener('input', (e) => {
      Project.setBoardScale(Number(e.target.value) / 100);
      $('boardScaleVal').textContent = e.target.value;
      UI.layout();
    });

    $('hitVol').addEventListener('input', (e) => {
      Project.setHitVolume(Number(e.target.value) / 100);
      $('hitVolVal').textContent = e.target.value;
      Synth.setHitVolume(Project.state.hitVol);
    });

    $('preset').addEventListener('change', (e) => {
      const value = e.target.value;
      if (!value) return;

      if (value.startsWith('zip:')) {
        loadPkgChart(Number(value.slice(4)));
        return;
      }

      const key = value.startsWith('preset:') ? value.slice(7) : value;
      if (!PRESETS[key]) return;
      stop();
      pkgCharts = null;
      setStageBackground(null);
      Project.loadPreset(key);
      musicOffset = 0;
      e.target.value = '';
      Synth.setHitVolume(Project.state.hitVol);
      UI.buildPresetOptions(null);
      UI.toast(`已载入「${PRESETS[key].name}」`);
    });

    /**
     * 保存文件：能用系统的「另存为」对话框就用（能选位置、反馈明确），
     * 不支持或被策略挡住时退回 <a download>。
     * 返回 'saved' | 'download' | 'cancel'
     */
    async function saveBlob(blob, filename) {
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const ext = filename.slice(filename.lastIndexOf('.'));
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: '文件', accept: { [blob.type || 'application/octet-stream']: [ext] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return 'saved';
        } catch (err) {
          if (err && err.name === 'AbortError') return 'cancel';
          // 其它错误（比如被浏览器策略禁用）就当它不存在，走下载
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return 'download';
    }

    $('btnSave').addEventListener('click', async () => {
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `polybeat-${Project.bpmAtBeat(1)}bpm-${stamp}.json`;
      try {
        const blob = new Blob([JSON.stringify(Project.toJSON(), null, 2)], { type: 'application/json' });
        const how = await saveBlob(blob, name);
        if (how === 'cancel') return;
        UI.toast(how === 'saved' ? `已保存「${name}」` : `已导出「${name}」，在浏览器下载目录`);
      } catch (err) {
        UI.toast('导出失败：' + (err && err.message ? err.message : err));
      }
    });

    /* -------------------------------------- 导入：工程 / 谱面 / 音乐 / PEZ */

    function showMusicUI(info) {
      $('musicVolWrap').hidden = false;
      $('musicVol').title = `音乐：${info.name}（${Math.round(info.duration)} 秒）`;
    }

    /** 载入伴奏，返回 Promise（方便多选导入时按顺序处理） */
    function loadMusicFile(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          musicOffset = 0;           // 单独导入的音乐从谱面第 1 拍开始，不带谱面 offset
          Synth.loadMusic(reader.result, file.name)
            .then((info) => {
              showMusicUI(info);
              refreshCycle();          // 音乐比谱面长的话，循环长度要跟着变
              UI.toast(`已导入音乐「${info.name}」，${info.duration.toFixed(1)} 秒`);
              resolve(info);
            })
            .catch((err) => {
              UI.toast('音乐导入失败：' + (err && err.message ? err.message : err));
              resolve(null);
            });
        };
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(file);
      });
    }

    /** 把解析好的谱面装进工程，并把 offset 记下来给音乐用 */
    function applyChart(result, extra) {
      stop();
      Project.pushUndo();
      Project.loadChart(result);
      Synth.setHitVolume(Project.state.hitVol);
      musicOffset = result.stats.offsetSec || 0;

      const s = result.stats;
      const errPct = (s.maxError * 100).toFixed(1);
      const offMs = -s.offsetSec * 1000;
      UI.toast(
        `已导入 ${s.format}：${s.rawNotes} 个音符（同时刻合并 ${s.merged}）` +
        ` → ${s.beats} 拍 / ${s.pages} 页 / ${s.hits} 次击打` +
        (Math.abs(offMs) >= 1 ? ` · 谱面偏移 ${offMs.toFixed(0)}ms` : '') +
        (s.maxError > 0.011 ? ` · 最大量化偏差 ${errPct}% 拍` : '') +
        (s.truncated ? ' · 超长已截断' : '') +
        (extra || '')
      );
    }

    /* ------------------------------------------------ 谱面背景（曲绘） */

    let stageBgUrl = null;

    /** 用图片文件当谱面背景；传 null 清除 */
    function setStageBackground(fileOrBlob) {
      if (stageBgUrl) {
        URL.revokeObjectURL(stageBgUrl);
        stageBgUrl = null;
      }
      if (!fileOrBlob) {
        UI.setStageBg(null);
        return;
      }
      stageBgUrl = URL.createObjectURL(fileOrBlob);
      UI.setStageBg(stageBgUrl);
    }

    /** 从压缩包里挑一张曲绘：优先 illustration/背景/封面，其次最大的图 */
    function pickArtEntry(entries) {
      const imgs = entries.filter((e) => /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(e.name));
      if (!imgs.length) return null;
      const scored = imgs.map((e) => {
        const n = e.name.toLowerCase();
        let score = 0;
        if (/illustration|illust|jacket|cover|art|曲绘|bg|back/.test(n)) score += 10;
        if (/blur|thumb|icon|logo|mask/.test(n)) score -= 20;   // 我们自己在模糊，别选现成的模糊图
        return { e, score, size: e.usize || 0 };
      });
      scored.sort((a, b) => (b.score - a.score) || (b.size - a.size));
      return scored[0].score >= 0 ? scored[0].e : null;
    }

    function isImageFile(file) {
      return (file.type || '').startsWith('image/') ||
        /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(file.name || '');
    }

    /** 压缩包（.pez / Phigros 官方 zip）：可能有好几个谱面 + 音乐 */
    let pkgCharts = null;   // { bytes, items: [{ label, file, entry }] }

    function zipText(bytes, entry) {
      return Zip.read(bytes, entry.name).then((u8) => new TextDecoder('utf-8').decode(u8));
    }

    /** 读包里的元信息：RPE 的 info.txt / Phigros 的 Info.json */
    async function readZipMeta(bytes, entries) {
      const meta = { song: '', levels: {}, chartFile: '', musicFile: '' };

      const txtEntry = entries.find((e) => /^info\.txt$/i.test(e.name));
      if (txtEntry) {
        const txt = await zipText(bytes, txtEntry);
        const pick = (re) => {
          const m = txt.match(re);
          return m ? m[1].trim() : '';
        };
        meta.song = pick(/^Name:\s*(.+)$/m);
        meta.chartFile = pick(/^Chart:\s*(.+)$/m);
        meta.musicFile = pick(/^Song:\s*(.+)$/m);
      }

      const jsonEntry = entries.find((e) => /^info\.json$/i.test(e.name));
      if (jsonEntry) {
        try {
          const arr = JSON.parse(await zipText(bytes, jsonEntry));
          if (Array.isArray(arr)) {
            meta.song = meta.song || String(arr[0] || '');
            if (arr[3] && typeof arr[3] === 'object') meta.levels = arr[3];
          }
        } catch (e) { /* Info.json 格式不认识就算了 */ }
      }

      return meta;
    }

    function chartLabel(fileName, meta, obj) {
      const m = fileName.match(/\.([A-Za-z]{1,3})\.json$/i);
      const diff = m ? m[1].toUpperCase() : '';
      const lv = diff && meta.levels[diff] ? meta.levels[diff][0] : '';
      const song = meta.song || (obj && obj.META && obj.META.name) || '';
      const label = [[diff, lv].filter(Boolean).join(' '), song].filter(Boolean).join(' · ');
      return label || fileName;
    }

    /** Arcaea 的 .aff 按文件名里的数字标难度：0 PST / 1 PRS / 2 FTR / 3 BYD / 4 ETR */
    const AFF_DIFF = ['PST', 'PRS', 'FTR', 'BYD', 'ETR'];
    function affLabel(fileName) {
      const m = /(?:^|[\\/])(\d+)\.aff$/i.exec(fileName);
      const diff = m ? (AFF_DIFF[Number(m[1])] || '') : '';
      return diff || fileName;          // 弹窗里还有一行文件名，这里只写难度
    }

    async function importZip(file) {
      UI.toast('正在读取压缩包…');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const entries = Zip.list(bytes);
        if (!entries.length) throw new Error('压缩包是空的');

        const meta = await readZipMeta(bytes, entries);

        // 找出所有「能认成谱面」的 json / aff
        const charts = [];
        for (const e of entries) {
          const isAff = /\.aff$/i.test(e.name);
          if (!isAff && !/\.json$/i.test(e.name)) continue;
          let text = '';
          try { text = await zipText(bytes, e); } catch (err) { continue; }
          if (isAff) {
            if (!ChartImport.looksLikeAFF(text)) continue;
            try { ChartImport.parseAFF(text); } catch (err) { continue; }
            charts.push({ file: e.name, entry: e, label: affLabel(e.name) });
            continue;
          }
          let obj;
          try { obj = JSON.parse(text); } catch (err) { continue; }
          if (!ChartImport.detect(obj)) continue;
          charts.push({ file: e.name, entry: e, label: chartLabel(e.name, meta, obj) });
        }
        if (!charts.length) throw new Error('压缩包里找不到可解析的谱面');

        // 一个包里有多个谱面 → 弹窗选
        let idx = 0;
        if (charts.length > 1) {
          idx = await UI.showChartPicker(
            charts.map((c) => ({ label: c.label, file: c.file })),
            `${file.name} 里有 ${charts.length} 个谱面，选一个解析`
          );
          if (idx == null) return;   // 取消
        }

        // 音乐（一次就好，换谱面不重载）
        let musicEntry = meta.musicFile
          ? entries.find((e) => e.name === meta.musicFile)
          : null;
        if (!musicEntry) {
          musicEntry = entries.find((e) => /\.(ogg|mp3|wav|m4a|flac|aac|opus)$/i.test(e.name));
        }
        let musicInfo = null;
        if (musicEntry) {
          const audio = await Zip.read(bytes, musicEntry.name);
          musicInfo = await Synth.loadMusic(audio.buffer, musicEntry.name);
          showMusicUI(musicInfo);
        }

        pkgCharts = { bytes, items: charts };
        const text = await zipText(bytes, charts[idx].entry);
        applyChart(
          ChartImport.fromText(text),
          ` · ${charts[idx].file}` +
          (musicInfo ? ` · 音乐「${musicEntry.name}」${musicInfo.duration.toFixed(0)}s` : '')
        );

        // 包里有曲绘就拿来当背景（模糊 + 压暗由 CSS 负责）
        const artEntry = pickArtEntry(entries);
        if (artEntry) {
          try {
            const img = await Zip.read(bytes, artEntry.name);
            const mime = /\.png$/i.test(artEntry.name) ? 'image/png'
              : /\.webp$/i.test(artEntry.name) ? 'image/webp'
                : /\.gif$/i.test(artEntry.name) ? 'image/gif'
                  : 'image/jpeg';
            setStageBackground(new Blob([img], { type: mime }));
          } catch (e) { setStageBackground(null); }
        } else {
          setStageBackground(null);
        }

        UI.buildPresetOptions(pkgCharts.items);
        $('preset').value = 'zip:' + idx;
      } catch (err) {
        UI.toast('导入失败：' + (err && err.message ? err.message : err));
      }
    }

    async function loadPkgChart(idx) {
      if (!pkgCharts || !pkgCharts.items[idx]) return;
      try {
        const item = pkgCharts.items[idx];
        const text = await zipText(pkgCharts.bytes, item.entry);
        applyChart(ChartImport.fromText(text), ` · ${item.file}`);
      } catch (err) {
        UI.toast('导入失败：' + (err && err.message ? err.message : err));
      }
    }

    function isAudioFile(file) {
      return (file.type || '').startsWith('audio/') ||
        /\.(mp3|ogg|oga|wav|m4a|flac|aac|opus|webm)$/i.test(file.name || '');
    }

    function isArchiveFile(file) {
      return /\.(pez|zip)$/i.test(file.name || '');
    }

    function readTextFile(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve('');
        reader.readAsText(file);
      });
    }

    async function loadAnyFile(file) {
      const name = file.name || '';
      if (isAudioFile(file)) { await loadMusicFile(file); return; }

      // 图片 → 当作谱面背景
      if (isImageFile(file)) {
        setStageBackground(file);
        UI.toast(`已把「${name}」设为背景`);
        return;
      }

      // 先看开头 4 个字节判断是不是 zip / pez
      let head = null;
      try { head = new Uint8Array(await file.slice(0, 4).arrayBuffer()); } catch (e) { head = null; }
      if ((head && Zip.isZip(head)) || isArchiveFile(file)) {
        await importZip(file);
        return;
      }

      const text = await readTextFile(file);
      let obj = null;
      try { obj = JSON.parse(text); } catch (e) { /* 交给下面报错 */ }

      // 1) PolyBeat 自己的工程
      if (obj && obj.app === 'PolyBeat') {
        try {
          stop();
          Project.fromJSON(obj);
          Synth.setHitVolume(Project.state.hitVol);
          musicOffset = 0;
          pkgCharts = null;
          UI.buildPresetOptions(null);
          setStageBackground(null);
          UI.toast('工程已导入');
        } catch (err) {
          UI.toast('导入失败：' + err.message);
        }
        return;
      }

      // 2) 单文件谱面（RPE / Phigros / Rizline）
      try {
        pkgCharts = null;
        UI.buildPresetOptions(null);
        setStageBackground(null);
        applyChart(ChartImport.fromText(text));
      } catch (err) {
        UI.toast('导入失败：' + err.message);
      }
    }

    /** 一次导入多个文件：压缩包 → 谱面/工程 → 音乐 → 图片，依次套上去 */
    async function loadAnyFiles(list) {
      const files = [...(list || [])];
      if (!files.length) return;
      const rank = (f) => (isArchiveFile(f) ? 0 : isImageFile(f) ? 3 : isAudioFile(f) ? 2 : 1);
      files.sort((a, b) => rank(a) - rank(b));
      for (const f of files) await loadAnyFile(f);
      if (files.length > 1) UI.toast(`已导入 ${files.length} 个文件`);
    }

    $('btnLoad').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      const files = e.target.files ? [...e.target.files] : [];
      e.target.value = '';
      if (files.length) loadAnyFiles(files);
    });

    $('musicVol').addEventListener('input', (e) => {
      $('musicVolVal').textContent = e.target.value;
      Synth.setMusicVolume(Number(e.target.value) / 100);
    });

    // 拖进窗口也行（可以一次拖多个）
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
      if (files.length) loadAnyFiles(files);
    });

    $('btnMidi').addEventListener('click', async () => {
      const name = MidiExport.filename();
      try {
        const blob = MidiExport.toBlob();
        const how = await saveBlob(blob, name);
        if (how === 'cancel') return;
        const kb = (blob.size / 1024).toFixed(1);
        UI.toast(how === 'saved'
          ? `已保存「${name}」（${kb} KB）`
          : `已导出「${name}」（${kb} KB），在浏览器下载目录`);
      } catch (err) {
        console.error(err);
        UI.toast('MIDI 导出失败：' + err.message);
      }
    });

    // 谱面空白处滚轮翻页（在方块上滚轮还是改音符数量）
    const stageEl = document.querySelector('.stage');
    const boardBox = document.getElementById('boardStage');
    let wheelAt = 0;
    stageEl.addEventListener('wheel', (e) => {
      if (e.target.closest('input, select, button, a, textarea, .tempo-panel, .picker')) return;
      // 用棋盘静止时的框判断：翻页动画里滑动的方块不算“在方块上”
      const r = boardBox.getBoundingClientRect();
      const onBoard = e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top && e.clientY <= r.bottom;
      if (onBoard && e.target.closest('.block')) return;
      if (!e.deltaY) return;
      e.preventDefault();
      const now = performance.now();
      if (now < wheelAt) return;                                     // 触控板惯性只翻一页
      wheelAt = now + 200;
      jumpToPage(Project.state.page + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });

    document.addEventListener('keydown', onKeydown);
  }

  function moveSelection(dx, dy) {
    const cur = Project.state.sel == null ? 0 : Project.state.sel;
    let row = Math.floor(cur / 4);
    let col = cur % 4;
    col = (col + dx + 4) % 4;
    row = (row + dy + 4) % 4;
    Project.select(row * 4 + col);
  }

  function onKeydown(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (Project.undo()) { stop(); syncControls(); }
      else UI.toast('没有可撤销的操作');
      return;
    }

    if (e.key === 'Home') {
      e.preventDefault();
      stop();
      jumpToPage(0);
      return;
    }

    if (e.key === ',') { e.preventDefault(); jumpToPage(Project.state.page - 1); return; }
    if (e.key === '.') { e.preventDefault(); jumpToPage(Project.state.page + 1); return; }

    if (/^[1-8]$/.test(e.key)) {
      const i = Project.state.sel;
      if (i == null) return;
      e.preventDefault();
      Project.pushUndo();
      Project.setCount(i, Number(e.key));
      return;
    }

    if (e.key === 'Enter') {
      const i = Project.state.sel;
      if (i == null) return;
      e.preventDefault();
      Project.pushUndo();
      Project.fillBlock(i, 'invert');
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const i = Project.state.sel;
      if (i == null) return;
      e.preventDefault();
      Project.pushUndo();
      Project.fillBlock(i, 'off');
      return;
    }

    const map = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    if (map[e.key]) {
      e.preventDefault();
      moveSelection(map[e.key][0], map[e.key][1]);
    }
  }

  /* ------------------------------------------------------------ 事件接线 */

  function wire() {
    Project.on((type, payload) => {
      if (type === 'reload' || type === 'pages') {
        UI.reloadHard();
        UI.resetPlayhead();
        refreshCycle();
        syncControls();
        saveLocal();
      } else if (type === 'page') {
        UI.reload();
        syncControls();
        saveLocal();
      } else if (type === 'selection') {
        UI.applySelection();
        UI.renderEditor();
        refreshBpmInput();
      } else if (type === 'block') {
        if (payload && payload.p === Project.state.page) UI.renderBlock(payload.i);
        UI.renderEditor();
        saveLocal();
      } else if (type === 'tempo') {
        refreshBpmInput();
        UI.renderTempoList();
        refreshCycle();          // 变速会改变"音乐放完要多少拍"
        saveLocal();
      } else if (type === 'tempos') {
        UI.renderTempoList();
      }
    });
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    const canStore = storageAvailable();
    let restored = false;

    if (canStore) {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const data = JSON.parse(raw);
          if (data && data.app === 'PolyBeat') {
            Project.fromJSON(data);
            restored = true;
          }
        }
      } catch (e) { restored = false; }
    }

    if (!restored) Project.newProject();

    UI.init();
    wire();
    bind();
    syncControls();
    Synth.setHitVolume(Project.state.hitVol);
    UI.renderPageTitle();

    if (!canStore) {
      const badge = $('storeBadge');
      if (badge) badge.hidden = false;
    }
    if (restored) setTimeout(() => UI.status('已恢复上次的工程'), 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.__bb = { Project, Synth, UI, Transport, play, stop, togglePlay, jumpToPage };
})();
