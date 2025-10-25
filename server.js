const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'media');
const CACHE_DIR = path.join(VIDEO_DIR, '.cache');
const CACHE_VERSION = 2; // bump to invalidate old remux outputs

const ALLOWED_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi']);
const THUMB_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUB_EXTS = new Set(['.vtt', '.srt', '.ass', '.ssa']);
const INCLUDE_MARKER = '.include';
const EXCLUDED_DIRS = new Set(['.cache', 'node_modules']);
// Simple in-memory metadata cache keyed by path+size+mtime
const metaCache = new Map();

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

app.use(express.static(path.join(__dirname, 'public')));

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
  const abs = path.join(CACHE_DIR, fileName);
  const rel = path.relative(VIDEO_DIR, abs).replace(/\\/g, '/');
  return { abs, rel };
}

const remuxInProgress = new Map(); // abs -> Promise

async function ensureRemuxedMp4(filePath, relPath, codecs) {
  const st = fs.statSync(filePath);
  const { abs, rel } = cachePathFor(relPath, st.size, st.mtimeMs);
  if (fs.existsSync(abs)) return { abs, rel };
  if (remuxInProgress.has(abs)) {
    await remuxInProgress.get(abs);
    return { abs, rel };
  }
  const task = new Promise((resolve, reject) => {
    try {
      const vCodec = (codecs && (codecs.videoCodec || '')).toString().toLowerCase();
      const aCodec = (codecs && (codecs.audioCodec || '')).toString().toLowerCase();
      const canCopyVideo = vCodec.includes('h264') || vCodec.includes('avc') || vCodec.includes('hevc') || vCodec.includes('h265') || vCodec.includes('hvc1') || vCodec.includes('hev1');
      const canCopyAudio = aCodec.includes('aac') || aCodec.includes('mp3');
      // For remuxing to a seekable MP4, use a single input and let
      // ffmpeg/mp4 preserve intrinsic stream offsets via edit lists.
      // Using -itsoffset with dual inputs can double the delay, so
      // we avoid it here.
      const cmd = ffmpeg(filePath);

      cmd.inputOptions(['-err_detect', 'ignore_err'])
        .outputOptions([
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

      if (canCopyAudio) cmd.audioCodec('copy');
      else cmd.audioCodec('aac').audioBitrate(process.env.AAC_BITRATE || '160k');

      cmd.on('error', (err) => {
        remuxInProgress.delete(abs);
        try { fs.unlinkSync(abs); } catch {}
        reject(err);
      }).on('end', () => {
        remuxInProgress.delete(abs);
        resolve();
      }).save(abs);
    } catch (e) {
      remuxInProgress.delete(abs);
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
    const { rel } = await ensureRemuxedMp4(filePath, relPath, codecs || {});
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
    command.videoCodec('libx264').outputOptions(['-crf', process.env.X264_CRF || '26', '-tune', 'fastdecode']);
    const maxHeight = parseInt(process.env.MAX_HEIGHT || '1080', 10);
    if (Number.isFinite(maxHeight)) {
      // Keep aspect ratio, cap height, and let width be even (-2)
      command.outputOptions(['-vf', `scale=-2:${maxHeight}:force_original_aspect_ratio=decrease`]);
    }
  }
  if (canCopyAudio && !forceTranscode) command.audioCodec('copy');
  else command.audioCodec('aac').audioBitrate(process.env.AAC_BITRATE || '160k');

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
    tr: 'Turkish',
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

function findSubsForVideo(filePath) {
  try {
    const dir = path.dirname(filePath);
    const videoBase = path.basename(filePath, path.extname(filePath));
    const tokenMatch = videoBase.match(/S\d{1,3}E\d{1,3}/i);
    const token = tokenMatch ? tokenMatch[0].toLowerCase() : null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const subs = [];
    for (const de of entries) {
      if (!de.isFile()) continue;
      const ext = path.extname(de.name).toLowerCase();
      if (!SUB_EXTS.has(ext)) continue;
      const nameLower = de.name.toLowerCase();
      const nameNoExtLower = path.basename(de.name, ext).toLowerCase();
      const matchesToken = token && (nameLower.includes(token));
      const matchesBase = !token && (nameNoExtLower.includes(videoBase.toLowerCase()));
      if (matchesToken || matchesBase) {
        const lang = parseLangFromFilename(de.name) || 'en';
        subs.push({ file: de.name, lang, label: langLabel(lang) });
      }
    }
    // Sort by language for stable order (en first)
    subs.sort((a, b) => (a.lang === 'en' ? -1 : b.lang === 'en' ? 1 : a.lang.localeCompare(b.lang)));
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
    const stream = ffmpeg()
      .input(subPath)
      .inputOptions(offsetMs ? ['-itsoffset', String(offsetMs/1000)] : [])
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

app.listen(PORT, () => {
  console.log(`LocalTube server running on http://localhost:${PORT}`);
  console.log(`Drop videos in: ${path.resolve(VIDEO_DIR)}`);
});
