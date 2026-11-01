import { useEffect } from "react";

// The background of the Weft banner and site: voxel columns drawn at low resolution and scaled up
// without smoothing. They stay put unless the cursor lifts them, so a window nobody touches draws
// nothing. Anything marked `.clear` gets a dark clearing, so text over the field stays readable.

const SEAM = [20, 22, 30], DEEP = [26, 30, 40];
const TOP = [70, 80, 100], LEFT = [52, 60, 78], RIGHT = [38, 44, 58];
const A3 = [255, 196, 87];
const pack = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const SEAM_PX = pack(SEAM[0], SEAM[1], SEAM[2]);

// One block: the top diamond is R wide each way, and a rank down the screen every RANK.
const R = 10, RANK = 10, UNIT = 5, VOXEL = 10;
const MAX_H = 8;

const mod = (x: number, m: number) => ((x % m) + m) % m;

function shade(c: number[], t: number) {
  return pack(
    (DEEP[0] + (c[0] - DEEP[0]) * t) | 0,
    (DEEP[1] + (c[1] - DEEP[1]) * t) | 0,
    (DEEP[2] + (c[2] - DEEP[2]) * t) | 0
  );
}

function startField() {
  // Shown as the background image of the body, over its solid color, with the canvas itself off the
  // page. Text is drawn sharply only where the browser knows it has something opaque behind it:
  // over a canvas or anything else under the content, Windows smooths the pixel font into a blur.
  const field = document.body;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = { x: 0, y: 0, sx: 0, sy: 0, on: false, lift: 0 };

  let W = 0, H = 0, dpr = 1, pixel = 4, cols = 0, ranks = 0;
  let img: ImageData, fb: Uint32Array, owner: Int32Array;
  let rects: { l: number; r: number; t: number; b: number }[] = [];
  let frame = 0, lastT = 0;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    pixel = Math.max(1, Math.round((window.innerWidth >= 1080 ? 4 : 3) * dpr));
    W = Math.ceil((window.innerWidth * dpr) / pixel);
    H = Math.ceil((window.innerHeight * dpr) / pixel);
    canvas.width = W;
    canvas.height = H;
    field.style.backgroundSize = `${(W * pixel) / dpr}px ${(H * pixel) / dpr}px`;
    img = ctx.createImageData(W, H);
    fb = new Uint32Array(img.data.buffer);
    owner = new Int32Array(W * H);
    cols = Math.ceil(W / 2 / R) + 2;
    ranks = Math.ceil(H / RANK) + Math.ceil((MAX_H * UNIT) / RANK) + 4;
  }

  function measure() {
    const k = dpr / pixel;
    rects = Array.from(document.querySelectorAll(".clear"), (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left * k, r: r.right * k, t: r.top * k, b: r.bottom * k };
    });
  }

  // As in the banner: nearly gone behind text, full strength a little way out.
  function clearing(x: number, y: number) {
    const floor = 0.08;
    let best = 1e9;
    for (const q of rects) {
      const dx = x < q.l ? q.l - x : x > q.r ? x - q.r : 0;
      const dy = y < q.t ? q.t - y : y > q.b ? y - q.b : 0;
      best = Math.min(best, dx * dx + dy * dy);
    }
    const t = (Math.sqrt(best) - 3) / 40;
    return t < 0 ? floor : t > 1 ? 1 : t * t * (3 - 2 * t) * (1 - floor) + floor;
  }

  function column(id: number, cx: number, ty: number, sideH: number, t: number) {
    const topC = shade(TOP, t), leftC = shade(LEFT, t), rightC = shade(RIGHT, t);
    const xl = Math.max(0, cx - R), xr = Math.min(W, cx + R);
    for (let x = xl; x < xr; x++) {
      const isLeft = x < cx;
      const y0 = ty + (R >> 1) + (isLeft ? (x - (cx - R)) >> 1 : (cx + R - 1 - x) >> 1);
      const foot = y0 + sideH;
      const side = isLeft ? leftC : rightC;
      for (let y = Math.max(0, y0); y < Math.min(H, foot); y++) {
        fb[y * W + x] = side;
        owner[y * W + x] = 0;
      }
      if (foot >= 0 && foot < H) {
        fb[foot * W + x] = SEAM_PX;
        owner[foot * W + x] = 0;
      }
    }
    const half = R >> 1;
    for (let row = 0; row < R; row++) {
      const y = ty + row;
      if (y < 0 || y >= H) continue;
      const span = row < half ? (row + 1) * 2 : (R - row) * 2;
      for (let x = Math.max(0, cx - span); x < Math.min(W, cx + span); x++) {
        fb[y * W + x] = topC;
        owner[y * W + x] = id;
      }
    }
  }

  // The banner's dash across a top: drawn last, and only if nearly all of it shows, since a clipped
  // dash is just a stray triangle.
  function dash(id: number, cx: number, ty: number, t: number) {
    const half = R >> 1;
    const color = shade(A3, t);
    let total = 0, seen = 0;
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1 && seen < total * 0.8) return;
      for (let row = 0; row < R; row++) {
        const y = ty + row;
        if (y < 0 || y >= H) continue;
        const span = row < half ? (row + 1) * 2 : (R - row) * 2;
        for (let x = Math.max(0, cx - span); x < Math.min(W, cx + span); x++) {
          if (Math.abs((x - cx) / 2 + (row - R / 2 + 0.5)) >= 1.6) continue;
          const mine = owner[y * W + x] === id;
          if (pass === 0) {
            total++;
            if (mine) seen++;
          } else if (mine) {
            fb[y * W + x] = color;
          }
        }
      }
    }
  }

  function render(T: number) {
    const ease = 1 - Math.exp(-Math.min(Math.max(T - lastT, 0), 0.1) * 8);
    lastT = T;
    pointer.sx += (pointer.x - pointer.sx) * ease;
    pointer.sy += (pointer.y - pointer.sy) * ease;
    pointer.lift += ((pointer.on ? 1 : 0) - pointer.lift) * ease;

    fb.fill(SEAM_PX);
    owner.fill(0);
    const dashes: number[] = [];
    let id = 0;
    const top = -Math.ceil(R / RANK) - 1;

    for (let rank = top; rank < ranks; rank++) {
      const cy = rank * RANK;
      for (let col = -cols - ((rank & 1) === (cols & 1) ? 0 : 1); col <= cols; col += 2) {
        const a = (rank + col) / 2, b = (rank - col) / 2;
        const cx = (W >> 1) + col * R;
        let h = 2 + Math.round(1.1 * Math.sin(a * 0.31) + 1.1 * Math.sin(b * 0.37));
        if (pointer.lift > 0.004) {
          const dx = cx - pointer.sx, dy = cy - pointer.sy;
          const d = dx * dx + dy * dy * 1.4;
          if (d < 4900) h += 5 * pointer.lift * Math.exp(-d / 900);
        }
        // Rounded here, so a moving column steps by one pixel at a time.
        const raised = Math.round(Math.min(h, MAX_H) * UNIT);
        const ty = cy - raised;
        if (ty > H) continue;
        const t = clearing(cx, ty + 5);
        id++;
        column(id, cx, ty, VOXEL + raised, t);
        if (mod(a, 6) === 0) dashes.push(id, cx, ty, t < 0.3 ? t * 0.6 : t);
      }
    }
    for (let i = 0; i < dashes.length; i += 4) {
      dash(dashes[i], dashes[i + 1], dashes[i + 2], dashes[i + 3]);
    }
    ctx.putImageData(img, 0, 0);
    field.style.backgroundImage = `url(${canvas.toDataURL()})`;

    return (
      Math.abs(pointer.x - pointer.sx) + Math.abs(pointer.y - pointer.sy) >= 0.2 ||
      Math.abs((pointer.on ? 1 : 0) - pointer.lift) >= 0.004
    );
  }

  const tick = (ms: number) => {
    frame = 0;
    measure();
    if (render(ms / 1000)) frame = requestAnimationFrame(tick);
  };
  const wake = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  const onResize = () => {
    resize();
    wake();
  };
  const onMove = (e: PointerEvent) => {
    const k = dpr / pixel;
    pointer.x = e.clientX * k;
    pointer.y = e.clientY * k;
    // Coming back in, rise where the cursor is instead of sliding over from where it left.
    if (!pointer.on && pointer.lift < 0.05) {
      pointer.sx = pointer.x;
      pointer.sy = pointer.y;
    }
    pointer.on = true;
    wake();
  };
  const onLeave = () => {
    pointer.on = false;
    wake();
  };

  // New content means new text to clear the field around.
  const changes = new MutationObserver(wake);
  changes.observe(document.getElementById("root")!, { childList: true, subtree: true });

  resize();
  wake();
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", wake, true);
  if (!still) {
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
  }

  return {
    stop() {
      cancelAnimationFrame(frame);
      changes.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", wake, true);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    },
  };
}

export function VoxelField() {
  useEffect(() => {
    const field = startField();
    return () => field.stop();
  }, []);

  return null;
}
