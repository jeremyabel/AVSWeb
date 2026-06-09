// CPU-side line/point drawing into a Uint8Array pixel buffer (RGBA, row-major).
// Matches the original AVS approach: effects draw into a raw pixel buffer.

export function setPixel(buf, x, y, w, h, r, g, b, mode = 0) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const i = (y * w + x) * 4;
  switch (mode) {
    case 1: // additive
      buf[i]   = Math.min(255, buf[i]   + r);
      buf[i+1] = Math.min(255, buf[i+1] + g);
      buf[i+2] = Math.min(255, buf[i+2] + b);
      break;
    case 2: // max
      buf[i]   = Math.max(buf[i],   r);
      buf[i+1] = Math.max(buf[i+1], g);
      buf[i+2] = Math.max(buf[i+2], b);
      break;
    default: // replace
      buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
  }
}

// Bresenham line with blend mode
export function drawLine(buf, x0, y0, x1, y1, w, h, r, g, b, mode = 0) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    setPixel(buf, x0, y0, w, h, r, g, b, mode);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx)  { err += dx; y0 += sy; }
  }
}

// Fill vertical bar from y0 to y1 at column x
export function drawVBar(buf, x, y0, y1, w, h, r, g, b, mode = 0) {
  if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
  for (let y = y0; y <= y1; y++) setPixel(buf, x, y, w, h, r, g, b, mode);
}
