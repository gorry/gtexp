import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ClientConfig, ListEntriesResponse, ListEntry, ListSummary } from '../../shared/types';
import { api } from '../api';
import { fitTo, infoContent, useGoogleMap } from '../maps';

/** 地図に出すピンの上限（多すぎると重くなる） */
const MAX_PINS = 2000;
const COLOR_VISITED = '#1a73e8';
const COLOR_NOT = '#e8710a';
/** 最後に見ていた地図の位置と一覧の位置。場所の詳細から戻ったときに同じところを出すため */
let lastView: { list: string; center: google.maps.LatLngLiteral; zoom: number; scroll: number } | null = null;

type Filter = '' | 'in' | 'out';
const FILTER_LABELS: Record<Filter, string> = { '': 'すべて', in: 'タイムラインにある', out: 'ない' };

function placeUrl(placeId: string): string {
  return `#/place/${encodeURIComponent(placeId)}`;
}

/** 位置の出どころの説明 */
function geoLabel(e: ListEntry): string {
  if (e.geo === 'takeout' || e.geo === 'mymap') return '';
  if (e.geo === 'pin') return '地図のピン';
  if (e.geo === 'osm') return `位置は OSM「${e.osmName}」から`;
  return e.candidates ? `位置不明（OSM に同じ名前が ${e.candidates} か所）` : '位置不明';
}

/**
 * Takeout の保存リストを見る。リストを選ぶと、店を一覧と地図に出す。タイムラインにある店は青、ない店は橙のピン。
 * タイムラインのデータは読むだけ
 */
export function ListsView({ config, query }: { config: ClientConfig; query: URLSearchParams }) {
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [list, setList] = useState(query.get('list') ?? '');
  const [filter, setFilter] = useState<Filter>((query.get('f') ?? '') as Filter);
  const [data, setData] = useState<ListEntriesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<{ index: number; seq: number } | null>(null);
  const sideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    api.lists().then(setLists).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    const p = new URLSearchParams();
    if (list) p.set('list', list);
    if (filter) p.set('f', filter);
    const q = p.toString();
    history.replaceState(null, '', `#/lists${q ? `?${q}` : ''}`);
  }, [list, filter]);

  useEffect(() => {
    setData(null);
    setFocus(null);
    if (!list) return;
    let alive = true;
    setLoading(true);
    setError('');
    api
      .listEntries(list)
      .then((r) => alive && setData(r))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [list]);

  const all = data?.entries ?? [];
  const counts = useMemo(
    () => ({
      in: all.filter((e) => e.place).length,
      out: all.filter((e) => !e.place).length,
      noGeo: all.filter((e) => e.lat == null).length,
      osm: all.filter((e) => e.geo === 'osm').length,
    }),
    [data],
  );
  const shown = useMemo(() => all.filter((e) => (filter === 'in' ? e.place : filter === 'out' ? !e.place : true)), [data, filter]);

  // 戻ってきたときは、一覧を前の位置まで送る
  useEffect(() => {
    if (!data || lastView?.list !== list || !sideRef.current) return;
    sideRef.current.scrollTop = lastView.scroll;
  }, [data]);

  const remember = (center?: google.maps.LatLngLiteral, zoom?: number) => {
    if (center && zoom != null) lastView = { list, center, zoom, scroll: sideRef.current?.scrollTop ?? 0 };
    else if (lastView) lastView.scroll = sideRef.current?.scrollTop ?? 0;
  };

  return (
    <div class="split-view">
      <aside class="side" ref={sideRef} onScroll={() => remember()}>
        <div class="filters">
          <select value={list} onChange={(e) => setList(e.currentTarget.value)} aria-label="保存リスト・マイマップ">
            <option value="">保存リスト・マイマップを選ぶ</option>
            {(['list', 'mymap'] as const).map(
              (kind) =>
                lists.some((l) => l.kind === kind) && (
                  <optgroup label={kind === 'list' ? '保存リスト' : 'マイマップ'}>
                    {lists
                      .filter((l) => l.kind === kind)
                      .map((l) => (
                        <option value={l.key}>
                          {l.list}（{l.count.toLocaleString()}）
                        </option>
                      ))}
                  </optgroup>
                ),
            )}
          </select>
          <div class="chips">
            {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
              <button type="button" class={`chip-btn${filter === f ? ' on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {FILTER_LABELS[f]}
                {data && `（${(f === 'in' ? counts.in : f === 'out' ? counts.out : all.length).toLocaleString()}）`}
              </button>
            ))}
          </div>
        </div>
        {error && <p class="error">{error}</p>}
        {!lists.length && !error && <p class="muted note">Takeout の保存リスト・マイマップがまだ入っていません（取り込みの画面で、Google Takeout の zip を送ってください）。</p>}
        {loading && <p class="muted result-count">読み込んでいます…</p>}
        {data && (
          <p class="muted result-count">
            {shown.length.toLocaleString()} か所
            {counts.noGeo > 0 && `・位置不明 ${counts.noGeo.toLocaleString()}`}
            {counts.osm > 0 && `・OSM から推定 ${counts.osm.toLocaleString()}`}
            {shown.filter((e) => e.lat != null).length > MAX_PINS && `（地図には ${MAX_PINS.toLocaleString()} か所まで）`}
          </p>
        )}
        {data && !data.osm.keys && (
          <p class="muted note">
            {data.osm.pois
              ? 'OSM の施設を名前で探す索引がまだないので、Takeout に位置のない店は位置不明になります（サーバーの管理者が作ります）。'
              : 'OSM の施設のデータがサーバーにないので、Takeout に位置のない店は位置不明になります（サーバーの管理者が入れます）。'}
          </p>
        )}
        <ol class="place-list">
          {shown.map((e, i) => (
            <li class={`visit${focus?.index === i ? ' selected' : ''}${e.lat == null ? ' no-geo' : ''}`} onClick={() => e.lat != null && setFocus((f) => ({ index: i, seq: (f?.seq ?? 0) + 1 }))}>
              <span class="badge dot" style={{ background: e.place ? COLOR_VISITED : COLOR_NOT }} />
              <div class="visit-body">
                <div class="visit-name">
                  <strong>{e.title || '（名前なし）'}</strong>
                </div>
                <div class="visit-meta">
                  {e.place ? (
                    <span>
                      {e.place.count.toLocaleString()} 回・最後 {e.place.lastDate}
                      {e.place.distM > 2 && <span class="muted">（{Math.round(e.place.distM)}m 離れた記録）</span>}
                    </span>
                  ) : (
                    <span class="muted">タイムラインにない</span>
                  )}
                  {geoLabel(e) && <span class="muted">・{geoLabel(e)}</span>}
                </div>
                {(e.memo || e.comment) && <div class="visit-memo">{[e.memo, e.comment].filter(Boolean).join(' / ')}</div>}
                <div class="visit-actions" onClick={(ev) => ev.stopPropagation()}>
                  {e.place && <a href={placeUrl(e.place.placeId)} onClick={() => remember()}>この場所の記録</a>}
                  {e.mapsUrl && (
                    <a href={e.mapsUrl} target="_blank" rel="noopener">
                      Google マップ
                    </a>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </aside>
      <section class="main">
        <ListMap config={config} list={list} entries={shown} focus={focus} onView={remember} />
      </section>
    </div>
  );
}

function ListMap({ config, list, entries, focus, onView }: {
  config: ClientConfig;
  list: string;
  entries: ListEntry[];
  focus: { index: number; seq: number } | null;
  onView: (center: google.maps.LatLngLiteral, zoom: number) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const { map, error } = useGoogleMap(el, config.mapsApiKey, config.mapId);
  const markers = useRef(new Map<ListEntry, google.maps.marker.AdvancedMarkerElement>());
  const info = useRef<google.maps.InfoWindow | null>(null);
  // 戻ってきたときの最初の描画では、覚えていた位置を優先する
  const restored = useRef(lastView?.list === list);

  useEffect(() => {
    if (!map) return;
    if (restored.current && lastView) {
      map.setCenter(lastView.center);
      map.setZoom(lastView.zoom);
    }
    const l = map.addListener('idle', () => {
      const c = map.getCenter();
      if (c) onView(c.toJSON(), map.getZoom() ?? 10);
    });
    return () => l.remove();
  }, [map]);

  const openInfo = (e: ListEntry, marker?: google.maps.marker.AdvancedMarkerElement) => {
    if (!map || e.lat == null || e.lng == null) return;
    info.current ??= new google.maps.InfoWindow();
    const links: [string, string][] = [];
    if (e.place) links.push(['この場所の記録', placeUrl(e.place.placeId)]);
    if (e.mapsUrl) links.push(['Google マップ', e.mapsUrl]);
    const detail = document.createElement('div');
    detail.textContent = [e.place ? `${e.place.count} 回・最後 ${e.place.lastDate}` : 'タイムラインにない', geoLabel(e)].filter(Boolean).join('・');
    info.current.setContent(infoContent(e.title || '（名前なし）', links, detail));
    if (marker) info.current.open({ map, anchor: marker });
    else {
      info.current.setPosition({ lat: e.lat, lng: e.lng });
      info.current.open({ map });
    }
  };

  useEffect(() => {
    if (!map) return;
    markers.current.forEach((m) => (m.map = null));
    markers.current.clear();
    info.current?.close();
    const pins = entries.filter((e) => e.lat != null && e.lng != null).slice(0, MAX_PINS);
    for (const e of pins) {
      const pin = new google.maps.marker.PinElement({
        background: e.place ? COLOR_VISITED : COLOR_NOT,
        borderColor: '#0000004d',
        glyphColor: '#fff',
        // OSM の名前から推定した位置は「?」を出して区別する
        glyphText: e.geo === 'osm' ? '?' : '',
        scale: 0.8,
      });
      const marker = new google.maps.marker.AdvancedMarkerElement({ map, position: { lat: e.lat!, lng: e.lng! }, content: pin, title: e.title, gmpClickable: true });
      marker.addListener('gmp-click', () => openInfo(e, marker));
      markers.current.set(e, marker);
    }
    if (!restored.current && pins.length) fitTo(map, pins.map((e) => ({ lat: e.lat!, lng: e.lng! })), 15);
    if (pins.length) restored.current = false;
  }, [map, entries]);

  useEffect(() => {
    if (!map || !focus) return;
    const e = entries[focus.index];
    if (!e || e.lat == null || e.lng == null) return;
    map.setZoom(17);
    map.panTo({ lat: e.lat, lng: e.lng });
    onView({ lat: e.lat, lng: e.lng }, 17);
    openInfo(e, markers.current.get(e));
  }, [map, focus?.seq]);

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
