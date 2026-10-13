import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Activity, ClientConfig, DayResponse, Visit } from '../../shared/types';
import { api } from '../api';
import { usePageTitle } from '../bookmarks';
import { activityLabel, addDays, visitNumbers, dateLabel, duration, googleEarthUrl, googleMapsUrl, km, semanticLabel, timeOnDay, todayIn } from '../format';
import { Calendar } from './Calendar';
import { MapView, areaHint, visitName } from './MapView';
import { NoteForm, TagList, EstimatedChip } from './NoteForm';

interface Props {
  date: string;
  config: ClientConfig;
  onDate: (date: string) => void;
}

type Item = { kind: 'visit'; v: Visit; no: number } | { kind: 'activity'; a: Activity };

export function DayView({ date, config, onDate }: Props) {
  usePageTitle(dateLabel(date));
  const [day, setDay] = useState<DayResponse | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  // スマホ幅では暦を畳んでおく（地図とリストを優先する）
  const [showCal, setShowCal] = useState(() => matchMedia('(min-width: 801px)').matches);

  useEffect(() => {
    let alive = true;
    setError('');
    setSelected(null);
    api
      .day(date)
      .then((d) => alive && setDay(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [date]);

  const items = useMemo<Item[]>(() => {
    if (!day) return [];
    const numbers = visitNumbers(day.visits);
    const list: (Item & { t: number; order: number })[] = [
      ...day.visits.map((v) => ({ kind: 'visit' as const, v, no: numbers.get(v.id) ?? 0, t: v.startMs, order: v.hierarchyLevel })),
      ...day.activities.map((a) => ({ kind: 'activity' as const, a, t: a.startMs, order: -1 })),
    ];
    // 同じ時刻なら、移動 → 主な滞在 → 入れ子の場所 の順
    return list.sort((x, y) => x.t - y.t || x.order - y.order);
  }, [day]);

  // 名前を付けたら、同じ場所の他の滞在にも反映する
  const updateNote = (placeId: string, note: Visit['note']) => {
    setDay((d) => d && { ...d, visits: d.visits.map((v) => (v.placeId === placeId ? { ...v, note } : v)) });
  };

  const totalKm = day ? day.activities.reduce((s, a) => s + a.distanceM, 0) : 0;

  return (
    <div class="split-view">
      <aside class="side">
        <div class="date-nav">
          <button type="button" class="icon-btn" onClick={() => onDate(addDays(date, -1))} title="前の日">‹</button>
          <input type="date" value={date} onChange={(e) => e.currentTarget.value && onDate(e.currentTarget.value)} />
          <button type="button" class="icon-btn" onClick={() => onDate(addDays(date, 1))} title="次の日">›</button>
          <button type="button" class="text-btn" onClick={() => onDate(todayIn(config.tzOffsetMinutes))}>今日</button>
          <button type="button" class="text-btn" onClick={() => setShowCal(!showCal)}>{showCal ? '暦を隠す' : '暦'}</button>
        </div>
        {showCal && <Calendar selected={date} onPick={onDate} />}

        <h2 class="day-title">{dateLabel(date)}</h2>
        {day && (day.visits.length > 0 || day.activities.length > 0) && (
          <p class="muted">滞在 {day.visits.filter((v) => v.hierarchyLevel === 0).length} 件・移動 {km(totalKm)}</p>
        )}
        {day?.trips.map((t) => (
          <a class="trip-banner" href={`#/trip/${t.startMs}`}>
            🧳 旅行中：{t.start.slice(0, 10)} 〜 {t.end.slice(0, 10)}
            {t.distanceKm ? `（出発地から ${t.distanceKm}km）` : ''}
            <span class="trip-banner-more">旅行の記録 ›</span>
          </a>
        ))}
        {error && <p class="error">{error}</p>}
        {day && items.length === 0 && <p class="muted">この日の記録はありません。</p>}

        <ol class="timeline">
          {items.map((it) =>
            it.kind === 'visit' ? (
              <VisitItem
                key={`v${it.v.id}`}
                v={it.v}
                no={it.no}
                date={date}
                selected={selected === it.v.id}
                onSelect={() => setSelected(it.v.id)}
                onNote={updateNote}
              />
            ) : (
              <ActivityItem key={`a${it.a.id}`} a={it.a} date={date} />
            ),
          )}
        </ol>
      </aside>
      <section class="main">
        <MapView
          apiKey={config.mapsApiKey}
          mapId={config.mapId}
          visits={day?.visits ?? []}
          activities={day?.activities ?? []}
          path={day?.path ?? []}
          selectedId={selected}
          onSelect={(id) => {
            setSelected(id);
            document.getElementById(`visit-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }}
        />
      </section>
    </div>
  );
}

function VisitItem({ v, no, date, selected, onSelect, onNote }: {
  v: Visit;
  no: number;
  date: string;
  selected: boolean;
  onSelect: () => void;
  onNote: (placeId: string, note: Visit['note']) => void;
}) {
  const [editing, setEditing] = useState(false);
  const label = semanticLabel(v.semanticType);
  const nested = v.hierarchyLevel > 0;
  return (
    <li id={`visit-${v.id}`} class={`visit${nested ? ' nested' : ''}${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span class={`badge type-${v.semanticType}`} title={nested ? '同じ時間帯の入れ子の場所' : undefined}>
        {nested ? '' : no}
      </span>
      <div class="visit-body">
        <div class="visit-time">
          {timeOnDay(v.start, date)} 〜 {timeOnDay(v.end, date)}
          <span class="muted">（{duration(v.startMs, v.endMs)}）</span>
          {v.estimated && <EstimatedChip />}
        </div>
        <div class="visit-name">
          <a href={`#/place/${encodeURIComponent(v.placeId)}`} onClick={(e) => e.stopPropagation()} title="この場所の記録を見る">
            {visitName(v)}
          </a>
          {v.note?.name && label && <span class="chip">{label}</span>}
          {v.note && <TagList tags={v.note.tags} />}
        </div>
        {v.note?.memo && !editing && <div class="visit-memo">{v.note.memo}</div>}
        <div class="visit-meta muted">
          {v.address ? areaHint(v) && `${areaHint(v)}・` : `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}・`}通算 {v.visitCount} 回
        </div>
        <div class="visit-actions" onClick={(e) => e.stopPropagation()}>
          <a href={googleMapsUrl(v.lat, v.lng, v.placeId)} target="_blank" rel="noopener">Google マップ</a>
          <a href={googleEarthUrl(v.lat, v.lng)} target="_blank" rel="noopener">Google Earth</a>
          <button type="button" class="link-btn" onClick={() => setEditing(!editing)}>
            {v.note?.name ? '名前を変える' : '名前を付ける'}
          </button>
        </div>
        {editing && (
          <NoteForm
            placeId={v.placeId}
            note={v.note}
            onSaved={(note) => {
              onNote(v.placeId, note);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>
    </li>
  );
}

function ActivityItem({ a, date }: { a: Activity; date: string }) {
  const [icon, label] = activityLabel(a.type);
  return (
    <li class="activity">
      <span class="activity-icon">{icon}</span>
      <span>
        {label}
        {a.distanceM > 0 && ` ${km(a.distanceM)}`}
        <span class="muted">
          {' '}{timeOnDay(a.start, date)} 〜 {timeOnDay(a.end, date)}（{duration(a.startMs, a.endMs)}）
        </span>
      </span>
    </li>
  );
}
