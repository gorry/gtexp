import { BarChart } from './BarChart';

interface Props {
  years: Record<string, number>;
  /** 棒を押したとき（その年の記録へ移動するなど） */
  onPick?: (year: string) => void;
}

/**
 * 年ごとの訪問回数の棒グラフ。記録のない年も 0 として並べる。
 * 各年の件数は、下の一覧の見出しにも出している（表の代わり）。
 */
export function YearChart({ years, onPick }: Props) {
  const keys = Object.keys(years).sort();
  if (!keys.length) return null;
  const first = Number(keys[0]);
  const last = Number(keys[keys.length - 1]);
  const bars = [];
  for (let y = first; y <= last; y++) {
    const n = years[String(y)] ?? 0;
    bars.push({
      key: String(y),
      tip: `${y}年 ${n}回`,
      tick: y === first || y === last || y % 5 === 0 ? `'${String(y).slice(2)}` : '',
      value: n,
      valueLabel: String(n),
    });
  }
  return <BarChart caption="年ごとの訪問回数" bars={bars} onPick={onPick} />;
}
