import { useRef, useState } from 'preact/hooks';
import type { Bookmark } from '../../shared/types';
import { deleteBookmark, pageLabel, renameBookmark, reorderBookmarks, useBookmarks, usePageTitle } from '../bookmarks';

/** id を from から to の位置へ動かした並び */
function moved(ids: number[], id: number, to: number): number[] {
  const rest = ids.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  return rest;
}

/**
 * ブックマークの一覧（並べた順。足したものはいちばん上）。選ぶとその画面に飛ぶ。
 * 左のつまみ（点 6 つ）をつかんで動かして並べ替える（名前で絞り込んでいる間はできない）。キーボードでの操作は付けない
 * （ほかの画面にもキーボードの操作はないため。Tab キーでつまみに止まらないよう、ボタンにはしない）
 */
export function BookmarksView() {
  usePageTitle('ブックマーク');
  const items = useBookmarks();
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  // つかんで動かしている間の並び（離したら送る）
  const [drag, setDrag] = useState<{ id: number; order: number[] } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const filtering = !!q.trim();
  const byId = new Map((items ?? []).map((b) => [b.id, b]));
  const ordered = drag ? drag.order.map((id) => byId.get(id)!).filter(Boolean) : items ?? [];
  const shown = ordered.filter((b) => !filtering || b.title.toLowerCase().includes(q.trim().toLowerCase()));

  const save = (ids: number[]) => {
    setError('');
    reorderBookmarks(ids).catch((e) => setError((e as Error).message));
  };

  /** 指の高さにある行の位置 */
  const indexAt = (y: number): number => {
    const rows = [...(listRef.current?.children ?? [])] as HTMLElement[];
    const i = rows.findIndex((r) => {
      const rect = r.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    return i < 0 ? rows.length - 1 : i;
  };

  const onPointerDown = (e: PointerEvent, id: number) => {
    if (!items || filtering || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, order: items.map((b) => b.id) });
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const to = indexAt(e.clientY);
    if (drag.order.indexOf(drag.id) !== to) setDrag({ id: drag.id, order: moved(drag.order, drag.id, to) });
  };
  const onPointerUp = () => {
    if (!drag || !items) return;
    const changed = drag.order.some((id, i) => items[i]?.id !== id);
    if (changed) save(drag.order);
    setDrag(null);
  };
  return (
    <div class="page">
      <h2>ブックマーク</h2>
      {!items && <p class="muted">読み込んでいます…</p>}
      {items && !items.length && <p class="muted note">まだありません。画面の右上の ☆ を押すと、その画面（日付・場所・絞り込んだ一覧など）をここに足せます。</p>}
      {items && items.length > 5 && (
        <input type="search" value={q} placeholder="名前で絞り込む" aria-label="名前で絞り込む" onInput={(e) => setQ(e.currentTarget.value)} />
      )}
      {error && <p class="error">{error}</p>}
      <ul class="bookmark-list" ref={listRef}>
        {shown.map((b) => (
          <BookmarkRow
            key={b.id}
            b={b}
            handle={
              !filtering &&
              shown.length > 1 && (
                <span
                  class="bookmark-handle"
                  title="つかんで並べ替える"
                  aria-hidden="true"
                  onPointerDown={(e) => onPointerDown(e, b.id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => setDrag(null)}
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    {[6, 12, 18].map((y) => [9, 15].map((x) => <circle cx={x} cy={y} r="1.8" fill="currentColor" />))}
                  </svg>
                </span>
              )
            }
            dragging={drag?.id === b.id}
          />
        ))}
      </ul>
    </div>
  );
}

function BookmarkRow({ b, handle, dragging }: { b: Bookmark; handle: preact.ComponentChildren; dragging: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(b.title);
  const [error, setError] = useState('');

  const save = async (e: Event) => {
    e.preventDefault();
    setError('');
    try {
      if (name.trim() && name.trim() !== b.title) await renameBookmark(b.id, name);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = () => deleteBookmark(b.id).catch((err) => setError((err as Error).message));

  return (
    <li data-id={b.id} class={dragging ? 'dragging' : ''}>
      {handle}
      <div class="bookmark-main">
        {editing ? (
          <form class="note-form" onSubmit={save}>
            <input type="text" value={name} maxLength={200} aria-label="ブックマークの名前" onInput={(e) => setName(e.currentTarget.value)} />
            <div class="note-form-buttons">
              <button type="submit">決定</button>
              <button type="button" class="text-btn" onClick={() => (setEditing(false), setName(b.title))}>キャンセル</button>
            </div>
          </form>
        ) : (
          <a class="bookmark-title" href={b.hash}>{b.title}</a>
        )}
        <div class="bookmark-sub muted">
          {pageLabel(b.hash)}・{b.createdAt.slice(0, 10)} に追加
        </div>
        {error && <p class="error">{error}</p>}
      </div>
      {!editing && (
        <>
          <button type="button" class="text-btn" onClick={() => setEditing(true)}>名前を変える</button>
          <button type="button" class="text-btn" onClick={remove}>外す</button>
        </>
      )}
    </li>
  );
}
