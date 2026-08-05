/**
 * 依存ライブラリなしの階段（ステップ）チャート。
 *
 * 価格は「次に変わるまで同じ値が続く」量なので、点と点を直線で結んではいけない。
 * 折れ線にすると、実際には起きていない緩やかな値動きを描いてしまう。
 * ここでは必ず「水平に伸ばして、変わる日に垂直に跳ぶ」形で描く。
 */

globalThis.DPT_CHART = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const PAD = { top: 14, right: 14, bottom: 26, left: 54 };
  const FALLBACK_W = 720;

  // viewBox は必ずコンテナの実 CSS ピクセル寸法に一致させる。
  // 固定 viewBox + preserveAspectRatio="none" にすると非等倍で拡大され、
  // 軸ラベルの文字が横に伸びて縦に潰れる（実測: 横1.15倍・縦0.84倍の歪み）。
  const measure = (container) => {
    const w = Math.round(container.getBoundingClientRect().width) || FALLBACK_W;
    const h = Math.round(parseFloat(getComputedStyle(container).getPropertyValue("--dpt-chart-h"))) || 210;
    return { w, h };
  };

  const el = (name, attrs = {}) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
    return node;
  };

  /**
   * 目盛りに使うキリの良い刻み幅を選ぶ。
   * target=4 だと range/4 が 10 の冪の境界をまたいだ時に一段飛んで罫線が3本まで減る
   * （実測: 範囲477円で刻み200円・罫線3本）。5 を狙うと 100円刻み・5本に収まる。
   */
  function niceStep(range, target = 5) {
    const raw = range / target;
    const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (mag * m >= raw) return mag * m;
    }
    return mag * 10;
  }

  function render(container, opts) {
    const { points, lastObserved, showListPrice = true } = opts;
    const F = globalThis.DPT_FORMAT;

    container.textContent = "";
    if (!points || points.length === 0) return null;

    const { w: VIEW_W, h: VIEW_H } = measure(container);
    const PLOT_W = VIEW_W - PAD.left - PAD.right;
    const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

    const firstDay = F.parseDay(points[0].d);
    const endDay = F.parseDay(lastObserved) || F.parseDay(points[points.length - 1].d);
    const totalDays = Math.max(F.dayDiff(endDay, firstDay), 1);

    // 定価は「表示する」かつ「販売価格と違う値が1つでもある」ときだけ描く。
    // 常に同額なら線が重なって読みにくくなるだけ。
    const listValues = points.map((p) => p.l).filter((v) => typeof v === "number");
    const hasList = showListPrice && listValues.length > 0 && listValues.some((v, i) => v !== points[i].p);

    const values = points.map((p) => p.p).concat(hasList ? listValues : []);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    // 目盛りにスナップさせず、データの上下に一定割合の余白だけ取る。
    // グリッドの倍数まで丸めると、上下に使われない帯ができて縦方向が無駄になる。
    const margin = Math.max((hi - lo) * 0.12, 1);
    const yMin = Math.max(0, lo - margin);
    const yMax = hi + margin;
    const ySpan = Math.max(yMax - yMin, 1);
    const step = niceStep(ySpan);

    const x = (day) => PAD.left + (F.dayDiff(day, firstDay) / totalDays) * PLOT_W;
    const y = (price) => PAD.top + PLOT_H - ((price - yMin) / ySpan) * PLOT_H;

    const svg = el("svg", {
      viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
      width: VIEW_W,
      height: VIEW_H,
      class: "dpt-chart",
      role: "img",
      "aria-label": buildSummary(points, lastObserved),
    });

    // ── 横罫線と価格ラベル（描画域に収まるキリの良い値だけ） ──
    const grid = el("g", { class: "dpt-grid" });
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      const yy = y(v);
      grid.appendChild(el("line", { x1: PAD.left, y1: yy, x2: VIEW_W - PAD.right, y2: yy }));
      const label = el("text", { x: PAD.left - 8, y: yy + 4, class: "dpt-axis-y" });
      label.textContent = v.toLocaleString("ja-JP");
      grid.appendChild(label);
    }
    svg.appendChild(grid);

    // ── 割引期間の帯 ──
    const bands = el("g", { class: "dpt-bands" });
    points.forEach((p, i) => {
      if (!p.dc) return;
      const x0 = x(F.parseDay(p.d));
      const x1 = i + 1 < points.length ? x(F.parseDay(points[i + 1].d)) : x(endDay);
      bands.appendChild(el("rect", { x: x0, y: PAD.top, width: Math.max(x1 - x0, 0.5), height: PLOT_H }));
    });
    svg.appendChild(bands);

    // ── 定価（破線） ──
    if (hasList) {
      svg.appendChild(el("path", { d: stepPath(points, (p) => p.l, x, y, endDay), class: "dpt-line-list" }));
    }

    // ── 販売価格（実線） ──
    svg.appendChild(el("path", { d: stepPath(points, (p) => p.p, x, y, endDay), class: "dpt-line-price" }));

    // ── 価格が変わった日のマーカー（期間左端に継ぎ足した点は除く） ──
    const marks = el("g", { class: "dpt-marks" });
    points.forEach((p) => {
      if (p.carried) return;
      marks.appendChild(el("circle", { cx: x(F.parseDay(p.d)), cy: y(p.p), r: 3 }));
    });
    svg.appendChild(marks);

    // ── 日付ラベル ──
    const xAxis = el("g", { class: "dpt-axis-x" });
    for (const d of dateTicks(firstDay, endDay)) {
      const t = el("text", { x: x(d), y: VIEW_H - 8 });
      t.textContent = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      xAxis.appendChild(t);
    }
    svg.appendChild(xAxis);

    // ── ホバー用のガイド線 ──
    const guide = el("line", {
      class: "dpt-guide",
      y1: PAD.top,
      y2: PAD.top + PLOT_H,
      x1: 0,
      x2: 0,
      opacity: 0,
    });
    svg.appendChild(guide);

    container.appendChild(svg);

    const tip = document.createElement("div");
    tip.className = "dpt-tooltip";
    tip.hidden = true;
    container.appendChild(tip);

    attachHover({ container, svg, guide, tip, points, x, firstDay, totalDays, hasList, VIEW_W, PLOT_W });

    // パネル幅が変わったら実寸に合わせて描き直す（viewBox は実寸と一致させる約束のため）。
    let lastW = VIEW_W;
    const ro = new ResizeObserver(() => {
      const w = Math.round(container.getBoundingClientRect().width);
      if (!w || Math.abs(w - lastW) < 2) return;
      lastW = w;
      ro.disconnect(); // render() が新しい observer を張り直す
      render(container, opts);
    });
    ro.observe(container);

    return { svg, disconnect: () => ro.disconnect() };
  }

  /** 階段状のパス文字列を作る。値が無い点は前の値を引き継ぐ。 */
  function stepPath(points, pick, x, y, endDay) {
    const F = globalThis.DPT_FORMAT;
    const seg = [];
    let prevY = null;
    points.forEach((p) => {
      const v = pick(p);
      if (typeof v !== "number") return;
      const px = x(F.parseDay(p.d));
      const py = y(v);
      if (prevY === null) {
        seg.push(`M ${px.toFixed(1)} ${py.toFixed(1)}`);
      } else {
        // 先に横へ伸ばしてから、垂直に跳ぶ。これが階段。
        seg.push(`L ${px.toFixed(1)} ${prevY.toFixed(1)}`, `L ${px.toFixed(1)} ${py.toFixed(1)}`);
      }
      prevY = py;
    });
    if (prevY !== null) seg.push(`L ${x(endDay).toFixed(1)} ${prevY.toFixed(1)}`);
    return seg.join(" ");
  }

  /** X軸のラベル位置を 4〜5 個選ぶ。 */
  function dateTicks(first, end) {
    const F = globalThis.DPT_FORMAT;
    const total = Math.max(F.dayDiff(end, first), 1);
    const count = Math.min(5, Math.max(2, Math.floor(total / 14) + 1));
    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push(new Date(first.getTime() + Math.round((total * i) / (count - 1)) * 86400000));
    }
    return out;
  }

  /** スクリーンリーダー向けの1行要約。グラフが読めなくても内容が伝わるようにする。 */
  function buildSummary(points, lastObserved) {
    const F = globalThis.DPT_FORMAT;
    const prices = points.map((p) => p.p);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const current = prices[prices.length - 1];
    return (
      `${F.longDate(points[0].d)}から${F.longDate(lastObserved)}までの価格推移。` +
      `最安${F.yen(min)}、最高${F.yen(max)}、現在${F.yen(current)}。` +
      `価格が変わった回数は${Math.max(points.length - 1, 0)}回。`
    );
  }

  /** ホバーでガイド線とツールチップを出す。 */
  function attachHover(ctx) {
    const { container, svg, guide, tip, points, x, firstDay, totalDays, hasList, VIEW_W, PLOT_W } = ctx;
    const F = globalThis.DPT_FORMAT;

    const hide = () => {
      guide.setAttribute("opacity", 0);
      tip.hidden = true;
    };

    const move = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      // viewBox は実寸と一致させてあるので比率換算はほぼ 1:1 だが、
      // ズーム時のずれを避けるため実測幅で正規化しておく。
      const vx = ((clientX - rect.left) / rect.width) * VIEW_W;
      const ratio = (vx - PAD.left) / PLOT_W;
      if (ratio < -0.02 || ratio > 1.02) return hide();

      const dayOffset = Math.round(Math.min(Math.max(ratio, 0), 1) * totalDays);
      const day = new Date(firstDay.getTime() + dayOffset * 86400000);
      const iso = day.toISOString().slice(0, 10);

      // その日に有効な区間 = 開始日が iso 以下の最後の点。
      let active = points[0];
      for (const p of points) {
        if (p.d <= iso) active = p;
        else break;
      }

      const gx = x(day);
      guide.setAttribute("x1", gx);
      guide.setAttribute("x2", gx);
      guide.setAttribute("opacity", 1);

      const rate =
        typeof active.l === "number" && active.l > 0 && active.p < active.l
          ? Math.round((1 - active.p / active.l) * 100)
          : null;

      const rows = [
        `<span class="dpt-tip-date">${F.longDate(iso)}</span>`,
        `<span class="dpt-tip-price">${F.yen(active.p)}</span>`,
      ];
      if (hasList && typeof active.l === "number" && active.l !== active.p) {
        rows.push(`<span class="dpt-tip-sub">定価 ${F.yen(active.l)}${rate !== null ? ` / ${rate}%OFF` : ""}</span>`);
      }
      const end = F.endDateTime(active.de);
      if (active.dc && end) rows.push(`<span class="dpt-tip-sub">セール ${end} まで</span>`);

      tip.innerHTML = rows.join("");
      tip.hidden = false;

      // ツールチップが右端で切れないように左右を反転させる。
      const cRect = container.getBoundingClientRect();
      const px = clientX - cRect.left;
      const flip = px > cRect.width - 150;
      tip.style.left = `${flip ? px - 12 : px + 12}px`;
      tip.style.transform = flip ? "translateX(-100%)" : "none";
      tip.style.top = `${Math.max(clientY - cRect.top - 12, 4)}px`;
    };

    svg.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
    svg.addEventListener("mouseleave", hide);
    svg.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (t) move(t.clientX, t.clientY);
    }, { passive: true });
    svg.addEventListener("touchend", hide);
  }

  return { render };
})();
