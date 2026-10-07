import { useEffect, useState } from 'preact/hooks';
import type { CalendarResponse } from '../../shared/types';
import { api } from '../api';

const cache = new Map<number, Promise<CalendarResponse>>();
function loadYear(year: number): Promise<CalendarResponse> {
  let p = cache.get(year);
  if (!p) {
    p = api.calendar(year);
    p.catch(() => cache.delete(year));
    cache.set(year, p);
  }
  return p;
}

/** 取り込み後などにカレンダーの件数を読み直させる */
export function clearCalendarCache(): void {
  cache.clear();
}

function level(visits: number): number {
  if (visits === 0) return 0;
  if (visits <= 2) return 1;
  if (visits <= 5) return 2;
  if (visits <= 9) return 3;
  return 4;
}

interface Props {
  selected: string;
  onPick: (date: string) => void;
}

/** 月のカレンダー。記録の多い日ほど濃く塗る */
export function Calendar({ selected, onPick }: Props) {
  const [ym, setYm] = useState(selected.slice(0, 7));
  const [data, setData] = useState<CalendarResponse | null>(null);
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));

  useEffect(() => setYm(selected.slice(0, 7)), [selected]);
  useEffect(() => {
    let alive = true;
    loadYear(year).then((d) => alive && setData(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [year]);

  const move = (n: number) => {
    const d = new Date(Date.UTC(year, month - 1 + n, 1));
    setYm(d.toISOString().slice(0, 7));
  };

  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = Array(first.getUTCDay()).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${ym}-${String(d).padStart(2, '0')}`);

  let monthVisits = 0;
  let monthKm = 0;
  for (const c of cells) {
    const info = c && data?.year === year ? data.days[c] : undefined;
    if (info) {
      monthVisits += info.visits;
      monthKm += info.distanceKm;
    }
  }

  return (
    <div class="calendar">
      <div class="calendar-head">
        <button type="button" class="icon-btn" onClick={() => move(-12)} title="前の年">«</button>
        <button type="button" class="icon-btn" onClick={() => move(-1)} title="前の月">‹</button>
        <span class="calendar-title">{year}年{month}月</span>
        <button type="button" class="icon-btn" onClick={() => move(1)} title="次の月">›</button>
        <button type="button" class="icon-btn" onClick={() => move(12)} title="次の年">»</button>
      </div>
      <div class="calendar-grid">
        {['日', '月', '火', '水', '木', '金', '土'].map((w) => (
          <span class="calendar-wd">{w}</span>
        ))}
        {cells.map((c) => {
          if (!c) return <span />;
          const info = data?.year === year ? data.days[c] : undefined;
          const lv = level(info?.visits ?? 0);
          return (
            <button
              type="button"
              class={`calendar-day lv${lv}${c === selected ? ' selected' : ''}`}
              title={info ? `滞在 ${info.visits} 件・移動 ${info.distanceKm}km` : '記録なし'}
              onClick={() => onPick(c)}
            >
              {Number(c.slice(8))}
            </button>
          );
        })}
      </div>
      <div class="calendar-foot muted">
        この月：滞在 {monthVisits} 件・移動 {Math.round(monthKm).toLocaleString()}km
      </div>
    </div>
  );
}
