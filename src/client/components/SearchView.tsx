import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Activity, PlaceKind, RecordGap, SearchGroup, SearchGroupRow, SearchResponse, SearchTarget, Visit } from '../../shared/types';
import { api } from '../api';
import { filteredTitle, usePageTitle } from '../bookmarks';
import { ACTIVITY_TYPES, WEEKDAYS, activityLabel, duration, hhmm, km, semanticLabel, shortDate, timeOnDay, totalDuration } from '../format';
import { BarChart, BarList, type Bar } from './BarChart';
import { ExportLinks } from './ExportLinks';
import { visitName } from './MapView';
import { TagList, EstimatedChip } from './NoteForm';
import { PeriodPicker } from './PeriodPicker';

const PAGE = 100;

type Measure = 'count' | 'days' | 'time' | 'distance';

interface Filters {
  target: SearchTarget;
  from: string;
  to: string;
  weekdays: number[];
  q: string;
  kind: PlaceKind;
  modes: string[];
  group: SearchGroup;
  measure: Measure;
}

const DEFAULTS: Filters = { target: 'visits', from: '', to: '', weekdays: [], q: '', kind: '', modes: [], group: 'year', measure: 'count' };

function filtersFrom(query: URLSearchParams): Filters {
  const list = (key: string) => (query.get(key) ?? '').split(',').filter(Boolean);
  return {
    target: (query.get('target') as SearchTarget) || DEFAULTS.target,
    from: query.get('from') ?? '',
    to: query.get('to') ?? '',
    weekdays: list('weekdays').map(Number),
    q: query.get('q') ?? '',
    kind: (query.get('kind') ?? '') as PlaceKind,
    modes: list('modes'),
    group: (query.get('group') as SearchGroup) || DEFAULTS.group,
    measure: (query.get('measure') as Measure) || DEFAULTS.measure,
  };
}

/** 画面の URL 用（既定値は省く）。measure は画面だけの設定 */
function filtersToQuery(f: Filters, forApi: boolean): URLSearchParams {
  const p = new URLSearchParams();
  if (forApi || f.target !== DEFAULTS.target) p.set('target', f.target);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.weekdays.length) p.set('weekdays', f.weekdays.join(','));
  if (f.target === 'visits') {
    if (f.q) p.set('q', f.q);
    if (f.kind) p.set('kind', f.kind);
  } else if (f.target === 'activities' && f.modes.length) {
    p.set('modes', f.modes.join(','));
  }
  if (forApi || f.group !== DEFAULTS.group) p.set('group', f.group);
  if (!forApi && f.measure !== DEFAULTS.measure) p.set('measure', f.measure);
  return p;
}

const GROUP_LABELS: Record<SearchGroup, string> = {
  year: '年ごと',
  month: '月ごと',
  weekday: '曜日ごと',
  hour: '時間帯ごと（始まった時刻）',
  mode: '移動手段ごと',
};

const KIND_LABELS: Record<PlaceKind, string> = {
  '': 'すべての場所',
  home: '自宅',
  work: '職場',
  named: '名前を付けた場所',
  unnamed: '名前のない場所',
};

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function measureValue(row: SearchGroupRow, m: Measure): number {
  if (m === 'count') return row.count;
  if (m === 'days') return row.days;
  if (m === 'time') return row.totalMs;
  return row.distanceM;
}

const TARGET_LABELS: Record<SearchTarget, string> = { visits: '滞在', activities: '移動', gaps: '記録なし' };

function measureText(row: SearchGroupRow, m: Measure, target: SearchTarget): string {
  if (m === 'count') return `${row.count.toLocaleString()}${target === 'activities' ? '件' : '回'}`;
  if (m === 'days') return `${row.days.toLocaleString()}日`;
  if (m === 'time') return totalDuration(row.totalMs);
  return km(row.distanceM);
}

function groupLabel(group: SearchGroup, key: string): string {
  if (group === 'year') return `${key}年`;
  if (group === 'month') return `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月`;
  if (group === 'weekday') return `${WEEKDAYS[Number(key)]}曜`;
  if (group === 'hour') return `${Number(key)}時台`;
  const [icon, label] = activityLabel(key);
  return `${icon} ${label}`;
}

/** 年・月・曜日・時間帯は、記録のない区切りも 0 として並べる */
function fillGroups(group: SearchGroup, rows: SearchGroupRow[]): SearchGroupRow[] {
  const zero = (key: string): SearchGroupRow => ({ key, count: 0, days: 0, totalMs: 0, distanceM: 0 });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  let keys: string[] = [];
  if (group === 'weekday') keys = ['0', '1', '2', '3', '4', '5', '6'];
  else if (group === 'hour') keys = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  else if (group === 'year' && rows.length && rows.every((r) => /^\d{4}$/.test(r.key))) {
    for (let y = Number(rows[0].key); y <= Number(rows[rows.length - 1].key); y++) keys.push(String(y));
  } else if (group === 'month' && rows.length && rows.every((r) => /^\d{4}-\d{2}$/.test(r.key))) {
    let [y, m] = rows[0].key.split('-').map(Number);
    const last = rows[rows.length - 1].key;
    // キーの形は上で確かめているが、念のため 1000 か月（約83年）で打ち切る
    for (let i = 0; i < 1000; i++) {
      const k = `${y}-${String(m).padStart(2, '0')}`;
      keys.push(k);
      if (k >= last) break;
      if (++m > 12) [y, m] = [y + 1, 1];
    }
  } else return rows;
  return keys.map((k) => byKey.get(k) ?? zero(k));
}

function tickFor(group: SearchGroup, key: string, i: number, n: number): string {
  if (group === 'year') return i === 0 || i === n - 1 || Number(key) % 5 === 0 ? `'${key.slice(2)}` : '';
  if (group === 'month') {
    // 1年分くらいなら月の数字、それより長ければ各年の1月に年を出す
    if (n <= 13) return `${Number(key.slice(5, 7))}`;
    return key.endsWith('-01') || i === 0 ? `'${key.slice(2, 4)}` : '';
  }
  if (group === 'weekday') return WEEKDAYS[Number(key)];
  if (group === 'hour') return Number(key) % 6 === 0 ? String(Number(key)) : '';
  return '';
}

export function SearchView({ query }: { query: URLSearchParams }) {
  const [filters, setFilters] = useState<Filters>(() => filtersFrom(query));
  const [qInput, setQInput] = useState(filters.q);
  usePageTitle(filteredTitle('集計', filters.q, filters.from, filters.to));
  // 結果は、取得したときのまとめ方と組で持つ（まとめ方を変えた直後に、古い結果を新しいまとめ方で読まないため）
  const [data, setData] = useState<(SearchResponse & { group: SearchGroup }) | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [gaps, setGaps] = useState<RecordGap[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  useEffect(() => {
    const t = setTimeout(() => set({ q: qInput.trim() }), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const load = async (offset: number) => {
    const id = ++request.current;
    setLoading(true);
    setError('');
    const group = filters.group;
    const p = filtersToQuery(filters, true);
    p.set('limit', String(PAGE));
    p.set('offset', String(offset));
    try {
      const r = await api.search(p);
      if (id !== request.current) return;
      if (offset === 0) setData({ ...r, group });
      setVisits((prev) => (offset === 0 ? r.visits : [...prev, ...r.visits]));
      setActivities((prev) => (offset === 0 ? r.activities : [...prev, ...r.activities]));
      setGaps((prev) => (offset === 0 ? r.gaps : [...prev, ...r.gaps]));
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  // measure の切り替えでは読み直さない
  const { measure, ...apiFilters } = filters;
  useEffect(() => {
    const q = filtersToQuery(filters, false).toString();
    history.replaceState(null, '', `#/search${q ? `?${q}` : ''}`);
  }, [filters]);
  useEffect(() => {
    load(0);
  }, [JSON.stringify(apiFilters)]);

  const isVisits = filters.target === 'visits';
  const isActivities = filters.target === 'activities';
  const isGaps = filters.target === 'gaps';
  // グラフと表は、結果を取得したときのまとめ方で描く
  const group = data?.group ?? filters.group;
  const groups = useMemo(() => (data ? fillGroups(data.group, data.groups) : []), [data]);
  const effectiveMeasure: Measure = !isActivities && measure === 'distance' ? 'count' : measure;
  const shown = data ? data.totals.count : 0;
  const loaded = isVisits ? visits.length : isActivities ? activities.length : gaps.length;

  const bars: Bar[] = groups.map((g, i) => ({
    key: g.key,
    tip: `${groupLabel(group, g.key)} ${measureText(g, effectiveMeasure, filters.target)}`,
    tick: tickFor(group, g.key, i, groups.length),
    value: measureValue(g, effectiveMeasure),
    valueLabel: measureText(g, effectiveMeasure, filters.target),
  }));
  const countName = isActivities ? '件数' : '回数';
  const measureName = { count: countName, days: '日数', time: '時間', distance: '距離' }[effectiveMeasure];

  return (
    <div class="page wide">
      <h2>集計</h2>
      <section class="card filters-card">
        <div class="segmented" role="radiogroup" aria-label="対象">
          {(['visits', 'activities', 'gaps'] as SearchTarget[]).map((t) => (
            <button
              type="button"
              role="radio"
              aria-checked={filters.target === t}
              class={filters.target === t ? 'active' : ''}
              onClick={() => set({ target: t, group: t !== 'activities' && filters.group === 'mode' ? 'year' : filters.group })}
            >
              {TARGET_LABELS[t]}
            </button>
          ))}
        </div>
        <PeriodPicker from={filters.from} to={filters.to} onChange={(from, to) => set({ from, to })} />
        <div class="chips" aria-label="曜日">
          {WEEKDAYS.map((w, i) => (
            <button type="button" class={`chip-btn${filters.weekdays.includes(i) ? ' on' : ''}`} aria-pressed={filters.weekdays.includes(i)} onClick={() => set({ weekdays: toggle(filters.weekdays, i).sort() })}>
              {w}
            </button>
          ))}
          <span class="muted chips-note">{filters.weekdays.length ? '' : 'すべての曜日'}</span>
        </div>
        {isVisits ? (
          <div class="filter-row">
            <input type="search" value={qInput} onInput={(e) => setQInput(e.currentTarget.value)} placeholder="場所の名前・メモ・住所、#タグ" />
            <select value={filters.kind} onChange={(e) => set({ kind: e.currentTarget.value as PlaceKind })} aria-label="種類">
              {Object.entries(KIND_LABELS).map(([v, l]) => (
                <option value={v}>{l}</option>
              ))}
            </select>
          </div>
        ) : isActivities ? (
          <div class="chips" aria-label="移動手段">
            {ACTIVITY_TYPES.map((t) => {
              const [icon, label] = activityLabel(t);
              const on = filters.modes.includes(t);
              return (
                <button type="button" class={`chip-btn${on ? ' on' : ''}`} aria-pressed={on} onClick={() => set({ modes: toggle(filters.modes, t) })}>
                  {icon} {label}
                </button>
              );
            })}
            <span class="muted chips-note">{filters.modes.length ? '' : 'すべての移動手段'}</span>
          </div>
        ) : (
          <p class="muted note">滞在にも移動にも記録されていない時間です（10 分未満の隙間は除きます）。端末の電源が切れていたときや、位置の記録が止まっていたときに起こります。</p>
        )}
        {isVisits && !filters.q && !filters.kind && (
          <p class="muted note">入れ子の場所は数えていません（時間が二重にならないように）。場所で絞ると入れ子も含めます。</p>
        )}
      </section>

      {error && <p class="error">{error}</p>}
      {data && (
        <>
          <div class="stat-tiles">
            <div class="stat"><span class="stat-value">{data.totals.count.toLocaleString()}</span><span class="stat-label">{isActivities ? '件' : '回'}</span></div>
            <div class="stat"><span class="stat-value">{data.totals.days.toLocaleString()}</span><span class="stat-label">日</span></div>
            <div class="stat"><span class="stat-value">{totalDuration(data.totals.totalMs)}</span><span class="stat-label">{isVisits ? '滞在' : isActivities ? '移動時間' : '記録なし'}</span></div>
            {isActivities && <div class="stat"><span class="stat-value">{km(data.totals.distanceM)}</span><span class="stat-label">距離</span></div>}
          </div>

          <section class="card">
            <div class="filter-row chart-controls">
              <select value={filters.group} onChange={(e) => set({ group: e.currentTarget.value as SearchGroup })} aria-label="まとめ方">
                {Object.entries(GROUP_LABELS)
                  .filter(([g]) => isActivities || g !== 'mode')
                  .map(([v, l]) => (
                    <option value={v}>{l}</option>
                  ))}
              </select>
              <select value={effectiveMeasure} onChange={(e) => set({ measure: e.currentTarget.value as Measure })} aria-label="値">
                <option value="count">{countName}</option>
                <option value="days">日数</option>
                <option value="time">時間</option>
                {isActivities && <option value="distance">距離</option>}
              </select>
            </div>
            {group === 'mode' ? (
              <BarList
                caption={`移動手段ごとの${measureName}`}
                rows={[...groups]
                  .sort((a, b) => measureValue(b, effectiveMeasure) - measureValue(a, effectiveMeasure))
                  .map((g) => ({ key: g.key, label: groupLabel('mode', g.key), value: measureValue(g, effectiveMeasure), valueLabel: measureText(g, effectiveMeasure, filters.target) }))}
              />
            ) : (
              <BarChart
                caption={`${GROUP_LABELS[group].replace(/（.*）/, '')}の${measureName}${group === 'year' ? '（棒を押すとその年の月ごとへ）' : ''}`}
                bars={bars}
                onPick={group === 'year' ? (y) => set({ from: `${y}-01-01`, to: `${y}-12-31`, group: 'month' }) : undefined}
              />
            )}
            <details class="group-table">
              <summary>表で見る</summary>
              <table class="history">
                <thead>
                  <tr>
                    <th>{GROUP_LABELS[group].replace(/ごと.*/, '')}</th>
                    <th>{countName}</th>
                    <th>日数</th>
                    <th>時間</th>
                    {isActivities && <th>距離</th>}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr>
                      <td>{groupLabel(group, g.key)}</td>
                      <td>{g.count.toLocaleString()}</td>
                      <td>{g.days.toLocaleString()}</td>
                      <td>{totalDuration(g.totalMs)}</td>
                      {isActivities && <td>{km(g.distanceM)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          <section class="card">
            <h3>記録（新しい順）</h3>
            {!isGaps && <ExportLinks source="search" params={filtersToQuery(filters, true)} count={shown} />}
            {shown === 0 && <p class="muted">条件に合う記録はありません。</p>}
            <ul class="record-list">
              {isVisits
                ? visits.map((v) => <VisitRow v={v} />)
                : isActivities
                  ? activities.map((a) => <ActivityRow a={a} />)
                  : gaps.map((g) => <GapRow g={g} />)}
            </ul>
            {loaded < shown && (
              <button type="button" class="more-btn" disabled={loading} onClick={() => load(loaded)}>
                {loading ? '読み込んでいます…' : `もっと見る（残り ${(shown - loaded).toLocaleString()} 件）`}
              </button>
            )}
          </section>
        </>
      )}
      {!data && loading && <p class="muted">集計しています…</p>}
    </div>
  );
}

function VisitRow({ v }: { v: Visit }) {
  const date = v.start.slice(0, 10);
  const label = semanticLabel(v.semanticType);
  return (
    <li>
      <a class="record-date" href={`#/day/${date}`}>{shortDate(date)}</a>
      <span class="muted">{hhmm(v.start)}〜{hhmm(v.end)}（{duration(v.startMs, v.endMs)}）</span>
      <a href={`#/place/${encodeURIComponent(v.placeId)}`}>{visitName(v)}</a>
      {v.note?.name && label && <span class="chip">{label}</span>}
      {v.hierarchyLevel > 0 && <span class="chip">入れ子</span>}
      {v.estimated && <EstimatedChip />}
      {v.note && <TagList tags={v.note.tags} />}
    </li>
  );
}

/** 記録なし。日をまたぐときは終わりにも日付を付ける */
function GapRow({ g }: { g: RecordGap }) {
  const date = g.start.slice(0, 10);
  return (
    <li>
      <a class="record-date" href={`#/day/${date}`}>{shortDate(date)}</a>
      <span class="muted">{hhmm(g.start)}〜{timeOnDay(g.end, date)}（{duration(g.startMs, g.endMs)}）</span>
      <span>記録なし</span>
    </li>
  );
}

function ActivityRow({ a }: { a: Activity }) {
  const date = a.start.slice(0, 10);
  const [icon, label] = activityLabel(a.type);
  return (
    <li>
      <a class="record-date" href={`#/day/${date}`}>{shortDate(date)}</a>
      <span class="muted">{hhmm(a.start)}〜{hhmm(a.end)}（{duration(a.startMs, a.endMs)}）</span>
      <span>{icon} {label}</span>
      {a.distanceM > 0 && <span>{km(a.distanceM)}</span>}
    </li>
  );
}
