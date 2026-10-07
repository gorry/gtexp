import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ClientConfig, PlaceKind, PlaceSort, PlaceSummary } from '../../shared/types';
import { api } from '../api';
import { googleEarthUrl, googleMapsUrl, semanticLabel, totalDuration } from '../format';
import { PIN_COLORS, PIN_DEFAULT, fitTo, infoContent, useGoogleMap } from '../maps';
import { areaHint, visitName } from './MapView';
import { TagList } from './NoteForm';
import { PeriodPicker } from './PeriodPicker';
import { ExportLinks } from './ExportLinks';
import { BulkTags, resetBulkTags } from './BulkTags';

const PAGE = 100;
/** 地図に出すピンの上限（多すぎると重くなる） */
const MAX_PINS = 300;
/** 最後に見ていた地図の位置。詳細画面から戻ったときに同じ範囲を出すため */
let lastView: { center: google.maps.LatLngLiteral; zoom: number } | null = null;

interface Filters {
  q: string;
  kind: PlaceKind;
  from: string;
  to: string;
  sort: PlaceSort;
  area: boolean;
}

function filtersFrom(query: URLSearchParams): Filters {
  return {
    q: query.get('q') ?? '',
    kind: (query.get('kind') ?? '') as PlaceKind,
    from: query.get('from') ?? '',
    to: query.get('to') ?? '',
    sort: (query.get('sort') ?? 'count') as PlaceSort,
    area: query.get('area') === '1',
  };
}

/** 既定値でない条件だけを URL に残す（一覧に戻ったときに条件を復元するため） */
function filtersToQuery(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.kind) p.set('kind', f.kind);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.sort !== 'count') p.set('sort', f.sort);
  if (f.area) p.set('area', '1');
  return p;
}

const SORT_LABELS: Record<PlaceSort, string> = {
  count: '回数が多い順',
  last: '最近行った順',
  first: '初めて行った順',
  duration: '滞在時間が長い順',
};

const KIND_LABELS: Record<PlaceKind, string> = {
  '': 'すべて',
  home: '自宅',
  work: '職場',
  named: '名前を付けた場所',
  unnamed: '名前のない場所',
};

/** ピンの色。まとめてタグ付けのときは選んでいる場所を青、外した場所を灰色に。それ以外は自宅・職場などの色 */
function pinColor(p: PlaceSummary, marks: Set<string> | null): string {
  if (marks) return marks.has(p.placeId) ? '#1a73e8' : '#9aa0a6';
  return PIN_COLORS[p.semanticType] ?? PIN_DEFAULT;
}

function placeUrl(placeId: string): string {
  return `#/place/${encodeURIComponent(placeId)}`;
}

export function PlacesView({ config, query }: { config: ClientConfig; query: URLSearchParams }) {
  const [filters, setFilters] = useState<Filters>(() => filtersFrom(query));
  const [qInput, setQInput] = useState(filters.q);
  const [bbox, setBbox] = useState('');
  const [items, setItems] = useState<PlaceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  // まとめてタグ付け：開いているか、その一覧（地図に出す）と選んでいる場所
  // 開いていることは URL にも残す（場所の詳細から「戻る」で戻ったときに開き直すため）
  const [bulk, setBulk] = useState(() => query.get('bulk') === '1');
  const [bulkItems, setBulkItems] = useState<PlaceSummary[]>([]);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  // 地図をその場所に寄せて拡大する指示（seq を変えると同じ場所でももう一度寄せる）
  const [focus, setFocus] = useState<{ placeId: string; seq: number } | null>(null);
  const request = useRef(0);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  // 検索語は打ち終わってから反映する
  useEffect(() => {
    const t = setTimeout(() => set({ q: qInput.trim() }), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const params = (offset: number) => {
    const p = filtersToQuery(filters);
    p.delete('area');
    if (filters.area && bbox) p.set('bbox', bbox);
    p.set('limit', String(PAGE));
    p.set('offset', String(offset));
    return p;
  };

  /** 書き出し用の条件：一覧と同じ条件（範囲で絞っていれば範囲も）で、件数の制限なし */
  const exportParams = () => {
    const q = params(0);
    q.delete('limit');
    q.delete('offset');
    return q;
  };

  const load = async (offset: number) => {
    const id = ++request.current;
    setLoading(true);
    setError('');
    try {
      const r = await api.places(params(offset));
      if (id !== request.current) return; // 条件が変わって古くなった応答は捨てる
      setTotal(r.total);
      setItems((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (filters.area && !bbox) return; // 地図の範囲がまだ分からない
    setSelected(null);
    load(0);
  }, [filters, filters.area ? bbox : '']);

  useEffect(() => {
    const p = filtersToQuery(filters);
    if (bulk) p.set('bulk', '1');
    const q = p.toString();
    history.replaceState(null, '', `#/places${q ? `?${q}` : ''}`);
  }, [filters, bulk]);

  return (
    <div class="split-view">
      <aside class="side">
        <div class="filters">
          <input type="search" value={qInput} onInput={(e) => setQInput(e.currentTarget.value)} placeholder="名前・メモ・住所、#タグで探す" />
          <div class="filter-row">
            <select value={filters.kind} onChange={(e) => set({ kind: e.currentTarget.value as PlaceKind })} aria-label="種類">
              {Object.entries(KIND_LABELS).map(([v, l]) => (
                <option value={v}>{l}</option>
              ))}
            </select>
            <select value={filters.sort} onChange={(e) => set({ sort: e.currentTarget.value as PlaceSort })} aria-label="並べ替え">
              {Object.entries(SORT_LABELS).map(([v, l]) => (
                <option value={v}>{l}</option>
              ))}
            </select>
          </div>
          <PeriodPicker from={filters.from} to={filters.to} onChange={(from, to) => set({ from, to })} />
          <label class="check">
            <input type="checkbox" checked={filters.area} onChange={(e) => set({ area: e.currentTarget.checked })} disabled={!config.mapsApiKey} />
            地図に見えている範囲だけ
          </label>
        </div>

        <p class="muted result-count">
          {loading && items.length === 0 ? '探しています…' : `${total.toLocaleString()} か所`}
          {total > MAX_PINS && items.length > 0 && `（地図には上位 ${Math.min(items.length, MAX_PINS)} か所）`}
        </p>
        {error && <p class="error">{error}</p>}
        {total > 0 && <ExportLinks source="places" params={exportParams()} count={total} />}
        {total > 0 && !bulk && (
          <button type="button" class="text-btn bulk-open" onClick={() => {
            resetBulkTags();
            setBulk(true);
          }}>まとめてタグ付け…</button>
        )}

        {bulk ? (
          <BulkTags
            params={exportParams()}
            onClose={() => setBulk(false)}
            onChanged={() => load(0)}
            onItems={(list, sel) => {
              setBulkItems(list);
              setBulkSelected(sel);
            }}
            onFocus={(placeId) => setFocus((f) => ({ placeId, seq: (f?.seq ?? 0) + 1 }))}
          />
        ) : (
          <ol class="place-list">
            {items.map((p, i) => (
              <PlaceItem key={p.placeId} p={p} rank={i + 1} selected={selected === p.placeId} onSelect={() => setSelected(p.placeId)} />
            ))}
          </ol>
        )}
        {!bulk && items.length < total && (
          <button type="button" class="more-btn" disabled={loading} onClick={() => load(items.length)}>
            {loading ? '読み込んでいます…' : `もっと見る（残り ${(total - items.length).toLocaleString()} か所）`}
          </button>
        )}
      </aside>
      <section class="main">
        <PlacesMap
          config={config}
          items={bulk ? bulkItems : items}
          marks={bulk ? bulkSelected : null}
          focus={bulk ? focus : null}
          selected={selected}
          // まとめてタグ付けの間は、地図を動かしても「見えている範囲」の条件を変えない（拡大した途端に一覧が絞られないように）
          area={filters.area && !bulk}
          onSelect={(id) => {
            setSelected(id);
            document.getElementById(`place-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }}
          onBounds={setBbox}
        />
      </section>
    </div>
  );
}

function PlaceItem({ p, rank, selected, onSelect }: { p: PlaceSummary; rank: number; selected: boolean; onSelect: () => void }) {
  const label = semanticLabel(p.semanticType);
  return (
    <li id={`place-${p.placeId}`} class={`visit${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span class={`badge type-${p.semanticType}`}>{rank}</span>
      <div class="visit-body">
        <div class="visit-name">
          <a href={placeUrl(p.placeId)} onClick={(e) => e.stopPropagation()}>{visitName(p)}</a>
          {p.note?.name && label && <span class="chip">{label}</span>}
          {p.note && <TagList tags={p.note.tags} />}
        </div>
        {areaHint(p) && <div class="visit-meta muted">{areaHint(p)}</div>}
        <div class="visit-time">
          <strong>{p.count.toLocaleString()} 回</strong>
          <span class="muted">・最後 {p.lastDate}・合計 {totalDuration(p.totalMs)}</span>
        </div>
        {p.note?.memo && <div class="visit-memo">{p.note.memo}</div>}
      </div>
    </li>
  );
}

function PlacesMap({ config, items, marks, focus, selected, area, onSelect, onBounds }: {
  config: ClientConfig;
  items: PlaceSummary[];
  /** まとめてタグ付けのとき：選んでいる場所（青）と、外した場所（灰色）でピンの色を変える */
  marks: Set<string> | null;
  /** この場所に地図を寄せて拡大する */
  focus: { placeId: string; seq: number } | null;
  selected: string | null;
  area: boolean;
  onSelect: (placeId: string) => void;
  onBounds: (bbox: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const { map, error } = useGoogleMap(el, config.mapsApiKey, config.mapId);
  const markers = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>());
  const pinEls = useRef(new Map<string, google.maps.marker.PinElement>());
  // 最後に全体が入るよう合わせたときの顔ぶれ（同じ顔ぶれなら合わせ直さない）
  const fittedKey = useRef('');
  const info = useRef<google.maps.InfoWindow | null>(null);
  const pins = useMemo(() => items.slice(0, MAX_PINS), [items]);
  // ピンの色を決めるときに使う、いまの選択（ピンを作るときにも使うので ref に持つ）
  const marksRef = useRef(marks);
  // 戻ってきたときの最初の描画では、覚えていた位置を優先する
  const restored = useRef(lastView !== null);

  // 地図の位置を覚えておき、作り直したときに復元する
  useEffect(() => {
    if (!map) return;
    if (lastView) {
      map.setCenter(lastView.center);
      map.setZoom(lastView.zoom);
    }
    const l = map.addListener('idle', () => {
      const c = map.getCenter();
      if (c) lastView = { center: c.toJSON(), zoom: map.getZoom() ?? 10 };
    });
    return () => l.remove();
  }, [map]);

  // 範囲で絞り込むときは、地図を動かし終わるたびに範囲を知らせる
  useEffect(() => {
    if (!map || !area) return;
    let timer: ReturnType<typeof setTimeout>;
    const report = () => {
      const b = map.getBounds();
      if (!b) return;
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      onBounds([sw.lat(), sw.lng(), ne.lat(), ne.lng()].map((n) => n.toFixed(5)).join(','));
    };
    // 作った直後は範囲が決まっていないので、決まった時点でも知らせる
    report();
    const once = google.maps.event.addListenerOnce(map, 'bounds_changed', report);
    const l = map.addListener('idle', () => {
      clearTimeout(timer);
      timer = setTimeout(report, 300);
    });
    return () => {
      clearTimeout(timer);
      once.remove();
      l.remove();
    };
  }, [map, area]);

  useEffect(() => {
    if (!map) return;
    info.current ??= new google.maps.InfoWindow();
    markers.current.forEach((m) => (m.map = null));
    markers.current.clear();
    pinEls.current.clear();
    pins.forEach((p, i) => {
      const pin = new google.maps.marker.PinElement({
        glyphText: i < 99 ? String(i + 1) : '',
        glyphColor: '#fff',
        background: pinColor(p, marksRef.current),
        borderColor: '#0000004d',
        scale: i < 10 ? 1 : 0.8,
      });
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: p.lat, lng: p.lng },
        content: pin,
        title: `${visitName(p)}（${p.count} 回）`,
        gmpClickable: true,
        zIndex: MAX_PINS - i,
      });
      marker.addListener('gmp-click', () => onSelect(p.placeId));
      markers.current.set(p.placeId, marker);
      pinEls.current.set(p.placeId, pin);
    });
    // 範囲で絞り込んでいるときは、地図を動かすと再検索になるので合わせ直さない
    if (!pins.length) return;
    // 合わせ直すのは顔ぶれが変わったときだけ（タグを付けたあとの読み直しなどで、拡大して見ていた位置が戻らないように）
    const key = pins.map((p) => p.placeId).join(',');
    if (!area && !restored.current && key !== fittedKey.current) fitTo(map, pins.map((p) => ({ lat: p.lat, lng: p.lng })), 15);
    fittedKey.current = key;
    restored.current = false;
  }, [map, pins]);

  // まとめてタグ付けのチェックを変えたときは、ピンを作り直さず色だけを変える
  useEffect(() => {
    marksRef.current = marks;
    for (const p of pins) {
      const pin = pinEls.current.get(p.placeId);
      if (pin) pin.background = pinColor(p, marks);
    }
  }, [marks]);

  // 指定した場所に寄せて拡大し、吹き出しを出す（ピンを出していない場所でも寄せる）
  useEffect(() => {
    if (!map || !focus) return;
    const p = items.find((x) => x.placeId === focus.placeId);
    if (!p) return;
    map.setZoom(17);
    map.panTo({ lat: p.lat, lng: p.lng });
    // 描き終わる（idle）前に吹き出しから詳細へ移っても、戻ったときにこの位置を出す
    lastView = { center: { lat: p.lat, lng: p.lng }, zoom: 17 };
    const detail = document.createElement('div');
    detail.textContent = `${p.count} 回・最後 ${p.lastDate}`;
    info.current?.setContent(
      infoContent(visitName(p), [
        ['この場所の記録', placeUrl(p.placeId)],
        ['Google マップ', googleMapsUrl(p.lat, p.lng, p.placeId)],
      ], detail),
    );
    const marker = markers.current.get(p.placeId);
    if (marker) info.current?.open({ map, anchor: marker });
    else {
      info.current?.setPosition({ lat: p.lat, lng: p.lng });
      info.current?.open({ map });
    }
  }, [map, focus?.seq]);

  useEffect(() => {
    if (!map || !selected) return;
    const p = items.find((x) => x.placeId === selected);
    const marker = markers.current.get(selected);
    if (!p || !marker) return;
    const detail = document.createElement('div');
    detail.textContent = `${p.count} 回・最後 ${p.lastDate}`;
    info.current?.setContent(
      infoContent(visitName(p), [
        ['この場所の記録', placeUrl(p.placeId)],
        ['Google マップ', googleMapsUrl(p.lat, p.lng, p.placeId)],
        ['Google Earth', googleEarthUrl(p.lat, p.lng)],
      ], detail),
    );
    info.current?.open({ map, anchor: marker });
    if (!area) map.panTo({ lat: p.lat, lng: p.lng });
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
