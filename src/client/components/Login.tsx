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

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.login(user.trim(), password);
      try {
        localStorage.setItem(LAST_USER_KEY, r.user ?? user.trim());
      } catch {}
      onLogin(r.user ?? user.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="login" onSubmit={submit}>
      <h1>{PROFILE.title}</h1>
      <p class="muted">いつ・どこに行ったかを調べる</p>
      <input
        type="text"
        autocomplete="username"
        autocapitalize="none"
        spellcheck={false}
        placeholder="利用者名"
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
