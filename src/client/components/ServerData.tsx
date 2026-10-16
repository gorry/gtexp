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
      setAssignResult(r.checked ? assignSummary(r) : '未照合の地点はありませんでした');
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
        <h3>住所データベース（位置参照情報）</h3>
        {summary.areas.areas === 0 ? (
          <p>未登録です。登録すると、名称未設定の地点に「〇〇市〇〇町一丁目」などの住所が自動付与されます。</p>
        ) : (
          <ul class="stats">
            <li>{summary.areas.prefectures} 都道府県・代表点 {summary.areas.areas.toLocaleString()} か所</li>
            <li>大字・町丁目まで判明：{summary.areas.places.toLocaleString()} / {summary.places.toLocaleString()} か所（未登録の都道府県や海外の地点を除く）</li>
            <li>街区（〇番）まで判明：{summary.areas.gaikuPlaces.toLocaleString()} か所</li>
            {summary.areas.pending > 0 && (
              <li class="note-strong">
                住所未照合の地点が {summary.areas.pending.toLocaleString()} か所あります（次回のタイムライン取り込み時にも自動で照合されます）。
                <button type="button" class="inline-btn" disabled={assigning} onClick={assignNow}>
                  {assigning ? '照合中…（約 1 分かかります）' : '今すぐ照合する'}
                </button>
              </li>
            )}
          </ul>
        )}
        <AdminNote text="位置参照情報データの登録はサーバー管理者が行います" />
        {assignResult && <p class="success">{assignResult}</p>}
        <AreaCredit />
      </section>

      <section class="card">
        <h3>施設名・住所（OpenStreetMap）</h3>
        <ul class="stats">
          <li>
            施設名：
            {summary.osm.pois > 0
              ? `施設データ ${summary.osm.pois.toLocaleString()} 件（${summary.osm.loadedAt ? new Date(summary.osm.loadedAt).toLocaleDateString() : ''} 登録）・施設名が付いた地点 ${summary.osm.poiPlaces.toLocaleString()} か所`
              : '未登録'}
          </li>
          <li>住所：照合済み {summary.osm.checked.toLocaleString()} / {summary.places.toLocaleString()} か所（取得済み {summary.osm.addr.toLocaleString()} か所）</li>
          {summary.osm.lastRun && (
            <li>
              最終取得日時 {new Date(summary.osm.lastRun.at).toLocaleString()}：{summary.osm.lastRun.done} か所
              {summary.osm.lastRun.remaining >= 0 && `・残り ${summary.osm.lastRun.remaining.toLocaleString()} か所`}
              {summary.osm.lastRun.stopped && <span class="error">（{summary.osm.lastRun.stopped}）</span>}
            </li>
          )}
        </ul>
        <details class="help">
          <summary>しくみ</summary>
          <p class="muted">
            施設名は、サーバーに登録された日本国内の OpenStreetMap データから、地点周辺の店舗・施設名を照合して付与します（タイムライン取り込み時および「今すぐ照合する」実行時）。
          </p>
          <p class="muted">
            住所は、未照合の地点を訪問頻度の高い順に OpenStreetMap（Nominatim）へ定期照会して取得します（海外の地点にも対応）。
          </p>
        </details>
        <AdminNote text="OpenStreetMap 施設データの登録および住所の定期取得設定はサーバー管理者が行います" />
        <OsmCredit />
      </section>
      {error && <p class="error">{error}</p>}
    </>
  );
}
