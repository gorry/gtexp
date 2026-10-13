import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ClientConfig, PlaceDetailResponse, PlaceVisit } from '../../shared/types';
import { api } from '../api';
import { usePageTitle } from '../bookmarks';
import { areaFull, duration, googleEarthUrl, googleMapsUrl, hhmm, semanticLabel, shortDate, totalDuration } from '../format';
import { PIN_COLORS, PIN_DEFAULT, useGoogleMap } from '../maps';
import { visitName } from './MapView';
import { NoteForm, TagList, hashtag, EstimatedChip } from './NoteForm';

export function PlaceView({ placeId, config }: { placeId: string; config: ClientConfig }) {
  const [data, setData] = useState<PlaceDetailResponse | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  usePageTitle(data ? visitName(data.place) : '場所');

  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    setEditing(false);
    api
      .place(placeId)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [placeId]);

  // 年ごとにまとめる（新しい年が上）
  const byYear = useMemo(() => {
    const groups: [string, PlaceVisit[]][] = [];
    for (const v of data?.visits ?? []) {
      const y = v.start.slice(0, 4);
      if (groups.length && groups[groups.length - 1][0] === y) groups[groups.length - 1][1].push(v);
      else groups.push([y, [v]]);
    }
    return groups;
  }, [data]);

  if (error) return <p class="page error">{error}</p>;
  if (!data) return null;
  const p = data.place;
  const label = semanticLabel(p.semanticType);

  return (
    <div class="split-view">
      <aside class="side">
        <a class="back-link" href="#/places" onClick={(e) => {
          // 一覧から来たときは、絞り込み条件ごと戻る
          if (history.length > 1) {
            e.preventDefault();
            history.back();
          }
        }}>
          ‹ 戻る
        </a>
        <h2 class="place-title">
          {visitName(p)}
          {p.note?.name && label && <span class="chip">{label}</span>}
        </h2>
        {p.note && <TagList tags={p.note.tags} />}
        {p.note?.memo && !editing && <p class="visit-memo">{p.note.memo}</p>}
        <div class="visit-actions">
          <a href={googleMapsUrl(p.lat, p.lng, p.placeId)} target="_blank" rel="noopener">Google マップ</a>
          <a href={googleEarthUrl(p.lat, p.lng)} target="_blank" rel="noopener">Google Earth</a>
          <button type="button" class="link-btn" onClick={() => setEditing(!editing)}>
            {p.note?.name ? '名前・メモを変える' : '名前を付ける'}
          </button>
        </div>
        {editing && (
          <NoteForm
            placeId={p.placeId}
            note={p.note}
            onSaved={(note) => {
              setData({ ...data, place: { ...p, note } });
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        )}

        <dl class="place-stats">
          <dt>訪問</dt>
          <dd>{p.count.toLocaleString()} 回</dd>
          <dt>初めて</dt>
          <dd><a href={`#/day/${p.firstDate}`}>{shortDate(p.firstDate)}</a></dd>
          <dt>最後</dt>
          <dd><a href={`#/day/${p.lastDate}`}>{shortDate(p.lastDate)}</a></dd>
          <dt>滞在の合計</dt>
          <dd>{totalDuration(p.totalMs)}</dd>
        </dl>

        {/* 訪問の記録：年ごとに折り畳む（新しい年だけ開いておく） */}
        <details class="place-fold" open>
          <summary>訪問回数（{p.count.toLocaleString()}回）</summary>
          {byYear.map(([year, visits], i) => (
            <details class="year-group" open={i === 0}>
              <summary>
                {year}年（{visits.length.toLocaleString()}回）
              </summary>
              <ul class="visit-dates">
                {visits.map((v) => (
                  <li>
                    <a href={`#/day/${v.start.slice(0, 10)}`}>{shortDate(v.start.slice(0, 10))}</a>
                    <span class="muted">
                      {' '}{hhmm(v.start)}〜{v.start.slice(0, 10) === v.end.slice(0, 10) ? '' : `${Number(v.end.slice(5, 7))}/${Number(v.end.slice(8, 10))} `}{hhmm(v.end)}（{duration(v.startMs, v.endMs)}）
                      {v.estimated && <EstimatedChip />}
                      {/* 入れ子の滞在には、外側の場所を添える（その場所の詳細へのリンク） */}
                      {v.hierarchyLevel > 0 &&
                        (v.parent ? (
                          <>
                            （<a href={`#/place/${encodeURIComponent(v.parent.placeId)}`}>{visitName(v.parent)}</a>内）
                          </>
                        ) : (
                          '（入れ子）'
                        ))}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </details>

        {/* 地点名・住所（取得方法ごと）と位置 */}
        <details class="place-fold">
          <summary>詳細</summary>
          <dl class="place-stats">
            {data.sources
              .filter((s) => s.status !== 'no-data')
              .map((s) => {
                const l = data.labels.find((x) => x.source === s.source);
                return (
                  <>
                    <dt>{s.kind === 'name' ? '地点名' : '住所'}</dt>
                    <dd>
                      {l ? (
                        areaFull(l)
                      ) : s.status === 'missing' ? (
                        <span class="muted">見つかりませんでした</span>
                      ) : (
                        <span class="muted">まだ調べていません</span>
                      )}
                      <span class="muted label-source">
                        {s.sourceName}
                        {l?.distM != null && `・基準点から ${l.distM.toLocaleString()}m`}
                      </span>
                      {s.status !== 'found' && s.note && <span class="muted label-source">{s.note}</span>}
                      {l?.source === 'takeout-saved' && l.detail && <TakeoutDetail detail={l.detail} />}
                      {l?.source === 'takeout-review' && l.detail && <ReviewDetail detail={l.detail} />}
                      {l?.source === 'takeout-mymap' && l.detail && <MyMapDetail detail={l.detail} />}
                      {l?.source === 'swarm-checkin' && l.detail && <SwarmDetail detail={l.detail} />}
                    </dd>
                  </>
                );
              })}
            <dt>位置</dt>
            <dd class="muted">{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</dd>
          </dl>
          {data.labels.some((l) => l.source.startsWith('isj')) && <AreaCredit />}
          {data.labels.some((l) => l.source.startsWith('osm')) && <OsmCredit />}
        </details>
      </aside>
      <section class="main">
        <PlaceMap config={config} lat={p.lat} lng={p.lng} semanticType={p.semanticType} title={visitName(p)} />
      </section>
    </div>
  );
}

function PlaceMap({ config, lat, lng, semanticType, title }: { config: ClientConfig; lat: number; lng: number; semanticType: string; title: string }) {
  const el = useRef<HTMLDivElement>(null);
  const { map, error } = useGoogleMap(el, config.mapsApiKey, config.mapId);
  useEffect(() => {
    if (!map) return;
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position: { lat, lng },
      title,
      content: new google.maps.marker.PinElement({ background: PIN_COLORS[semanticType] ?? PIN_DEFAULT, borderColor: '#0000004d', glyphColor: '#fff' }),
    });
    map.setCenter({ lat, lng });
    map.setZoom(16);
    return () => {
      marker.map = null;
    };
  }, [map, lat, lng]);

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

/** 位置参照情報の出典（公共データ利用規約により表示が必要） */
export function AreaCredit() {
  return (
    <p class="muted note credit">
      住所：<a href="https://nlftp.mlit.go.jp/isj/" target="_blank" rel="noopener">位置参照情報ダウンロードサービス（国土交通省）</a>を加工して作成。
      いちばん近い街区・大字町丁目の代表点から推定しているため、実際の住所と違うことがあります（特に大字・町丁目は、境界の近くで隣の町になりやすい）。
    </p>
  );
}

/** OpenStreetMap の帰属表示（ODbL により表示が必要） */
export function OsmCredit() {
  return (
    <p class="muted note credit">
      施設名・住所の一部：© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>（ODbL）。
      近くの施設を推定しているため、別の店や施設になっていることがあります。
    </p>
  );
}

/** Google Takeout のクチコミ（評価と本文・書いた日・Google マップのリンク） */
function ReviewDetail({ detail }: { detail: Record<string, string> }) {
  const url = detail.url?.replace(/^http:/, 'https:');
  return (
    <span class="takeout-detail">
      {detail.review && <span class="visit-memo">{detail.review}</span>}
      <span class="muted label-source">
        {detail.date && `${detail.date.slice(0, 10)} にクチコミ`}
        {url && (
          <>
            {detail.date && '・'}
            <a href={url} target="_blank" rel="noopener">Google マップで開く</a>
          </>
        )}
      </span>
    </span>
  );
}

/** Google Takeout のマイマップの地点（地図とフォルダーの名前・メモ）。地図の名前を押すと、保存リストのタブでその地図を開く */
function MyMapDetail({ detail }: { detail: Record<string, string> }) {
  return (
    <span class="takeout-detail">
      {detail.memo && <span class="visit-memo">{detail.memo}</span>}
      <span class="muted label-source">
        マイマップ「<a href={`#/lists?list=${encodeURIComponent(`mymap:${detail.map}`)}`}>{detail.map}</a>」
        {detail.folder && `（${detail.folder}）`}
      </span>
    </span>
  );
}

/** Foursquare Swarm のチェックイン（回数と期間・ひとこと・イベント・ほかにチェックインした店・Foursquare のリンク） */
function SwarmDetail({ detail }: { detail: Record<string, string> }) {
  const period = detail.first === detail.last ? detail.first : `${detail.first} 〜 ${detail.last}`;
  return (
    <span class="takeout-detail">
      {detail.shouts && <span class="visit-memo">{detail.shouts}</span>}
      <span class="muted label-source">
        チェックイン {detail.count} 回（{period}）
        {detail.events && `・${detail.events}`}
        {detail.url && (
          <>
            ・<a href={detail.url} target="_blank" rel="noopener">Foursquare で開く</a>
          </>
        )}
      </span>
      {detail.others && <span class="muted label-source">ほかにチェックインした店：{detail.others}</span>}
    </span>
  );
}

/** Google Takeout の保存した場所に付いていた情報（保存リスト・コメント・保存日・Google マップのリンク） */
function TakeoutDetail({ detail }: { detail: Record<string, string> }) {
  const url = detail.url?.replace(/^http:/, 'https:');
  return (
    <span class="takeout-detail">
      {detail.lists && (
        <span class="tags">
          {detail.lists.split('、').map((t) => (
            <a class="tag" href={`#/places?q=${encodeURIComponent(hashtag(t))}`}>{hashtag(t)}</a>
          ))}
        </span>
      )}
      {detail.comment && <span class="visit-memo">{detail.comment}</span>}
      <span class="muted label-source">
        {detail.savedAt && `${detail.savedAt.slice(0, 10)} に保存`}
        {url && (
          <>
            {detail.savedAt && '・'}
            <a href={url} target="_blank" rel="noopener">Google マップで開く</a>
          </>
        )}
      </span>
    </span>
  );
}
