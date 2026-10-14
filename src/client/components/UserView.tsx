import { useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { usePageTitle } from '../bookmarks';
import { UserIcon, makeIcon, setIconVersion } from '../userIcon';
import { ImportView } from './ImportView';

/**
 * ユーザー情報：アイコンの設定、データの取り込み、パスワードの変更、ログアウト。
 * 見出しのメニューの利用者名から開く（#/user。前の #/import と、共有から送られてきたときもここ）
 */
export function UserView({ user, query, onImported }: { user: string; query: URLSearchParams; onImported: () => void }) {
  usePageTitle('ユーザー情報');
  return (
    <div class="page">
      <h2>ユーザー情報</h2>
      <IconCard user={user} />
      <ImportView query={query} onImported={onImported} />
      <PasswordCard />
      <section class="card">
        <h3>ログアウト</h3>
        <p class="muted">この端末でログアウトします。</p>
        <button
          type="button"
          // 画面が覚えている前の利用者の状態（地図の位置・作業中のタグ付けなど）を残さないよう、読み込み直す
          onClick={() => api.logout().finally(() => location.replace('/'))}
        >
          ログアウト
        </button>
      </section>
    </div>
  );
}

function IconCard({ user }: { user: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<string | null>, done: string) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      setIconVersion(await fn());
      setMessage(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (file: File | undefined) => {
    if (!file) return;
    run(async () => {
      let icon: Blob;
      try {
        icon = await makeIcon(file);
      } catch {
        throw new Error('画像を読み込めませんでした。別の画像を選んでください。');
      }
      return (await api.uploadIcon(icon)).icon;
    }, 'アイコンを変更しました。');
  };

  return (
    <section class="card">
      <h3>アイコン</h3>
      <div class="user-icon-row">
        <UserIcon size={96} />
        <div>
          <p class="user-name">{user}</p>
          <div class="visit-actions">
            <button type="button" disabled={busy} onClick={() => input.current?.click()}>
              画像を選ぶ
            </button>
            <button type="button" class="text-btn" disabled={busy} onClick={() => run(async () => (await api.deleteIcon()).icon, '初期のアイコンに戻しました。')}>
              初期のアイコンに戻す
            </button>
          </div>
        </div>
      </div>
      <p class="muted note">画像の中央を正方形に切り抜き、512×512 ピクセルより大きければ縮めて保存します。</p>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          pick(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }}
      />
      {busy && <p class="muted">保存しています…</p>}
      {message && <p>{message}</p>}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    setMessage('');
    setError('');
    if (next !== again) {
      setError('新しいパスワードが一致しません。確認して、もう一度入力してください。');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setMessage('パスワードを変更しました。ほかの端末では、ログアウトされます。');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card">
      <h3>パスワードの変更</h3>
      <form class="password-form" onSubmit={submit}>
        <input type="password" value={current} autocomplete="current-password" placeholder="今のパスワード" aria-label="今のパスワード" onInput={(e) => setCurrent(e.currentTarget.value)} />
        <input type="password" value={next} autocomplete="new-password" placeholder="新しいパスワード（8 文字以上）" aria-label="新しいパスワード" onInput={(e) => setNext(e.currentTarget.value)} />
        <input type="password" value={again} autocomplete="new-password" placeholder="新しいパスワード（もう一度）" aria-label="新しいパスワード（もう一度）" onInput={(e) => setAgain(e.currentTarget.value)} />
        <div>
          <button type="submit" disabled={busy || !current || !next || !again}>
            変更
          </button>
        </div>
      </form>
      <p class="muted note">変更すると、ほかの端末ではログアウトされます。</p>
      {message && <p>{message}</p>}
      {error && <p class="error">{error}</p>}
    </section>
  );
}
