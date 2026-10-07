import { useEffect, useRef } from 'preact/hooks';
import type { Activity, PathPoint, Visit } from '../../shared/types';
import { activityLabel, areaShort, googleEarthUrl, googleMapsUrl, semanticLabel, visitNumbers } from '../format';
import { PIN_COLORS, PIN_DEFAULT, fitTo, infoContent, useGoogleMap } from '../maps';

type Named = Pick<Visit, 'note' | 'semanticType'> & { address?: Visit['address']; placeName?: Visit['placeName'] };

/** 名前の決め方：自分で付けた名前 → 自宅・職場など → 地点名（OpenStreetMap の施設名など）→ 住所 → 名前なし */
export function visitName(v: Named): string {
  return v.note?.name || semanticLabel(v.semanticType) || v.placeName?.shortText || areaShort(v.address) || '名前なし';
}

/** 名前の横に添える住所。名前がすでに住所なら空 */
export function areaHint(v: Named): string {
  const name = visitName(v);
  const a = areaShort(v.address);
  return a && a !== name ? a : '';
}

interface Props {
  apiKey: string;
  mapId: string;
  visits: Visit[];
  activities: Activity[];
  path: PathPoint[];
  selectedId: number | null;
  onSelect: (visitId: number) => void;
}

/** 日付から見る画面の地図：その日の滞在先・経路・移動 */
export function MapView({ apiKey, mapId, visits, activities, path, selectedId, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const { map, error } = useGoogleMap(el, apiKey, mapId);
  const info = useRef<google.maps.InfoWindow | null>(null);
  const overlays = useRef<{ markers: Map<number, google.maps.marker.AdvancedMarkerElement>; lines: google.maps.Polyline[] }>({ markers: new Map(), lines: [] });

  // データが変わったら描き直して全体が入るように合わせる
  useEffect(() => {
    if (!map) return;
    info.current ??= new google.maps.InfoWindow();
    const o = overlays.current;
    o.markers.forEach((mk) => (mk.map = null));
    o.markers.clear();
    o.lines.forEach((l) => l.setMap(null));
    o.lines = [];
    info.current.close();

    const points: google.maps.LatLngLiteral[] = [];
    if (path.length > 1) {
      const line = new google.maps.Polyline({
        map,
        path: path.map(([, lat, lng]) => ({ lat, lng })),
        strokeColor: '#4285f4',
        strokeOpacity: 0.85,
        strokeWeight: 4,
      });
      o.lines.push(line);
      path.forEach(([, lat, lng]) => points.push({ lat, lng }));
    }
    // 経路の点がない移動（飛行機など）は始点と終点を点線で結ぶ
    for (const a of activities) {
      const covered = path.some(([t]) => t >= a.startMs && t <= a.endMs);
      if (covered) continue;
      const line = new google.maps.Polyline({
        map,
        path: [{ lat: a.startLat, lng: a.startLng }, { lat: a.endLat, lng: a.endLng }],
        geodesic: a.type === 'FLYING',
        strokeOpacity: 0,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, strokeColor: '#5f6368', scale: 3 }, offset: '0', repeat: '14px' }],
      });
      o.lines.push(line);
      points.push({ lat: a.startLat, lng: a.startLng }, { lat: a.endLat, lng: a.endLng });
    }
    const numbers = visitNumbers(visits);
    visits.forEach((v) => {
      const nested = v.hierarchyLevel > 0;
      const pin = new google.maps.marker.PinElement({
        glyphText: nested ? '' : String(numbers.get(v.id) ?? ''),
        glyphColor: '#fff',
        background: nested ? '#9aa0a6' : PIN_COLORS[v.semanticType] ?? PIN_DEFAULT,
        borderColor: '#0000004d',
        scale: nested ? 0.75 : 1,
      });
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: v.lat, lng: v.lng },
        content: pin,
        title: visitName(v),
        gmpClickable: true,
      });
      marker.addListener('gmp-click', () => onSelect(v.id));
      o.markers.set(v.id, marker);
      points.push({ lat: v.lat, lng: v.lng });
    });
    fitTo(map, points);
  }, [map, visits, activities, path]);

  // 選んだ滞在先を吹き出しで示す
  useEffect(() => {
    if (!map || selectedId == null) return;
    const v = visits.find((x) => x.id === selectedId);
    const marker = overlays.current.markers.get(selectedId);
    if (!v || !marker) return;
    info.current?.setContent(
      infoContent(visitName(v), [
        ['この場所の記録', `#/place/${encodeURIComponent(v.placeId)}`],
        ['Google マップ', googleMapsUrl(v.lat, v.lng, v.placeId)],
        ['Google Earth', googleEarthUrl(v.lat, v.lng)],
      ]),
    );
    info.current?.open({ map, anchor: marker });
    map.panTo({ lat: v.lat, lng: v.lng });
  }, [map, selectedId, visits]);

  if (!apiKey) {
    return (
      <div class="map map-placeholder">
        <p>地図を表示するには、サーバーの設定ファイルに <code>mapsApiKey</code> を設定してください。</p>
        <p class="muted">
          {visits.length ? `滞在 ${visits.filter((v) => v.hierarchyLevel === 0).length} 件` : ''}
          {activities.length ? ` / 移動 ${activities.map((a) => activityLabel(a.type)[0]).join('')}` : ''}
        </p>
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
