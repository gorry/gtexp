import { render, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ClientConfig } from '../shared/types';
import { api, setUnauthorizedHandler } from './api';
import { todayIn } from './format';
import { About } from './components/About';
import { BookmarkButton } from './components/BookmarkButton';
import { BookmarksView } from './components/BookmarksView';
import { DayView } from './components/DayView';
import { HeaderMenu } from './components/HeaderMenu';
import { ListsView } from './components/ListsView';
import { Login } from './components/Login';
import { PlaceView } from './components/PlaceView';
import { PlacesView } from './components/PlacesView';
import { SearchView } from './components/SearchView';
import { TripView } from './components/TripView';
import { TripsView } from './components/TripsView';
import { UserView } from './components/UserView';
import { openTab, tabHash } from './tabs';
import { setIconVersion } from './userIcon';
import './styles.css';

// 画面の切り替えは URL の # 以降で行う（#/day/2024-05-25, #/places?q=..., #/place/{placeId}, #/search?..., #/trips, #/trip/{開始時刻ms}, #/lists?list=..., #/import, #/bookmarks, #/about）
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
    // アイコンの版（ログインした直後は分からないので、ここで確かめる）
    api.me().then((r) => setIconVersion(r.icon ?? null)).catch(() => {});
    // 最初に開く日は、データがある最後の日
    api.summary().then((s) => setDefaultDate(s.lastDate ?? '')).catch(() => {});
  }, [loggedIn]);

  if (loggedIn === null) return null;
  // このアプリについて（ログインしていなくても見られる）
  if (page === 'about') return <About loggedIn={loggedIn} />;
  if (!loggedIn) return <Login onLogin={setUser} />;
  if (!config) return null;

  const date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : defaultDate || todayIn(config.tzOffsetMinutes);
  // 前の取り込みの画面（#/import）は、ユーザー情報の画面に入れた
  const current = page === 'import' ? 'user' : ['user', 'places', 'place', 'search', 'trips', 'trip', 'lists', 'bookmarks'].includes(page) ? page : 'day';

  return (
    <div class="app">
      <header class="header">
        <nav>
          <a href={`#/day/${date}`} class={current === 'day' ? 'active' : ''}>日付</a>
          {/* 場所・集計・旅行・保存リストは、前に開いていた条件のまま戻る（tabs.ts） */}
          <TabLink page="places" active={current === 'places' || current === 'place'}>場所</TabLink>
          <TabLink page="search" active={current === 'search'}>集計</TabLink>
          <TabLink page="trips" active={current === 'trips' || current === 'trip'}>旅行</TabLink>
          <TabLink page="lists" active={current === 'lists'}>
            <span class="nav-full">保存リスト</span>
            <span class="nav-short">リスト</span>
          </TabLink>
        </nav>
        <BookmarkButton />
        <HeaderMenu user={user ?? ''} />
      </header>
      <main class="content">
        {current === 'user' ? (
          <UserView user={user ?? ''} query={query} onImported={() => api.summary().then((s) => setDefaultDate(s.lastDate ?? ''))} />
        ) : current === 'places' ? (
          // タグのリンクなどで条件付きの URL に来たら、条件を読み直す
          <PlacesView key={query.toString()} config={config} query={query} />
        ) : current === 'bookmarks' ? (
          <BookmarksView />
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

/** 見出しのタブ。href は描いたときの値なので、押したときの値で移る */
function TabLink({ page, active, children }: { page: string; active: boolean; children: ComponentChildren }) {
  return (
    <a
      href={tabHash(page)}
      class={active ? 'active' : ''}
      onClick={(e) => {
        e.preventDefault();
        openTab(page);
      }}
    >
      {children}
    </a>
  );
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
