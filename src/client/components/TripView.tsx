import { useEffect, useRef, useState } from 'preact/hooks';
import type { ClientConfig, PathPoint, TripDestination, TripDetailResponse, Visit } from '../../shared/types';
import { api } from '../api';
import { duration, googleEarthUrl, googleMapsPlaceUrl, googleMapsUrl, hhmm, km, shortDate } from '../format';
import { PIN_COLORS, PIN_DEFAULT, fitTo, infoContent, useGoogleMap } from '../maps';
import { ExportLinks } from './ExportLinks';
import { visitName } from './MapView';
import { NoteForm } from './NoteForm';
import { destinationName, tripPeriod } from './TripsView';

export function TripView({ startMs, config }: { startMs: number; config: ClientConfig }) {
  const [data, setData] = useState<TripDetailResponse | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    api
      .trip(startMs)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [startMs]);

  if (error) return <p class="page error">{error}</p>;
  if (!data) return null;
  const t = data.trip;
  // 書き出しは日付の単位で絞る（旅行の最初の日から最後の日まで）
  const period = new URLSearchParams({ from: t.start.slice(0, 10), to: t.end.slice(0, 10) });
  const exportParams = (target: string) => {
    const p = new URLSearchParams(period);
    p.set('target', target);
    return p;
  };
  const updateDestination = (placeId: string, note: TripDestination['note']) => {
    setData({ ...data, trip: { ...t, destinationPlaces: t.destinationPlaces.map((d) => (d.placeId === placeId ? { ...d, note } : d)) } });
  };

  return (
    <div class="split-view">
      <aside class="side">
        <a class="back-link" href="#/trips" onClick={(e) => {
          if (history.length > 1) {
            e.preventDefault();
            history.back();
          }
        }}>
          ‹ 戻る
        </a>
        <h2 class="place-title">{tripPeriod(t)}</h2>
        <dl class="place-stats">
          <dt>日数</dt>
          <dd>{t.days} 日間</dd>
          {t.distanceKm != null && (
            <>
              <dt>出発地から</dt>
              <dd>{t.distanceKm.toLocaleString()} km</dd>
            </>
          )}
          <dt>滞在</dt>
          <dd>{t.visitCount} 件</dd>
          <dt>移動</dt>
          <dd>{t.activityCount} 件・{km(t.distanceM)}</dd>
        </dl>
        <ExportLinks source="search" params={exportParams('visits')} count={t.visitCount} label="滞在" />
        <ExportLinks source="search" params={exportParams('activities')} count={t.activityCount} label="移動" />

        <h3 class="section-title">行き先</h3>
        <p class="muted note">地域を指す場所なので、名前は Google マップで確かめて付けてください。</p>
        <ul class="destinations">
          {t.destinationPlaces.map((d, i) => (
            <DestinationItem d={d} i={i} onNote={updateDestination} />
          ))}
        </ul>

        <h3 class="section-title">日ごと</h3>
        <ul class="visit-dates">
          {data.days.map((d) => (
            <li>
              <a href={`#/day/${d.date}`}>{shortDate(d.date)}</a>
              <span class="muted">
                {' '}滞在 {d.visits} 件・移動 {km(d.distanceM)}
              </span>
            </li>
          ))}
        </ul>

        <h3 class="section-title">滞在先</h3>
        <ul class="visit-dates">
          {data.visits.map((v) => (
            <li id={`trip-visit-${v.id}`} class={selected === v.id ? 'selected' : ''} onClick={() => setSelected(v.id)}>
              <span class="muted">{shortDate(v.start.slice(0, 10)).replace(/^\d{4}\//, '')} {hhmm(v.start)}</span>{' '}
              <a href={`#/place/${encodeURIComponent(v.placeId)}`} onClick={(e) => e.stopPropagation()}>{visitName(v)}</a>
              <span class="muted">（{duration(v.startMs, v.endMs)}）</span>
            </li>
          ))}
        </ul>
      </aside>
      <section class="main">
        <TripMap
          config={config}
          visits={data.visits}
          path={data.path}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            document.getElementById(`trip-visit-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }}
        />
      </section>
    </div>
  );
}

function DestinationItem({ d, i, onNote }: { d: TripDestination; i: number; onNote: (placeId: string, note: TripDestination['note']) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <li>
      <strong>{destinationName(d, i)}</strong>
      <span class="visit-actions inline">
        <a href={googleMapsPlaceUrl(d.placeId)} target="_blank" rel="noopener">Google マップ</a>
        <button type="button" class="link-btn" onClick={() => setEditing(!editing)}>
          {d.note?.name ? '名前を変える' : '名前を付ける'}
        </button>
      </span>
      {editing && (
        <NoteForm
          placeId={d.placeId}
          note={d.note}
          onSaved={(note) => {
            onNote(d.placeId, note);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function TripMap({ config, visits, path, selected, onSelect }: {
  config: ClientConfig;
  visits: Visit[];
  path: PathPoint[];
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const { map, error } = useGoogleMap(el, config.mapsApiKey, config.mapId);
  const markers = useRef(new Map<number, google.maps.marker.AdvancedMarkerElement>());
  const info = useRef<google.maps.InfoWindow | null>(null);

  useEffect(() => {
    if (!map) return;
    info.current ??= new google.maps.InfoWindow();
    const line = path.length > 1
      ? new google.maps.Polyline({ map, path: path.map(([, lat, lng]) => ({ lat, lng })), strokeColor: '#4285f4', strokeOpacity: 0.8, strokeWeight: 3 })
      : null;
    visits.forEach((v) => {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: v.lat, lng: v.lng },
        title: visitName(v),
        gmpClickable: true,
        content: new google.maps.marker.PinElement({ background: PIN_COLORS[v.semanticType] ?? PIN_DEFAULT, borderColor: '#0000004d', glyphColor: '#fff', scale: 0.7 }),
      });
      marker.addEventListener('gmp-click', () => onSelect(v.id));
      markers.current.set(v.id, marker);
    });
    fitTo(map, [...path.map(([, lat, lng]) => ({ lat, lng })), ...visits.map((v) => ({ lat: v.lat, lng: v.lng }))], 15);
    return () => {
      line?.setMap(null);
      markers.current.forEach((m) => (m.map = null));
      markers.current.clear();
    };
  }, [map, visits, path]);

  useEffect(() => {
    if (!map || selected == null) return;
    const v = visits.find((x) => x.id === selected);
    const marker = markers.current.get(selected);
    if (!v || !marker) return;
    const when = document.createElement('div');
    when.textContent = `${shortDate(v.start.slice(0, 10))} ${hhmm(v.start)}〜${hhmm(v.end)}`;
    info.current?.setContent(
      infoContent(visitName(v), [
        ['この場所の記録', `#/place/${encodeURIComponent(v.placeId)}`],
        ['Google マップ', googleMapsUrl(v.lat, v.lng, v.placeId)],
        ['Google Earth', googleEarthUrl(v.lat, v.lng)],
      ], when),
    );
    info.current?.open({ map, anchor: marker });
    map.panTo({ lat: v.lat, lng: v.lng });
  }, [map, selected]);

  if (!config.mapsApiKey) {
    return (
      <div class="map map-placeholder">
        <p>地図を表示するには、サーバーの設定ファイルに <code>mapsApiKey</code> を設定してください。</p>
      </div>
    );
  }
  return (
    <div class="map">
      <div ref={el} class="map-canvas" />
      {error && <div class="map-error">{error}</div>}
    </div>
  );
}
