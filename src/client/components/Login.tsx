import { useState } from 'preact/hooks';
import { PROFILE } from '../../shared/profile.gen';
import { api } from '../api';

/** 最後にログインした利用者名（次から入れておく） */
const LAST_USER_KEY = 'gtexp.lastUser';

function lastUser(): string {
  try {
    return localStorage.getItem(LAST_USER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function Login({ onLogin }: { onLogin: (user: string) => void }) {
  const [user, setUser] = useState(lastUser);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 2 段階認証を使っている利用者は、パスワードのあとに確認コード（アプリの 6 桁かバックアップコード）を入れる
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState('');

  const done = (name: string) => {
    try {
      localStorage.setItem(LAST_USER_KEY, name);
    } catch {}
    onLogin(name);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (needCode) {
        const r = await api.loginMfa(code.trim());
        done(r.user ?? user.trim());
        return;
      }
      const r = await api.login(user.trim(), password);
      if (r.mfaRequired) {
        setNeedCode(true);
        return;
      }
      done(r.user ?? user.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 確認コードの入力をやめて、パスワードからやり直す */
  const restart = () => {
    setNeedCode(false);
    setCode('');
    setPassword('');
    setError('');
  };

  return (
    <form class="login" onSubmit={submit}>
      <h1>{PROFILE.title}</h1>
      <p class="muted">Google タイムラインの移動・滞在履歴ビューア</p>
      {needCode ? (
        <>
          <p>認証アプリに表示されている 6 桁の確認コードを入力してください。</p>
          <input
            type="text"
            inputMode="numeric"
            autocomplete="one-time-code"
            autocapitalize="none"
            spellcheck={false}
            placeholder="確認コード"
            aria-label="確認コード"
            value={code}
            onInput={(e) => setCode(e.currentTarget.value)}
            autoFocus
          />
          <button type="submit" disabled={busy || !code.trim()}>確認</button>
          <p class="muted note">認証アプリを使用できない場合は、バックアップコード（xxxx-xxxx）を入力してください。</p>
          <button type="button" class="text-btn" onClick={restart}>
            パスワードの入力に戻る
          </button>
        </>
      ) : (
        <>
          <input
            type="text"
            autocomplete="username"
            autocapitalize="none"
            spellcheck={false}
            placeholder="ユーザー名"
            value={user}
            onInput={(e) => setUser(e.currentTarget.value)}
            autoFocus={!user}
          />
          <input
            type="password"
            autocomplete="current-password"
            placeholder="パスワード"
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
            autoFocus={!!user}
          />
          <button type="submit" disabled={busy || !user.trim() || !password}>ログイン</button>
        </>
      )}
      {error && <p class="error">{error}</p>}
      <p class="muted about">
        バージョン {PROFILE.version}
        <br />
        {PROFILE.copyright}
        <br />
        <a href="#/about">このアプリについて</a>
      </p>
    </form>
  );
}
