import { useEffect, useRef, useState } from 'preact/hooks';
import { addBookmark, currentHash, currentTitle, deleteBookmark, useBookmarks } from '../bookmarks';

/**
 * 見出しの ☆：いま開いている画面をブックマークに足す。☆ を押すと「ブックマークします」（名前を決めて OK で足す）、
 * 足してある画面（★）で押すと「ブックマークから外します」（OK で外す）の欄を出す。キャンセルでは何もしない
 */
export function BookmarkButton() {
  const items = useBookmarks();
  const hash = currentHash();
  const mark = items?.find((b) => b.hash === hash) ?? null;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // 外を押したとき・Esc・画面を切り替えたときに閉じる
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onHash = () => setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      removeEventListener('hashchange', onHash);
    };
  }, [open]);

  const onClick = () => {
    if (open) return setOpen(false);
    setError('');
    setName(mark ? mark.title : currentTitle() || hash);
    setOpen(true);
  };

  // OK：☆ なら足す、★ なら外す
  const ok = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mark) await deleteBookmark(mark.id);
      else await addBookmark(hash, name.trim() || currentTitle() || hash);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="bookmark-menu" ref={box}>
      <button
        type="button"
        class={`header-menu-btn bookmark-btn${mark ? ' on' : ''}`}
        aria-label={mark ? 'ブックマーク済み' : 'この画面をブックマークに足す'}
        title={mark ? 'ブックマーク済み' : 'この画面をブックマークに足す'}
        aria-expanded={open}
        disabled={!items}
        onClick={onClick}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
            fill={mark ? 'currentColor' : 'none'}
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div class="bookmark-pop">
          {error && <p class="error">{error}</p>}
          <form class="note-form" onSubmit={ok}>
            <p class="bookmark-pop-head">{mark ? 'ブックマークから外します' : 'ブックマークします'}</p>
            {mark ? (
              <p class="bookmark-pop-name">{mark.title}</p>
            ) : (
              <input type="text" value={name} maxLength={200} aria-label="ブックマークの名前" onInput={(e) => setName(e.currentTarget.value)} />
            )}
            <div class="note-form-buttons">
              <button type="submit" disabled={busy}>OK</button>
              <button type="button" class="text-btn" onClick={() => setOpen(false)}>キャンセル</button>
              <a class="bookmark-pop-list" href="#/bookmarks">ブックマークの一覧</a>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
