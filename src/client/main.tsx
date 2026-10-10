import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { PROFILE } from '../shared/profile.gen';
import type { ClientConfig } from '../shared/types';
import { api, setUnauthorizedHandler } from './api';
import { todayIn } from './format';
import { About } from './components/About';
import { DayView } from './components/DayView';
import { ImportView } from './components/ImportView';
import { ListsView } from './components/ListsView';
import { Login } from './components/Login';
import { PlaceView } from './components/PlaceView';
import { PlacesView } from './components/PlacesView';
import { SearchView } from './components/SearchView';
import { TripView } from './components/TripView';
import { TripsView } from './components/TripsView';
import './styles.css';

// 画面の切り替えは URL の # 以降で行う（#/day/2024-05-25, #/places?q=..., #/place/{placeId}, #/search?..., #/trips, #/trip/{開始時刻ms}, #/lists?list=..., #/import, #/about）
function parseHash(): { page: string; arg: string; query: URLSearchParams } {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const [, page = '', arg = ''] = path.split('/');
  return { page, arg: decodeURIComponent(arg), query: new URLSearchParams(qs ?? '') };
}

function useHash() {
  const [hash, setHash] = useState(parseHash);
  useEffect(() => {
    const on = () => setHash(parseHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function App() {
  // ログインしている利用者の名前。null はまだ確かめていない、'' はログインしていない
  const [user, setUser] = useState<string | null>(null);
  const loggedIn = user == null ? null : !!user;
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [defaultDate, setDefaultDate] = useState('');
  const { page, arg, query } = useHash();

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(''));
    api.me().then((r) => setUser(r.loggedIn ? r.user ?? '' : '')).catch(() => setUser(''));
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    api.config().then(setConfig).catch(() => {});
    // 最初に開く日は、データがある最後の日
    api.summary().then((s) => setDefaultDate(s.lastDate ?? '')).catch(() => {});
  }, [loggedIn]);

  if (loggedIn === null) return null;
  // このアプリについて（ログインしていなくても見られる）
  if (page === 'about') return <About loggedIn={loggedIn} />;
  if (!loggedIn) return <Login onLogin={setUser} />;
  if (!config) return null;

  const date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : defaultDate || todayIn(config.tzOffsetMinutes);
  const current = ['import', 'places', 'place', 'search', 'trips', 'trip', 'lists'].includes(page) ? page : 'day';

  return (
    <div class="app">
      <header class="header">
        <a class="brand" href="#/day" title={`${PROFILE.title} ${PROFILE.version}`}>
          <span class="brand-full">{PROFILE.title}</span>
          <span class="brand-short">{PROFILE.shortTitle}</span>
        </a>
        <nav>
          <a href={`#/day/${date}`} class={current === 'day' ? 'active' : ''}>日付</a>
          <a href="#/places" class={current === 'places' || current === 'place' ? 'active' : ''}>場所</a>
          <a href="#/search" class={current === 'search' ? 'active' : ''}>集計</a>
          <a href="#/trips" class={current === 'trips' || current === 'trip' ? 'active' : ''}>旅行</a>
          <a href="#/lists" class={current === 'lists' ? 'active' : ''}>
            <span class="nav-full">保存リスト</span>
            <span class="nav-short">リスト</span>
          </a>
          <a href="#/import" class={current === 'import' ? 'active' : ''}>取り込み</a>
        </nav>
        <span class="user-name muted" title="ログインしている利用者">{user}</span>
        <button
          type="button"
          class="text-btn logout"
          // 画面が覚えている前の利用者の状態（地図の位置・作業中のタグ付けなど）を残さないよう、読み込み直す
          onClick={() => api.logout().finally(() => location.replace('/'))}
        >
          ログアウト
        </button>
      </header>
      <main class="content">
        {current === 'import' ? (
          <ImportView query={query} onImported={() => api.summary().then((s) => setDefaultDate(s.lastDate ?? ''))} />
        ) : current === 'places' ? (
          // タグのリンクなどで条件付きの URL に来たら、条件を読み直す
          <PlacesView key={query.toString()} config={config} query={query} />
        ) : current === 'lists' ? (
          <ListsView key={query.get('list') ?? ''} config={config} query={query} />
        ) : current === 'trips' ? (
          <TripsView key={query.toString()} query={query} />
        ) : current === 'trip' ? (
          <TripView startMs={Number(arg)} config={config} />
        ) : current === 'search' ? (
          <SearchView key={query.toString()} query={query} />
        ) : current === 'place' ? (
          <PlaceView placeId={arg} config={config} />
        ) : (
          <DayView date={date} config={config} onDate={(d) => (location.hash = `#/day/${d}`)} />
        )}
      </main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
