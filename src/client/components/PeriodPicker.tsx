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

/** 日付で期間を指定しているときの、ドロップダウンの表示だけの項目 */
const CUSTOM = 'custom';

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
    <div class="filter-row period-row">
      {/* 日付で指定しているときは「期間」（選べない表示だけの項目）を出す。「全期間」はいつでも選べて、期間を解除する */}
      <select
        value={wholeYear || (from || to ? CUSTOM : '')}
        onChange={(e) => {
          const y = e.currentTarget.value;
          if (y === CUSTOM) return;
          if (y) onChange(`${y}-01-01`, `${y}-12-31`);
          else onChange('', '');
        }}
        aria-label="年"
      >
        {(from || to) && !wholeYear && (
          <option value={CUSTOM} disabled>
            期間
          </option>
        )}
        <option value="">全期間</option>
        {years.map((y) => (
          <option value={y}>{y}年</option>
        ))}
      </select>
      {/* 始めが終わりを追い越したら（終わりが始めより前になったら）、もう片方を同じ日にそろえる */}
      <div class="period-dates">
        <input
          type="date"
          value={from}
          onChange={(e) => {
            const f = e.currentTarget.value;
            onChange(f, f && to && f > to ? f : to);
          }}
          aria-label="期間の始め"
        />
        <span class="muted">〜</span>
        <input
          type="date"
          value={to}
          onChange={(e) => {
            const t = e.currentTarget.value;
            onChange(from && t && t < from ? t : from, t);
          }}
          aria-label="期間の終わり"
        />
      </div>
    </div>
  );
}
