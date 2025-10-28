import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MdFullscreen, MdFullscreenExit, MdPause, MdPlayArrow, MdSkipNext, MdSkipPrevious } from 'react-icons/md';

type MediaItem = {
  name: string;
  relPath: string;
  size: number;
  mtime: number;
  ext: string;
  mime?: string;
  duration?: number;
  category?: string;
};

function useIOSStandalone() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Mac OS X') && 'ontouchend' in document);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (navigator as any).standalone === true;
  return isIOS && standalone;
}

export default function App() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [active, setActive] = useState<number>(-1);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isIOSPWA = useIOSStandalone();

  useEffect(() => {
    fetch('/api/videos').then(r => r.json()).then(data => {
      const list: MediaItem[] = (data.items || []).sort((a: any, b: any) => b.mtime - a.mtime);
      setItems(list);
      if (list.length) setActive(0);
    }).catch(() => {});
  }, []);

  const src = useMemo(() => {
    const it = items[active];
    if (!it) return '';
    const useRemux = ['.mkv', '.avi', '.mov'].includes(it.ext);
    return useRemux ? `/remux?p=${encodeURIComponent(it.relPath)}` : `/stream?p=${encodeURIComponent(it.relPath)}`;
  }, [items, active]);

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    v.setAttribute('playsinline', '');
    (v as any).webkitPlaysInline = true;
    v.setAttribute('disablepictureinpicture', '');
    v.setAttribute('controlsList', 'nodownload noplaybackrate noremoteplayback');
  }, []);

  // Fullscreen handling with iOS PWA fallback.
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const onFs = () => setFs(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange' as any, onFs as any);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange' as any, onFs as any);
    };
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMode = () => setFs(((v as any).webkitPresentationMode === 'fullscreen'));
    v.addEventListener('webkitpresentationmodechanged' as any, onMode as any);
    return () => v.removeEventListener('webkitpresentationmodechanged' as any, onMode as any);
  }, []);

  const toggleFs = () => {
    const host = containerRef.current || videoRef.current?.parentElement!;
    const v = videoRef.current!;
    if (!isIOSPWA) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else host.requestFullscreen?.().catch(() => {});
    } else {
      const mode = (v as any).webkitPresentationMode;
      if (mode === 'fullscreen') (v as any).webkitSetPresentationMode?.('inline');
      else (v as any).webkitSetPresentationMode?.('fullscreen');
    }
  };

  const playing = !!videoRef.current && !videoRef.current.paused;

  return (
    <div className="lw-app" ref={containerRef}>
      <header className="topbar-react">
        <div className="brand">LocalWatch</div>
      </header>
      <main className="layout-react">
        <aside className="sidebar-react">
          <div className="list-react">
            {items.map((it, i) => (
              <button key={it.relPath} className={"row" + (i === active ? ' active' : '')} onClick={() => setActive(i)}>
                <span className="name">{it.name}</span>
                <span className="meta">{(it.ext||'').toUpperCase().replace('.', '')}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className="player-react">
          <div className="video-wrap">
            {src && (
              <video ref={videoRef} src={src} controls playsInline webkit-playsinline="true" />
            )}
            <div className="ep-ctrl-react">
              <button className="btn prev" onClick={() => setActive(Math.max(0, active - 1))} disabled={active <= 0}>
                <MdSkipPrevious size={64} />
              </button>
              <button className="btn play" onClick={() => {
                const v = videoRef.current; if (!v) return;
                if (v.paused) v.play().catch(() => {}); else v.pause();
              }}>
                {playing ? <MdPause size={64} /> : <MdPlayArrow size={64} />}
              </button>
              <button className="btn next" onClick={() => setActive(Math.min(items.length - 1, active + 1))} disabled={active >= items.length - 1}>
                <MdSkipNext size={64} />
              </button>
              <button className="btn fs" onClick={toggleFs}>
                {fs ? <MdFullscreenExit size={28} /> : <MdFullscreen size={28} />}
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

