// HUD widgets: live neural-network view and per-generation progress chart.

export function drawNetwork(canvas, net) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!net) return;
  const L = net.layers, padX = 16, padY = 10;
  const pos = L.map((n, l) => {
    const x = padX + (w - 2 * padX) * (l / (L.length - 1));
    return Array.from({ length: n }, (_, i) => [x, padY + (h - 2 * padY) * (n === 1 ? 0.5 : i / (n - 1))]);
  });
  net.forEachWeight((l, i, j, wt) => {
    const a = net.activations[l - 1][i];
    const strength = Math.min(1, Math.abs(wt * a));
    if (strength < 0.08) return;
    ctx.strokeStyle = wt * a > 0 ? `rgba(63,167,255,${strength})` : `rgba(255,80,100,${strength})`;
    ctx.lineWidth = 0.5 + strength * 1.5;
    ctx.beginPath(); ctx.moveTo(...pos[l - 1][i]); ctx.lineTo(...pos[l][j]); ctx.stroke();
  });
  const r = Math.max(2.5, Math.min(6, (h - 2 * padY) / Math.max(...L) / 2.4));
  pos.forEach((layer, l) => layer.forEach(([x, y], i) => {
    const a = net.activations[l][i];
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    const v = Math.round(Math.abs(a) * 255);
    ctx.fillStyle = a >= 0 ? `rgb(${40 + v * 0.3},${80 + v * 0.5},${120 + v * 0.53})` : `rgb(${120 + v * 0.53},${50},${60})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; ctx.stroke();
  }));
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right';
  const out = pos[L.length - 1];
  ctx.fillText('steer', out[0][0] - 9, out[0][1] + 3);
  ctx.fillText('gas', out[1][0] - 9, out[1][1] + 3);
}

export function drawChart(canvas, history) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 30, r: 34, t: 8, b: 14 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, iw, ih);
  ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
  if (history.length < 1) {
    ctx.textAlign = 'center'; ctx.fillText('stats appear after generation 1', w / 2, h / 2); return;
  }
  const n = history.length, X = i => pad.l + (n === 1 ? iw / 2 : iw * i / (n - 1));
  // Progress % (left axis)
  ctx.textAlign = 'right'; ctx.fillStyle = '#3fa7ff';
  ctx.fillText('100%', pad.l - 3, pad.t + 8); ctx.fillText('0%', pad.l - 3, pad.t + ih);
  ctx.strokeStyle = '#3fa7ff'; ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((s, i) => { const y = pad.t + ih * (1 - s.bestProgress); i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); });
  ctx.stroke();
  // Lap time (right axis), running best
  const laps = history.map(s => s.bestLap).filter(Boolean);
  if (laps.length) {
    const lo = Math.min(...laps), hi = Math.max(...laps), span = Math.max(0.5, hi - lo);
    const Y = t => pad.t + ih * 0.1 + ih * 0.8 * ((t - lo) / span);
    ctx.strokeStyle = '#ffc02e'; ctx.fillStyle = '#ffc02e';
    ctx.beginPath(); let started = false;
    history.forEach((s, i) => {
      if (!s.bestLap) return;
      const y = Y(s.bestLap);
      started ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); started = true;
    });
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText(lo.toFixed(1) + 's', pad.l + iw + 3, Y(lo) + 3);
    if (hi - lo > 0.3) ctx.fillText(hi.toFixed(1) + 's', pad.l + iw + 3, Y(hi) + 3);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.textAlign = 'center';
  ctx.fillText(`gen 1 – ${history[n - 1].generation}`, pad.l + iw / 2, h - 2);
}
