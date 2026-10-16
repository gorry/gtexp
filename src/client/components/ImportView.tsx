import { useEffect, useState } from 'preact/hooks';
import type { ImportRecord, SummaryResponse, TakeoutImportStats, ZipImportResult } from '../../shared/types';
import { reloadBookmarks, usePageTitle } from '../bookmarks';
import { api, uploadExport, uploadTakeout, type ImportResult, type UploadStage } from '../api';
import { assignSummary } from '../format';
import { clearCalendarCache } from './Calendar';
import { clearYearsCache } from './PeriodPicker';

const SHARE_CACHE = 'gtexp-share';
const SHARE_KEY = '/shared-file';

/** Service Worker が共有で受け取ったファイルを取り出す */
async function takeSharedFile(): Promise<{ blob: Blob; name: string } | null> {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const res = await cache.match(SHARE_KEY);
  if (!res) return null;
  await cache.delete(SHARE_KEY);
  return { blob: await res.blob(), name: decodeURIComponent(res.headers.get('X-File-Name') ?? 'shared.json') };
}

/** Takeout か Swarm の zip か（それ以外はタイムラインのエクスポートとして送る） */
const isZip = (name: string, type: string) => /\.zip$/i.test(name) || /zip/.test(type);

/** 書き出した名前・メモ・タグとブックマークのファイルか（JSON の先頭に gtexp-userdata の印がある） */
async function isUserData(f: { blob: Blob; name: string }): Promise<boolean> {
  if (/\.gz$/i.test(f.name)) return false;
  const head = await f.blob.slice(0, 200).text().catch(() => '');
  return /^\s*\{\s*"format"\s*:\s*"gtexp-userdata"/.test(head);
}

/** 取り込みの履歴を一度に出す件数 */
const HISTORY_PAGE = 20;

const IMPORT_KIND_LABELS: Record<ImportRecord['kind'], string> = {
  timeline: 'タイムライン',
  takeout: 'Google Takeout',
  swarm: 'Foursquare Swarm',
  userdata: 'ユーザーデータ（名前・メモ・タグ・ブックマーク）',
};

/** 取り込みの履歴の「内容」 */
function importDetail(h: ImportRecord): string {
  const n = (v: number) => (v ?? 0).toLocaleString();
  const d = h.detail ?? {};
  if (h.kind === 'timeline') return `${h.rangeStart?.slice(0, 10) ?? ''} 〜 ${h.rangeEnd?.slice(0, 10) ?? ''}・滞在 ${n(h.visits)} 件・移動 ${n(h.activities)} 件`;
  if (h.kind === 'swarm') return `チェックイン ${n(d.checkins)} 件（店 ${n(d.venues)} か所）`;
  if (h.kind === 'userdata') return `名前・メモ・タグ ${n(d.notes)} か所・ブックマーク ${n(d.bookmarks)} 件`;
  // Takeout は、zip に入っていて置き換えた種類だけ
  const count: Record<string, string> = {
    saved: `${n(d.saved)} 件`,
    labeled: `${n(d.labeled)} 件`,
    lists: `${n(d.listEntries)} 件`,
    reviews: `${n(d.reviews)} 件`,
    mymaps: `${n(d.mymaps)} 個（地点 ${n(d.mymapPoints)} か所）`,
  };
  return ((d.replaced ?? []) as string[]).map((k) => `${TAKEOUT_KIND_LABELS[k as keyof typeof TAKEOUT_KIND_LABELS]} ${count[k]}`).join('・');
}

const TAKEOUT_KIND_LABELS: Record<TakeoutImportStats['replaced'][number], string> = {
  saved: '保存した場所',
  labeled: 'ラベルを付けた場所',
  lists: '保存リスト',
  reviews: 'クチコミ',
  mymaps: 'マイマップ',
};

const STAGE_LABELS: Record<UploadStage, string> = {
  compress: '圧縮しています…',
  upload: '送信しています…',
  process: 'サーバーで取り込んでいます…',
};

export function ImportView({ query, onImported }: { query: URLSearchParams; onImported: () => void }) {
  usePageTitle('データの取り込み');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [history, setHistory] = useState<ImportRecord[]>([]);
  // 取り込みの履歴は新しい HISTORY_PAGE 件ずつ出す（「もっと見る」で続き）
  const [historyShown, setHistoryShown] = useState(HISTORY_PAGE);
  const [progress, setProgress] = useState<{ stage: UploadStage; ratio: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [takeoutResult, setTakeoutResult] = useState<ZipImportResult | null>(null);
  const [userDataResult, setUserDataResult] = useState('');
  const [error, setError] = useState(query.get('share') === 'failed' ? '共有されたファイルを受信できませんでした。下のボタンからファイルを選んでください。' : '');

  const reload = () => {
    api.summary().then(setSummary).catch(() => {});
    api.imports().then(setHistory).catch(() => {});
  };

  /**
   * 選んだファイルを送る。zip は Google Takeout か Swarm としてまとめて 1 回で（書き出しが複数の zip に分かれていることがあるため。
   * どちらかはサーバーが中身で決める）、
   * それ以外はタイムラインのエクスポートとして 1 つずつ送る
   */
  const upload = async (files: { blob: Blob; name: string }[]) => {
    setError('');
    setResult(null);
    setTakeoutResult(null);
    setUserDataResult('');
    const onProgress = (stage: UploadStage, ratio: number) => setProgress({ stage, ratio });
    const zips = files.filter((f) => isZip(f.name, f.blob.type));
    const others = files.filter((f) => !isZip(f.name, f.blob.type));
    // 書き出した名前・メモ・タグとブックマーク（.json）は中身の印で見分け、タイムラインとは別に読み込む
    const userData: typeof files = [];
    const timelines: typeof files = [];
    for (const f of others) ((await isUserData(f)) ? userData : timelines).push(f);
    try {
      for (const f of userData) {
        const r = await api.importUserData(f.blob, f.name);
        setUserDataResult(`名前・メモ・タグ ${r.notes.toLocaleString()} か所と、ブックマーク ${r.bookmarks.toLocaleString()} 件を読み込みました。`);
        reloadBookmarks().catch(() => {});
      }
      for (const f of timelines) {
        setResult(await uploadExport(f.blob, f.name, onProgress));
        clearCalendarCache();
        clearYearsCache();
        onImported();
      }
      if (zips.length) {
        setTakeoutResult(await uploadTakeout(zips.map((f) => f.blob), zips.map((f) => f.name), onProgress));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
      reload();
    }
  };

  useEffect(() => {
    reload();
    if (query.get('shared') === '1') {
      takeSharedFile().then((f) => f && upload([f]));
    }
  }, []);

  /** データを削除したあと：表示と、日付・年の一覧を読み直す */
  const afterDelete = () => {
    setResult(null);
    setTakeoutResult(null);
    clearCalendarCache();
    clearYearsCache();
    onImported();
    reload();
  };

  const onFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])].map((file) => ({ blob: file as Blob, name: file.name }));
    input.value = '';
    if (files.length) upload(files);
  };

  return (
    <div class="page">
      <a class="back-link" href="#/user">‹ ユーザー情報</a>
      <h2>データの取り込み</h2>

      <section class="card">
        <h3>ファイルのインポート</h3>
        <p class="muted">タイムラインのエクスポート（.json / .gz）、Google Takeout・Foursquare Swarm のアーカイブ（.zip）、エクスポートしたユーザーデータ（.json）を取り込めます。複数ファイルの同時選択も可能です。</p>
        <label class={`file-button${progress ? ' disabled' : ''}`}>
          ファイルを選択
          <input
            type="file"
            multiple
            accept=".json,.gz,.zip,application/json,application/gzip,application/zip"
            onChange={onFile}
            disabled={!!progress}
            hidden
          />
        </label>
        {progress && (
          <div class="progress">
            <span>{STAGE_LABELS[progress.stage]}</span>
            {progress.stage === 'upload' && <progress value={progress.ratio} max={1} />}
          </div>
        )}
        {result && (
          <p class="success">
            取り込みました：{result.rangeStart?.slice(0, 10)} 〜 {result.rangeEnd?.slice(0, 10)}、
            滞在 {result.visits.toLocaleString()} 件・移動 {result.activities.toLocaleString()} 件
            {result.addresses && result.addresses.checked > 0 && (
              <>
                <br />
                {assignSummary(result.addresses)}
              </>
            )}
          </p>
        )}
        {takeoutResult && (
          <p class="success">
            {takeoutResult.takeout && (
              <>
                Google Takeout を取り込みました（{takeoutResult.takeout.replaced.map((k) => TAKEOUT_KIND_LABELS[k]).join('・')}を更新
                {takeoutResult.takeout.replaced.length < 5 && '。含まれていない項目は既存のデータを維持'}）
                <br />
                保存した場所 {takeoutResult.takeout.saved.toLocaleString()} 件・ラベルを付けた場所 {takeoutResult.takeout.labeled.toLocaleString()} 件・
                保存リスト {takeoutResult.takeout.lists.length} 個（{takeoutResult.takeout.listEntries.toLocaleString()} 件）・クチコミ {takeoutResult.takeout.reviews.toLocaleString()} 件・
                マイマップ {takeoutResult.takeout.mymaps} 個（地点 {takeoutResult.takeout.mymapPoints.toLocaleString()} か所）
              </>
            )}
            {takeoutResult.takeout && takeoutResult.swarm && <br />}
            {takeoutResult.swarm && (
              <>
                Swarm のチェックインを取り込みました：{takeoutResult.swarm.checkins.toLocaleString()} 件（店 {takeoutResult.swarm.venues.toLocaleString()} か所）
              </>
            )}
            {takeoutResult.addresses.checked > 0 && (
              <>
                <br />
                {assignSummary(takeoutResult.addresses)}
              </>
            )}
          </p>
        )}
        {userDataResult && <p class="success">{userDataResult}</p>}
        {error && <p class="error">{error}</p>}
        <details class="help">
          <summary>タイムラインのエクスポート手順（Android）</summary>
          <ol>
            <li>端末の「設定」→「位置情報」→「位置情報サービス」→「タイムライン」を開きます</li>
            <li>「タイムライン データをエクスポート」でファイルを保存します</li>
            <li>保存したファイルを「共有」からこのアプリへ送るか、この画面の「ファイルを選択」から取り込みます</li>
          </ol>
          <p class="muted">
            取り込んだファイルの開始日以降のデータが更新されます（それより前の記録や、登録した名前・メモ・タグは保持されます）。
          </p>
        </details>
        <details class="help">
          <summary>Google Takeout のエクスポート手順</summary>
          <p class="muted">Google マップで保存した場所・ラベル・クチコミを書いた店・マイマップの地点の名前を、地点名として使えます。保存リストとマイマップは「保存リスト」のタブでも見られます。</p>
          <ol>
            <li>
              <a href="https://takeout.google.com/" target="_blank" rel="noopener">Google Takeout</a> で次の4つを選んで書き出し、zip をダウンロードします。
              「マップ」は「コンテンツ オプション」で「ラベルを付けた場所」のみを選択します（「写真と動画」は使用しないため選択不要です）
              <ul>
                <li>マップ（ラベルを付けた場所だけ）</li>
                <li>マップ（マイプレイス）：保存した場所（スター付きの場所）とクチコミ</li>
                <li>保存済み：保存リスト</li>
                <li>マイマップ</li>
              </ul>
            </li>
            <li>この画面の「ファイルを選択」から zip を取り込みます。複数の zip に分かれている場合は、まとめて選択できます（別々に送ってもかまいません）</li>
          </ol>
          <p class="muted">
            zip に含まれる項目（保存した場所・ラベル・保存リスト・クチコミ・マイマップ）ごとに既存データを更新します。取り込んだ地点データをもとに、近くの滞在先へ自動的に地点名や住所を割り当てます。また、移動経路がラベル付きの場所の近くを通過した場合は、短時間でも「立ち寄り（推定）」として滞在履歴に補完します（自宅・職場の周辺を除く）。
          </p>
        </details>
        <details class="help">
          <summary>Foursquare Swarm のエクスポート手順</summary>
          <p class="muted">Swarm でチェックインした店の名前を、地点名として使えます。</p>
          <ol>
            <li>
              Foursquare のアカウントの設定から、データのエクスポートを申し込みます。届いた zip をダウンロードします
            </li>
            <li>この画面の「ファイルを選択」から zip を取り込みます（Takeout の zip と同時に選択してもかまいません）</li>
          </ol>
          <p class="muted">
            チェックイン履歴のみを使用し、取り込みのたびに既存データを更新します。チェックインの日時と位置から対応する滞在先を照合し、最も多くチェックインした店舗名を地点名として割り当てます。
          </p>
        </details>
      </section>

      {summary && (
        <section class="card">
          <h3>タイムライン</h3>
          {summary.visits === 0 ? (
            <p>まだデータがありません。</p>
          ) : (
            <ul class="stats">
              <li>期間：{summary.firstDate} 〜 {summary.lastDate}</li>
              <li>滞在 {summary.visits.toLocaleString()} 件（場所 {summary.places.toLocaleString()} か所）</li>
              <li>移動 {summary.activities.toLocaleString()} 件・経路の点 {summary.points.toLocaleString()} 個</li>
              <li>旅行 {summary.trips.toLocaleString()} 件</li>
            </ul>
          )}
          {summary.visits > 0 && (
            <DeleteData
              kind="timeline"
              note="タイムラインのデータ（滞在・移動・経路・旅行）、インポート履歴、および自動付与された住所・地点名を削除します。登録した名前・メモ・タグ・ブックマーク、および OpenStreetMap から取得済みの住所は保持されます。復元するには再度ファイルをインポートしてください。"
              onDeleted={afterDelete}
            />
          )}
        </section>
      )}

      {summary && (
        <UserDataCard
          status={summary.userData}
          onChanged={() => {
            reloadBookmarks().catch(() => {});
            reload();
          }}
        />
      )}

      {summary && (
        <section class="card">
          <h3>地点名・住所（Google Takeout）</h3>
          {summary.takeout.loadedAt ? (
            <ul class="stats">
              <li>
                保存した場所 {summary.takeout.saved.toLocaleString()} 件・ラベルを付けた場所 {summary.takeout.labeled.toLocaleString()} 件・保存リスト {summary.takeout.listEntries.toLocaleString()} 件・
                クチコミ {summary.takeout.reviews.toLocaleString()} 件・マイマップ {summary.takeout.mymaps} 個（地点 {summary.takeout.mymapPoints.toLocaleString()} か所）
                （{new Date(summary.takeout.loadedAt).toLocaleDateString()} 取り込み）
              </li>
              <li>
                名前が付いた地点：保存した場所 {summary.takeout.savedPlaces.toLocaleString()} か所・ラベル {summary.takeout.labelPlaces.toLocaleString()} か所・
                クチコミ {summary.takeout.reviewPlaces.toLocaleString()} か所・マイマップ {summary.takeout.mymapPlaces.toLocaleString()} か所
              </li>
              <li>ラベルを付けた場所への立ち寄り（経路から推定した滞在）：{summary.takeout.labelStops.toLocaleString()} 件</li>
            </ul>
          ) : (
            <p>未取り込みです。上の「ファイルのインポート」から Takeout の zip を取り込むと、Google マップの保存済みスポットやラベル名を地点名として利用できます。</p>
          )}
          {summary.takeout.loadedAt && (
            <DeleteData
              kind="takeout"
              note="Google Takeout から取り込んだデータ（保存した場所・ラベル・保存リスト・クチコミ・マイマップ）、自動付与された地点名・住所、および推定の立ち寄りを削除します。復元するには再度ファイルをインポートしてください。"
              onDeleted={afterDelete}
            />
          )}
        </section>
      )}

      {summary && (
        <section class="card">
          <h3>地点名（Foursquare Swarm）</h3>
          {summary.swarm.loadedAt ? (
            <ul class="stats">
              <li>
                チェックイン {summary.swarm.checkins.toLocaleString()} 件（店 {summary.swarm.venues.toLocaleString()} か所）
                （{new Date(summary.swarm.loadedAt).toLocaleDateString()} 取り込み）
              </li>
              <li>店の名前が付いた地点：{summary.swarm.places.toLocaleString()} か所</li>
            </ul>
          ) : (
            <p>未取り込みです。上の「ファイルのインポート」から Swarm のエクスポート zip を取り込むと、チェックインした店舗名を地点名として利用できます。</p>
          )}
          {summary.swarm.loadedAt && (
            <DeleteData kind="swarm" note="Foursquare Swarm から取り込んだチェックイン履歴と、自動付与された店舗名を削除します。復元するには再度ファイルをインポートしてください。" onDeleted={afterDelete} />
          )}
        </section>
      )}

      {history.length > 0 && (
        <section class="card">
          <h3>インポート履歴</h3>
          <table class="history">
            <thead>
              <tr><th>日時</th><th>種別</th><th>内容</th></tr>
            </thead>
            <tbody>
              {history.slice(0, historyShown).map((h) => (
                <tr>
                  <td>{new Date(h.importedAt).toLocaleString()}</td>
                  <td>
                    {IMPORT_KIND_LABELS[h.kind]}
                    {h.fileName && <div class="muted history-file">{h.fileName}</div>}
                  </td>
                  <td>{importDetail(h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length > historyShown && (
            <button type="button" class="more-btn" onClick={() => setHistoryShown(historyShown + HISTORY_PAGE)}>
              もっと見る（残り {(history.length - historyShown).toLocaleString()} 件）
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/** 送ったデータを削除する。押すと「本当に削除しますか？」を出し、もう一度「削除」を押したら削除する */
function DeleteData({ kind, note, onDeleted }: { kind: 'timeline' | 'takeout' | 'swarm' | 'userdata'; note: string; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await api.deleteData(kind);
      setAsking(false);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="delete-data">
      {asking ? (
        <div class="delete-confirm">
          <p>
            <strong>本当に削除しますか？</strong>
          </p>
          <p class="muted">{note}</p>
          <div class="visit-actions">
            <button type="button" class="danger-btn" disabled={busy} onClick={run}>
              {busy ? '削除しています…' : '削除'}
            </button>
            <button type="button" class="text-btn" disabled={busy} onClick={() => setAsking(false)}>
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <button type="button" class="text-btn danger-text" onClick={() => setAsking(true)}>
          削除
        </button>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}

/** ユーザーデータ（名前・メモ・タグ・ブックマーク）：エクスポート（JSON）・削除する（復元するときは「ファイルのインポート」で送る） */
function UserDataCard({ status, onChanged }: { status: { notes: number; bookmarks: number }; onChanged: () => void }) {
  const empty = !status.notes && !status.bookmarks;
  return (
    <section class="card">
      <h3>ユーザーデータ（名前・メモ・タグ・ブックマーク）</h3>
      <ul class="stats">
        <li>名前・メモ・タグを付けた場所 {status.notes.toLocaleString()} か所</li>
        <li>ブックマーク {status.bookmarks.toLocaleString()} 件</li>
      </ul>
      <div class="visit-actions">
        {empty ? (
          <span class="file-button disabled">エクスポート（JSON）</span>
        ) : (
          <a class="file-button" href="/api/userdata" download>
            エクスポート（JSON）
          </a>
        )}
      </div>
      <p class="muted note">
        エクスポートしたファイルは、バックアップや別環境への移行に利用できます。上の「ファイルのインポート」から読み込むと既存データに統合されます（同一地点の名前・メモ・タグや同一画面のブックマーク名は上書きされます）。
      </p>
      {!empty && (
        <DeleteData
          kind="userdata"
          note="登録した名前・メモ・タグとブックマークをすべて削除します。事前に「エクスポート（JSON）」で保存しておくと、あとから再インポートして復元できます。"
          onDeleted={onChanged}
        />
      )}
    </section>
  );
}
