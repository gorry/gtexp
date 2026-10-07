export interface Bar {
  key: string;
  /** 触れたときに出す説明（例：「2024年 17回」） */
  tip: string;
  /** 下の目盛りに出す文字。空なら出さない */
  tick: string;
  value: number;
  /** いちばん大きい棒に添える数字 */
  valueLabel: string;
}

interface Props {
  caption: string;
  bars: Bar[];
  onPick?: (key: string) => void;
}

/**
 * 1系列の縦棒グラフ（凡例なし）。いちばん大きい棒にだけ数字を添え、触れると説明を出す。
 * 数値はグラフの下に表でも出すこと（色だけ・形だけに頼らないため）。
 */
export function BarChart({ caption, bars, onPick }: Props) {
  if (!bars.length) return null;
  const max = Math.max(...bars.map((b) => b.value));
  const maxIndex = bars.findIndex((b) => b.value === max);
  return (
    <figure class="year-chart">
      <figcaption class="muted">{caption}</figcaption>
      <div class="year-chart-plot" role="img" aria-label={`${caption}：${bars.map((b) => b.tip).join('、')}`}>
        {bars.map((b, i) => (
          <button type="button" class={`year-col${onPick ? '' : ' static'}`} title={b.tip} disabled={b.value === 0} onClick={() => onPick?.(b.key)}>
            <span class="year-tip">{b.tip}</span>
            <span class="year-bar" style={{ height: max > 0 ? `${(b.value / max) * 100}%` : '0' }}>
              {/* 数字は棒の上に重ねて置き、棒の高さを縮めない */}
              {i === maxIndex && max > 0 && <span class="year-max">{b.valueLabel}</span>}
            </span>
          </button>
        ))}
      </div>
      <div class="year-axis">
        {bars.map((b) => (
          <span>{b.tick}</span>
        ))}
      </div>
    </figure>
  );
}

/** 横棒の一覧（移動手段ごとなど、名前の長い分類向け）。値の大きい順に渡す */
export function BarList({ caption, rows }: { caption: string; rows: { key: string; label: string; value: number; valueLabel: string }[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <figure class="bar-list">
      <figcaption class="muted">{caption}</figcaption>
      {rows.map((r) => (
        <div class="bar-list-row" title={`${r.label}：${r.valueLabel}`}>
          <span class="bar-list-label">{r.label}</span>
          <span class="bar-list-track">
            <span class="bar-list-bar" style={{ width: max > 0 ? `${(r.value / max) * 100}%` : '0' }} />
          </span>
          <span class="bar-list-value">{r.valueLabel}</span>
        </div>
      ))}
    </figure>
  );
}
