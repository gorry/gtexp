import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';

let yearsCache: Promise<string[]> | null = null;

/** データのある年の一覧（新しい順）。1回だけ取得する */
function loadYears(): Promise<string[]> {
  yearsCache ??= api.summary().then((s) => {
    const list: string[] = [];
    if (s.firstDate && s.lastDate) {
      for (let y = Number(s.lastDate.slice(0, 4)); y >= Number(s.firstDate.slice(0, 4)); y--) list.push(String(y));
    }
    return list;
  });
  yearsCache.catch(() => (yearsCache = null));
  return yearsCache;
}

/** 取り込みで期間が変わったときに読み直させる */
export function clearYearsCache(): void {
  yearsCache = null;
}

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

/** 期間の指定：年を選ぶか、開始日・終了日を入れる */
export function PeriodPicker({ from, to, onChange }: Props) {
  const [years, setYears] = useState<string[]>([]);
  useEffect(() => {
    loadYears().then(setYears).catch(() => {});
  }, []);
  const wholeYear = from && from.slice(0, 4) === to.slice(0, 4) && from.endsWith('-01-01') && to.endsWith('-12-31') ? from.slice(0, 4) : '';
  return (
    <div class="filter-row">
      <select
        value={wholeYear}
        onChange={(e) => {
          const y = e.currentTarget.value;
          if (y) onChange(`${y}-01-01`, `${y}-12-31`);
          else onChange('', '');
        }}
        aria-label="年"
      >
        <option value="">{from || to ? '期間を指定中' : '全期間'}</option>
        {years.map((y) => (
          <option value={y}>{y}年</option>
        ))}
      </select>
      <input type="date" value={from} onChange={(e) => onChange(e.currentTarget.value, to)} aria-label="期間の始め" />
      <span class="muted">〜</span>
      <input type="date" value={to} onChange={(e) => onChange(from, e.currentTarget.value)} aria-label="期間の終わり" />
    </div>
  );
}
