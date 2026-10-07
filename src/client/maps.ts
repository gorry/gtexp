import { useEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

let loading: Promise<void> | null = null;

/** Maps JavaScript API を1回だけ読み込む */
export function loadMaps(key: string): Promise<void> {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    (window as any).__gtexpMapsReady = () => resolve();
    const script = document.createElement('script');
    const q = new URLSearchParams({ key, v: 'weekly', loading: 'async', libraries: 'marker', language: 'ja', region: 'JP', callback: '__gtexpMapsReady' });
    script.src = `https://maps.googleapis.com/maps/api/js?${q}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error('Google マップを読み込めませんでした'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** el の要素に地図を作る。API キーがなければ何もしない */
export function useGoogleMap(el: RefObject<HTMLDivElement>, apiKey: string, mapId: string) {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!apiKey) return;
    let alive = true;
    let stopLocate: (() => void) | null = null;
    loadMaps(apiKey)
      .then(() => {
        if (!alive || !el.current) return;
        const m = new google.maps.Map(el.current, {
          mapId,
          center: { lat: 35.68, lng: 139.76 },
          zoom: 10,
          gestureHandling: 'greedy',
          clickableIcons: true,
        });
        stopLocate = addLocateControl(m);
        setMap(m);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
      stopLocate?.();
    };
  }, [apiKey, mapId]);
  return { map, error };
}

/** 全体が入るように縮尺を合わせる。近づきすぎないよう maxZoom で止める */
export function fitTo(map: google.maps.Map, points: google.maps.LatLngLiteral[], maxZoom = 17): void {
  if (!points.length) return;
  const bounds = new google.maps.LatLngBounds();
  points.forEach((p) => bounds.extend(p));
  map.fitBounds(bounds, 40);
  google.maps.event.addListenerOnce(map, 'idle', () => {
    if ((map.getZoom() ?? 0) > maxZoom) map.setZoom(maxZoom);
  });
}

export const PIN_COLORS: Record<string, string> = {
  HOME: '#188038',
  INFERRED_HOME: '#188038',
  WORK: '#1a73e8',
  INFERRED_WORK: '#1a73e8',
};
export const PIN_DEFAULT = '#d93025';

/** 外部リンクだけを並べた吹き出しの中身を作る */
export function infoContent(title: string, links: [string, string][], extra?: Node): HTMLElement {
  const box = document.createElement('div');
  box.className = 'infowindow';
  const t = document.createElement('strong');
  t.textContent = title;
  const row = document.createElement('div');
  for (const [label, href] of links) {
    const a = document.createElement('a');
    a.href = href;
    if (/^https?:/.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    a.textContent = label;
    row.appendChild(a);
  }
  box.append(t, row);
  if (extra) box.appendChild(extra);
  return box;
}

/**
 * 地図の右下に「現在地」ボタンを付ける。押すと端末の位置（GPS など）を取って地図を寄せ、青い点と精度の円を出す。
 * 一度押したあとは位置が変わるたびに点を動かす（地図は動かさない。もう一度押すと寄せ直す）。止める関数を返す
 */
export function addLocateControl(map: google.maps.Map): () => void {
  if (!('geolocation' in navigator)) return () => {};
  const box = document.createElement('div');
  box.className = 'locate-control';
  const button = document.createElement('button');
  button.type = 'button';
  button.title = '現在地';
  button.setAttribute('aria-label', '現在地');
  // 照準の形のアイコン
  button.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="currentColor" stroke-width="2"/></svg>';
  const message = document.createElement('div');
  message.className = 'locate-message';
  message.hidden = true;
  box.append(message, button);
  map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(box);

  let watchId: number | null = null;
  let dot: google.maps.marker.AdvancedMarkerElement | null = null;
  let circle: google.maps.Circle | null = null;
  // 押したあと最初に位置が取れたときに、地図を寄せる
  let pendingPan = false;
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  const show = (text: string) => {
    message.textContent = text;
    message.hidden = false;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (message.hidden = true), 5000);
  };

  const onPosition = (pos: GeolocationPosition) => {
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (!dot) {
      const el = document.createElement('div');
      el.className = 'my-location';
      dot = new google.maps.marker.AdvancedMarkerElement({ map, position: p, content: el, title: '現在地', zIndex: 100000 });
      circle = new google.maps.Circle({ map, center: p, radius: pos.coords.accuracy, clickable: false, strokeColor: '#1a73e8', strokeOpacity: 0.4, strokeWeight: 1, fillColor: '#1a73e8', fillOpacity: 0.12 });
    } else {
      dot.position = p;
      circle?.setCenter(p);
      circle?.setRadius(pos.coords.accuracy);
    }
    button.classList.remove('busy');
    button.classList.add('active');
    if (pendingPan) {
      pendingPan = false;
      if ((map.getZoom() ?? 0) < 16) map.setZoom(16);
      map.panTo(p);
    }
  };

  const onError = (e: GeolocationPositionError) => {
    button.classList.remove('busy');
    // 追っている途中の一時的な失敗（電波の届かない所など）では知らせない。押した直後と、許可されていないときだけ
    const pressed = pendingPan;
    pendingPan = false;
    if (!pressed && e.code !== e.PERMISSION_DENIED) return;
    show(
      e.code === e.PERMISSION_DENIED
        ? '位置情報の利用が許可されていません（ブラウザの設定で、このサイトの位置情報を許可してください）'
        : '現在地を取得できませんでした',
    );
    if (e.code === e.PERMISSION_DENIED && watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  };

  button.addEventListener('click', () => {
    pendingPan = true;
    const last = dot?.position;
    if (watchId == null) {
      button.classList.add('busy');
      watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
    } else if (last) {
      // すでに追っているときは、最後の位置にすぐ寄せる
      pendingPan = false;
      if ((map.getZoom() ?? 0) < 16) map.setZoom(16);
      map.panTo(last as google.maps.LatLngLiteral);
    }
  });

  return () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    clearTimeout(messageTimer);
    if (dot) dot.map = null;
    circle?.setMap(null);
  };
}
