import { useEffect, useMemo, useState } from 'preact/hooks';
import type { TripDestination, TripSummary } from '../../shared/types';
import { api } from '../api';
import { km, shortDate } from '../format';
import { BarChart } from './BarChart';
import { PeriodPicker } from './PeriodPicker';

type TripSort = 'new' | 'long' | 'far';

const SORT_LABELS: Record<TripSort, string> = {
  new: '新しい順',
  long: '日数が長い順',
  far: '出発地から遠い順',
};

/** 行き先の表示名：自分で付けた名前、なければ「行き先 n」 */
export function destinationName(d: TripDestination, i: number): string {
  return d.note?.name || `行き先 ${i + 1}`;
}

/** 2026/9/18（金）〜 9/23（水） */
export function tripPeriod(t: TripSummary): string {
  const s = t.start.slice(0, 10);
  const e = t.end.slice(0, 10);
  if (s === e) return shortDate(s);
  const end = shortDate(e);
  return `${shortDate(s)} 〜 ${s.slice(0, 4) === e.slice(0, 4) ? end.slice(5) : end}`;
}

export function TripsView({ query }: { query: URLSearchParams }) {
  const [from, setFrom] = useState(query.get('from') ?? '');
  const [to, setTo] = useState(query.get('to') ?? '');
  const [sort, setSort] = useState<TripSort>((query.get('sort') as TripSort) || 'new');
  const [items, setItems] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (sort !== 'new') p.set('sort', sort);
    const qs = p.toString();
    history.replaceState(null, '', `#/trips${qs ? `?${qs}` : ''}`);
    p.delete('sort');
    let alive = true;
    setError('');
    api
      .trips(p)
      .then((r) => alive && setItems(r.items))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [from, to, sort]);

  const sorted = useMemo(() => {
    const list = [...(items ?? [])];
    if (sort === 'long') list.sort((a, b) => b.days - a.days || b.startMs - a.startMs);
    if (sort === 'far') list.sort((a, b) => (b.distanceKm ?? 0) - (a.distanceKm ?? 0) || b.startMs - a.startMs);
    return list;
  }, [items, sort]);

  // 年ごとの旅行の日数（旅行の始まった年で数える）
  const bars = useMemo(() => {
    const byYear = new Map<number, number>();
    for (const t of items ?? []) {
      const y = Number(t.start.slice(0, 4));
      byYear.set(y, (byYear.get(y) ?? 0) + t.days);
    }
    if (!byYear.size) return [];
    const ys = [...byYear.keys()];
    const first = Math.min(...ys);
    const last = Math.max(...ys);
    const out = [];
    for (let y = first; y <= last; y++) {
      const n = byYear.get(y) ?? 0;
      out.push({ key: String(y), tip: `${y}年 ${n}日`, tick: y === first || y === last || y % 5 === 0 ? `'${String(y).slice(2)}` : '', value: n, valueLabel: `${n}日` });
    }
    return out;
  }, [items]);

  const totalDays = (items ?? []).reduce((s, t) => s + t.days, 0);

  return (
    <div class="page wide">
      <h2>旅行</h2>
      <section class="card filters-card">
        <PeriodPicker from={from} to={to} onChange={(f, t) => (setFrom(f), setTo(t))} />
        <div class="filter-row">
          <select value={sort} onChange={(e) => setSort(e.currentTarget.value as TripSort)} aria-label="並べ替え">
            {Object.entries(SORT_LABELS).map(([v, l]) => (
              <option value={v}>{l}</option>
            ))}
          </select>
        </div>
        <p class="muted note">Google のタイムラインが「旅行」としてまとめた記録です。行き先は地域を指す場所で、名前は Google マップで確かめて自分で付けられます。</p>
      </section>
      {error && <p class="error">{error}</p>}
      {items && (
        <>
          <p class="muted">
            {items.length.toLocaleString()} 件の旅行・合計 {totalDays.toLocaleString()} 日
          </p>
          {!from && !to && bars.length > 1 && (
            <section class="card">
              <BarChart
                caption="年ごとの旅行の日数（棒を押すとその年の旅行だけに）"
                bars={bars}
                onPick={(y) => {
                  setFrom(`${y}-01-01`);
                  setTo(`${y}-12-31`);
                }}
              />
            </section>
          )}
          <ul class="trip-list">
            {sorted.map((t) => (
              <li>
                <a class="trip-card" href={`#/trip/${t.startMs}`}>
                  <span class="trip-period">
                    {tripPeriod(t)}
                    <span class="muted">・{t.days}日間</span>
                  </span>
                  <span class="trip-meta muted">
                    {t.distanceKm != null && `出発地から ${t.distanceKm.toLocaleString()}km・`}
                    滞在 {t.visitCount} 件・移動 {km(t.distanceM)}
                  </span>
                  <span class="trip-dest">
                    {t.destinationPlaces.some((d) => d.note?.name)
                      ? t.destinationPlaces.map(destinationName).join('、')
                      : `行き先 ${t.destinationPlaces.length} か所`}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {items.length === 0 && <p class="muted">この期間の旅行はありません。</p>}
        </>
      )}
    </div>
  );
}
