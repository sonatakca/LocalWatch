(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const listEl = $('#video-list');
  const layoutEl = $('.layout');
  const sidebarEl = $('.sidebar');
  const collapseBtn = document.getElementById('collapse-btn');
  const countEl = $('#video-count');
  const emptyHint = $('#empty-hint');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
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

  // Inline SVG icons (rounded)
  const svgPrev = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="14" width="6" height="36" rx="3"/><path d="M48 16 L24 32 L48 48 Z" fill="currentColor" stroke="currentColor" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  const svgPlay = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M23 16 L23 48 L47 32 Z" fill="currentColor" stroke="currentColor" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  const svgPause = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="20" y="16" width="8" height="32" rx="2"/><rect x="36" y="16" width="8" height="32" rx="2"/></svg>';
  const svgNext = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="48" y="14" width="6" height="36" rx="3"/><path d="M16 16 L40 32 L16 48 Z" fill="currentColor" stroke="currentColor" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/></svg>';

  const player = new Plyr(videoEl, {
    invertTime: false,
    ratio: '16:9',
    captions: { active: true, language: 'auto' },
    keyboard: { focused: true, global: true },
    // Do not toggle play/pause when clicking empty video area
    clickToPlay: false,
    // Prefer element-based fullscreen so overlays render on iPad
    fullscreen: { enabled: true, fallback: true, iosNative: false },
    seekTime: 10, // +/- 10s jumps
    controls: [
      // Removed 'play-large' to disable the big center button
      'rewind', 'play', 'fast-forward', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'airplay', 'fullscreen'
    ],
  });

  const isTouchEnv = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  // Skip Intro UI state
  let skipIntroWindow = null; // { start, end }
  let skipBtnHost = null; // container appended inside plyr
  let lastSkipVisible = false;

  // Next Episode UI state
  let nextEpAt = null; // seconds from start when to show
  let nextBtnHost = null;
  let lastNextVisible = false;
  let nextBtnEl = null;
  let nextAutoSkipTimer = null;
  let nextAutoSkipSuppressed = false; // once user interacts, don't auto-skip until next appearance
  let nextAutoSkipCancelHandlers = [];

  // Resume playback state (localStorage)
  let lastResumeSaveTs = 0;
  function resumeKey(relPath) { return `LocalWatch:resume:${relPath}`; }
  function loadResume(relPath) {
    try {
      const raw = localStorage.getItem(resumeKey(relPath));
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (j && typeof j.t === 'number' && j.t >= 0) return j;
    } catch {}
    return null;
  }
  function saveResume(relPath, t, dur) {
    try {
      const data = { t: Math.max(0, Math.floor(t)), dur: dur || null, ts: Date.now() };
      localStorage.setItem(resumeKey(relPath), JSON.stringify(data));
    } catch {}
  }
  function clearResume(relPath) { try { localStorage.removeItem(resumeKey(relPath)); } catch {} }
  function approxDuration() {
    const d = Number(player && player.duration) || Number(videoEl && videoEl.duration) || 0;
    if (d && Number.isFinite(d) && d > 0) return d;
    return (currentItem && Number(currentItem.duration)) || 0;
  }

  function ensureSkipIntroUI() {
    try {
      const container = player && player.elements && player.elements.container;
      if (!container) return;
      if (skipBtnHost && skipBtnHost.isConnected) return; // already added
      const host = document.createElement('div');
      host.className = 'lt-skip-intro';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Skip Intro';
      btn.addEventListener('click', () => {
        if (!skipIntroWindow) return;
        try {
          const t = Math.max(0, Number(skipIntroWindow.end) || 0);
          player.currentTime = t + 0.01;
          attemptPlayWithMutedFallback();
        } catch {}
        setSkipBtnVisible(false);
      });
      host.appendChild(btn);
      container.appendChild(host);
      skipBtnHost = host;
    } catch {}
  }

  function setSkipBtnVisible(show) {
    if (!skipBtnHost) return;
    lastSkipVisible = !!show;
    skipBtnHost.classList.toggle('show', !!show);
  }

  function ensureNextEpisodeUI() {
    try {
      const container = player && player.elements && player.elements.container;
      if (!container) return;
      if (nextBtnHost && nextBtnHost.isConnected) return; // already added
      const host = document.createElement('div');
      host.className = 'lt-next-episode';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Next Episode';
      btn.addEventListener('click', () => {
        try {
          if (activeIndex >= 0 && activeIndex < filtered.length - 1) {
            const target = activeIndex + 1;
            // Ensure sound is on for user‑gesture next
            try {
              videoEl.autoplay = true;
              if (player) player.muted = false;
              if (videoEl) { videoEl.muted = false; videoEl.removeAttribute('muted'); }
            } catch {}
            // Kick playback immediately within the gesture
            Promise.resolve(playIndex(target)).then(() => {
              try { const pp = player && player.play && player.play(); if (pp && pp.catch) pp.catch(() => {}); } catch {}
            });
          }
        } catch {}
        setNextBtnVisible(false);
      });
      host.appendChild(btn);
      container.appendChild(host);
      nextBtnHost = host;
      nextBtnEl = btn;
    } catch {}
  }

  // Episode quick controls (prev / play-pause / next)
  let epCtrlHost = null;
  let epBtnPrev = null;
  let epBtnPlay = null;
  let epBtnNext = null;
  let epAutoHideTimer = null;
  let epHovering = false;
  function ensureEpisodeControlsUI() {
    try {
      const container = player && player.elements && player.elements.container;
      if (!container) return;
      if (epCtrlHost && epCtrlHost.isConnected) return;
      const host = document.createElement('div');
      host.className = 'lw-ep-ctrl';
      // Simple default icons using inline SVG
      const mkBtn = (cls, title, svg) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ep-btn ' + cls;
        // Avoid native OS tooltips on long hover/hold; use aria-label instead
        if (title) b.setAttribute('aria-label', title);
        b.innerHTML = svg;
        host.appendChild(b);
        return b;
      };
      // icons provided at top-level (svgPrev, svgPlay, svgPause, svgNext)
      epBtnPrev = mkBtn('prev', 'Previous', svgPrev);
      epBtnPlay = mkBtn('playpause', 'Pause/Resume', svgPause);
      epBtnNext = mkBtn('next', 'Next', svgNext);

      epBtnPrev.addEventListener('click', () => { try { if (activeIndex > 0) playIndex(activeIndex - 1); } catch {} });
      epBtnNext.addEventListener('click', () => { try { if (activeIndex < filtered.length - 1) playIndex(activeIndex + 1); } catch {} });
      epBtnPlay.addEventListener('click', () => {
        try {
          const isPaused = (player && typeof player.playing === 'boolean')
            ? !player.playing
            : !!(videoEl && videoEl.paused);
          if (isPaused) {
            attemptPlayWithMutedFallback();
          } else {
            try { player && player.pause && player.pause(); }
            catch {}
            try { if (videoEl) videoEl.pause(); } catch {}
          }
          updateEpisodeControls();
        } catch {}
      });

      container.appendChild(host);
      epCtrlHost = host;

      // Keep both overlays visible while hovering the episode controls
      const hold = () => {
        epHovering = true;
        try { epCtrlHost.classList.add('open'); } catch {}
        try { container.classList.remove('plyr--hide-controls'); } catch {}
      };
      const release = () => { epHovering = false; };
      try { epBtnPrev.addEventListener('pointerenter', hold); epBtnPrev.addEventListener('pointerleave', release); } catch {}
      try { epBtnPlay.addEventListener('pointerenter', hold); epBtnPlay.addEventListener('pointerleave', release); } catch {}
      try { epBtnNext.addEventListener('pointerenter', hold); epBtnNext.addEventListener('pointerleave', release); } catch {}

      try { videoEl.addEventListener('play', () => updateEpisodeControls()); } catch {}
      try { videoEl.addEventListener('pause', () => updateEpisodeControls()); } catch {}

      player.on('play', () => {
        updateEpisodeControls();
        // If controls are already hidden when playback resumes, hide our overlay too
        if (container.classList.contains('plyr--hide-controls')) {
          try { epCtrlHost.classList.remove('open'); } catch {}
        }
      });
      player.on('pause', () => {
        updateEpisodeControls();
        try { epCtrlHost.classList.add('open'); } catch {}
      });
      player.on('controlsshown', () => { try { epCtrlHost.classList.add('open'); } catch {} });
      player.on('controlshidden', () => {
        if (epHovering) {
          // While hovering, keep controls visible and our overlay open
          try { container.classList.remove('plyr--hide-controls'); } catch {}
          try { epCtrlHost.classList.add('open'); } catch {}
          return;
        }
        if (player && player.playing) {
          try { epCtrlHost.classList.remove('open'); } catch {}
        }
      });

      updateEpisodeControls();
    } catch {}
  }

  function updateEpisodeControls() {
    if (!epCtrlHost) return;
    const hasPrev = activeIndex > 0;
    const hasNext = filtered && activeIndex >= 0 && activeIndex < filtered.length - 1;
    const paused = (player && typeof player.playing === 'boolean')
      ? !player.playing
      : !!(videoEl && videoEl.paused);
    epBtnPrev && epBtnPrev.classList.toggle('hidden', !hasPrev);
    epBtnNext && epBtnNext.classList.toggle('hidden', !hasNext);
    if (epBtnPlay) {
      epBtnPlay.innerHTML = paused ? svgPlay : svgPause;
    }
  }

  function showEpisodeControls() {
    ensureEpisodeControlsUI();
    updateEpisodeControls();
    if (!epCtrlHost) return;
    epCtrlHost.classList.add('open');
  }

  function hideEpisodeControlsSoon(ms) {
    if (!epCtrlHost) return;
    clearTimeout(epAutoHideTimer);
    const delay = Math.max(0, Number(ms || 0));
    epAutoHideTimer = setTimeout(() => { try { epCtrlHost.classList.remove('open'); } catch {} }, delay);
  }

  function setNextBtnVisible(show) {
    if (!nextBtnHost) return;
    lastNextVisible = !!show;
    nextBtnHost.classList.toggle('show', !!show);
    // Manage auto-skip lifecycle tied to visibility
    if (show) {
      // Start countdown only if not previously suppressed by user activity
      if (!nextAutoSkipSuppressed) startNextAutoSkipCountdown(5000);
    } else {
      // Hide: clear any pending timers and reset suppression for next time
      clearNextAutoSkip(true /*resetSuppression*/);
    }
  }

  async function fetchSkipIntro(relPath) {
    try {
      const r = await fetch(`/skipintro?p=${encodeURIComponent(relPath)}`);
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      if (j && typeof j.start === 'number' && typeof j.end === 'number' && j.end > j.start) {
        return { start: j.start, end: j.end };
      }
    } catch {}
    return null;
  }

  function updateSkipBtnVisibility(currentTime) {
    if (!skipIntroWindow) { setSkipBtnVisible(false); return; }
    const t = Number(currentTime) || 0;
    const show = t >= skipIntroWindow.start && t < skipIntroWindow.end;
    if (show !== lastSkipVisible) setSkipBtnVisible(show);
  }

  async function fetchNextEpisode(relPath) {
    try {
      const r = await fetch(`/nextepisode?p=${encodeURIComponent(relPath)}`);
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      if (j && typeof j.at === 'number' && j.at >= 0) {
        return j.at;
      }
      // Fallback if server only returns offset (when duration unknown)
      if (j && typeof j.offset === 'number' && currentItem && typeof currentItem.duration === 'number') {
        const dur = currentItem.duration || 0;
        const at = j.offset < 0 ? Math.max(0, dur + j.offset) : Math.max(0, Math.min(dur, j.offset));
        return at;
      }
    } catch {}
    return null;
  }

  function updateNextBtnVisibility(currentTime) {
    if (nextEpAt == null) { setNextBtnVisible(false); return; }
    const t = Number(currentTime) || 0;
    // Show once we reach trigger time; keep visible until end
    const show = t >= nextEpAt && (activeIndex < filtered.length);
    if (show !== lastNextVisible) setNextBtnVisible(show);
  }

  function clearNextAutoSkip(resetSuppression) {
    try { if (nextAutoSkipTimer) { clearTimeout(nextAutoSkipTimer); } } catch {}
    nextAutoSkipTimer = null;
    if (nextBtnEl) {
      nextBtnEl.removeAttribute('data-auto-skip');
      try { nextBtnEl.style.removeProperty('--auto-skip-duration'); } catch {}
    }
    // Remove temporary cancel handlers
    nextAutoSkipCancelHandlers.forEach(({ t, fn, opts }) => {
      try { window.removeEventListener(t, fn, opts); } catch {}
    });
    nextAutoSkipCancelHandlers = [];
    if (resetSuppression) nextAutoSkipSuppressed = false;
  }

  // Attempt to start playback; if blocked by autoplay policy, retry muted then restore.
  function attemptPlayWithMutedFallback() {
    try {
      const p = player && player.play && player.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          try {
            const msg = String((err && (err.name || err.message)) || err || '');
            if (!/NotAllowedError|Autoplay|play\(\) failed|operation is not allowed/i.test(msg)) return;
          } catch {}
          const wasMuted = !!(player && player.muted);
          try {
            if (player) player.muted = true;
            if (videoEl) { videoEl.muted = true; videoEl.setAttribute('muted', ''); }
          } catch {}
          const p2 = player && player.play && player.play();
          if (p2 && typeof p2.catch === 'function') { try { p2.catch(() => {}); } catch {} }
          const restore = () => {
            try { videoEl.removeEventListener('playing', restore); } catch {}
            if (!wasMuted) {
              setTimeout(() => {
                try {
                  if (player) player.muted = false;
                  if (videoEl) { videoEl.muted = false; videoEl.removeAttribute('muted'); }
                } catch {}
              }, 80);
            }
          };
          try { videoEl.addEventListener('playing', restore, { once: true }); } catch {}
        });
      }
    } catch {}
  }

  // Media Session integration for Bluetooth/OS controls (AirPods, lock screen, etc.)
  function setupMediaSessionControls() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const trySet = (action, handler) => { try { ms.setActionHandler(action, handler); } catch {} };
    const getSeekDelta = (d) => Math.max(1, Number((d && d.seekOffset) || (player && player.config && player.config.seekTime) || 10));

    trySet('play', () => { attemptPlayWithMutedFallback(); });
    trySet('pause', () => { try { player.pause(); } catch {} });
    trySet('stop', () => { try { player.pause(); player.currentTime = 0; } catch {} });
    trySet('seekbackward', (details) => {
      try {
        const delta = getSeekDelta(details);
        player.currentTime = Math.max(0, Number(player.currentTime || 0) - delta);
      } catch {}
    });
    trySet('seekforward', (details) => {
      try {
        const delta = getSeekDelta(details);
        player.currentTime = Math.max(0, Number(player.currentTime || 0) + delta);
      } catch {}
    });
    trySet('seekto', (details) => {
      try {
        if (details && typeof details.seekTime === 'number') {
          player.currentTime = Math.max(0, details.seekTime);
          if (details.fastSeek && 'fastSeek' in videoEl) { try { videoEl.fastSeek(details.seekTime); } catch {} }
        }
      } catch {}
    });
    trySet('previoustrack', () => { try { if (activeIndex > 0) { playIndex(activeIndex - 1); } } catch {} });
    trySet('nexttrack', () => { try { if (activeIndex < filtered.length - 1) { playIndex(activeIndex + 1); } } catch {} });
  }

  function updateMediaMetadataFor(item) {
    try {
      if (!('mediaSession' in navigator) || !item) return;
      const title = (item.name || '').replace(/\.[^.]+$/, '');
      const album = 'LocalWatch';
      const artist = item.category || 'Library';
      const artUrl = `/thumb?p=${encodeURIComponent(item.relPath)}`;
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork: [
          { src: artUrl, sizes: '256x256', type: 'image/png' },
          { src: artUrl, sizes: '512x512', type: 'image/png' }
        ]
      });
    } catch {}
  }

  function updateMediaPositionState() {
    try {
      if (!('mediaSession' in navigator)) return;
      const duration = approxDuration() || 0;
      const position = Number(player && player.currentTime) || Number(videoEl && videoEl.currentTime) || 0;
      const playbackRate = Number(videoEl && videoEl.playbackRate) || 1;
      if (typeof navigator.mediaSession.setPositionState === 'function') {
        navigator.mediaSession.setPositionState({ duration, playbackRate, position });
      }
    } catch {}
  }

  function startNextAutoSkipCountdown(ms) {
    clearNextAutoSkip(false);
    if (!nextBtnEl) return;
    // Mark running to enable CSS indicator
    nextBtnEl.setAttribute('data-auto-skip', 'running');
    try { nextBtnEl.style.setProperty('--auto-skip-duration', `${Math.max(0, ms|0)}ms`); } catch {}

    // Cancel on any user activity (mouse, key, touch, wheel)
    const cancel = () => {
      nextAutoSkipSuppressed = true;
      clearNextAutoSkip(false);
    };
    const addCancel = (t, opts) => {
      const fn = () => cancel();
      window.addEventListener(t, fn, opts);
      nextAutoSkipCancelHandlers.push({ t, fn, opts });
    };
    addCancel('mousemove', { passive: true });
    addCancel('pointermove', { passive: true });
    addCancel('mousedown', { passive: true });
    addCancel('pointerdown', { passive: true });
    addCancel('keydown', false);
    addCancel('wheel', { passive: true });
    addCancel('touchstart', { passive: true });
    addCancel('touchmove', { passive: true });

    // After delay, if still visible and not suppressed, go to next episode
    nextAutoSkipTimer = setTimeout(() => {
      nextAutoSkipTimer = null;
      // Only proceed if button still visible and countdown hasn't been cancelled
      if (!lastNextVisible || nextAutoSkipSuppressed) { clearNextAutoSkip(false); return; }
      try {
        if (activeIndex >= 0 && activeIndex < filtered.length - 1) {
          const target = activeIndex + 1;
          // Hint autoplay; then play on readiness with muted fallback if needed
          try { videoEl.autoplay = true; } catch {}
          Promise.resolve(playIndex(target)).then(() => {
            const onReady = () => { attemptPlayWithMutedFallback(); };
            try {
              videoEl.addEventListener('loadeddata', onReady, { once: true });
              videoEl.addEventListener('canplay', onReady, { once: true });
            } catch {}
            // Also attempt shortly in case events already fired
            setTimeout(onReady, 0);
          });
        }
      } catch {}
      clearNextAutoSkip(true);
      setNextBtnVisible(false);
    }, Math.max(0, ms|0));
  }

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
    try { setupMediaSessionControls(); } catch {}
    const controls = player.elements && player.elements.controls;
    const settingsBtn = controls && controls.querySelector('button[aria-label="Settings"]');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => setTimeout(setupSettingsMenu, 0));
    }
    wireLiftForControls();
    ensureSkipIntroUI();
    ensureNextEpisodeUI();
    ensureEpisodeControlsUI();
    updateEpisodeControls();
    try { setupEmptyClickDismiss(); } catch {}
    try { setupFullscreenTypingGuard(); } catch {}
    try { applyCustomSeekIcons(); } catch {}
    try { ensureTapGestures(); } catch {}
  });

  // Replace Plyr's default rewind/forward icons with custom SVGs
  function applyCustomSeekIcons() {
    const controls = player && player.elements && player.elements.controls;
    if (!controls) return;

    const rewindBtn = controls.querySelector('button[data-plyr="rewind"]');
    const ffBtn = controls.querySelector('button[data-plyr="fast-forward"]');

    const setIcon = (btn, svgMarkup) => {
      if (!btn) return;
      // Remove existing SVGs but keep tooltips or other children
      btn.querySelectorAll('svg').forEach((el) => el.remove());
      // Insert our custom SVG icon
      const tpl = document.createElement('template');
      tpl.innerHTML = svgMarkup.trim();
      const icon = tpl.content.firstChild;
      if (icon) btn.insertBefore(icon, btn.firstChild);
    };

    // Use currentColor so the icon matches theme
    const rewindSvg = `
      <svg aria-hidden="true" focusable="false" class="lw-icon" width="22" height="22" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" stroke-width="3" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vector-effect: non-scaling-stroke; pointer-events: none;">
        <polyline points="9.57 15.41 12.17 24.05 20.81 21.44" stroke-linecap="round"></polyline>
        <path d="M26.93,41.41V23a.09.09,0,0,0-.16-.07s-2.58,3.69-4.17,4.78" stroke-linecap="round"></path>
        <rect x="32.19" y="22.52" width="11.41" height="18.89" rx="5.7"></rect>
        <path d="M12.14,23.94a21.91,21.91,0,1,1-.91,13.25" stroke-linecap="round"></path>
      </svg>
    `;

    const forwardSvg = `
      <svg aria-hidden="true" focusable="false" class="lw-icon" width="22" height="22" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" stroke-width="3" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vector-effect: non-scaling-stroke; pointer-events: none;">
        <path d="M23.93,41.41V23a.09.09,0,0,0-.16-.07s-2.58,3.69-4.17,4.78" stroke-linecap="round"></path>
        <rect x="29.19" y="22.52" width="11.41" height="18.89" rx="5.7"></rect>
        <polyline points="54.43 15.41 51.83 24.05 43.19 21.44" stroke-linecap="round"></polyline>
        <path d="M51.86,23.94a21.91,21.91,0,1,0,.91,13.25" stroke-linecap="round"></path>
      </svg>
    `;

    setIcon(rewindBtn, rewindSvg);
    setIcon(ffBtn, forwardSvg);
  }

  player.on('timeupdate', () => {
    updateSkipBtnVisibility(player.currentTime || 0);
    updateNextBtnVisibility(player.currentTime || 0);
    try { updateMediaPositionState(); } catch {}
    // Persist resume position (throttled)
    try {
      if (!currentRelPath) return;
      const now = Date.now();
      const t = Number(player.currentTime || 0);
      // If we're in the .nextepisode span (outro), don't keep resume
      if (nextEpAt != null && t >= Math.max(0, nextEpAt - 1)) { clearResume(currentRelPath); return; }
      if (now - lastResumeSaveTs >= 1500) {
        const d = approxDuration();
        saveResume(currentRelPath, t, d || null);
        lastResumeSaveTs = now;
      }
    } catch {}
  });
  player.on('seeking', () => {
    updateSkipBtnVisibility(player.currentTime || 0);
    updateNextBtnVisibility(player.currentTime || 0);
    try { updateMediaPositionState(); } catch {}
  });
  player.on('ended', () => { setSkipBtnVisible(false); setNextBtnVisible(false); if (currentRelPath) clearResume(currentRelPath); });
  player.on('play', () => { try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; } catch {} });
  player.on('pause', () => { try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; } catch {} });

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
      const v = localStorage.getItem('LocalWatch:subDelay:' + folder);
      return v != null ? parseInt(v, 10) || 0 : 0;
    } catch { return 0; }
  }
  function setSavedDelayMs(folder, ms) {
    try { localStorage.setItem('LocalWatch:subDelay:' + folder, String(ms)); } catch {}
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
      const j = JSON.parse(localStorage.getItem('LocalWatch:subStyle') || '{}');
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
    try { localStorage.setItem('LocalWatch:subStyle', JSON.stringify(style)); } catch {}
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
    try { localStorage.setItem('LocalWatch:sidebarCollapsed', collapsed ? '1' : '0'); } catch {}
  }
  function getSidebarCollapsed() {
    try { return localStorage.getItem('LocalWatch:sidebarCollapsed') === '1'; } catch { return false; }
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
    const paused = !!(videoEl && videoEl.paused);
    player.config.duration = currentItem.duration || null;
    player.source = source;
    try { updateMediaMetadataFor(item); updateMediaPositionState(); } catch {}
    videoEl.addEventListener('loadeddata', () => {
      try { player.currentTime = time; } catch {}
      if (!paused) attemptPlayWithMutedFallback();
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

    // Pre-fetch next-episode trigger so resume logic can respect it
    ensureNextEpisodeUI();
    if (activeIndex < filtered.length - 1) {
      nextEpAt = await fetchNextEpisode(item.relPath);
    } else {
      nextEpAt = null;
    }
    updateNextBtnVisibility(0);

    // Provide a real duration for plyr to display when streaming
    // fragmented MP4 where the intrinsic duration is unknown.
    player.config.duration = item.duration || null;
    player.source = source;
    try { updateMediaMetadataFor(item); updateMediaPositionState(); } catch {}
    // Robust resume after new source is set (handles fast metadata and fallbacks)
    (function applyResume() {
      try {
        const resume = loadResume(item.relPath);
        if (!resume || typeof resume.t !== 'number' || resume.t <= 0) { attemptPlayWithMutedFallback(); return; }
        // If saved time is within the .nextepisode span (outro), do not resume
        if (nextEpAt != null && resume.t >= Math.max(0, nextEpAt - 1)) {
          clearResume(item.relPath);
          attemptPlayWithMutedFallback();
          return;
        }
        const target = Math.max(0, resume.t);
        let applied = false;
        const seekAndPlay = () => {
          if (applied) return;
          applied = true;
          try { player.currentTime = target; } catch {}
          attemptPlayWithMutedFallback();
        };
        // If metadata is already available, seek immediately
        try {
          if ((videoEl.readyState || 0) >= 1 && (videoEl.duration || player.duration || 0)) {
            seekAndPlay();
          }
        } catch {}
        // Otherwise, hook events; race to first
        videoEl.addEventListener('loadedmetadata', seekAndPlay, { once: true });
        videoEl.addEventListener('canplay', seekAndPlay, { once: true });
        videoEl.addEventListener('loadeddata', seekAndPlay, { once: true });
        const onTu = () => { if (!applied && (Number(videoEl.currentTime||0) < target - 0.25)) seekAndPlay(); };
        videoEl.addEventListener('timeupdate', onTu, { once: true });
        // Safety timeout in case events are missed
        setTimeout(seekAndPlay, 1000);
      } catch {
        attemptPlayWithMutedFallback();
      }
    })();
    nowTitle.textContent = item.name.replace(/\.[^.]+$/, '');
    const durStr = item.duration ? ` • ${formatDuration(item.duration)}` : '';
    nowMeta.textContent = `${item.ext.replace('.', '').toUpperCase()} • ${bytesToSize(item.size)}${durStr}`;
    highlightActive();
    currentRelPath = item.relPath;
    try { localStorage.setItem('LocalWatch:last', item.relPath); } catch {}

    // Fetch skip-intro window for this item and initialize UI
    ensureSkipIntroUI();
    skipIntroWindow = await fetchSkipIntro(item.relPath);
    updateSkipBtnVisibility(0);

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
        try { updateMediaMetadataFor(item); updateMediaPositionState(); } catch {}
        // Re-apply resume for fallback source
        (function applyResume() {
          try {
            const resume = loadResume(item.relPath);
            if (!resume || typeof resume.t !== 'number' || resume.t <= 0) { attemptPlayWithMutedFallback(); return; }
            // Respect .nextepisode span for resume decision
            if (nextEpAt != null && resume.t >= Math.max(0, nextEpAt - 1)) { clearResume(item.relPath); attemptPlayWithMutedFallback(); return; }
            const target = Math.max(0, resume.t);
            let applied = false;
            const seekAndPlay = () => { if (applied) return; applied = true; try { player.currentTime = target; } catch {}; attemptPlayWithMutedFallback(); };
            try { if ((videoEl.readyState||0) >= 1 && (videoEl.duration||player.duration||0)) { seekAndPlay(); } } catch {}
            videoEl.addEventListener('loadedmetadata', seekAndPlay, { once: true });
            videoEl.addEventListener('canplay', seekAndPlay, { once: true });
            videoEl.addEventListener('loadeddata', seekAndPlay, { once: true });
            const onTu = () => { if (!applied && (Number(videoEl.currentTime||0) < target - 0.25)) seekAndPlay(); };
            videoEl.addEventListener('timeupdate', onTu, { once: true });
            setTimeout(seekAndPlay, 1000);
          } catch { attemptPlayWithMutedFallback(); }
        })();
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
    // We no longer show the media path; dropzone replaces it.
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
    try { restored = localStorage.getItem('LocalWatch:last'); } catch {}
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

  // Drag & drop uploader for adding files/folders into /media
  if (dropzone) {
    // Support tap-to-upload for touch devices and desktops
    dropzone.addEventListener('click', (e) => {
      // Avoid triggering when an actual drag operation is in progress
      if (dropzone.classList.contains('uploading')) return;
      if (fileInput) {
        try { fileInput.value = ''; } catch {}
        fileInput.click();
      }
    });

    const onDragOver = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    };
    const onDragLeave = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    };
    dropzone.addEventListener('dragover', onDragOver);
    dropzone.addEventListener('dragenter', onDragOver);
    dropzone.addEventListener('dragleave', onDragLeave);
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
      if (!e.dataTransfer) return;

      dropzone.classList.add('uploading');
      try {
        // Prefer moving files/folders via local file:// URIs if available
        const localItems = extractLocalDropItems(e.dataTransfer);
        if (localItems && localItems.length) {
          await moveLocalItems(localItems);
        } else {
          const files = await collectDroppedFiles(e.dataTransfer);
          // Try to move from Downloads by matching name+size first
          const movedKeys = await guessAndMoveFromDownloads(files);
          // Upload any that were not moved
          const notMoved = [];
          for (const f of files) {
            const key = `${f.file.name}|${f.file.size||0}`;
            if (movedKeys.has(key)) continue;
            await uploadOne(f.file, f.relPath);
            notMoved.push(f);
          }
          // After upload, make a best-effort to delete originals in Downloads
          if (notMoved.length) await guessAndMoveFromDownloads(notMoved);
        }
        // Refresh list after upload
        await load();
      } catch (err) {
        console.error('Upload failed:', err);
      } finally {
        dropzone.classList.remove('uploading');
      }
    });
  }

  // Handle file picker fallback
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      dropzone && dropzone.classList.add('uploading');
      try {
        // Keep directory structure when available
        for (const file of files) {
          const relPath = (file.webkitRelativePath && file.webkitRelativePath.length)
            ? file.webkitRelativePath
            : file.name;
          await uploadOne(file, relPath);
        }
        await load();
      } catch (err) {
        console.error('Upload (picker) failed:', err);
      } finally {
        dropzone && dropzone.classList.remove('uploading');
      }
    });
  }

  // Touch-friendly gestures: YouTube-style multi‑tap seek on left/right.
  // 1 tap = no action; 2 taps = 10s; 3 taps = 20s; n taps = 10*(n-1)s.
  function ensureTapGestures() {
    const container = (player && player.elements && player.elements.container) || document.querySelector('.player-container');
    if (!container || container.dataset.lwTapWired === '1') return;
    container.dataset.lwTapWired = '1';

    // Feedback overlay host
    const fbHost = document.createElement('div');
    fbHost.className = 'lw-tap-feedback';
    container.appendChild(fbHost);

    const seekDelta = Math.max(1, Number(player && player.config && player.config.seekTime) || 10);
    const TAP_WINDOW_MS = 350;            // tighter window to aggregate taps (was 700)
    const MAX_DIST_PX = 140;              // max movement to keep same sequence
    const PULSE_DURATION_MS = 900;        // visual burst length
    const AGG_LINGER_MS = 1200;           // time the label stays visible after last tap

    // Aggregate labels per side (left/right) with independent timers
    const agg = {
      left: { el: null, hideTimer: null },
      right: { el: null, hideTimer: null },
    };

    function fadeOutAgg(sideRight) {
      const side = sideRight ? 'right' : 'left';
      const a = agg[side];
      if (!a.el) return;
      clearTimeout(a.hideTimer);
      try {
        a.el.classList.remove('fade-in');
        a.el.classList.add('fade-out');
        const toRemove = a.el;
        const cleanup = () => { try { toRemove.remove(); } catch {} if (a.el === toRemove) a.el = null; };
        toRemove.addEventListener('animationend', cleanup, { once: true });
        setTimeout(cleanup, 400);
      } catch {
        try { a.el.remove(); } catch {}
        a.el = null;
      }
    }
    function showAgg(sideRight, text, animateIn) {
      const side = sideRight ? 'right' : 'left';
      const a = agg[side];
      if (!a.el) {
        const el = document.createElement('div');
        el.className = 'label';
        a.el = el;
        fbHost.appendChild(el);
      }
      const rect = container.getBoundingClientRect();
      const ax = sideRight ? rect.width * 0.82 : rect.width * 0.18;
      const ay = rect.height * 0.35; // fixed vertical anchor
      a.el.style.left = `${ax}px`;
      a.el.style.top = `${ay}px`;
      a.el.textContent = text;
      // Only animate on first appearance within a sequence
      try {
        a.el.classList.remove('fade-out');
        if (animateIn) {
          a.el.classList.remove('fade-in');
          void a.el.offsetWidth; // reflow
          a.el.classList.add('fade-in');
        } else {
          a.el.classList.remove('fade-in');
        }
      } catch {}
      clearTimeout(a.hideTimer);
      a.hideTimer = setTimeout(() => {
        if (!a.el) return;
        try {
          a.el.classList.remove('fade-in');
          a.el.classList.add('fade-out');
          const toRemove = a.el;
          const cleanup = () => { try { toRemove.remove(); } catch {} if (a.el === toRemove) a.el = null; };
          toRemove.addEventListener('animationend', cleanup, { once: true });
          setTimeout(cleanup, 400);
        } catch {
          try { a.el.remove(); } catch {}
          a.el = null;
        }
      }, AGG_LINGER_MS);
    }

    function spawnPulse(x, y) {
      const pulse = document.createElement('div');
      pulse.className = 'pulse';
      pulse.style.left = `${x}px`;
      pulse.style.top = `${y}px`;
      fbHost.appendChild(pulse);
      requestAnimationFrame(() => { pulse.classList.add('fade'); });
      setTimeout(() => { try { pulse.remove(); } catch {} }, PULSE_DURATION_MS);
    }

    // Current tap session within a short time window
    let seq = {
      active: false,
      lastTime: 0,
      count: 0,
      sideRight: false,
      applied: 0, // seconds already applied in this sequence
      lastPointerType: '',
      lastX: 0,
      lastY: 0,
    };

    function onPointerUp(e) {
      // Ignore interactions on controls
      if (e.target && (e.target.closest('.plyr__controls') || e.target.closest('.plyr__control'))) return;
      const type = (e.pointerType || (e.changedTouches ? 'touch' : '')) || '';
      const now = Date.now();
      const rect = container.getBoundingClientRect();
      let cx, cy;
      if (e.changedTouches && e.changedTouches.length) {
        cx = e.changedTouches[0].clientX; cy = e.changedTouches[0].clientY;
      } else {
        cx = e.clientX; cy = e.clientY;
      }
      const x = cx - rect.left;
      const y = cy - rect.top;
      const frac = x / Math.max(1, rect.width);
      const isRight = frac >= 0.5;

      // Decide if we continue the current sequence
      const within = now - (seq.lastTime || 0);
      const dist = Math.hypot(x - seq.lastX, y - seq.lastY);
      const samePointer = (seq.lastPointerType === type) || !seq.lastPointerType;
      const continueSeq = seq.active && within < TAP_WINDOW_MS && dist < MAX_DIST_PX && samePointer && seq.sideRight === isRight;

      if (!continueSeq) {
        // Start a new sequence (first tap: no action)
        seq = { active: true, lastTime: now, count: 1, sideRight: isRight, applied: 0, lastPointerType: type, lastX: x, lastY: y };
        // 1 tap: no pulse, no label (as requested).
        // Do not interfere with the other side label or timers.
        // Rely on Plyr controls visibility to show episode controls (synced by events).
        return;
      }

      // Continue sequence: second+ taps
      e.preventDefault();
      e.stopPropagation();
      seq.count += 1;
      seq.lastTime = now;
      seq.lastX = x; seq.lastY = y; seq.lastPointerType = type;

      const total = seekDelta * (seq.count - 1); // 2 taps => 10, 3 => 20...
      const diff = total - (seq.applied || 0);
      const sign = seq.sideRight ? +1 : -1;
      const wasPlaying = !(videoEl && videoEl.paused);
      try {
        const cur = Number(player.currentTime || 0);
        const next = Math.max(0, cur + sign * diff);
        player.currentTime = next;
        if (wasPlaying) { attemptPlayWithMutedFallback(); }
      } catch {}
      seq.applied = total;

      spawnPulse(x, y);
      showAgg(seq.sideRight, (seq.sideRight ? '+' : '−') + String(total) + 's', seq.count === 2);
      // Only when a sequence actually triggers (second tap), fade out the other side
      if (seq.count === 2) fadeOutAgg(!seq.sideRight);
    }

    // Prefer PointerEvents; fall back to touchend where PointerEvents unsupported
    if (window.PointerEvent) {
      container.addEventListener('pointerup', (e) => {
        // Ignore taps on our episode controls overlay so they don't count
        if (e.target && e.target.closest && e.target.closest('.lw-ep-ctrl')) return;
        onPointerUp(e);
      }, { passive: false });
    } else {
      container.addEventListener('touchend', (e) => {
        if (e.target && e.target.closest && e.target.closest('.lw-ep-ctrl')) return;
        onPointerUp(e);
      }, { passive: false });
    }
  }

  // Hide Plyr controls + our episode buttons when clicking empty space
  function setupEmptyClickDismiss() {
    const container = player && player.elements && player.elements.container;
    if (!container || container.dataset.lwDismissWired === '1') return;
    container.dataset.lwDismissWired = '1';
    container.addEventListener('click', (e) => {
      try {
        const t = e.target;
        // Ignore clicks on any Plyr UI or our buttons or timeline area
        if (t.closest('.plyr__controls') || t.closest('.plyr__control') || t.closest('.plyr__menu') || t.closest('.plyr__progress') || t.closest('.lw-ep-ctrl')) {
          return;
        }
        // Only act if controls are shown
        if (container.classList && !container.classList.contains('plyr--hide-controls')) {
          container.classList.add('plyr--hide-controls');
          try { epCtrlHost && epCtrlHost.classList.remove('open'); } catch {}
        }
      } catch {}
    }, true);
  }

  // Prevent iPadOS Safari fullscreen "typing not allowed" alerts by
  // blurring focused inputs and swallowing character key events while in fullscreen.
  function setupFullscreenTypingGuard() {
    const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
    const blurActive = () => {
      try {
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
          ae.blur();
        }
      } catch {}
    };
    const keyHandler = (e) => {
      if (!isFs()) return;
      const k = e.key || '';
      const isChar = k.length === 1 || k === 'Unidentified' || k === 'Spacebar' || k === ' ';
      if (isChar) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onFsChange = () => { if (isFs()) blurActive(); };
    document.addEventListener('keydown', keyHandler, { capture: true });
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
  }

  async function uploadOne(file, relPath) {
    // Ensure forward slashes in relPath
    relPath = (relPath || file.name).replace(/\\+/g, '/');
    const url = `/upload?p=${encodeURIComponent(relPath)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
        'X-File-Size': String(file.size || 0),
      },
      body: file,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => String(r.status));
      throw new Error(`Upload failed for ${relPath}: ${r.status} ${txt}`);
    }
    return r.json().catch(() => ({}));
  }

  async function collectDroppedFiles(dt) {
    // Prefer FileSystemEntry API for directories
    if (dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
      const entries = Array.from(dt.items).map((it) => it.webkitGetAsEntry()).filter(Boolean);
      const out = [];
      async function walkEntry(entry, prefix) {
        prefix = prefix || '';
        if (entry.isFile) {
          await new Promise((resolve, reject) => {
            entry.file((file) => {
              out.push({ file, relPath: prefix + file.name });
              resolve();
            }, reject);
          });
        } else if (entry.isDirectory) {
          const dirReader = entry.createReader();
          let batch = [];
          // readEntries may return in chunks; loop until empty
          do {
            batch = await new Promise((resolve, reject) => {
              dirReader.readEntries(resolve, reject);
            });
            for (const ent of batch) {
              await walkEntry(ent, prefix + entry.name + '/');
            }
          } while (batch.length > 0);
        }
      }
      for (const en of entries) {
        const base = en.isDirectory ? (en.name ? en.name + '/' : '') : '';
        await walkEntry(en, en.isDirectory ? '' : '');
        // Note: walkEntry already prefixes directory names as it descends
      }
      return out;
    }
    // Fallback: plain files list (no directory structure)
    const files = Array.from(dt.files || []);
    return files.map((file) => ({ file, relPath: file.webkitRelativePath || file.name }));
  }

  function extractLocalDropItems(dt) {
    try {
      const all = [];
      try {
        const u = dt.getData('text/uri-list');
        if (u) all.push(...u.split(/\r?\n/));
      } catch {}
      try {
        const t = dt.getData('text/plain');
        if (t) all.push(...t.split(/\r?\n/));
      } catch {}
      const uris = all
        .map(s => (s || '').trim())
        .filter(s => /^file:/i.test(s));
      if (!uris.length) return [];
      const items = uris.map((uri) => {
        // destRel defaults to the basename of the path
        const destRel = decodeURIComponent(uri.replace(/^file:\/\//i, ''))
          .replace(/\\+/g, '/').replace(/^\/+/, '')
          .split('/')
          .filter(Boolean)
          .slice(-1)[0] || '';
        return { src: uri, destRel };
      }).filter(it => it.destRel);
      return items;
    } catch (e) {
      return [];
    }
  }

  async function moveLocalItems(items) {
    const r = await fetch('/ingest_local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => String(r.status));
      throw new Error(`Move failed: ${r.status} ${txt}`);
    }
    return r.json().catch(() => ({}));
  }

  async function guessAndMoveFromDownloads(files) {
    try {
      if (!files || !files.length) return new Set();
      const payload = {
        items: files.map(({ file, relPath }) => ({
          name: file.name,
          size: file.size || 0,
          mtime: file.lastModified || 0,
          destRel: (relPath || file.name).replace(/\\+/g, '/'),
        })),
      };
      const r = await fetch('/ingest_from_downloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) return new Set();
      const data = await r.json().catch(() => ({}));
      const moved = new Set((data && data.moved ? data.moved : []).map(x => `${x.name}|${x.size||0}`));
      return moved;
    } catch (e) {
      return new Set();
    }
  }
})();
