import { useEffect, useState } from 'preact/hooks';
import { PROFILE } from '../shared/profile.gen';
import type { Bookmark } from '../shared/types';
import { api } from './api';

// ブックマークと、いま開いている画面（URL と名前）。見出しの ★ とブックマークの一覧で同じものを使う

let items: Bookmark[] | null = null;
let title = '';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

// 絞り込みを変えた画面は history.replaceState で URL を書き換える（hashchange は起きない）ので、それも知らせる
const replaceState = history.replaceState.bind(history);
history.replaceState = (...args: Parameters<History['replaceState']>) => {
  replaceState(...args);
  notify();
};
addEventListener('hashchange', notify);

/** いま開いている画面の URL（# 以降）。何もなければ日付の画面 */
export function currentHash(): string {
  return location.hash.length > 1 ? location.hash : '#/day';
}

/** いま開いている画面の名前（ブックマークを足すときの名前） */
export function currentTitle(): string {
  return title;
}

/** 画面の名前を決める（ブラウザのタブの名前にもなる） */
export function usePageTitle(t: string): void {
  useEffect(() => {
    title = t;
    document.title = t ? `${t} - ${PROFILE.title}` : PROFILE.title;
    notify();
  }, [t]);
}

/** ブックマークの一覧（null はまだ届いていない）。画面が変わったときも描き直す */
export function useBookmarks(): Bookmark[] | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    listeners.add(on);
    if (!items) reloadBookmarks();
    return () => void listeners.delete(on);
  }, []);
  return items;
}

export function reloadBookmarks(): Promise<void> {
  return api.bookmarks().then((list) => {
    items = list;
    notify();
  });
}

export async function addBookmark(hash: string, t: string): Promise<Bookmark> {
  const b = await api.addBookmark(hash, t);
  items = [b, ...(items ?? []).filter((x) => x.id !== b.id)];
  notify();
  return b;
}

export async function renameBookmark(id: number, t: string): Promise<void> {
  const b = await api.renameBookmark(id, t);
  items = (items ?? []).map((x) => (x.id === id ? b : x));
  notify();
}

let reorderSeq = 0;

/**
 * 並べ替える（先に画面を変えてから送る。失敗したら読み直す）。続けて動かしたときは、最後に送ったものの応答だけを使う
 * （前の応答で古い並びに戻すと、↑↓ キーで動かしている行のフォーカスが外れる）
 */
export async function reorderBookmarks(ids: number[]): Promise<void> {
  const byId = new Map((items ?? []).map((b) => [b.id, b]));
  items = ids.map((id) => byId.get(id)!).filter(Boolean);
  notify();
  const seq = ++reorderSeq;
  try {
    const list = await api.reorderBookmarks(ids);
    if (seq !== reorderSeq) return;
    items = list;
    notify();
  } catch (e) {
    await reloadBookmarks().catch(() => {});
    throw e;
  }
}

export async function deleteBookmark(id: number): Promise<void> {
  await api.deleteBookmark(id);
  items = (items ?? []).filter((x) => x.id !== id);
  notify();
}

const PAGE_LABELS: Record<string, string> = {
  day: '日付',
  places: '場所の一覧',
  place: '場所',
  search: '集計',
  trips: '旅行の一覧',
  trip: '旅行',
  lists: '保存リスト',
  import: 'データの取り込み',
  user: 'ユーザー情報',
  bookmarks: 'ブックマーク',
};

/** URL（# 以降）が指す画面の種類 */
export function pageLabel(hash: string): string {
  return PAGE_LABELS[hash.replace(/^#\//, '').split(/[/?]/)[0]] ?? '';
}

/** 絞り込める画面の名前（例：場所「#ラーメン」2024-01-01〜2024-06-30） */
export function filteredTitle(base: string, q: string, from: string, to: string): string {
  return `${base}${q.trim() ? `「${q.trim()}」` : ''}${from || to ? ` ${from}〜${to}` : ''}`;
}
