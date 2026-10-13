import { useEffect, useState } from 'preact/hooks';
import type { HealthResponse } from '../../shared/types';
import { PROFILE } from '../../shared/profile.gen';
import { BUILD } from '../../shared/build.gen';
import { api } from '../api';
import { usePageTitle } from '../bookmarks';
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

  useEffect(() => {
    api.health().then(setHealth, (e) => setError((e as Error).message));
  }, []);

  // 画面とサーバーが別のコミットから作られている（画面が古いまま残っている、またはサーバーがまだ再起動していない）
  const mismatch = !!health && !!BUILD.commit && !!health.commit && (health.commit !== BUILD.commit || health.dirty !== BUILD.dirty);

  return (
    <div class="about-page">
      <p>
        <a href={loggedIn ? '#/day' : '#/'}>← {loggedIn ? '戻る' : 'ログインの画面へ'}</a>
      </p>
      <h1>{PROFILE.title}</h1>
      <p class="muted">いつ・どこに行ったかを調べる</p>

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
            <th>画面</th>
            <td>
              {commitText(BUILD.commit, BUILD.dirty)}（{BUILD.builtAt ? `${dateText(BUILD.builtAt)} 作成` : '開発中のバージョン'}）
            </td>
          </tr>
          <tr>
            <th>サーバー</th>
            <td>
              {health ? (
                <>
                  {health.version !== PROFILE.version && `${health.version} `}
                  {commitText(health.commit, health.dirty)}（{dateText(health.builtAt)} 作成、{dateText(health.startedAt)} 起動）
                </>
              ) : error ? (
                <span class="error">{error}</span>
              ) : (
                '確認しています…'
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {mismatch && (
        <p class="error">
          画面とサーバーのバージョンが違います。画面を読み込み直すと、新しいバージョンになります。{' '}
          <button type="button" onClick={() => location.reload()}>
            読み込み直す
          </button>
        </p>
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
        。著作権表示と、使っているソフトウェア・データの表示は次のとおりです。
      </p>
      <pre class="notice">{notice}</pre>
    </div>
  );
}
