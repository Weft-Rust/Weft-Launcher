import { useEffect, useState } from "react";
import { modsApi } from "../../mods/api";

const loaded = new Map<string, Promise<string | null>>();

function iconData(url: string): Promise<string | null> {
  let p = loaded.get(url);
  if (!p) {
    p = modsApi.icon(url).catch(() => null);
    loaded.set(url, p);
  }
  return p;
}

const COLORS = ["#e09632", "#8c97ad", "#4fa25e", "#c2503c", "#ffc457", "#9bb7e3"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A mirrored 5×5 pixel pattern from the id, so a mod without an icon still looks like itself. */
function Glyph({ id }: { id: string }) {
  const h = hash(id);
  const rects = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((h >> (y * 3 + x)) & 1) {
        rects.push(<rect key={`${x},${y}`} x={x} y={y} width="1" height="1" />);
        if (x < 2) rects.push(<rect key={`m${x},${y}`} x={4 - x} y={y} width="1" height="1" />);
      }
    }
  }
  return (
    <svg className="pixel-icon" width="30" height="30" viewBox="0 0 5 5" fill={COLORS[h % COLORS.length]} aria-hidden="true">
      {rects}
    </svg>
  );
}

export function ModIcon({ id, url }: { id: string; url: string | null }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSrc(null);
    if (url) iconData(url).then((d) => live && setSrc(d));
    return () => {
      live = false;
    };
  }, [url]);

  return (
    <div className="mod-icon" aria-hidden="true">
      {src ? <img src={src} alt="" width={40} height={40} /> : <Glyph id={id} />}
    </div>
  );
}
