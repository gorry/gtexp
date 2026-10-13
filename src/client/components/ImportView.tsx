import { useEffect, useState } from 'preact/hooks';
import { PROFILE } from '../../shared/profile.gen';
import type { ImportRecord, SummaryResponse, TakeoutImportStats, ZipImportResult } from '../../shared/types';
import { api, uploadExport, uploadTakeout, type ImportResult, type UploadStage } from '../api';
import { usePageTitle } from '../bookmarks';
import { assignSummary } from '../format';
import { clearCalendarCache } from './Calendar';
import { clearYearsCache } from './PeriodPicker';
import { AreaCredit, OsmCredit } from './PlaceView';

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

/** Takeout か Swarm の zip か（それ以外はタイムラインのエクスポートとして送る） */
const isZip = (name: string, type: string) => /\.zip$/i.test(name) || /zip/.test(type);

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
  usePageTitle('取り込み');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [history, setHistory] = useState<ImportRecord[]>([]);
  const [progress, setProgress] = useState<{ stage: UploadStage; ratio: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [takeoutResult, setTakeoutResult] = useState<ZipImportResult | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assignResult, setAssignResult] = useState('');
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
    const onProgress = (stage: UploadStage, ratio: number) => setProgress({ stage, ratio });
    const zips = files.filter((f) => isZip(f.name, f.blob.type));
    const timelines = files.filter((f) => !isZip(f.name, f.blob.type));
    try {
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

  /** 取り込み直さずに、まだ調べていない地点の住所を調べる */
  const assignNow = async () => {
    setAssigning(true);
    setAssignResult('');
    setError('');
    try {
      const r = await api.assignAreas();
      setAssignResult(r.checked ? assignSummary(r) : '調べる地点はありませんでした');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAssigning(false);
    }
  };

  const onFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])].map((file) => ({ blob: file as Blob, name: file.name }));
    input.value = '';
    if (files.length) upload(files);
  };

  return (
    <div class="page">
      <h2>データの取り込み</h2>

      {summary && (
        <section class="card">
          <h3>いま入っているデータ</h3>
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
        </section>
      )}

      <section class="card">
        <h3>ファイルを送る</h3>
        <p class="muted">タイムラインのエクスポート（.json / .gz）と、Google Takeout・Foursquare Swarm の書き出し（.zip）を送れます。まとめて選んでもかまいません。</p>
        <label class={`file-button${progress ? ' disabled' : ''}`}>
          ファイルを選ぶ
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
                Google Takeout を取り込みました（{takeoutResult.takeout.replaced.map((k) => TAKEOUT_KIND_LABELS[k]).join('・')}を置き換え
                {takeoutResult.takeout.replaced.length < 5 && '。zip に入っていなかった種類は前のまま'}）
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
        {error && <p class="error">{error}</p>}
        <details class="help">
          <summary>タイムラインのエクスポートのしかた（Android）</summary>
          <ol>
            <li>端末の「設定」→「位置情報」→「位置情報サービス」→「タイムライン」を開きます</li>
            <li>「タイムライン データをエクスポート」でファイルを保存します</li>
            <li>保存したファイルを「共有」→「G Timeline Explorer」（または gtexp）で送るか、この画面で選びます</li>
          </ol>
          <p class="muted">
            ファイルには毎回、端末にある全期間が入っています。取り込むと、そのファイルの最初の日以降を新しい内容で置き換え、
            それより前のデータは残します。自分で付けた名前やメモは消えません。
          </p>
        </details>
        <details class="help">
          <summary>Google Takeout の書き出しかた</summary>
          <p class="muted">Google マップで保存した場所・ラベル・クチコミを書いた店・マイマップの地点の名前を、地点名として使えます。保存リストとマイマップは「保存リスト」のタブでも見られます。</p>
          <ol>
            <li>
              <a href="https://takeout.google.com/" target="_blank" rel="noopener">Google Takeout</a> で次の4つを選んで書き出し、zip をダウンロードします。
              「マップ」は「コンテンツ オプション」で「ラベルを付けた場所」だけにします（「写真と動画」は容量のほとんどを占めますが、使いません）
              <ul>
                <li>マップ（ラベルを付けた場所だけ）</li>
                <li>マップ（マイプレイス）：保存した場所（スター付きの場所）とクチコミ</li>
                <li>保存済み：保存リスト</li>
                <li>マイマップ</li>
              </ul>
            </li>
            <li>この画面の「ファイルを選ぶ」で zip を送ります。複数の zip に分かれているときは、全部を一度に選びます（別々に送ってもかまいません）</li>
          </ol>
          <p class="muted">
            zip に入っていた種類（保存した場所・ラベルを付けた場所・保存リスト・クチコミ・マイマップ）ごとに、前に入れたデータを置き換えます（zip そのものはサーバーに残しません）。保存した場所は、滞在先と同じ場所（2m 以内）か、
            同じ場所がなければ 30m 以内でいちばん近い滞在先 1 か所の地点名にします。ラベルを付けた場所は 30m 以内です。
            また、経路がラベルを付けた場所の 50m 以内に来た時間を、短くても「立ち寄り」として滞在に加えます（「推定」の印が付きます。自宅・職場の近くは除きます）。クチコミとマイマップの地点は、それぞれいちばん近い滞在先 1 か所（クチコミは 30m、マイマップは 30m 以内）に付けます。
          </p>
        </details>
        <details class="help">
          <summary>Foursquare Swarm の書き出しかた</summary>
          <p class="muted">Swarm でチェックインした店の名前を、地点名として使えます。</p>
          <ol>
            <li>
              Foursquare のアカウントの設定から、データのエクスポートを申し込みます。届いた zip をダウンロードします
            </li>
            <li>この画面の「ファイルを選ぶ」で zip を送ります（Takeout の zip と一緒に選んでもかまいません）</li>
          </ol>
          <p class="muted">
            使うのはチェックインだけです（zip そのものはサーバーに残さず、毎回全部を置き換えます）。チェックインした時刻にいた滞在先を探し、
            その場所でいちばん多くチェックインした店の名前を付けます。同じ時刻の滞在先が複数あれば、チェックインした位置にいちばん近いもの（300m 以内）です。
            時刻の合う滞在先がなければ、前後 10 分の滞在先（150m 以内）から探します。
          </p>
        </details>
      </section>

      {summary && (
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
                  <button type="button" class="inline-btn" disabled={assigning || !!progress} onClick={assignNow}>
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
      )}

      {summary && (
        <section class="card">
          <h3>地点名・住所（Google Takeout）</h3>
          {summary.takeout.loadedAt ? (
            <ul class="stats">
              <li>
                保存した場所 {summary.takeout.saved.toLocaleString()} 件・ラベルを付けた場所 {summary.takeout.labeled.toLocaleString()} 件・保存リスト {summary.takeout.listEntries.toLocaleString()} 件・
                クチコミ {summary.takeout.reviews.toLocaleString()} 件・マイマップ {summary.takeout.mymaps} 個（地点 {summary.takeout.mymapPoints.toLocaleString()} か所）
                （{new Date(summary.takeout.loadedAt).toLocaleDateString()} に入れたデータ）
              </li>
              <li>
                名前が付いた地点：保存した場所 {summary.takeout.savedPlaces.toLocaleString()} か所・ラベル {summary.takeout.labelPlaces.toLocaleString()} か所・
                クチコミ {summary.takeout.reviewPlaces.toLocaleString()} か所・マイマップ {summary.takeout.mymapPlaces.toLocaleString()} か所
              </li>
              <li>ラベルを付けた場所への立ち寄り（経路から推定した滞在）：{summary.takeout.labelStops.toLocaleString()} 件</li>
            </ul>
          ) : (
            <p>まだ入れていません。上の「ファイルを送る」で Takeout の zip を送ると、Google マップで保存した場所やラベルの名前を地点名として使えます。</p>
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
                （{new Date(summary.swarm.loadedAt).toLocaleDateString()} に入れたデータ）
              </li>
              <li>店の名前が付いた地点：{summary.swarm.places.toLocaleString()} か所</li>
            </ul>
          ) : (
            <p>まだ入れていません。上の「ファイルを送る」で Swarm の書き出しの zip を送ると、チェックインした店の名前を地点名として使えます。</p>
          )}
        </section>
      )}

      {summary && (
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
      )}

      {history.length > 0 && (
        <section class="card">
          <h3>取り込みの履歴</h3>
          <table class="history">
            <thead>
              <tr><th>日時</th><th>期間</th><th>滞在</th><th>移動</th></tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr>
                  <td>{new Date(h.importedAt).toLocaleString()}</td>
                  <td>{h.rangeStart?.slice(0, 10)} 〜 {h.rangeEnd?.slice(0, 10)}</td>
                  <td>{h.visits.toLocaleString()}</td>
                  <td>{h.activities.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
