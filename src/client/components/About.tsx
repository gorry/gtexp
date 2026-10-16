import { useEffect, useState } from 'preact/hooks';
import type { HealthResponse, SummaryResponse } from '../../shared/types';
import { PROFILE } from '../../shared/profile.gen';
import { BUILD } from '../../shared/build.gen';
import { api } from '../api';
import { usePageTitle } from '../bookmarks';
import { ServerDataCards } from './ServerData';
// 著作権表示と第三者のソフトウェア・データの表示（リポジトリの NOTICE をビルドのときに埋め込む）
import notice from '../../../NOTICE?raw';

/** コミット（短い形）。コミットしていない変更を含むビルドには「+」を付ける */
function commitText(commit: string, dirty: boolean): string {
  return commit ? `${commit}${dirty ? '+' : ''}` : '不明';
}

function dateText(iso: string): string {
  return iso ? new Date(iso).toLocaleString() : '不明';
}

/**
 * このアプリについて：版・著作権表示・ビルドの情報（画面とサーバーのそれぞれ、どのコミットからいつ作ったか）と NOTICE。
 * ログインしていなくても見られる（ログインの画面から開く）
 */
export function About({ loggedIn }: { loggedIn: boolean }) {
  usePageTitle('このアプリについて');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState('');

  // 住所・施設名のデータ（全員で使うデータ）の状態は、ログインしているときだけ出す（調べた地点の数は利用者ごと）
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const loadSummary = () => {
    api.summary().then(setSummary).catch(() => {});
  };

  useEffect(() => {
    api.health().then(setHealth, (e) => setError((e as Error).message));
    if (loggedIn) loadSummary();
  }, []);

  // 画面とサーバーが別のコミットから作られている（画面が古いまま残っている、またはサーバーがまだ再起動していない）
  const mismatch = !!health && !!BUILD.commit && !!health.commit && (health.commit !== BUILD.commit || health.dirty !== BUILD.dirty);

  return (
    <div class="about-page">
      <p>
        <a href={loggedIn ? '#/day' : '#/'}>← {loggedIn ? '戻る' : 'ログイン画面へ'}</a>
      </p>
      <h1>{PROFILE.title}</h1>
      <p class="muted">Google タイムラインの移動・滞在履歴ビューア</p>

      <table class="about-table">
        <tbody>
          <tr>
            <th>バージョン</th>
            <td>{PROFILE.version}</td>
          </tr>
          <tr>
            <th>著作権</th>
            <td>{PROFILE.copyright}</td>
          </tr>
          {PROFILE.projectUrl && (
            <tr>
              <th>プロジェクト</th>
              <td>
                <a href={PROFILE.projectUrl} target="_blank" rel="noopener">
                  {PROFILE.projectUrl.replace(/^https?:\/\//, '')}
                </a>
              </td>
            </tr>
          )}
          <tr>
            <th>クライアント</th>
            <td>
              {commitText(BUILD.commit, BUILD.dirty)}（{BUILD.builtAt ? `${dateText(BUILD.builtAt)} ビルド` : '開発版'}）
            </td>
          </tr>
          <tr>
            <th>サーバー</th>
            <td>
              {health ? (
                <>
                  {health.version !== PROFILE.version && `${health.version} `}
                  {commitText(health.commit, health.dirty)}（{dateText(health.builtAt)} ビルド、{dateText(health.startedAt)} 起動）
                </>
              ) : error ? (
                <span class="error">{error}</span>
              ) : (
                '確認中…'
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {mismatch && (
        <p class="error">
          新しいバージョンが利用可能です。ページを再読み込みしてください。{' '}
          <button type="button" onClick={() => location.reload()}>
            再読み込み
          </button>
        </p>
      )}

      {summary && (
        <>
          <h2>住所・施設名のデータ</h2>
          <ServerDataCards summary={summary} onChanged={loadSummary} />
        </>
      )}

      <h2>ライセンスと表示</h2>
      <p>
        このソフトウェアは Apache License 2.0 で提供しています
        {PROFILE.projectUrl && (
          <>
            （
            <a href={`${PROFILE.projectUrl}/blob/main/LICENSE`} target="_blank" rel="noopener">
              LICENSE
            </a>
            ）
          </>
        )}
        。著作権表示および使用しているオープンソースソフトウェア・データの表記は以下のとおりです。
      </p>
      <pre class="notice">{notice}</pre>
    </div>
  );
}
