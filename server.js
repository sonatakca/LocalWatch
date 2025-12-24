const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const os = require('os');
const { spawn } = require('child_process');
const console = require('console');
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
const FFMPEG_BIN = ffmpegPath || 'ffmpeg';

const app = express();
const PORT = process.env.PORT || 3000;
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'media');
const CACHE_DIR = path.join(VIDEO_DIR, '.cache'); // root cache for uncategorized files
const CACHE_VERSION = 4; // bump to invalidate old remux outputs (subtitle embedding)

const ALLOWED_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi']);
const THUMB_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUB_EXTS = new Set(['.vtt', '.srt', '.ass', '.ssa']);
const INCLUDE_MARKER = '.include';
const EXCLUDED_DIRS = new Set(['.cache', 'node_modules']);
// Simple in-memory metadata cache keyed by path+size+mtime
const metaCache = new Map();

// Track remux/transcode progress for UI polling
const remuxStatusActive = new Map(); // abs -> status object
const remuxStatusRecent = [];
const REMUX_RECENT_LIMIT = 8;
const REMUX_RECENT_TTL_MS = 2 * 60 * 1000;
const remuxLogLast = new Map(); // abs -> { ts, percent }

const tcol = {
  // Reset
  reset: "\x1b[0m",

  // --- Text Styles ---
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  blink: "\x1b[5m",
  reverse: "\x1b[7m",
  hidden: "\x1b[8m",
  strike: "\x1b[9m",

  // --- Foreground (Bright/High Contrast) ---
  pink: "\x1b[95m",     // Bright Magenta
  red: "\x1b[91m",      // Bright Red
  green: "\x1b[92m",    // Bright Green
  yellow: "\x1b[93m",   // Bright Yellow
  blue: "\x1b[94m",     // Bright Blue
  cyan: "\x1b[96m",     // Bright Cyan
  white: "\x1b[97m",    // Bright White
  gray: "\x1b[90m",     // Bright Black / Gray

  // --- Extended Colors (256-color palette) ---
  orange: "\x1b[38;5;208m", // Standard Xterm Orange
  purple: "\x1b[38;5;129m", // Deep Purple
  teal: "\x1b[38;5;37m",   // Darker Cyan
  gold: "\x1b[38;5;214m",   // Golden Yellow
  lime: "\x1b[38;5;118m",   // Electric Green
  brown: "\x1b[38;5;94m",   // Matches your SVG theme
  
  // --- Background Colors ---
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgWhite: "\x1b[47m",

  // --- Utility Functions ---
  // Create any RGB color (supports 16 million colors in modern terminals)
  rgb: (r, g, b) => `\x1b[38;2;${r};${g};${b}m`,
  bgRgb: (r, g, b) => `\x1b[48;2;${r};${g};${b}m`
};

function createGradient(text, start, end) {
  // Count only non-whitespace chars (so spaces don't consume gradient steps)
  const nonSpaceCount = [...text].filter(ch => !/\s/.test(ch)).length;

  // Edge cases: no characters / only spaces / only 1 colored char
  if (nonSpaceCount === 0) return text;
  if (nonSpaceCount === 1) {
    // color the single non-space char with start (or end; same effect)
    let done = false;
    let out = "";
    for (const ch of text) {
      if (!done && !/\s/.test(ch)) {
        out += `${tcol.rgb(start.r, start.g, start.b)}${ch}`;
        done = true;
      } else {
        out += ch;
      }
    }
    return out + tcol.reset;
  }

  const steps = nonSpaceCount - 1;
  let idx = 0; // gradient index over non-space chars
  let result = "";

  for (const ch of text) {
    if (/\s/.test(ch)) {
      // keep spaces uncolored (or keep previous color if you prefer)
      result += ch;
      continue;
    }

    const ratio = idx / steps;

    const r = Math.round(start.r + (end.r - start.r) * ratio);
    const g = Math.round(start.g + (end.g - start.g) * ratio);
    const b = Math.round(start.b + (end.b - start.b) * ratio);

    // Optional clamp if someone passes weird values
    const rc = Math.max(0, Math.min(255, r));
    const gc = Math.max(0, Math.min(255, g));
    const bc = Math.max(0, Math.min(255, b));

    result += `${tcol.rgb(rc, gc, bc)}${ch}`;
    idx++;
  }

  return result + tcol.reset;
}


function trimRemuxRecent() {
  const cutoff = Date.now() - REMUX_RECENT_TTL_MS;
  while (remuxStatusRecent.length && remuxStatusRecent[0].finishedAt && remuxStatusRecent[0].finishedAt < cutoff) {
    remuxStatusRecent.shift();
  }
  if (remuxStatusRecent.length > REMUX_RECENT_LIMIT) {
    remuxStatusRecent.splice(0, remuxStatusRecent.length - REMUX_RECENT_LIMIT);
  }
}

function upsertRemuxStatus(abs, patch) {
  const prev = remuxStatusActive.get(abs) || {};
  const next = { ...prev, ...patch };
  remuxStatusActive.set(abs, next);
  return next;
}

function finishRemuxStatus(abs, patch) {
  const prev = remuxStatusActive.get(abs) || {};
  const next = { ...prev, ...patch };
  if (!next.finishedAt) next.finishedAt = Date.now();
  remuxStatusActive.delete(abs);
  remuxStatusRecent.push(next);
  // Keep recent sorted oldest->newest for efficient trim
  remuxStatusRecent.sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  trimRemuxRecent();
  return next;
}

function secondsFromTimemark(tm) {
  if (!tm || typeof tm !== 'string') return null;
  const m = tm.trim().match(/^(\d+):([0-5]?\d):([0-5]?\d)(?:\.(\d+))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10) || 0;
  const min = parseInt(m[2], 10) || 0;
  const s = parseInt(m[3], 10) || 0;
  const ms = parseInt((m[4] || '0').slice(0, 3), 10) || 0;
  return h * 3600 + min * 60 + s + ms / 1000;
}

function ensureVideoDir() {
  if (!fs.existsSync(VIDEO_DIR)) {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
  }
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function isAllowed(file) {
  const ext = path.extname(file).toLowerCase();
  return ALLOWED_EXTS.has(ext);
}

function walk(dir, baseDir, includedFromAncestor = false) {
  const results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });

  // Determine if this directory itself is marked as included
  const hasMarker = list.some(
    (de) => de.isFile() && de.name.toLowerCase() === INCLUDE_MARKER
  );
  const includedHere = includedFromAncestor || hasMarker;

  for (const dirent of list) {
    const name = dirent.name;
    const full = path.join(dir, name);
    if (dirent.isDirectory()) {
      if (EXCLUDED_DIRS.has(name) || name === '.' || name === '..') continue;
      // Recurse into all directories so deeper included folders are found,
      // but only collect files if includedHere (or descendant marks itself).
      results.push(...walk(full, baseDir, includedHere));
    } else if (includedHere && dirent.isFile() && isAllowed(name)) {
      const rel = path.relative(baseDir, full);
      const stat = fs.statSync(full);
      const type = mime.lookup(full) || 'application/octet-stream';
      const parts = rel.split(path.sep);
      const category = parts.length > 1 ? parts[0] : 'Uncategorized';
      results.push({
        name: path.basename(full),
        relPath: rel.replace(/\\/g, '/'),
        size: stat.size,
        mtime: stat.mtimeMs,
        ext: path.extname(full).toLowerCase(),
        mime: type,
        category,
      });
    }
  }
  return results;
}

function resolveSafe(relativePath) {
  const resolved = path.resolve(VIDEO_DIR, relativePath);
  // Prevent path traversal
  if (!resolved.startsWith(path.resolve(VIDEO_DIR))) {
    return null;
  }
  return resolved;
}

ensureVideoDir();

// Development: inject LiveReload and watch static assets for instant refresh
// Enabled when dev dependencies (connect-livereload/livereload) are available
// and not explicitly disabled via LIVERELOAD=0.
try {
  if (process.env.LIVERELOAD !== '0') {
    const lrPort = Number(process.env.LIVERELOAD_PORT) || 35729;
    // Run the LiveReload server on all interfaces so LAN clients can connect
    const livereload = require('livereload');
    const lrStart = { r: 0, g: 180, b: 180 }; // DarkCyan
    const lrEnd = { r: 0, g: 255, b: 255 };   // Bright Cyan
    const lrText = createGradient("[LiveReload]", lrStart, lrEnd)
    const lrserver = livereload.createServer({
      host: '0.0.0.0',
      port: lrPort,
      exts: ['html', 'css', 'js'],
      delay: 100,
    });
    lrserver.watch([path.join(__dirname, 'public')]);
    console.log(`${lrText} ${tcol.green}[active]${tcol.reset} \n   ${tcol.yellow}0.0.0.0:${lrPort}, watching public/${tcol.reset}`);
  }
} catch (e) {
  // Dev dependencies not installed or some environments may not support this; ignore silently
}

// Optional Basic Auth for external exposure
// Set AUTH_USER and AUTH_PASS to enable. Applies to all routes and static.
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    try {
      const hdr = req.headers.authorization || '';
      if (!hdr.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="LocalWatch"');
        return res.status(401).end('Auth required');
      }
      const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      const u = i >= 0 ? decoded.slice(0, i) : decoded;
      const p = i >= 0 ? decoded.slice(i + 1) : '';
      if (u === AUTH_USER && p === AUTH_PASS) return next();
      res.setHeader('WWW-Authenticate', 'Basic realm="LocalWatch"');
      return res.status(401).end('Unauthorized');
    } catch {
      res.setHeader('WWW-Authenticate', 'Basic realm="LocalWatch"');
      return res.status(401).end('Auth error');
    }
  });
}

// Shared file helpers
function ensureParentDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// Resolve per-title cache directory: files in a top-level folder get a .cache inside that folder.
// Files directly under VIDEO_DIR use the root .cache.
function cacheDirFor(relPath) {
  try {
    const parts = (relPath || '').split(/[\\/]+/).filter(Boolean);
    if (parts.length > 1) {
      const top = parts[0];
      const dir = path.join(VIDEO_DIR, top, '.cache');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  } catch {}
  // Fallback to root cache for uncategorized
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

function copyFileSyncBuffered(src, dest) {
  ensureParentDir(dest);
  const BUF_SIZE = 64 * 1024;
  const buf = Buffer.allocUnsafe(BUF_SIZE);
  const srcFd = fs.openSync(src, 'r');
  const destFd = fs.openSync(dest, 'w');
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(srcFd, buf, 0, BUF_SIZE, null);
      if (bytesRead > 0) fs.writeSync(destFd, buf, 0, bytesRead);
    } while (bytesRead > 0);
  } finally {
    try { fs.closeSync(srcFd); } catch {}
    try { fs.closeSync(destFd); } catch {}
  }
}

function copyDirRecursive(srcDir, destDir) {
  const st = fs.statSync(srcDir);
  if (!st.isDirectory()) throw new Error('Source is not a directory');
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const de of entries) {
    const s = path.join(srcDir, de.name);
    const d = path.join(destDir, de.name);
    if (de.isDirectory()) copyDirRecursive(s, d);
    else if (de.isFile()) copyFileSyncBuffered(s, d);
    else if (de.isSymbolicLink()) {
      const target = fs.readlinkSync(s);
      fs.symlinkSync(target, d);
    }
  }
}

function movePathSync(src, dest) {
  // Fast path
  try {
    ensureParentDir(dest);
    fs.renameSync(src, dest);
    return true;
  } catch (e) {
    // Cross-device or locked; fallback to copy+delete
    if (e && e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'BUSY') {
      throw e;
    }
    const st = fs.statSync(src);
    ensureParentDir(dest);
    if (st.isDirectory()) {
      if (fs.existsSync(dest)) throw new Error('Destination exists');
      if (fs.cpSync) fs.cpSync(src, dest, { recursive: true });
      else copyDirRecursive(src, dest);
      fs.rmSync(src, { recursive: true, force: true });
      return true;
    } else {
      copyFileSyncBuffered(src, dest);
      const dstSt = fs.statSync(dest);
      if (dstSt.size !== st.size) {
        try { fs.unlinkSync(dest); } catch {}
        throw new Error('copy-verify-failed');
      }
      fs.unlinkSync(src);
      return true;
    }
  }
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------
// Background Preconversion
// ---------------------------
// Convert/remux videos into a seekable MP4 under .cache proactively, so
// playback never waits (except initial processing after files are added).

const PRECONVERT_ENABLED = (process.env.PRECONVERT !== '0');
const PRECONVERT_CONCURRENCY = Math.max(1, parseInt(process.env.PRECONVERT_CONCURRENCY || '1', 10) || 1);
const PRECONVERT_SCAN_INTERVAL_MS = Math.max(10_000, parseInt(process.env.PRECONVERT_SCAN_INTERVAL_MS || '60000', 10) || 60000);

const preconvertQueue = [];
const preconvertQueuedKeys = new Set(); // key: abs:size:mtime
let preconvertActive = 0;

function keyForStat(abs) {
  try { const st = fs.statSync(abs); return `${abs}:${st.size}:${st.mtimeMs}`; } catch { return null; }
}

// Natural episode ordering helpers for preconvert scan
function parseSeasonEpisodeToken(text) {
  if (!text) return null;
  const m = String(text).match(/S(\d{1,3})E(\d{1,3})/i);
  if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
  const m2 = String(text).match(/\bE(\d{1,4})\b/i); // bare E##
  if (m2) return { s: 0, e: parseInt(m2[1], 10) };
  return null;
}
function compareEpisodeNatural(a, b) {
  const ka = parseSeasonEpisodeToken(a.name) || parseSeasonEpisodeToken(a.relPath);
  const kb = parseSeasonEpisodeToken(b.name) || parseSeasonEpisodeToken(b.relPath);
  if (ka && kb) {
    if (ka.s !== kb.s) return ka.s - kb.s;
    if (ka.e !== kb.e) return ka.e - kb.e;
  } else if (ka && !kb) {
    return -1;
  } else if (!ka && kb) {
    return 1;
  }
  // Fallback: natural, case-insensitive path compare
  return a.relPath.localeCompare(b.relPath, undefined, { numeric: true, sensitivity: 'base' });
}

function enqueuePreconvert(abs, rel) {
  if (!PRECONVERT_ENABLED) return;
  try {
    const st = fs.statSync(abs);
    const { abs: outAbs } = cachePathFor(rel, st.size, st.mtimeMs);
    if (fs.existsSync(outAbs)) return; // already converted
    // Mark queued so UI can show progress immediately
    upsertRemuxStatus(outAbs, {
      id: outAbs,
      input: rel,
      output: path.relative(VIDEO_DIR, outAbs).replace(/\\/g, '/'),
      size: st.size,
      stage: 'queued',
      trigger: 'preconvert',
      queuedAt: Date.now(),
    });
    const key = `${abs}:${st.size}:${st.mtimeMs}`;
    if (preconvertQueuedKeys.has(key)) return;
    preconvertQueuedKeys.add(key);
    preconvertQueue.push({ abs, rel, key, queuedAt: Date.now() });
    process.nextTick(runPreconvertWorker);
  } catch {}
}

async function runPreconvertWorker() {
  if (!PRECONVERT_ENABLED) return;
  while (preconvertActive < PRECONVERT_CONCURRENCY && preconvertQueue.length) {
    const task = preconvertQueue.shift();
    if (!task) break;
    preconvertActive++;
    (async () => {
      try {
        const codecs = await probe(task.abs).catch(() => null);
        await ensureRemuxedMp4(task.abs, task.rel, codecs || {}, { trigger: 'preconvert', queuedAt: task.queuedAt });
      } catch (e) {
        try { console.error('Preconvert failed:', task.rel, e && e.message || e); } catch {}
      } finally {
        preconvertActive--;
        preconvertQueuedKeys.delete(task.key);
        if (preconvertQueue.length) setTimeout(runPreconvertWorker, 0);
      }
    })();
  }
}

function scanAndEnqueuePreconvert() {
  if (!PRECONVERT_ENABLED) return;
  try {
    const items = walk(VIDEO_DIR, VIDEO_DIR);
    const toQueue = items.filter((it) => {
      const ext = (it.ext || '').toLowerCase();
      return ext === '.mkv' || ext === '.avi' || ext === '.mov';
    }).sort(compareEpisodeNatural);
    for (const it of toQueue) {
      try { const abs = resolveSafe(it.relPath); if (abs) enqueuePreconvert(abs, it.relPath); } catch {}
    }
  } catch (e) { try { console.error('Preconvert scan error:', e && e.message || e); } catch {} }
}

function startPreconvertLoop() {
  if (!PRECONVERT_ENABLED) return;
  // Initial scan shortly after startup to avoid blocking boot
  setTimeout(scanAndEnqueuePreconvert, 2000);
  // Periodic rescan for new/changed files
  setInterval(scanAndEnqueuePreconvert, PRECONVERT_SCAN_INTERVAL_MS).unref();
}

startPreconvertLoop();

function getRemuxStatusSnapshot() {
  trimRemuxRecent();
  return {
    active: Array.from(remuxStatusActive.values()).map((s) => ({ ...s })),
    recent: remuxStatusRecent.slice().reverse(),
    queue: preconvertQueue.length,
    running: preconvertActive,
  };
}

// Lightweight status endpoint for UI polling
app.get('/api/convert_status', (req, res) => {
  try {
    res.json(getRemuxStatusSnapshot());
  } catch (e) {
    res.status(500).json({ error: 'status-failed' });
  }
});

// Accept raw uploads streamed to disk inside VIDEO_DIR.
// Usage: POST /upload?p=<relative/path/in/media>
// Body: file content (any type). Creates parent folders as needed.
app.post('/upload', (req, res) => {
  try {
    const rel = req.query.p;
    if (!rel || typeof rel !== 'string') {
      return res.status(400).send('Missing destination path');
    }
    // Normalize separators and strip leading slashes
    const safeRel = rel.replace(/\\+/g, '/').replace(/^\/+/, '');
    const dest = resolveSafe(safeRel);
    if (!dest) return res.status(400).send('Bad destination path');

    // Ensure parent exists
    const dir = path.dirname(dest);
    fs.mkdirSync(dir, { recursive: true });

    // Ensure top-level folder is marked included
    try {
      const top = safeRel.includes('/') ? safeRel.split('/')[0] : '';
      const markerDir = top ? path.join(VIDEO_DIR, top) : VIDEO_DIR;
      const markerPath = path.join(markerDir, INCLUDE_MARKER);
      if (!fs.existsSync(markerPath)) {
        fs.writeFileSync(markerPath, '', { flag: 'wx' });
      }
    } catch {}

    // Stream request body into the destination file
    const expectedSize = parseInt(req.headers['x-file-size'] || '0', 10) || 0;
    let received = 0;
    req.on('data', (chunk) => { received += chunk.length; });
    const out = fs.createWriteStream(dest);
    let finished = false;
    const done = (code, msg) => {
      if (finished) return;
      finished = true;
      try { out.destroy(); } catch {}
      if (code === 200) {
        try {
          const st = fs.statSync(dest);
          if (expectedSize && st.size !== expectedSize) {
            try { fs.unlinkSync(dest); } catch {}
            return res.status(400).json({ ok: false, error: 'size-mismatch' });
          }
        } catch (e) {
          return res.status(500).json({ ok: false, error: 'stat-failed' });
        }
        res.json({ ok: true, rel: safeRel, bytes: received });
        // Kick off background preconversion for remux-needed containers
        try {
          const ext = path.extname(safeRel).toLowerCase();
          if (ext === '.mkv' || ext === '.avi' || ext === '.mov') {
            enqueuePreconvert(dest, safeRel);
          }
        } catch {}
      } else {
        res.status(code).end(msg || 'Upload error');
      }
    };

    req.on('aborted', () => {
      try { out.destroy(); } catch {}
      try { fs.unlinkSync(dest); } catch {}
    });
    out.on('error', (err) => {
      console.error('Upload write error:', err);
      done(500, 'Write failed');
    });
    out.on('finish', () => done(200));

    req.pipe(out);
  } catch (e) {
    console.error('Upload exception:', e);
    res.status(500).end('Upload failed');
  }
});

// Move local files or directories into VIDEO_DIR.
// Usage: POST /ingest_local  with JSON: { items: [ { src: string, destRel?: string } ] }
// - src can be an absolute path (C:\\... or /path) or a file:// URI
// - destRel is the destination path relative to VIDEO_DIR (defaults to basename of src)
// Notes: This is intended for local-only use. It will attempt a fast rename and
//        falls back to copy+delete across devices when needed.
app.post('/ingest_local', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'No items' });

    function parseSrc(any) {
      if (!any || typeof any !== 'string') return null;
      try {
        if (/^file:/i.test(any)) {
          const u = new URL(any);
          if (u.protocol !== 'file:') return null;
          let p = u.pathname || '';
          // Decode percent-encoding
          p = decodeURIComponent(p);
          if (process.platform === 'win32') {
            // file:///C:/path -> C:\path
            if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
            p = p.replace(/\//g, '\\');
          }
          return p;
        }
      } catch {}
      return any;
    }

    function resolveDestRel(rel) {
      if (!rel || typeof rel !== 'string') return null;
      // Normalize separators, strip leading slashes and dots
      const safeRel = rel.replace(/\\+/g, '/').replace(/^\/+/, '').replace(/^\.\/+/, '');
      return safeRel;
    }

    function destAbsFor(rel) {
      const safe = resolveDestRel(rel);
      const abs = safe && resolveSafe(safe);
      return abs;
    }

    // use shared helpers: ensureParentDir, movePathSync, copy* above

    const moved = [];
    for (const it of items) {
      const srcAny = it && it.src;
      let src = parseSrc(srcAny);
      if (!src) throw new Error('Bad src');
      // Normalize src to absolute path
      if (!path.isAbsolute(src)) {
        // If relative, resolve from process cwd
        src = path.resolve(process.cwd(), src);
      }
      if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
      const st = fs.statSync(src);

      // Determine destination relative path
      let destRel = resolveDestRel(it && it.destRel);
      if (!destRel) {
        const base = path.basename(src);
        destRel = base;
      }
      const destAbs = destAbsFor(destRel);
      if (!destAbs) throw new Error('Bad destination');

      // Ensure destination does not escape VIDEO_DIR
      if (!destAbs.startsWith(path.resolve(VIDEO_DIR))) {
        throw new Error('Unsafe destination');
      }
      // If dest exists: allow overwrite for files, but avoid destructive
      // merges for directories (error out for directories).
      if (fs.existsSync(destAbs)) {
        const dstSt = fs.statSync(destAbs);
        const srcIsDir = st.isDirectory();
        const dstIsDir = dstSt.isDirectory();
        if (srcIsDir) {
          // Avoid deleting an existing directory tree implicitly
          throw new Error(`Destination exists: ${destRel}`);
        } else {
          if (dstIsDir) throw new Error(`Destination exists: ${destRel}`);
          try { fs.unlinkSync(destAbs); } catch (e) {}
        }
      }

      movePathSync(src, destAbs);
      moved.push({ src, destRel, isDir: st.isDirectory() });
      // Preconvert files (not directories) we just ingested
      try {
        if (!st.isDirectory()) {
          const ext = path.extname(destRel).toLowerCase();
          if (ext === '.mkv' || ext === '.avi' || ext === '.mov') {
            enqueuePreconvert(destAbs, destRel.replace(/\\+/g, '/'));
          }
        }
      } catch {}
    }

    return res.json({ ok: true, moved });
  } catch (e) {
    console.error('ingest_local error:', e);
    const msg = (e && e.message) || 'ingest_local failed';
    return res.status(400).json({ ok: false, error: msg });
  }
});

// Try to find dropped items inside the user's Downloads and move them.
// Usage: POST /ingest_from_downloads { items: [ { name, size, mtime?, destRel? } ] }
// Notes: Recursively searches Downloads (depth-limited) for a unique match by name+size
//        (mtime within tolerance if provided). Moves matching items into VIDEO_DIR.
app.post('/ingest_from_downloads', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const items = (req.body && Array.isArray(req.body.items)) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'No items' });

    const dlDir = getDownloadsDir();
    if (!dlDir || !fs.existsSync(dlDir)) return res.status(400).json({ ok: false, error: 'Downloads not found' });

    const moved = [];
    const unresolved = [];
    for (const it of items) {
      const name = it && it.name;
      const size = it && Number(it.size);
      const mtimeHint = it && Number(it.mtime);
      let destRel = (it && it.destRel) || name;
      if (!name || !size || !destRel) { unresolved.push({ name, reason: 'bad-item' }); continue; }
      const src = findInDownloads(dlDir, name, size, mtimeHint);
      if (!src) { unresolved.push({ name, reason: 'not-found' }); continue; }
      const destAbs = resolveSafe(destRel.replace(/\\+/g, '/'));
      if (!destAbs) { unresolved.push({ name, reason: 'bad-dest' }); continue; }
      // If destination exists, use same overwrite rule as ingest_local (files overwrite, dirs error)
      if (fs.existsSync(destAbs)) {
        const stSrc = fs.statSync(src);
        const stDst = fs.statSync(destAbs);
        if (stSrc.isDirectory()) { unresolved.push({ name, reason: 'dest-exists' }); continue; }
        if (stDst.isDirectory()) { unresolved.push({ name, reason: 'dest-exists' }); continue; }
        try { fs.unlinkSync(destAbs); } catch {}
      }
      movePathSync(src, destAbs);
      moved.push({ name, size, destRel, src });
      try {
        const ext = path.extname(destRel).toLowerCase();
        if (ext === '.mkv' || ext === '.avi' || ext === '.mov') {
          enqueuePreconvert(destAbs, destRel.replace(/\\+/g, '/'));
        }
      } catch {}
    }
    return res.json({ ok: true, moved, unresolved });
  } catch (e) {
    console.error('ingest_from_downloads error:', e);
    return res.status(500).json({ ok: false, error: 'ingest_from_downloads failed' });
  }


  function getDownloadsDir() {
    const home = process.env.USERPROFILE || process.env.HOME || require('os').homedir();
    if (!home) return null;
    const cand = path.join(home, 'Downloads');
    return cand;
  }

  function findInDownloads(base, name, size, mtime) {
    const maxDepth = 3;
    function walk(dir, depth) {
      if (depth > maxDepth) return null;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const de of entries) {
        const full = path.join(dir, de.name);
        if (de.isDirectory()) {
          const sub = walk(full, depth + 1);
          if (sub) return sub;
        } else if (de.isFile() && de.name === name) {
          try {
            const st = fs.statSync(full);
            if (Number(st.size) === Number(size)) {
              if (mtime) {
                const delta = Math.abs(Number(st.mtimeMs || 0) - Number(mtime));
                if (delta > 15000) continue; // 15s tolerance
              }
              return full;
            }
          } catch {}
        }
      }
      return null;
    }
    return walk(base, 0);
  }
});

app.get('/api/videos', async (req, res) => {
  try {
    const items = walk(VIDEO_DIR, VIDEO_DIR).sort((a, b) => b.mtime - a.mtime);

    // Enrich with duration using ffprobe (cached by path+size+mtime)
    await Promise.all(items.map(async (it) => {
      const abs = resolveSafe(it.relPath);
      if (!abs) return it;
      const key = `${abs}:${it.size}:${it.mtime}`;
      let meta = metaCache.get(key);
      if (!meta) {
        meta = await probe(abs);
        metaCache.set(key, meta || {});
      }
      if (meta && typeof meta.durationSec === 'number') {
        it.duration = Math.round(meta.durationSec);
      }
      return it;
    }));

    // Group by top-level folder as category
    const groupsMap = new Map();
    for (const it of items) {
      const key = it.category || 'Uncategorized';
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key).push(it);
    }
    const groups = Array.from(groupsMap.entries()).map(([name, its]) => ({
      key: name,
      name,
      count: its.length,
      items: its,
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      directory: path.resolve(VIDEO_DIR),
      count: items.length,
      items,
      groups,
    });
  } catch (e) {
    console.error('Error listing videos:', e);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

// Stream endpoint: /stream?p=<encodeURIComponent(relativePath)>
app.get('/stream', (req, res) => {
  const relPath = req.query.p;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).send('Missing video path');
  }

  const filePath = resolveSafe(relPath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = mime.lookup(filePath) || 'application/octet-stream';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) {
      return res.status(416).set({
        'Content-Range': `bytes */${fileSize}`,
      }).end();
    }

    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Probe codecs of a file
function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve(null); // be permissive
      try {
        const v = (data.streams || []).find(s => s.codec_type === 'video');
        const a = (data.streams || []).find(s => s.codec_type === 'audio');
        const durationSec = (data.format && (parseFloat(data.format.duration))) ||
          (v && (parseFloat(v.duration))) || null;
        resolve({
          videoCodec: v && (v.codec_name || v.codec_long_name),
          audioCodec: a && (a.codec_name || a.codec_long_name),
          audioChannels: a && (parseInt(a.channels, 10) || null),
          durationSec: typeof durationSec === 'number' && Number.isFinite(durationSec) ? durationSec : null,
          vStart: v && (parseFloat(v.start_time)) || 0,
          aStart: a && (parseFloat(a.start_time)) || 0,
        });
      } catch (e) { resolve(null); }
    });
  });
}

// Build a stable cache file path for a media item (depends on size+mtime)
function cachePathFor(relPath, size, mtime) {
  const base = path.basename(relPath, path.extname(relPath));
  const safeBase = base.replace(/[^a-z0-9-_\.]/gi, '_').slice(-60);
  const key = `v${CACHE_VERSION}:${relPath}:${size}:${mtime}`;
  const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 10);
  const fileName = `${safeBase}-${hash}.mp4`;
  const cacheDir = cacheDirFor(relPath);
  const abs = path.join(cacheDir, fileName);
  const rel = path.relative(VIDEO_DIR, abs).replace(/\\/g, '/');
  return { abs, rel };
}

const remuxInProgress = new Map(); // abs -> Promise

async function ensureRemuxedMp4(filePath, relPath, codecs, opts = {}) {
  const st = fs.statSync(filePath);
  const { abs, rel } = cachePathFor(relPath, st.size, st.mtimeMs);
  const baseStatus = {
    id: abs,
    input: relPath,
    output: rel,
    size: st.size,
    stage: 'queued',
    trigger: opts.trigger || 'on-demand',
    queuedAt: opts.queuedAt || Date.now(),
  };
  if (fs.existsSync(abs)) {
    finishRemuxStatus(abs, { ...baseStatus, stage: 'done', percent: 100 });
    return { abs, rel };
  }
  // If a conversion is already running, reuse its status and wait.
  if (remuxInProgress.has(abs)) {
    upsertRemuxStatus(abs, { ...baseStatus, stage: 'running' });
    await remuxInProgress.get(abs);
    return { abs, rel };
  }
  // Prefer to embed a text subtitle for iOS native players
  let subToEmbed = null;
  let subInputPath = null;
  let subLang = null;
  let subTitle = null;
  try {
    const subs = findSubsForVideo(filePath) || [];
    subToEmbed = subs.find(s => (s && s.lang === 'tr')) || subs[0] || null;
    if (subToEmbed && subToEmbed.file) {
      const cand = path.resolve(path.dirname(filePath), subToEmbed.file);
      if (fs.existsSync(cand)) {
        const prepared = prepareSubtitleUtf8(cand, relPath);
        subInputPath = (prepared && prepared.path) || cand;
      }
      subLang = (subToEmbed.lang || 'tr').toLowerCase();
      try { subTitle = subToEmbed.label || langLabel(subLang) || subLang.toUpperCase(); } catch { subTitle = subLang.toUpperCase(); }
      // Prefer localized label for Turkish
      if (subLang === 'tr') subTitle = 'Türkçe';
    }
  } catch {}

  const task = new Promise((resolve, reject) => {
    try {
      upsertRemuxStatus(abs, { ...baseStatus, stage: 'running', startedAt: Date.now(), percent: 0 });
      const vCodec = (codecs && (codecs.videoCodec || '')).toString().toLowerCase();
      const aCodec = (codecs && (codecs.audioCodec || '')).toString().toLowerCase();
      const aCh = (codecs && Number(codecs.audioChannels)) || 0;
      const canCopyVideo = vCodec.includes('h264') || vCodec.includes('avc') || vCodec.includes('hevc') || vCodec.includes('h265') || vCodec.includes('hvc1') || vCodec.includes('hev1');
      const canCopyAudio = aCodec.includes('aac') || aCodec.includes('mp3');
      // For remuxing to a seekable MP4, use a single input and let
      // ffmpeg/mp4 preserve intrinsic stream offsets via edit lists.
      // Using -itsoffset with dual inputs can double the delay, so
      // we avoid it here.
      const cmd = ffmpeg(filePath);
      cmd.inputOptions(['-err_detect', 'ignore_err']);

      // Add external subtitle as a second input, to be embedded into MP4
      if (subInputPath) {
        try {
          console.log('Embedding subtitle:', path.basename(subInputPath));
          cmd.input(subInputPath);
          const ext = path.extname(subInputPath).toLowerCase();
          const subInputOpts = ['-err_detect', 'ignore_err'];
          // Best-effort charset for SRT/ASS files containing non-ASCII
          if (ext === '.srt' || ext === '.ass' || ext === '.ssa') {
            subInputOpts.unshift('-sub_charenc', 'UTF-8');
          }
          cmd.inputOptions(subInputOpts);
        } catch {}
      }

      cmd.outputOptions([
          '-movflags', 'faststart',
        ])
        .format('mp4');

      if (canCopyVideo) {
        cmd.videoCodec('copy');
        if (vCodec.includes('hevc') || vCodec.includes('h265') || vCodec.includes('hvc1') || vCodec.includes('hev1')) {
          cmd.outputOptions(['-tag:v', 'hvc1']);
        }
      } else {
        cmd.videoCodec('libx264').outputOptions(['-preset', 'veryfast', '-crf', process.env.X264_CRF || '23']);
      }

      if (canCopyAudio) {
        cmd.audioCodec('copy');
      } else {
        // Transcode non-MP4-compatible audio (e.g., DTS/TrueHD/FLAC) to AAC.
        // Prefer 5.1 when the source has >=6 channels (browser-compatible).
        const preferSurround = process.env.AAC_SURROUND !== '0';
        const wantSurround = preferSurround && aCh >= 6;
        cmd.audioCodec('aac');
        if (wantSurround) {
          // Downmix to 5.1 for wide compatibility, with a higher bitrate.
          const br = process.env.AAC_6CH_BITRATE || '384k';
          cmd.audioChannels(6).audioBitrate(br);
        } else {
          const br = process.env.AAC_2CH_BITRATE || process.env.AAC_BITRATE || '192k';
          cmd.audioChannels(2).audioBitrate(br);
        }
      }

      // Explicitly map streams, including the (optional) external subtitle
      if (subInputPath) {
        cmd.outputOptions([
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-map', '1:s:0?',
          '-c:s', 'mov_text',
          // Add metadata so iOS shows a friendly label and language (ISO 639-2 for MP4)
          '-metadata:s:s:0', `language=${(function(l){
            try{
              const m={en:'eng',tr:'tur',es:'spa',fr:'fra',de:'deu',it:'ita',pt:'por',ru:'rus',ar:'ara',fa:'fas',zh:'zho',ja:'jpn',ko:'kor'};
              l=(l||'tr').toLowerCase();
              return m[l]||l;
            }catch{return 'tur';}
          })(subLang)}`,
          '-metadata:s:s:0', `title=${subTitle || 'Subtitle'}`,
          '-disposition:s:0', 'default',
        ]);
      } else {
        cmd.outputOptions([
          '-map', '0:v:0',
          '-map', '0:a:0?',
        ]);
      }

      cmd.on('progress', (prog) => {
        try {
          const duration = codecs && Number(codecs.durationSec);
          let percent = Number(prog.percent) || null;
          if ((!percent || !Number.isFinite(percent)) && duration && prog && prog.timemark) {
            const sec = secondsFromTimemark(prog.timemark);
            if (sec != null && duration > 0) percent = Math.min(99.5, (sec / duration) * 100);
          }
          upsertRemuxStatus(abs, {
            ...baseStatus,
            stage: 'running',
            percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
            timemark: prog && prog.timemark,
            speedKbps: prog && Number(prog.currentKbps),
            updatedAt: Date.now(),
          });
          // Throttle terminal logging to avoid noise
          const last = remuxLogLast.get(abs) || { ts: 0, percent: 0 };
          const now = Date.now();
          const pctRounded = Number.isFinite(percent) ? Math.floor(percent) : null;
          if ((pctRounded != null && pctRounded !== last.percent) || now - last.ts > 4000) {
            const name = path.basename(relPath || baseStatus.input || abs);
            const pctStr = pctRounded != null ? `${pctRounded}%` : (prog && prog.timemark ? prog.timemark : '...');
            console.log(`${tcol.blue}[convert]${tcol.reset} ${name}: ${pctStr}`);
            remuxLogLast.set(abs, { ts: now, percent: pctRounded });
          }
        } catch {}
      }).on('error', (err) => {
        remuxInProgress.delete(abs);
        try { fs.unlinkSync(abs); } catch {}
        finishRemuxStatus(abs, { ...baseStatus, stage: 'error', percent: null, error: err && err.message || err });
        reject(err);
      }).on('end', () => {
        remuxInProgress.delete(abs);
        finishRemuxStatus(abs, { ...baseStatus, stage: 'done', percent: 100 });
        try {
          const name = path.basename(relPath || baseStatus.input || abs);
          console.log(`${tcol.blue}[convert]${tcol.res} ${name} ${tcol.red}[done]${tcol.reset}`);
        } catch {}
        resolve();
      }).save(abs);
    } catch (e) {
      remuxInProgress.delete(abs);
      finishRemuxStatus(abs, { ...baseStatus, stage: 'error', percent: null, error: e && e.message || e });
      reject(e);
    }
  });
  remuxInProgress.set(abs, task);
  await task;
  return { abs, rel };
}

// Generate a seekable MP4 on disk (remuxed) and then stream via /stream
app.get('/remux', async (req, res) => {
  const relPath = req.query.p;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).send('Missing video path');
  }
  const filePath = resolveSafe(relPath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  try {
    const codecs = await probe(filePath);
    const { rel } = await ensureRemuxedMp4(filePath, relPath, codecs || {}, { trigger: 'on-demand' });
    return res.redirect(302, `/stream?p=${encodeURIComponent(rel)}`);
  } catch (e) {
    console.error('Remux failed:', e);
    return res.status(500).send('Remux failed');
  }
});

// Transcoding/remux endpoint for browser-incompatible formats
// Usage: /play?p=<relPath>
app.get('/play', async (req, res) => {
  const relPath = req.query.p;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).send('Missing video path');
  }
  const filePath = resolveSafe(relPath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  // If already mp4/webm, prefer native streaming
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4' || ext === '.webm') {
    return res.redirect(302, `/stream?p=${encodeURIComponent(relPath)}`);
  }

  const codecs = await probe(filePath);
  const videoCodec = (codecs && (codecs.videoCodec || '')).toString().toLowerCase();
  const audioCodec = (codecs && (codecs.audioCodec || '')).toString().toLowerCase();
  const audioChannels = (codecs && Number(codecs.audioChannels)) || 0;

  // Determine strategy
  // Prefer remuxing over transcoding to avoid heavy CPU use.
  // Many 4K MKVs are HEVC/H.265 which would otherwise trigger a
  // very expensive transcode. Allow copying HEVC/H.265 as well –
  // it will play on systems/browsers that support it (e.g. with
  // HEVC extensions or Safari). If the browser can't decode it,
  // the user can still force a transcode via query (?transcode=1).
  const canCopyVideo = (
    videoCodec.includes('h264') ||
    videoCodec.includes('avc') ||
    videoCodec.includes('hevc') ||
    videoCodec.includes('h265') ||
    videoCodec.includes('hvc1') ||
    videoCodec.includes('hev1')
  );
  const canCopyAudio = audioCodec.includes('aac') || audioCodec.includes('mp3');

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    // no Accept-Ranges when piping
  });

  const vStart = (codecs && Number(codecs.vStart)) || 0;
  const aStart = (codecs && Number(codecs.aStart)) || 0;
  const offset = aStart - vStart; // +ve means audio starts later

  let command;
  if (Math.abs(offset) > 0.0005) {
    // Use dual-input trick with itsoffset to preserve audio/video delay
    command = ffmpeg();
    if (offset > 0) {
      command = command.input(filePath).inputOptions(['-itsoffset', String(offset)])
        .input(filePath)
        .outputOptions(['-map', '1:v:0', '-map', '0:a:0']);
    } else {
      command = command.input(filePath).inputOptions(['-itsoffset', String(-offset)])
        .input(filePath)
        .outputOptions(['-map', '0:v:0', '-map', '1:a:0']);
    }
  } else {
    command = ffmpeg(filePath);
  }

  command
    .inputOptions(['-err_detect', 'ignore_err'])
    .outputOptions([
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-preset', 'veryfast',
    ])
    .format('mp4');

  // Allow client to force a transcode (useful when copying HEVC
  // fails to play in the current browser): /play?p=...&transcode=1
  const forceTranscode = req.query.transcode === '1' || req.query.transcode === 'true';

  if (canCopyVideo && !forceTranscode) {
    // Copy video stream as-is. If it's HEVC, tag as hvc1 for better
    // container compatibility.
    command.videoCodec('copy');
    if (videoCodec.includes('hevc') || videoCodec.includes('h265') || videoCodec.includes('hvc1') || videoCodec.includes('hev1')) {
      command.outputOptions(['-tag:v', 'hvc1']);
    }
  } else {
    // Fall back to H.264 software encode with a lighter preset to
    // avoid pegging the CPU too hard.
    // If a hardware encoder is available, FFmpeg may pick it when
    // mapped via environment or aliases; otherwise libx264 is used.
    command.videoCodec('libx264').outputOptions(['-crf', process.env.X264_CRF || '21', '-tune', 'fastdecode']);
    const maxHeight = parseInt(process.env.MAX_HEIGHT || '1080', 10);
    if (Number.isFinite(maxHeight)) {
      // Keep aspect ratio, cap height, and let width be even (-2)
      command.outputOptions(['-vf', `scale=-2:${maxHeight}:force_original_aspect_ratio=decrease`]);
    }
  }
  if (canCopyAudio && !forceTranscode) {
    command.audioCodec('copy');
  } else {
    const preferSurround = process.env.AAC_SURROUND !== '0';
    const wantSurround = preferSurround && audioChannels >= 6;
    command.audioCodec('aac');
    if (wantSurround) {
      const br = process.env.AAC_6CH_BITRATE || '384k';
      command.audioChannels(6).audioBitrate(br);
    } else {
      const br = process.env.AAC_2CH_BITRATE || process.env.AAC_BITRATE || '192k';
      command.audioChannels(2).audioBitrate(br);
    }
  }

  const stream = command.on('error', (err) => {
    console.error('FFmpeg error:', err && err.message || err);
    if (!res.headersSent) res.status(500).end('Transcode failed');
    try { res.end(); } catch {}
  }).pipe();

  stream.pipe(res);
});

// Thumbnail endpoint: tries sibling image (jpg/jpeg/png/webp) case-insensitively,
// then common folder fallbacks like fallback/cover/poster/folder.(jpg|jpeg|png|webp)
function findThumbForVideo(filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const baseLower = base.toLowerCase();
  const dir = path.dirname(filePath);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const de of entries) {
      if (!de.isFile()) continue;
      const deExt = path.extname(de.name).toLowerCase();
      if (!THUMB_EXTS.has(deExt)) continue;
      const nameNoExtLower = path.basename(de.name, path.extname(de.name)).toLowerCase();
      if (nameNoExtLower === baseLower) {
        return path.join(dir, de.name);
      }
    }
    // Folder-level fallback names
    const candidates = ['fallback', 'cover', 'poster', 'folder', 'thumbnail', 'thumb'];
    for (const de of entries) {
      if (!de.isFile()) continue;
      const deExt = path.extname(de.name).toLowerCase();
      if (!THUMB_EXTS.has(deExt)) continue;
      const nameNoExtLower = path.basename(de.name, path.extname(de.name)).toLowerCase();
      if (candidates.includes(nameNoExtLower)) {
        return path.join(dir, de.name);
      }
    }
  } catch {}

  // Fallbacks in same dir, media root, or public with common names and extensions
  const checkFallbacks = (baseDir) => {
    const names = ['fallback', 'cover', 'poster', 'folder', 'thumbnail', 'thumb'];
    for (const n of names) {
      for (const te of THUMB_EXTS) {
        const p = path.join(baseDir, `${n}${te}`);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  };
  const local = checkFallbacks(dir);
  if (local) return local;
  const root = checkFallbacks(VIDEO_DIR);
  if (root) return root;
  const pub = checkFallbacks(path.join(__dirname, 'public'));
  if (pub) return pub;
  return null;
}

// Subtitle helpers
function parseLangFromFilename(name) {
  const base = path.basename(name, path.extname(name));
  const m = base.match(/[\.\-_]([a-z]{2,3})(?:-[A-Za-z]{2})?$/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

function langLabel(code) {
  const map = {
    en: 'English',
    tr: 'Türkçe',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    ru: 'Russian',
    ar: 'Arabic',
    fa: 'Persian',
    zh: 'Chinese',
    ja: 'Japanese',
    ko: 'Korean',
  };
  return map[code] || code.toUpperCase();
}

const utf8DecoderFatal = new TextDecoder('utf-8', { fatal: true });
const SUB_ENCODING_CANDIDATES = ['windows-1254', 'iso-8859-9', 'windows-1252', 'iso-8859-1'];
function prepareSubtitleUtf8(subAbsPath, relPath) {
  try {
    const buf = fs.readFileSync(subAbsPath);
    try {
      utf8DecoderFatal.decode(buf);
      return { path: subAbsPath, encoding: 'utf-8', converted: false };
    } catch {}
    for (const enc of SUB_ENCODING_CANDIDATES) {
      try {
        const txt = new TextDecoder(enc, { fatal: true }).decode(buf);
        const cacheDir = path.join(cacheDirFor(relPath), 'subs');
        fs.mkdirSync(cacheDir, { recursive: true });
        const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
        const ext = path.extname(subAbsPath);
        const base = path.basename(subAbsPath, ext);
        const out = path.join(cacheDir, `${base}-${hash}.utf8${ext}`);
        fs.writeFileSync(out, txt, 'utf8');
        return { path: out, encoding: enc, converted: true };
      } catch {}
    }
  } catch (e) {
    try { console.error('subtitle prepare failed:', e && e.message || e); } catch {}
  }
  return { path: subAbsPath, encoding: null, converted: false };
}

function findSubsForVideo(filePath) {
  try {
    const dir = path.dirname(filePath);
    const videoBase = path.basename(filePath, path.extname(filePath));
    const tokenMatch = videoBase.match(/S(\d{1,3})E(\d{1,3})/i);
    const season = tokenMatch ? parseInt(tokenMatch[1], 10) : null;
    const episode = tokenMatch ? parseInt(tokenMatch[2], 10) : null;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const subs = [];
    for (const de of entries) {
      if (!de.isFile()) continue;
      const ext = path.extname(de.name).toLowerCase();
      if (!SUB_EXTS.has(ext)) continue;
      const nameLower = de.name.toLowerCase();
      const nameNoExtLower = path.basename(de.name, ext).toLowerCase();

      let matches = false;
      if (season != null && episode != null) {
        // Match SxxExx with optional zero-padding and ensure E1 doesn't match E10
        // Example: season=2, episode=1 matches s2e1, s02e01, s002e001, and variants with separators
        const reTight = new RegExp(`s0*${season}e0*${episode}(?!\\d)`, 'i');
        if (reTight.test(nameLower)) {
          matches = true;
        } else {
          // Allow a non-alnum separator between season and episode (e.g., s02.e01 or s02 e01)
          const reSep = new RegExp(`s0*${season}[^a-z0-9]?e0*${episode}(?!\\d)`, 'i');
          matches = reSep.test(nameLower);
        }
      } else {
        // Fallback for videos without SxxExx token: rely on basename inclusion
        matches = nameNoExtLower.includes(videoBase.toLowerCase());
      }

      if (matches) {
        const lang = parseLangFromFilename(de.name) || 'tr';
        subs.push({ file: de.name, lang, label: langLabel(lang) });
      }
    }
    // Sort by language for stable order (tr first)
    subs.sort((a, b) => (a.lang === 'tr' ? -1 : b.lang === 'tr' ? 1 : a.lang.localeCompare(b.lang)));
    return subs;
  } catch (e) {
    return [];
  }
}

app.get('/subs', (req, res) => {
  const relPath = req.query.p;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ tracks: [] });
  }
  const filePath = resolveSafe(relPath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ tracks: [] });
  }
  const subs = findSubsForVideo(filePath);
  const baseDir = path.dirname(filePath);
  const baseRelDir = path.relative(VIDEO_DIR, baseDir).replace(/\\/g, '/');
  const tracks = subs.map(s => ({
    lang: s.lang,
    label: s.label,
    url: `/sub?p=${encodeURIComponent(relPath)}&f=${encodeURIComponent(s.file)}`,
  }));
  res.json({ tracks });
});

// Skip-intro helpers
function parseHhMmSs(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m = s.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const hh = parseInt(m[1] || '0', 10) || 0;
  const mm = parseInt(m[2] || '0', 10) || 0;
  const ss = parseInt(m[3] || '0', 10) || 0;
  const ms = parseInt(m[4] || '0', 10) || 0;
  return hh * 3600 + mm * 60 + ss + (ms ? (ms / 1000) : 0);
}

function parseSkipIntroFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let start = null, end = null;
    raw.split(/\r?\n/).forEach((line) => {
      const ln = line.trim();
      if (!ln) return;
      // Accept formats like: s -> 00:03  or  start: 00:03  or s=00:03
      const m = ln.match(/^(s|start)\s*(?:->|:|=)?\s*([^#;]+)/i);
      const n = ln.match(/^(e|end)\s*(?:->|:|=)?\s*([^#;]+)/i);
      if (m) {
        const v = parseHhMmSs(m[2].trim());
        if (v != null) start = v;
      }
      if (n) {
        const v = parseHhMmSs(n[2].trim());
        if (v != null) end = v;
      }
    });
    if (start != null && end != null && end > start) {
      return { start, end };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function findSkipIntroForVideo(filePath) {
  try {
    let dir = path.dirname(filePath);
    const root = path.resolve(VIDEO_DIR);
    while (dir && dir.length >= root.length) {
      const cand = path.join(dir, '.skipintro');
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        const se = parseSkipIntroFile(cand);
        if (se) return se;
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

// Auto-detect skip-intro by matching a reference intro audio clip (e.g. thewire_season1_intro.mp3)
const AUTO_SKIP_AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg']);
const AUTO_SKIP_NAME_HINTS = ['intro', 'opening', 'theme'];
const AUTO_SKIP_FRAME_MS = Number(process.env.SKIPINTRO_FRAME_MS || 250); // analysis resolution
const AUTO_SKIP_MAX_SCAN_SEC = Number(process.env.SKIPINTRO_MAX_SCAN_SEC || 900); // scan first 15 min
const AUTO_SKIP_MIN_SCORE = Number(process.env.SKIPINTRO_MIN_SCORE || 0.50);
const DETECT_INTRO_FILENAME = '.detectIntro';
const SKIPINTRO_AUTOSCAN = process.env.SKIPINTRO_AUTOSCAN !== '0';
const SKIPINTRO_AUTOSCAN_FORCE = process.env.SKIPINTRO_AUTOSCAN_FORCE === '1';
const SKIPINTRO_AUTOSCAN_DELAY_MS = Number(process.env.SKIPINTRO_AUTOSCAN_DELAY_MS || 1500);

const autoSkipCacheMem = new Map(); // cachePath -> entries object
const introRefCache = new Map(); // abs ref path -> { frames, durationSec, frameSec }

function relKey(relPath) {
  return (relPath || '').replace(/\\/g, '/');
}

function skipIntroCachePath(relPath) {
  const dir = cacheDirFor(relPath || '');
  return path.join(dir, 'skipintro-auto.json');
}

function loadAutoSkipCache(relPath) {
  const p = skipIntroCachePath(relPath);
  if (autoSkipCacheMem.has(p)) return autoSkipCacheMem.get(p);
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      autoSkipCacheMem.set(p, raw);
      return raw;
    }
  } catch {}
  autoSkipCacheMem.set(p, {});
  return {};
}

function saveAutoSkipCache(relPath, data) {
  try {
    const p = skipIntroCachePath(relPath);
    ensureParentDir(p);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    autoSkipCacheMem.set(p, data);
  } catch (e) {
    console.error('Failed to persist auto skip-intro cache:', e && e.message ? e.message : e);
  }
}

function getCachedAutoSkipEntry(relPath) {
  const key = relKey(relPath);
  const cache = loadAutoSkipCache(relPath);
  return cache && cache[key] ? cache[key] : null;
}

function isValidSkipWindow(entry) {
  return !!(entry && typeof entry.start === 'number' && typeof entry.end === 'number' && entry.end > entry.start);
}

function getCachedAutoSkip(relPath) {
  const entry = getCachedAutoSkipEntry(relPath);
  if (!entry) return null;
  if (entry.status === 'failed' || entry.status === 'unreferenced') return null;
  return isValidSkipWindow(entry) ? entry : null;
}

function setCachedAutoSkipEntry(relPath, payload) {
  const key = relKey(relPath);
  const cache = loadAutoSkipCache(relPath);
  cache[key] = payload;
  saveAutoSkipCache(relPath, cache);
}

function parseDetectIntroFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const map = new Map(); // key: number|string 'x' -> filename
    raw.split(/\r?\n/).forEach((line) => {
      const ln = line.trim();
      if (!ln || ln.startsWith('#') || ln.startsWith('//')) return;
      const m = ln.match(/^S(\d{1,3}|x)\s*(?:->|:|=)\s*([^#;]+)/i);
      if (!m) return;
      const seasonToken = m[1].toLowerCase() === 'x' ? 'x' : parseInt(m[1], 10);
      const file = m[2].trim();
      if (!file) return;
      map.set(seasonToken, file);
    });
    if (!map.size) return null;
    return { baseDir: path.dirname(filePath), map, filePath };
  } catch (e) {
    return null;
  }
}

function parseSeasonFromName(filePath) {
  const rel = path.relative(VIDEO_DIR, filePath);
  const name = path.basename(filePath);
  const tok = parseSeasonEpisodeToken(rel) || parseSeasonEpisodeToken(name);
  if (tok && Number.isFinite(tok.s)) return tok.s;
  return null;
}

function findDetectIntroConfig(filePath) {
  try {
    let dir = path.dirname(filePath);
    const root = path.resolve(VIDEO_DIR);
    while (dir && dir.length >= root.length) {
      const cand = path.join(dir, DETECT_INTRO_FILENAME);
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        const cfg = parseDetectIntroFile(cand);
        if (cfg && cfg.map && cfg.map.size) return cfg;
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

function resolveIntroFromConfig(cfg, filePath) {
  if (!cfg || !cfg.map || !cfg.map.size) return { path: null, reason: 'no-config' };
  const season = parseSeasonFromName(filePath);
  const seasonKey = season != null ? season : null;
  const match = (seasonKey != null && cfg.map.get(seasonKey)) || cfg.map.get('x');
  if (!match) return { path: null, reason: 'no-mapping', source: 'detectIntro', configPath: cfg.filePath || null };
  const abs = path.resolve(cfg.baseDir, match);
  const ext = path.extname(abs).toLowerCase();
  if (!AUTO_SKIP_AUDIO_EXTS.has(ext)) {
    return { path: null, reason: 'invalid-ref-ext', source: 'detectIntro', ref: match, configPath: cfg.filePath || null };
  }
  if (!fs.existsSync(abs)) {
    return { path: null, reason: 'missing-ref', source: 'detectIntro', ref: match, configPath: cfg.filePath || null };
  }
  return { path: abs, name: path.basename(abs), source: 'detectIntro', ref: match, configPath: cfg.filePath || null };
}

function findIntroReferenceHeuristic(filePath) {
  try {
    const rel = path.relative(VIDEO_DIR, filePath);
    if (!rel || rel.startsWith('..')) return null;
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    if (!parts.length) return null;
    // Prefer a reference intro clip under the show root (top-level folder)
    const showRoot = path.join(VIDEO_DIR, parts[0]);
    const tryDirs = [showRoot, path.dirname(filePath)];
    let candidates = [];
    for (const dir of tryDirs) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const de of entries) {
          if (!de.isFile()) continue;
          const ext = path.extname(de.name).toLowerCase();
          if (!AUTO_SKIP_AUDIO_EXTS.has(ext)) continue;
          const lower = de.name.toLowerCase();
          if (!AUTO_SKIP_NAME_HINTS.some(h => lower.includes(h))) continue;
          const abs = path.join(dir, de.name);
          const st = fs.statSync(abs);
          candidates.push({
            abs,
            name: de.name,
            ext,
            size: st.size || 0,
            score: (lower.includes('intro') ? 2 : 0) + (lower.includes('wire') ? 1 : 0) + (ext === '.mp3' ? 0.2 : 0),
          });
        }
      } catch {}
      if (candidates.length) break; // prefer first directory with matches
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || b.size - a.size);
    return candidates[0].abs;
  } catch (e) {
    return null;
  }
}

function resolveIntroReference(filePath) {
  // 1) Prefer explicit mapping from .detectIntro (season-specific or default Sx)
  const cfg = findDetectIntroConfig(filePath);
  if (cfg) {
    return resolveIntroFromConfig(cfg, filePath);
  }
  // 2) Fallback to heuristic filename-based search (backwards compatible)
  const heuristic = findIntroReferenceHeuristic(filePath);
  if (heuristic) {
    return { path: heuristic, name: path.basename(heuristic), source: 'heuristic' };
  }
  return { path: null, reason: 'no-reference', source: 'heuristic' };
}

function pcm16FromBuffer(buf) {
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

function frameRmsSeries(buf, sampleRate, frameMs) {
  const frameSamples = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const pcm = pcm16FromBuffer(buf);
  const len = pcm.length;
  const frames = new Float32Array(Math.max(0, Math.floor(len / frameSamples)));
  let idx = 0;
  for (let i = 0; i + frameSamples <= len; i += frameSamples) {
    let sumSq = 0;
    for (let j = 0; j < frameSamples; j++) {
      const v = pcm[i + j];
      sumSq += v * v;
    }
    frames[idx++] = Math.sqrt(sumSq / frameSamples) || 0;
  }
  return frames.subarray(0, idx);
}

function smoothSeries(series, radius) {
  if (!series || !series.length || !radius) return series;
  const out = new Float32Array(series.length);
  for (let i = 0; i < series.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(series.length - 1, i + radius); j++) {
      sum += series[j];
      count++;
    }
    out[i] = count ? sum / count : series[i];
  }
  return out;
}

function bestCorrelation(refSeries, targetSeries) {
  if (!refSeries || !targetSeries || !refSeries.length || targetSeries.length < refSeries.length) {
    return null;
  }
  const n = refSeries.length;
  // Precompute ref mean/std
  let refSum = 0, refSumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = refSeries[i];
    refSum += v;
    refSumSq += v * v;
  }
  const refMean = refSum / n;
  const refVar = Math.max(1e-9, refSumSq / n - refMean * refMean);
  const refStd = Math.sqrt(refVar);

  const prefix = new Float64Array(targetSeries.length + 1);
  const prefixSq = new Float64Array(targetSeries.length + 1);
  for (let i = 0; i < targetSeries.length; i++) {
    const v = targetSeries[i];
    prefix[i + 1] = prefix[i] + v;
    prefixSq[i + 1] = prefixSq[i] + v * v;
  }

  let best = { score: -Infinity, offset: 0 };

  for (let off = 0; off <= targetSeries.length - n; off++) {
    const wSum = prefix[off + n] - prefix[off];
    const wSumSq = prefixSq[off + n] - prefixSq[off];
    const wMean = wSum / n;
    const wVar = Math.max(1e-9, wSumSq / n - wMean * wMean);
    const wStd = Math.sqrt(wVar);
    if (!Number.isFinite(wStd) || wStd <= 0) continue;
    let dot = 0;
    for (let i = 0; i < n; i++) {
      dot += (refSeries[i] - refMean) * (targetSeries[off + i] - wMean);
    }
    const denom = refStd * wStd * n;
    if (!denom || !Number.isFinite(denom)) continue;
    const score = dot / denom;
    if (score > best.score) best = { score, offset: off };
  }
  return { best };
}

function readPcmMono(filePath, opts = {}) {
  const sampleRate = opts.sampleRate || 8000;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (opts.startSec) {
    args.push('-ss', String(opts.startSec));
  }
  args.push('-i', filePath, '-vn', '-ac', '1', '-ar', String(sampleRate));
  if (opts.maxSec) {
    args.push('-t', String(opts.maxSec));
  }
  args.push('-f', 's16le', 'pipe:1');
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      child.stdout.on('data', (d) => chunks.push(d));
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}`));
        resolve(Buffer.concat(chunks));
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function loadIntroReference(refPath) {
  if (!refPath) return null;
  if (introRefCache.has(refPath)) return introRefCache.get(refPath);
  try {
    const sampleRate = 8000;
    const pcm = await readPcmMono(refPath, { sampleRate });
    if (!pcm || !pcm.length) return null;
    const frames = frameRmsSeries(pcm, sampleRate, AUTO_SKIP_FRAME_MS);
    const smooth = smoothSeries(frames, 1);
    const durationSec = (frames.length * AUTO_SKIP_FRAME_MS) / 1000;
    const ref = { frames: smooth, durationSec, frameSec: AUTO_SKIP_FRAME_MS / 1000 };
    introRefCache.set(refPath, ref);
    return ref;
  } catch (e) {
    console.error('Failed to load intro reference', refPath, e && e.message ? e.message : e);
    introRefCache.set(refPath, null);
    return null;
  }
}

function statSafe(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function entryMatchesStats(entry, srcStat, refStat, refName) {
  if (!entry || !srcStat) return false;
  if (entry.srcSize != null && entry.srcSize !== srcStat.size) return false;
  if (entry.srcMtime != null && entry.srcMtime !== srcStat.mtimeMs) return false;
  if (refStat) {
    if (refName && entry.ref && entry.ref !== refName) return false;
    if (entry.refSize != null && entry.refSize !== refStat.size) return false;
    if (entry.refMtime != null && entry.refMtime !== refStat.mtimeMs) return false;
  }
  return true;
}

async function autoDetectSkipIntro(filePath, relPath, opts = {}) {
  try {
    const force = !!opts.force;
    const srcStat = statSafe(filePath);
    const cachedEntry = getCachedAutoSkipEntry(relPath);
    const refInfo = resolveIntroReference(filePath);
    const refPath = refInfo && refInfo.path;
    const refName = refInfo && (refInfo.name || (refInfo.ref && path.basename(refInfo.ref))) || null;
    const refStat = refPath ? statSafe(refPath) : null;

    const cachedOk = getCachedAutoSkip(relPath);
    if (!force && cachedOk && entryMatchesStats(cachedOk, srcStat, refStat, refName)) {
      return cachedOk;
    }

    if (!refPath) {
      const payload = {
        status: 'unreferenced',
        ref: 'unreferenced',
        reason: (refInfo && refInfo.reason) || 'unreferenced',
        refSource: (refInfo && refInfo.source) || null,
        updatedAt: Date.now(),
        srcSize: srcStat ? srcStat.size : null,
        srcMtime: srcStat ? srcStat.mtimeMs : null,
      };
      if (!force && cachedEntry && cachedEntry.status === 'unreferenced' && entryMatchesStats(cachedEntry, srcStat, null, null)) {
        return null;
      }
      setCachedAutoSkipEntry(relPath, payload);
      return null;
    }

    if (!force && cachedEntry && cachedEntry.status === 'failed' && entryMatchesStats(cachedEntry, srcStat, refStat, refName)) {
      return null;
    }

    const ref = await loadIntroReference(refPath);
    if (!ref || !ref.frames || !ref.frames.length) {
      setCachedAutoSkipEntry(relPath, {
        status: 'failed',
        ref: refName || path.basename(refPath),
        reason: 'ref-load-failed',
        refSource: (refInfo && refInfo.source) || null,
        updatedAt: Date.now(),
        srcSize: srcStat ? srcStat.size : null,
        srcMtime: srcStat ? srcStat.mtimeMs : null,
        refSize: refStat ? refStat.size : null,
        refMtime: refStat ? refStat.mtimeMs : null,
      });
      return null;
    }
    const st = fs.statSync(filePath);
    let durationSec = null;
    try {
      const key = `${filePath}:${st.size}:${st.mtimeMs}`;
      let meta = metaCache.get(key);
      if (!meta) { meta = await probe(filePath); metaCache.set(key, meta || {}); }
      if (meta && typeof meta.durationSec === 'number') durationSec = meta.durationSec;
    } catch {}
    const maxScan = Math.min(AUTO_SKIP_MAX_SCAN_SEC, durationSec ? Math.ceil(durationSec) : AUTO_SKIP_MAX_SCAN_SEC);
    const pcm = await readPcmMono(filePath, { sampleRate: 8000, maxSec: maxScan });
    if (!pcm || !pcm.length) return null;
    let series = frameRmsSeries(pcm, 8000, AUTO_SKIP_FRAME_MS);
    series = smoothSeries(series, 1);
    const corr = bestCorrelation(ref.frames, series);
    if (!corr || !corr.best || !Number.isFinite(corr.best.score)) return null;
    const { best } = corr;
    if (best.score < AUTO_SKIP_MIN_SCORE) {
      const startSec = Math.max(0, best.offset * (AUTO_SKIP_FRAME_MS / 1000));
      setCachedAutoSkipEntry(relPath, {
        status: 'failed',
        ref: refName || path.basename(refPath),
        score: best.score,
        at: startSec,
        reason: 'low-confidence',
        refSource: (refInfo && refInfo.source) || null,
        updatedAt: Date.now(),
        srcSize: srcStat ? srcStat.size : null,
        srcMtime: srcStat ? srcStat.mtimeMs : null,
        refSize: refStat ? refStat.size : null,
        refMtime: refStat ? refStat.mtimeMs : null,
      });
      return null;
    }
    const startSec = Math.max(0, best.offset * (AUTO_SKIP_FRAME_MS / 1000));
    let endSec = startSec + ref.durationSec;
    if (durationSec && endSec > durationSec) endSec = durationSec;
    const result = {
      status: 'ok',
      start: startSec,
      end: endSec,
      score: best.score,
      ref: refName || path.basename(refPath),
      refSource: (refInfo && refInfo.source) || null,
      updatedAt: Date.now(),
      srcSize: srcStat ? srcStat.size : null,
      srcMtime: srcStat ? srcStat.mtimeMs : null,
      refSize: refStat ? refStat.size : null,
      refMtime: refStat ? refStat.mtimeMs : null,
    };
    setCachedAutoSkipEntry(relPath, result);
    return result;
  } catch (e) {
    console.error('Auto skip-intro detect failed for', relPath, e && e.message ? e.message : e);
    return null;
  }
}

async function runSkipIntroAutoScan() {
  if (!SKIPINTRO_AUTOSCAN) return;
  let items = [];
  try { items = walk(VIDEO_DIR, VIDEO_DIR); } catch {}
  if (!items || !items.length) return;
  items.sort(compareEpisodeNatural);
  console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.pink}[auto-scan start] [${items.length} items to scan]${tcol.reset}`);
  const total = items.length;
  let scanned = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const abs = resolveSafe(it.relPath);
    if (!abs || !fs.existsSync(abs)) continue;
    // Skip if cache already matches current file + reference (unless force)
    const srcStat = statSafe(abs);
    const refInfo = resolveIntroReference(abs);
    const refPath = refInfo && refInfo.path;
    const refName = refInfo && (refInfo.name || (refInfo.ref && path.basename(refInfo.ref))) || null;
    const refStat = refPath ? statSafe(refPath) : null;
    const cachedEntry = getCachedAutoSkipEntry(it.relPath);
    if (!SKIPINTRO_AUTOSCAN_FORCE && cachedEntry && entryMatchesStats(cachedEntry, srcStat, refStat, refName)) {
      continue;
    }
    scanned += 1;
    console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.cyan}[scan ${scanned}]${tcol.reset} ${tcol.bgRed}${it.relPath}${tcol.reset}`);
    try {
      await autoDetectSkipIntro(abs, it.relPath, { force: SKIPINTRO_AUTOSCAN_FORCE });
    } catch (e) {
      console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.pink}${tcol.pink}[result ${scanned}]${tcol.reset} error`);
      continue;
    }
    const entry = getCachedAutoSkipEntry(it.relPath);
    if (!entry) {
      console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.pink}[result ${scanned}]${tcol.reset} none`);
    } else if (entry.status === 'failed') {
      const scoreStr = (typeof entry.score === 'number') ? ` score=${entry.score.toFixed(3)}` : '';
      const gapStr = (typeof entry.gap === 'number') ? ` gap=${entry.gap.toFixed(3)}` : '';
      const atStr = (typeof entry.at === 'number') ? ` at=${entry.at.toFixed(2)}s` : '';
      const refStr = entry.ref ? ` ref=${entry.ref}` : '';
      const reasonStr = entry.reason ? ` reason=${entry.reason}` : '';
      console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.pink}[result ${scanned}]${tcol.reset} ${tcol.orange}failed${scoreStr}${gapStr}${atStr}${refStr}${reasonStr}${tcol.reset}`);
    } else if (entry.status === 'unreferenced') {
      const reasonStr = entry.reason ? ` reason=${entry.reason}` : '';
      console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.pink}[result ${scanned}]${tcol.reset} unreferenced${reasonStr}`);
    } else if (isValidSkipWindow(entry)) {
      const scoreStr = (typeof entry.score === 'number') ? ` score=${entry.score.toFixed(3)}` : '';
      console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.pink}[result ${scanned}]${tcol.reset} ${tcol.green}ok ${entry.start.toFixed(2)}s-${entry.end.toFixed(2)}s${scoreStr}${tcol.reset}`);
    } else {
      const status = entry.status || 'unknown';
      console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.pink}[result ${scanned}]${tcol.reset} ${status}`);
    }
  }
  console.log(`${tcol.blue}[skipintro]${tcol.reset} ${tcol.pink}[auto-scan  done] [${scanned}/${total} is scanned]${tcol.reset}`);
}

// Return skip-intro window for a given video
// GET /skipintro?p=<relative video path>
app.get('/skipintro', async (req, res) => {
  const relPath = req.query.p;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({});
  }
  const filePath = resolveSafe(relPath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({});
  }
  // 1) Manual .skipintro file in the folder tree
  let se = findSkipIntroForVideo(filePath);
  // 2) Auto-detect using intro reference audio (cached)
  if (!se) {
    se = await autoDetectSkipIntro(filePath, relPath).catch(() => null);
  }
  if (!se) return res.json({});
  return res.json({ start: se.start, end: se.end });
});

// Next-episode helpers
function parseSignedTime(str) {
  if (!str) return null;
  const s = String(str).trim();
  const sign = s.startsWith('-') ? -1 : 1;
  const raw = s.replace(/^[-+]/, '');
  // Support mm:ss or hh:mm:ss (optionally with .ms)
  const sec = parseHhMmSs(raw);
  if (sec == null) return null;
  return sign * sec;
}

function parseNextEpisodeFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let offset = null; // seconds; negative => from end; positive => from start
    raw.split(/\r?\n/).forEach((line) => {
      const ln = line.trim();
      if (!ln || ln.startsWith('#') || ln.startsWith('//')) return;
      // Accept formats like: o -> -01:05  or  outro: -00:45  or next=47:00
      // Order longer tokens first so "outro" doesn't get truncated to leading "o"
      const m = ln.match(/^(outro|nextepisode|next|o)\s*(?:->|:|=)?\s*([^#;]+)/i);
      if (m) {
        const v = parseSignedTime(m[2].trim());
        if (v != null) offset = v;
      }
    });
    if (offset == null) return null;
    return { offset };
  } catch (e) {
    return null;
  }
}

function findNextEpisodeForVideo(filePath) {
  try {
    let dir = path.dirname(filePath);
    const root = path.resolve(VIDEO_DIR);
    while (dir && dir.length >= root.length) {
      const cand = path.join(dir, '.nextepisode');
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        const ne = parseNextEpisodeFile(cand);
        if (ne) return ne;
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

// Return next-episode trigger time for a given video
// GET /nextepisode?p=<relative video path>
// Response: { at: <seconds-from-start> }
app.get('/nextepisode', async (req, res) => {
  const relPath = req.query.p;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({});
  }
  const filePath = resolveSafe(relPath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({});
  }
  const data = findNextEpisodeForVideo(filePath);
  if (!data || typeof data.offset !== 'number' || !Number.isFinite(data.offset)) {
    return res.json({});
  }
  // Compute absolute time.
  let duration = null;
  try {
    const st = fs.statSync(filePath);
    const key = `${filePath}:${st.size}:${st.mtimeMs}`;
    let meta = metaCache.get(key);
    if (!meta) {
      meta = await probe(filePath);
      metaCache.set(key, meta || {});
    }
    if (meta && typeof meta.durationSec === 'number') duration = meta.durationSec;
  } catch {}
  // If no duration available, return a relative offset indicator
  if (duration == null) {
    // When duration is unknown, only emit offset so client can decide
    return res.json({ offset: data.offset });
  }
  let at = null;
  if (data.offset < 0) at = Math.max(0, duration + data.offset);
  else at = Math.max(0, Math.min(duration, data.offset));
  return res.json({ at });
});

function shiftWebVtt(content, offsetMs) {
  if (!offsetMs) return content;
  const add = (ms) => {
    if (!ms && ms !== 0) return '00:00:00.000';
    let t = Math.max(0, ms);
    const h = Math.floor(t / 3600000); t -= h * 3600000;
    const m = Math.floor(t / 60000); t -= m * 60000;
    const s = Math.floor(t / 1000); t -= s * 1000;
    const pad = (n, w=2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}.${String(t).padStart(3, '0')}`;
  };
  const toMs = (str) => {
    const m = str.match(/(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})/);
    if (!m) return 0;
    const h = parseInt(m[1] || '0', 10);
    const mm = parseInt(m[2], 10);
    const ss = parseInt(m[3], 10);
    const ms = parseInt(m[4], 10);
    return ((h*60 + mm)*60 + ss)*1000 + ms;
  };
  return content.replace(/^(\d{2,}:)?\d{2}:\d{2}\.\d{3} --> (\d{2,}:)?\d{2}:\d{2}\.\d{3}.*$/gm, (line) => {
    const parts = line.split(' --> ');
    const left = parts[0];
    const rightAndRest = parts[1];
    let right = rightAndRest;
    let rest = '';
    const sp = rightAndRest.split(/\s+/);
    if (sp.length > 1) {
      right = sp[0];
      rest = ' ' + sp.slice(1).join(' ');
    }
    const startMs = toMs(left) + offsetMs;
    const endMs = toMs(right) + offsetMs;
    return `${add(startMs)} --> ${add(endMs)}${rest}`;
  });
}

// Serve subtitles as WebVTT via a friendly URL under /subs/<relative-path>
// Example: /subs/Show/Season 4/S4E1.tr.vtt?offset_ms=100
// - If the path resolves to a .vtt file, it is served directly (optionally time-shifted).
// - If the path resolves to .srt/.ass/.ssa, it is converted to WebVTT on the fly.
// Use a RegExp route to capture everything after /subs/
app.get(/^\/subs\/(.+)$/, (req, res) => {
  try {
    const relAny = (req.params && (req.params[0] || '')) || '';
    if (!relAny || typeof relAny !== 'string') return res.status(400).end('bad path');
    const rel = relAny.replace(/\\+/g, '/').replace(/^\/+/, '');
    let abs = resolveSafe(rel);
    if (!abs) return res.status(404).end('not found');
    let ext = path.extname(abs).toLowerCase();
    let exists = fs.existsSync(abs);
    // If requesting .vtt that doesn't exist, try common subtitle extensions and convert
    if (!exists && ext === '.vtt') {
      const baseNoExt = abs.slice(0, -4);
      const tryExts = ['.srt', '.ass', '.ssa'];
      for (const te of tryExts) {
        const cand = baseNoExt + te;
        if (fs.existsSync(cand)) { abs = cand; ext = te; exists = true; break; }
      }
    }
    if (!exists) return res.status(404).end('not found');
    const offsetMs = parseInt(req.query.offset_ms || '0', 10) || 0;
    res.setHeader('Cache-Control', 'no-store');

    if (ext === '.vtt') {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      if (!offsetMs) return fs.createReadStream(abs).pipe(res);
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        const out = shiftWebVtt(raw, offsetMs);
        return res.end(out);
      } catch (e) {
        console.error('VTT read/shift failed:', e && e.message || e);
        return fs.createReadStream(abs).pipe(res);
      }
    }

    if (!SUB_EXTS.has(ext)) return res.status(404).end('unsupported');
    // Convert to WebVTT on the fly from srt/ass/ssa
    try {
      const prepared = prepareSubtitleUtf8(abs, rel);
      const subPath = (prepared && prepared.path) || abs;
      const usedExt = path.extname(subPath).toLowerCase();
      const args = [];
      if (offsetMs) args.push('-itsoffset', String(offsetMs / 1000));
      if (usedExt === '.srt' || usedExt === '.ass' || usedExt === '.ssa') args.push('-sub_charenc', 'UTF-8');
      const stream = ffmpeg()
        .input(subPath)
        .inputOptions(args)
        .outputOptions([])
        .format('webvtt')
        .on('error', (err) => {
          console.error('Subtitle convert error (/subs):', err && err.message || err);
          try { res.status(500).end('subtitle convert failed'); } catch {}
        })
        .pipe();
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      stream.pipe(res);
    } catch (e) {
      console.error('Subtitle convert exception (/subs):', e);
      res.status(500).end('subtitle convert failed');
    }
  } catch (e) {
    console.error('subs route failed:', e);
    res.status(500).end('error');
  }
});

app.get('/sub', (req, res) => {
  const relPath = req.query.p;
  const fileName = req.query.f;
  const offsetMs = parseInt(req.query.offset_ms || '0', 10) || 0;
  if (!relPath || typeof relPath !== 'string' || !fileName || typeof fileName !== 'string') {
    return res.status(400).send('Missing parameters');
  }
  const videoPath = resolveSafe(relPath);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(404).send('Video not found');
  }
  const dir = path.dirname(videoPath);
  const subPath = path.resolve(dir, fileName);
  if (!subPath.startsWith(path.resolve(dir))) return res.status(400).end();
  const ext = path.extname(subPath).toLowerCase();
  if (!SUB_EXTS.has(ext) || !fs.existsSync(subPath)) return res.status(404).end();

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');

  if (ext === '.vtt') {
    if (!offsetMs) {
      return fs.createReadStream(subPath).pipe(res);
    }
    try {
      const raw = fs.readFileSync(subPath, 'utf8');
      const out = shiftWebVtt(raw, offsetMs);
      return res.end(out);
    } catch (e) {
      console.error('VTT shift error:', e);
      return fs.createReadStream(subPath).pipe(res);
    }
  }
  // Convert to WebVTT on the fly
  try {
    const prepared = prepareSubtitleUtf8(subPath, relPath);
    const subInputPath = (prepared && prepared.path) || subPath;
    const usedExt = path.extname(subInputPath).toLowerCase();
    const inputOpts = [];
    if (offsetMs) inputOpts.push('-itsoffset', String(offsetMs/1000));
    if (usedExt === '.srt' || usedExt === '.ass' || usedExt === '.ssa') inputOpts.push('-sub_charenc', 'UTF-8');
    const stream = ffmpeg()
      .input(subInputPath)
      .inputOptions(inputOpts)
      .outputOptions([])
      .format('webvtt')
      .on('error', (err) => {
        console.error('Subtitle convert error:', err && err.message || err);
        try { res.status(500).end('subtitle convert failed'); } catch {}
      })
      .pipe();
    stream.pipe(res);
  } catch (e) {
    console.error('Subtitle convert exception:', e);
    res.status(500).end('subtitle convert failed');
  }
});

app.get('/thumb', (req, res) => {
  const relPath = req.query.p;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).send('Missing video path');
  }
  const videoPath = resolveSafe(relPath);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(404).send('File not found');
  }
  const thumb = findThumbForVideo(videoPath);
  if (!thumb) return res.status(404).end();
  const type = mime.lookup(thumb) || 'image/png';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', type);
  fs.createReadStream(thumb).pipe(res);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Persist per-device playback progress
// Body: { deviceId: string, rel: string, t: number, started?: boolean }
app.post('/progress', express.json({ limit: '256kb' }), (req, res) => {
  try {
    const body = req.body || {};
    let deviceId = body.deviceId;
    const rel = body.rel;
    let t = Number(body.t);
    const started = !!body.started;
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ ok: false, error: 'bad-deviceId' });
    if (!rel || typeof rel !== 'string') return res.status(400).json({ ok: false, error: 'bad-rel' });
    if (!Number.isFinite(t) || t < 0) t = 0;

    // Sanitize deviceId to a safe file name
    deviceId = deviceId.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'device';
    const dir = path.join(VIDEO_DIR, 'connectedDevicesHistory');
    const file = path.join(dir, deviceId + '.json');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    const payload = { rel, t: Math.floor(t), started: !!started };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return res.json({ ok: true });
  } catch (e) {
    console.error('progress save failed:', e && e.message || e);
    return res.status(500).json({ ok: false });
  }
});

// Determine the most advanced progress across devices
// Comparison order: season, then episode, then time (seconds)
app.get('/progress/leader', (req, res) => {
  try {
    const dir = path.join(VIDEO_DIR, 'connectedDevicesHistory');
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    const records = [];
    for (const de of entries) {
      try {
        if (!de.isFile()) continue;
        if (!/\.json$/i.test(de.name)) continue;
        const abs = path.join(dir, de.name);
        const raw = fs.readFileSync(abs, 'utf8');
        const j = JSON.parse(raw);
        const rel = j && j.rel;
        const t = Number(j && j.t);
        if (!rel || !Number.isFinite(t)) continue;
        const deviceId = de.name.replace(/\.json$/i, '');
        const stat = fs.statSync(abs);
        const mtime = Number(stat.mtimeMs || 0);
        const tok = parseSeasonEpisodeToken(rel) || { s: 0, e: 0 };
        records.push({ deviceId, rel, t: Math.max(0, Math.floor(t)), started: !!(j && j.started), s: tok.s, e: tok.e, mtime });
      } catch {}
    }

    if (!records.length) return res.json({ ok: true, leader: null, count: 0 });

    records.sort((a, b) => {
      if (a.s !== b.s) return b.s - a.s; // higher season first
      if (a.e !== b.e) return b.e - a.e; // higher episode first
      if (a.t !== b.t) return b.t - a.t; // higher time first
      // as a last tie-breaker, latest modification time wins
      if (a.mtime !== b.mtime) return b.mtime - a.mtime;
      // finally, stable by deviceId
      return String(a.deviceId).localeCompare(String(b.deviceId));
    });

    const top = records[0];
    return res.json({ ok: true, leader: { deviceId: top.deviceId, rel: top.rel, t: top.t, started: top.started }, count: records.length });
  } catch (e) {
    console.error('leader calc failed:', e && e.message || e);
    return res.status(500).json({ ok: false });
  }
});
const lwStart = { r: 217, g: 119, b: 6 };
const lwEnd = { r: 251, g: 191, b: 36 };
const prefSpace = '    '
const logo = createGradient("LocalWatch", lwStart, lwEnd);
const runAddr1 = createGradient(`http://localhost:${PORT}`, lwStart, lwEnd);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`╔${"═".repeat(42)}╗`)
  console.log(`║${" ".repeat(42)}║`)
  console.log(`║${" ".repeat(16)}${tcol.bold}${logo}${tcol.reset}${" ".repeat(16)}║\n║${" ".repeat(10)}${runAddr1}${" ".repeat(11)}║`);
  


  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        const runAddr2 = createGradient(`http://${net.address}:${PORT}`, lwStart, lwEnd);
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`║${" ".repeat(8)}${runAddr2}${prefSpace.repeat(2)}║`);
          console.log(`║${" ".repeat(42)}║`)
          console.log(`╚${"═".repeat(42)}╝`)
          break; // Show first non-internal IPv4 address
        }
      }
    }
  } catch (e) {
    console.error('Could not determine local network address.', e);
  }

  console.log(`${tcol.yellow}Drop videos in media\n   "${path.resolve(VIDEO_DIR)}"`);

  if (SKIPINTRO_AUTOSCAN) {
    setTimeout(() => { runSkipIntroAutoScan().catch(() => {}); }, Math.max(0, SKIPINTRO_AUTOSCAN_DELAY_MS));
  }
});
