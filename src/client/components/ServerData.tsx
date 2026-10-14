import { useState } from 'preact/hooks';
import { PROFILE } from '../../shared/profile.gen';
import type { SummaryResponse } from '../../shared/types';
import { api } from '../api';
import { assignSummary } from '../format';
import { AreaCredit, OsmCredit } from './PlaceView';

// サーバーの管理者が入れる、全員で使うデータ（位置参照情報・OpenStreetMap）の状態。「このアプリについて」に出す
// （ログインしているときだけ。調べた地点の数は、ログインしている利用者の記録についてのもの）

/** 管理者向けの説明（位置参照情報・OpenStreetMap などのサーバーのデータは、この画面ではなく管理者が入れる） */
const ADMIN_DOC_URL = PROFILE.projectUrl ? `${PROFILE.projectUrl}/blob/main/deploy/README.md` : '';

function AdminNote({ text }: { text: string }) {
  return (
    <p class="muted">
      {text}
      {ADMIN_DOC_URL && (
        <>
          （管理者向けの説明：
          <a href={ADMIN_DOC_URL} target="_blank" rel="noopener">
            設置手順
          </a>
          ）
        </>
      )}
      。
    </p>
  );
}

export function ServerDataCards({ summary, onChanged }: { summary: SummaryResponse; onChanged: () => void }) {
  const [assigning, setAssigning] = useState(false);
  const [assignResult, setAssignResult] = useState('');
  const [error, setError] = useState('');

  /** 取り込み直さずに、まだ調べていない地点の住所を調べる */
  const assignNow = async () => {
    setAssigning(true);
    setAssignResult('');
    setError('');
    try {
      const r = await api.assignAreas();
      setAssignResult(r.checked ? assignSummary(r) : '調べる地点はありませんでした');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAssigning(false);
    }
  };

  return (
    <>
      <section class="card">
        <h3>住所のデータ（位置参照情報）</h3>
        {summary.areas.areas === 0 ? (
          <p>まだ入っていません。入ると、名前のない場所に「〇〇市〇〇町一丁目」のような住所が付きます。</p>
        ) : (
          <ul class="stats">
            <li>{summary.areas.prefectures} 都道府県・代表点 {summary.areas.areas.toLocaleString()} か所</li>
            <li>大字・町丁目まで分かった場所 {summary.areas.places.toLocaleString()} / {summary.places.toLocaleString()} か所（付いていないのは、データのない都道府県や海外などの場所です）</li>
            <li>街区（〇番）まで分かった場所 {summary.areas.gaikuPlaces.toLocaleString()} か所（街区の代表点が 150m 以内にある場所）</li>
            {summary.areas.pending > 0 && (
              <li class="note-strong">
                まだ住所を調べていない地点が {summary.areas.pending.toLocaleString()} か所あります。次にタイムラインを取り込んだときに調べます。
                <button type="button" class="inline-btn" disabled={assigning} onClick={assignNow}>
                  {assigning ? '調べています…（全国分で 1 分ほど）' : '今すぐ調べる'}
                </button>
              </li>
            )}
          </ul>
        )}
        <AdminNote text="位置参照情報は、サーバーの管理者が入れます" />
        {assignResult && <p class="success">{assignResult}</p>}
        <AreaCredit />
      </section>

      <section class="card">
        <h3>施設名・住所（OpenStreetMap）</h3>
        <ul class="stats">
          <li>
            施設名：
            {summary.osm.pois > 0
              ? `施設 ${summary.osm.pois.toLocaleString()} 件（${summary.osm.loadedAt ? new Date(summary.osm.loadedAt).toLocaleDateString() : ''} に入れたデータ）・施設名の付いた地点 ${summary.osm.poiPlaces.toLocaleString()} か所`
              : 'まだデータを入れていません'}
          </li>
          <li>住所：調べた地点 {summary.osm.checked.toLocaleString()} / {summary.places.toLocaleString()} か所（住所が取れた地点 {summary.osm.addr.toLocaleString()} か所）</li>
          {summary.osm.lastRun && (
            <li>
              住所の最後の取得 {new Date(summary.osm.lastRun.at).toLocaleString()}：{summary.osm.lastRun.done} か所
              {summary.osm.lastRun.remaining >= 0 && `・残り ${summary.osm.lastRun.remaining.toLocaleString()} か所`}
              {summary.osm.lastRun.stopped && <span class="error">（{summary.osm.lastRun.stopped}）</span>}
            </li>
          )}
        </ul>
        <details class="help">
          <summary>しくみ</summary>
          <p class="muted">
            施設名は、サーバーに入れてある日本の OpenStreetMap のデータから、地点から 60m 以内の名前の付いた店や施設を付けます
            （タイムラインの取り込みのたびと「今すぐ調べる」で）。
          </p>
          <p class="muted">
            住所は、サーバーが毎時、まだ調べていない地点をよく行く順に少しずつ OpenStreetMap の住所検索に問い合わせて貯めます
            （利用規約の範囲で、15〜25 秒に1回）。海外の地点にも付きます。
          </p>
        </details>
        <AdminNote text="OpenStreetMap の施設のデータを入れることと、住所を毎時取る設定は、サーバーの管理者が行います" />
        <OsmCredit />
      </section>
      {error && <p class="error">{error}</p>}
    </>
  );
}
