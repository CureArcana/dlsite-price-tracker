/**
 * 表示用の整形と、期間フィルタ・派生値の算出。
 *
 * API は「価格が変わった日」だけを返すラン・レングス圧縮形式なので、
 * 期間で絞るときは「区間の開始点を期間の左端まで引き延ばす」処理が要る。
 * ここを間違えるとグラフの左端が空白になる。
 */

globalThis.DPT_FORMAT = (() => {
  const yen = (n) => (typeof n === "number" ? `${n.toLocaleString("ja-JP")}円` : "—");

  const parseDay = (s) => {
    if (!s) return null;
    const [y, m, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };

  const dayDiff = (a, b) => Math.round((a - b) / 86400000);

  /** 2026-05-27 → 「05/27」 */
  const shortDate = (s) => {
    const d = parseDay(s);
    return d ? `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}` : "—";
  };

  /** 2026-05-27 → 「2026年5月27日」 */
  const longDate = (s) => {
    const d = parseDay(s);
    return d ? `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日` : "—";
  };

  /**
   * セール終了日時 → 「09/14 13:59」
   *
   * DB が持っているのは「セールが終わる瞬間」（例 14:00）だが、DLsite の画面は
   * 「13:59 まで」と最後の有効時刻で表示する。両方を並べると食い違って見えるので、
   * 1分引いて DLsite の表記に合わせる。
   */
  const endDateTime = (iso) => {
    if (!iso) return null;
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, h, mi] = m.map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, h, mi) - 60000);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${p2(t.getUTCMonth() + 1)}/${p2(t.getUTCDate())} ${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`;
  };

  /** セール終了までの残り日数。過ぎていたら null。 */
  const daysUntil = (iso) => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const diff = Math.ceil((t - Date.now()) / 86400000);
    return diff >= 0 ? diff : null;
  };

  /**
   * 圧縮された points を指定期間に絞る。
   * 期間の左端より前の最後の点を、左端の値として引き継ぐ（区間の引き延ばし）。
   */
  function sliceByDays(points, lastObserved, days) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (!days) return points.slice();

    const end = parseDay(lastObserved) || parseDay(points[points.length - 1].d);
    if (!end) return points.slice();
    const startMs = end.getTime() - (days - 1) * 86400000;
    const startISO = new Date(startMs).toISOString().slice(0, 10);

    const inRange = points.filter((p) => p.d >= startISO);
    const before = points.filter((p) => p.d < startISO).pop();
    if (!before) return inRange;
    // 期間の左端に、直前の価格を持つ点を作って差し込む。
    return [{ ...before, d: startISO, carried: true }, ...inRange];
  }

  /** 期間内の統計を points（引き延ばし済み）から算出する。 */
  function statsFor(points, lastObserved) {
    if (!points.length) return null;
    const prices = points.map((p) => p.p);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const current = prices[prices.length - 1];
    const minPoint = points.find((p) => p.p === min);
    const span = dayDiff(parseDay(lastObserved) || parseDay(points[points.length - 1].d), parseDay(points[0].d)) + 1;
    return { min, max, current, minDate: minPoint ? minPoint.d : null, spanDays: Math.max(span, 1) };
  }

  /** 買い時シグナルの表示文言。API の signal と期間内の実測から決める。 */
  function signalLabel(signal, current, min) {
    if (signal === "no_change") return { text: "値動きなし", tone: "flat" };
    if (current <= min) return { text: "過去最安", tone: "best" };
    if (current <= min * 1.1) return { text: "ほぼ最安", tone: "good" };
    if (current >= min * 1.6) return { text: "高値圏", tone: "high" };
    return { text: "様子見", tone: "normal" };
  }

  return { yen, parseDay, dayDiff, shortDate, longDate, endDateTime, daysUntil, sliceByDays, statsFor, signalLabel };
})();
