import { useEffect, useState } from 'preact/hooks';
import type { ImportRecord, SummaryResponse } from '../../shared/types';
import { api, uploadExport, type ImportResult, type UploadStage } from '../api';
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

const STAGE_LABELS: Record<UploadStage, string> = {
  compress: '圧縮しています…',
  upload: '送信しています…',
  process: 'サーバーで取り込んでいます…',
};

export function ImportView({ query, onImported }: { query: URLSearchParams; onImported: () => void }) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [history, setHistory] = useState<ImportRecord[]>([]);
  const [progress, setProgress] = useState<{ stage: UploadStage; ratio: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assignResult, setAssignResult] = useState('');
  const [error, setError] = useState(query.get('share') === 'failed' ? '共有されたファイルを受け取れませんでした。下のボタンからファイルを選んでください。' : '');

  const reload = () => {
    api.summary().then(setSummary).catch(() => {});
    api.imports().then(setHistory).catch(() => {});
  };

  const upload = async (blob: Blob, name: string) => {
    setError('');
    setResult(null);
    try {
      const r = await uploadExport(blob, name, (stage, ratio) => setProgress({ stage, ratio }));
      setResult(r);
      clearCalendarCache();
      clearYearsCache();
      reload();
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  useEffect(() => {
    reload();
    if (query.get('shared') === '1') {
      takeSharedFile().then((f) => f && upload(f.blob, f.name));
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
    const file = input.files?.[0];
    input.value = '';
    if (file) upload(file, file.name);
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
        <h3>エクスポートしたファイルを送る</h3>
        <label class={`file-button${progress ? ' disabled' : ''}`}>
          ファイルを選ぶ
          <input type="file" accept=".json,.gz,application/json,application/gzip" onChange={onFile} disabled={!!progress} hidden />
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
        {error && <p class="error">{error}</p>}
        <details class="help">
          <summary>エクスポートのしかた（Android）</summary>
          <ol>
            <li>端末の「設定」→「位置情報」→「位置情報サービス」→「タイムライン」を開く</li>
            <li>「タイムライン データをエクスポート」でファイルを保存する</li>
            <li>保存したファイルを「共有」→「G Timeline Explorer」（または gtexp）で送るか、この画面で選ぶ</li>
          </ol>
          <p class="muted">
            ファイルには毎回、端末にある全期間が入っています。取り込むと、そのファイルの最初の日以降を新しい内容で置き換え、
            それより前のデータは残します。自分で付けた名前やメモは消えません。
          </p>
        </details>
      </section>

      {summary && (
        <section class="card">
          <h3>住所のデータ（位置参照情報）</h3>
          {summary.areas.areas === 0 ? (
            <p>まだ入っていません。入れると、名前のない場所に「〇〇市〇〇町一丁目」のような住所が付きます。</p>
          ) : (
            <ul class="stats">
              <li>{summary.areas.prefectures} 都道府県・代表点 {summary.areas.areas.toLocaleString()} か所</li>
              <li>大字・町丁目まで分かった場所 {summary.areas.places.toLocaleString()} / {summary.places.toLocaleString()} か所（付いていないのは、データのない都道府県や海外など）</li>
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
          <details class="help">
            <summary>入れかた</summary>
            <ol>
              <li><a href="https://nlftp.mlit.go.jp/isj/" target="_blank" rel="noopener">位置参照情報ダウンロードサービス</a>で「大字・町丁目レベル」と「街区レベル」の、必要な都道府県の最新版をダウンロードする（zip のまま、ファイル名も変えない）</li>
              <li>サーバーの <code>~/gtexp/data/isj/</code> に置き、<code>cd ~/gtexp &amp;&amp; sh deploy/import-isj.sh</code> を実行する（街区の zip は、そのフォルダーに置いたままにする）</li>
              <li>次にタイムラインを取り込むと、すべての地点に住所が付く（以降は、取り込みのたびに新しい地点にだけ付く）</li>
            </ol>
            <p class="muted">同じ都道府県を入れ直すと置き換わり、次の取り込みで全地点を調べ直します。</p>
          </details>
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
                保存した場所 {summary.takeout.saved.toLocaleString()} 件・ラベルを付けた場所 {summary.takeout.labeled.toLocaleString()} 件・保存リスト {summary.takeout.listEntries.toLocaleString()} 件
                （{new Date(summary.takeout.loadedAt).toLocaleDateString()} に入れたデータ）
              </li>
              <li>
                保存した場所の名前が付いた地点 {summary.takeout.savedPlaces.toLocaleString()} か所・ラベルの名前が付いた地点 {summary.takeout.labelPlaces.toLocaleString()} か所
              </li>
            </ul>
          ) : (
            <p>まだ入れていません。Google マップで保存した場所やラベルの名前を、地点名として使えます。</p>
          )}
          <details class="help">
            <summary>入れかた</summary>
            <ol>
              <li>
                <a href="https://takeout.google.com/" target="_blank" rel="noopener">Google Takeout</a> で次の3つを選んで書き出し、zip をダウンロードする。
                「マップ」は「コンテンツ オプション」で「ラベルを付けた場所」だけにする（「写真と動画」は容量のほとんどを占めるが使わない）
                <ul>
                  <li>マップ（ラベルを付けた場所だけ）</li>
                  <li>マップ（マイプレイス）</li>
                  <li>保存済み</li>
                </ul>
              </li>
              <li>サーバーの <code>~/gtexp/data/takeout/</code> に zip を置き、<code>cd ~/gtexp &amp;&amp; node dist/server.mjs import-takeout data/takeout</code> を実行する</li>
              <li>「今すぐ調べる」か、次のタイムラインの取り込みで地点名が付く</li>
            </ol>
            <p class="muted">
              保存した場所は、滞在先と同じ場所（既定 2m 以内）のときだけ地点名にします。ラベルを付けた場所は 30m 以内です。
              書き出し直したときは、同じように入れ直すと全部置き換わります。
            </p>
          </details>
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
            <summary>しくみと入れかた</summary>
            <p class="muted">
              施設名は、日本の OpenStreetMap のデータから名前の付いた店や施設を取り出してサーバーに入れておき、地点から 60m 以内のものを付けます
              （タイムラインの取り込みのたびと「今すぐ調べる」で）。データを入れる・新しくするときは、サーバーで <code>sh deploy/make-osm-poi.sh</code> を実行します。
            </p>
            <p class="muted">
              住所は、サーバーの cron で毎時 <code>deploy/fetch-osm.sh</code> を起動し、まだ調べていない地点をよく行く順に最大 150 か所、
              OpenStreetMap の Nominatim に問い合わせて貯めます（問い合わせは 15〜25 秒に1回で、公開サーバーの利用規約の範囲）。海外の地点にも付きます。
            </p>
          </details>
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
