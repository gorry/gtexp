const FORMATS: [string, string, string][] = [
  ['csv', 'CSV', 'Excel などの表計算ソフト向け'],
  ['kml', 'KML', 'Google Earth・Google マイマップ向け'],
  ['gpx', 'GPX', '地図アプリ・GPS 機器向け'],
  ['geojson', 'GeoJSON', 'GIS ソフト・プログラム向け'],
];

interface Props {
  /** search（集計の条件）か places（場所の一覧の条件） */
  source: 'search' | 'places';
  /** 絞り込みの条件（limit / offset は含めない） */
  params: URLSearchParams;
  count: number;
  /** 件数の前に付ける説明（例：「滞在」） */
  label?: string;
}

/** いまの条件に合う記録を、全件ファイルに書き出すリンク */
export function ExportLinks({ source, params, count, label }: Props) {
  const href = (format: string) => {
    const p = new URLSearchParams(params);
    p.set('source', source);
    p.set('format', format);
    return `/api/export?${p}`;
  };
  return (
    <div class="export-links">
      <span class="muted">{label ? `${label} ` : ''}{count.toLocaleString()} 件を書き出す：</span>
      {FORMATS.map(([f, label, hint]) => (
        <a href={href(f)} download title={hint} class="export-link" aria-disabled={count === 0} onClick={(e) => count === 0 && e.preventDefault()}>
          {label}
        </a>
      ))}
    </div>
  );
}
