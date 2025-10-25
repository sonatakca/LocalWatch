(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const listEl = $('#video-list');
  const layoutEl = $('.layout');
  const sidebarEl = $('.sidebar');
  const collapseBtn = document.getElementById('collapse-btn');
  const countEl = $('#video-count');
  const emptyHint = $('#empty-hint');
  const dirInfo = $('#dir-info');
  const searchEl = $('#search');
  const catBar = $('#cat-bar');
  const nowTitle = $('#now-title');
  const nowMeta = $('#now-meta');
  const videoEl = $('#player');
  const sdMinus = $('#sd-minus');
  const sdPlus = $('#sd-plus');
  const sdReset = $('#sd-reset');
  const sdValue = $('#sd-value');
  const subSize = $('#sub-size');
  const subBg = $('#sub-bg');
  const subEffect = $('#sub-effect');
  const subX = $('#sub-x');
  const subY = $('#sub-y');
  const subLiftToggle = $('#sub-lift-toggle');
  const subPosReset = $('#sub-pos-reset');

  const player = new Plyr(videoEl, {
    invertTime: false,
    ratio: '16:9',
    captions: { active: true, language: 'auto' },
    keyboard: { focused: true, global: true },
    controls: [
      'play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'airplay', 'fullscreen'
    ],
  });

  // Subtitle tools live under the video (collapsible panel)
  const subsTools = document.querySelector('.subs-tools');
  const sdToggleBtn = document.getElementById('sd-toggle');
  function toggleSubsTools(show) {
    if (!subsTools) return;
    const want = show == null ? !subsTools.classList.contains('open') : show;
    subsTools.classList.toggle('open', want);
  }

  // Customize Plyr settings to use a simple Subtitles On/Off and to open
  // our subtitle delay panel (under the video) from the gear menu.
  function setupSettingsMenu() {
    const controls = player.elements && player.elements.controls;
    if (!controls) return;
    const settingsBtn = controls.querySelector('button[aria-label="Settings"]');
    if (!settingsBtn) return;
    const panelId = settingsBtn.getAttribute('aria-controls');
    const panel = panelId && document.getElementById(panelId);
    if (!panel || panel.dataset.ltWired === '1') return;

    panel.dataset.ltWired = '1';

    // Remove Plyr's built-in captions choices (Disabled/English...)
    panel.querySelectorAll('[data-plyr="captions"]').forEach((el) => el.remove());

    // Build our simple Subtitles On/Off
    const subHeader = document.createElement('div');
    subHeader.className = 'plyr__menu__heading';
    subHeader.textContent = 'Subtitles';

    const onBtn = document.createElement('button');
    onBtn.type = 'button';
    onBtn.className = 'plyr__control';
    onBtn.setAttribute('role', 'menuitemradio');
    onBtn.textContent = 'On';

    const offBtn = document.createElement('button');
    offBtn.type = 'button';
    offBtn.className = 'plyr__control';
    offBtn.setAttribute('role', 'menuitemradio');
    offBtn.textContent = 'Off';

    function refreshCaptionRadios() {
      const active = !!(player && player.captions && player.captions.active);
      onBtn.setAttribute('aria-checked', active ? 'true' : 'false');
      offBtn.setAttribute('aria-checked', active ? 'false' : 'true');
    }
    onBtn.addEventListener('click', () => { try { player.toggleCaptions(true); } catch {} refreshCaptionRadios(); });
    offBtn.addEventListener('click', () => { try { player.toggleCaptions(false); } catch {} refreshCaptionRadios(); });

    const delayBtn = document.createElement('button');
    delayBtn.type = 'button';
    delayBtn.className = 'plyr__control';
    delayBtn.textContent = 'Subtitle delay…';
    delayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSubsTools(true);
      try { subsTools.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
    });

    // Append to panel root
    const container = panel.querySelector('.plyr__menu__container') || panel;
    container.appendChild(subHeader);
    container.appendChild(onBtn);
    container.appendChild(offBtn);
    container.appendChild(delayBtn);

    // Keep radios in sync when captions toggled elsewhere
    player.on('captionsenabled', refreshCaptionRadios);
    player.on('captionsdisabled', refreshCaptionRadios);
    refreshCaptionRadios();
  }

  // Try to wire on ready and whenever settings is opened
  player.on('ready', () => {
    setupSettingsMenu();
    const controls = player.elements && player.elements.controls;
    const settingsBtn = controls && controls.querySelector('button[aria-label="Settings"]');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => setTimeout(setupSettingsMenu, 0));
    }
    wireLiftForControls();
  });

  // Toggle button under the video
  if (sdToggleBtn) {
    sdToggleBtn.addEventListener('click', () => {
      toggleSubsTools();
      try { subsTools.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
    });
  }

  let videos = [];
  let filtered = [];
  let categories = [];
  let selectedCat = 'All';
  let activeIndex = -1;
  let currentRelPath = null;
  let currentItem = null;
  let currentFolder = null;

  function parseSeasonEpisode(text) {
    if (!text) return null;
    const m = String(text).match(/S(\d{1,3})E(\d{1,3})/i);
    if (!m) return null;
    return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
  }

  function compareBySeasonEpisode(a, b) {
    const ka = parseSeasonEpisode(a.name) || parseSeasonEpisode(a.relPath);
    const kb = parseSeasonEpisode(b.name) || parseSeasonEpisode(b.relPath);
    if (ka && kb) {
      if (ka.s !== kb.s) return ka.s - kb.s;
      if (ka.e !== kb.e) return ka.e - kb.e;
    } else if (ka && !kb) {
      return -1;
    } else if (!ka && kb) {
      return 1;
    }
    // Fallback: natural name compare
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  }

  function formatDuration(sec) {
    if (!sec && sec !== 0) return '';
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  }

  function bytesToSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function folderOf(relPath) {
    if (!relPath) return '';
    const parts = relPath.split('/');
    parts.pop();
    return parts.join('/');
  }

  function getSavedDelayMs(folder) {
    try {
      const v = localStorage.getItem('localtube:subDelay:' + folder);
      return v != null ? parseInt(v, 10) || 0 : 0;
    } catch { return 0; }
  }
  function setSavedDelayMs(folder, ms) {
    try { localStorage.setItem('localtube:subDelay:' + folder, String(ms)); } catch {}
  }
  function updateDelayUI(ms) {
    if (sdValue) sdValue.value = String(ms);
  }

  function computeShadow(effect) {
    switch ((effect || 'shadow')) {
      case 'none': return 'none';
      case 'lifted': return '0 1px 0 rgba(255,255,255,0.25), 0 2px 4px rgba(0,0,0,0.9)';
      case 'outline': return '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';
      case 'shadow':
      default: return '0 2px 6px rgba(0,0,0,0.9)';
    }
  }

  function loadSubStyle() {
    try {
      const j = JSON.parse(localStorage.getItem('localtube:subStyle') || '{}');
      return {
        size: Number.isFinite(j.size) ? j.size : 100,
        bg: Number.isFinite(j.bg) ? j.bg : 0.35,
        effect: j.effect || 'shadow',
        x: Number.isFinite(j.x) ? j.x : 0,
        y: Number.isFinite(j.y) ? j.y : 0,
        lift: !!j.lift,
      };
    } catch { return { size: 100, bg: 0.35, effect: 'shadow' }; }
  }
  function saveSubStyle(style) {
    try { localStorage.setItem('localtube:subStyle', JSON.stringify(style)); } catch {}
  }
  function applySubStyle(style) {
    const root = document.documentElement;
    root.style.setProperty('--sub-size', String(style.size || 100));
    root.style.setProperty('--sub-bg-opacity', String((style.bg != null ? style.bg : 0.35)));
    root.style.setProperty('--sub-shadow', computeShadow(style.effect));
    root.style.setProperty('--sub-x', String(style.x || 0));
    root.style.setProperty('--sub-y', String(style.y || 0));
    // sub-lift handled by event based on controls visibility
  }

  function initSubStyleUI() {
    const s = loadSubStyle();
    if (subSize) subSize.value = String(s.size);
    if (subBg) subBg.value = String(s.bg);
    if (subEffect) subEffect.value = String(s.effect);
    if (subX) subX.value = String(s.x || 0);
    if (subY) subY.value = String(s.y || 0);
    if (subLiftToggle) subLiftToggle.checked = !!s.lift;
    applySubStyle(s);

    function update() {
      const ns = {
        size: parseInt(subSize.value, 10) || 100,
        bg: parseFloat(subBg.value) || 0,
        effect: subEffect.value || 'shadow',
        x: parseInt((subX && subX.value) || '0', 10) || 0,
        y: parseInt((subY && subY.value) || '0', 10) || 0,
        lift: subLiftToggle ? !!subLiftToggle.checked : false,
      };
      applySubStyle(ns);
      saveSubStyle(ns);
      // update visual fill for sliders
      setRangeFill(subSize);
      setRangeFill(subBg);
      setRangeFill(subX);
      setRangeFill(subY);
    }

    if (subSize) subSize.addEventListener('input', update);
    if (subBg) subBg.addEventListener('input', update);
    if (subEffect) subEffect.addEventListener('change', update);
    if (subX) subX.addEventListener('input', update);
    if (subY) subY.addEventListener('input', update);
    if (subLiftToggle) subLiftToggle.addEventListener('change', update);
    if (subPosReset) subPosReset.addEventListener('click', () => {
      if (subX) subX.value = '0';
      if (subY) subY.value = '0';
      update();
    });
    // Reapply when entering/exiting fullscreen to override any vendor defaults
    document.addEventListener('fullscreenchange', () => {
      applySubStyle(loadSubStyle());
      if (document.fullscreenElement) {
        // Auto-collapse subtitle settings when entering fullscreen
        toggleSubsTools(false);
      }
    });

    // Initialize filled track visuals
    setRangeFill(subSize);
    setRangeFill(subBg);
    setRangeFill(subX);
    setRangeFill(subY);
  }

  function setRangeFill(el) {
    if (!el) return;
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '100');
    const val = parseFloat(el.value || String(min));
    const pct = Math.max(0, Math.min(1, (val - min) / (max - min))) * 100;
    el.style.setProperty('--fill', pct + '%');
  }

  // Lift captions when controls are shown if enabled
  function wireLiftForControls() {
    const apply = () => {
      const s = loadSubStyle();
      const root = document.documentElement;
      const visible = !(player.elements && player.elements.container && player.elements.container.classList.contains('plyr--hide-controls'));
      if (s.lift && visible) root.style.setProperty('--sub-lift', '48px');
      else root.style.setProperty('--sub-lift', '0px');
    };
    player.on('controlsshown', apply);
    player.on('controlshidden', apply);
    player.on('pause', apply);
    player.on('play', apply);
    apply();
  }

  // Sidebar collapse/expand
  function setSidebarCollapsed(collapsed) {
    if (!layoutEl || !sidebarEl) return;
    layoutEl.classList.toggle('collapsed', collapsed);
    sidebarEl.classList.toggle('collapsed', collapsed);
    try { localStorage.setItem('localtube:sidebarCollapsed', collapsed ? '1' : '0'); } catch {}
  }
  function getSidebarCollapsed() {
    try { return localStorage.getItem('localtube:sidebarCollapsed') === '1'; } catch { return false; }
  }
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      setSidebarCollapsed(!layoutEl.classList.contains('collapsed'));
    });
    // Initialize from storage
    setSidebarCollapsed(getSidebarCollapsed());
  }

  async function buildTracks(relPath, delayMs) {
    try {
      const r = await fetch(`/subs?p=${encodeURIComponent(relPath)}`);
      const j = await r.json();
      return (j.tracks || []).map((t, i) => ({
        kind: 'captions',
        label: t.label || t.lang || `Track ${i+1}`,
        srclang: t.lang || 'en',
        src: `${t.url}&offset_ms=${encodeURIComponent(delayMs || 0)}`,
        default: t.lang === 'en' ? true : i === 0,
      }));
    } catch { return []; }
  }

  async function applySubDelay(ms) {
    if (!currentItem) return;
    const folder = currentFolder || folderOf(currentItem.relPath);
    setSavedDelayMs(folder, ms);
    updateDelayUI(ms);
    // Rebuild source with new track URLs while preserving playback position
    const useTranscode = ['.mkv', '.avi', '.mov'].includes(currentItem.ext);
    const baseUrl = useTranscode
      ? `/remux?p=${encodeURIComponent(currentItem.relPath)}`
      : `/stream?p=${encodeURIComponent(currentItem.relPath)}`;
    const url = baseUrl;
    const tracks = await buildTracks(currentItem.relPath, ms);
    const source = {
      type: 'video',
      title: currentItem.name,
      sources: [{ src: url, type: useTranscode ? 'video/mp4' : (currentItem.mime || mimeFromExt(currentItem.ext)) }],
      tracks,
    };
    const time = player.currentTime || 0;
    const paused = player.paused;
    player.config.duration = currentItem.duration || null;
    player.source = source;
    videoEl.addEventListener('loadeddata', () => {
      try { player.currentTime = time; } catch {}
      if (!paused) player.play();
    }, { once: true });
  }

  function renderList(list) {
    listEl.innerHTML = '';
    list.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.index = String(idx);
      card.innerHTML = `
        <div class="thumb">
          <img class="img" alt="thumb" src="/thumb?p=${encodeURIComponent(item.relPath)}" />
          <div class="play">▶</div>
          <div class="badge">${item.ext.replace('.', '').toUpperCase()}</div>
        </div>
        <div class="info">
          <div class="title" title="${item.name}">${item.name.replace(/\.[^.]+$/, '')}</div>
          <div class="meta">${bytesToSize(item.size)}${item.category ? ' • ' + item.category : ''}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        playIndex(idx);
      });
      listEl.appendChild(card);
    });
    countEl.textContent = String(list.length);
    emptyHint.style.display = list.length ? 'none' : 'block';
  }

  function mimeFromExt(ext) {
    const map = {
      '.mp4': 'video/mp4',
      '.m4v': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
    };
    return map[ext] || 'video/mp4';
  }

  async function playIndex(idx) {
    if (idx < 0 || idx >= filtered.length) return;
    activeIndex = idx;
    const item = filtered[idx];
    currentItem = item;
    currentFolder = folderOf(item.relPath);
    const useTranscode = ['.mkv', '.avi', '.mov'].includes(item.ext);
    // Prefer a seekable remuxed MP4 for MKV/AVI/MOV so the progress
    // bar works as expected. If decoding fails, fallback to /play with
    // transcode. Native MP4/WebM use /stream directly.
    const baseUrl = useTranscode
      ? `/remux?p=${encodeURIComponent(item.relPath)}`
      : `/stream?p=${encodeURIComponent(item.relPath)}`;
    let url = baseUrl;

    const delayMs = getSavedDelayMs(currentFolder);
    updateDelayUI(delayMs);
    const tracks = await buildTracks(item.relPath, delayMs);
    const source = {
      type: 'video',
      title: item.name,
      sources: [{ src: url, type: useTranscode ? 'video/mp4' : (item.mime || mimeFromExt(item.ext)) }],
      tracks,
    };

    // Provide a real duration for plyr to display when streaming
    // fragmented MP4 where the intrinsic duration is unknown.
    player.config.duration = item.duration || null;
    player.source = source;
    player.play();
    nowTitle.textContent = item.name.replace(/\.[^.]+$/, '');
    const durStr = item.duration ? ` • ${formatDuration(item.duration)}` : '';
    nowMeta.textContent = `${item.ext.replace('.', '').toUpperCase()} • ${bytesToSize(item.size)}${durStr}`;
    highlightActive();
    currentRelPath = item.relPath;
    try { localStorage.setItem('localtube:last', item.relPath); } catch {}

    // If the browser fails to play remuxed/copy output (e.g. it
    // can't decode HEVC), automatically retry forcing a transcode.
    const onError = () => {
      if (useTranscode && !/transcode=1/.test(url)) {
        // Fallback to live /play with transcode=1
        const playBase = `/play?p=${encodeURIComponent(item.relPath)}`;
        url = `${playBase}&transcode=1`;
        const retry = {
          type: 'video',
          title: item.name,
          sources: [{ src: url, type: 'video/mp4' }],
          tracks,
        };
        console.warn('Retrying with transcode=1 for better compatibility');
        player.source = retry;
        player.play();
      }
      videoEl.removeEventListener('error', onError);
    };
    videoEl.addEventListener('error', onError, { once: true });
  }

  function highlightActive() {
    $$('.card', listEl).forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
    });
  }

  function applyFilter() {
    const q = (searchEl.value || '').trim().toLowerCase();
    filtered = videos.filter(v => {
      const matchesText = !q || v.name.toLowerCase().includes(q) || v.relPath.toLowerCase().includes(q);
      const matchesCat = selectedCat === 'All' || v.category === selectedCat;
      return matchesText && matchesCat;
    }).sort(compareBySeasonEpisode);
    renderList(filtered);
    // try to keep current playing highlight
    const keepIdx = currentRelPath ? filtered.findIndex(v => v.relPath === currentRelPath) : -1;
    if (keepIdx !== -1) {
      activeIndex = keepIdx;
      highlightActive();
    } else if (filtered.length && activeIndex === -1) {
      playIndex(0);
    } else {
      highlightActive();
    }
  }

  function renderCategories(groups) {
    catBar.innerHTML = '';
    const mkChip = (label, key, count) => {
      const btn = document.createElement('button');
      btn.className = 'chip' + (selectedCat === key ? ' active' : '');
      btn.textContent = count != null ? `${label} (${count})` : label;
      btn.addEventListener('click', () => {
        selectedCat = key;
        applyFilter();
        // scroll list top
        listEl.parentElement.scrollTo({ top: 0, behavior: 'smooth' });
        $$('.chip', catBar).forEach(ch => ch.classList.remove('active'));
        btn.classList.add('active');
      });
      return btn;
    };

    const total = groups.reduce((acc, g) => acc + (g.count || 0), 0);
    catBar.appendChild(mkChip('All', 'All', total));
    for (const g of groups) {
      catBar.appendChild(mkChip(g.name, g.key, g.count));
    }
  }

  async function load() {
    const res = await fetch('/api/videos');
    const data = await res.json();
    dirInfo.textContent = data.directory;
    videos = (data.items || []).map((v) => {
      // Derive category client-side if missing
      if (!v.category && v.relPath && v.relPath.includes('/')) {
        v.category = v.relPath.split('/')[0];
      }
      return v;
    }).sort(compareBySeasonEpisode);
    // Use server groups if present; else build from items
    categories = (data.groups && data.groups.length)
      ? data.groups
      : Array.from(
          videos.reduce((m, it) => {
            const cat = it.category || 'Uncategorized';
            m.set(cat, (m.get(cat) || 0) + 1);
            return m;
          }, new Map())
        ).map(([name, count]) => ({ key: name, name, count }));
    renderCategories(categories);
    filtered = videos.slice();
    renderList(filtered);

    // Restore last played if available
    let restored = null;
    try { restored = localStorage.getItem('localtube:last'); } catch {}
    if (restored) {
      const idx = filtered.findIndex(v => v.relPath === restored);
      if (idx !== -1) {
        playIndex(idx);
        return;
      }
    }
    if (filtered.length) playIndex(0);
  }

  // Keyboard next/prev
  document.addEventListener('keydown', (e) => {
    if (e.target === searchEl) return;
    if (e.key === 'j') { // previous
      if (activeIndex > 0) playIndex(activeIndex - 1);
    } else if (e.key === 'k') { // next
      if (activeIndex < filtered.length - 1) playIndex(activeIndex + 1);
    }
  });

  searchEl.addEventListener('input', applyFilter);

  // Subtitle delay controls
  if (sdMinus && sdPlus && sdValue && sdReset) {
    const step = 100; // ms
    sdMinus.addEventListener('click', () => {
      const folder = currentFolder || (currentItem && folderOf(currentItem.relPath));
      if (!folder) return;
      const v = getSavedDelayMs(folder) - step;
      applySubDelay(v);
    });
    sdPlus.addEventListener('click', () => {
      const folder = currentFolder || (currentItem && folderOf(currentItem.relPath));
      if (!folder) return;
      const v = getSavedDelayMs(folder) + step;
      applySubDelay(v);
    });
    sdReset.addEventListener('click', () => {
      const folder = currentFolder || (currentItem && folderOf(currentItem.relPath));
      if (!folder) return;
      applySubDelay(0);
    });
    sdValue.addEventListener('change', () => {
      const folder = currentFolder || (currentItem && folderOf(currentItem.relPath));
      if (!folder) return;
      const v = parseInt(sdValue.value, 10) || 0;
      applySubDelay(v);
    });
  }

  load().catch(err => {
    console.error(err);
  });

  // Initialize subtitle appearance controls on startup
  initSubStyleUI();
})();
