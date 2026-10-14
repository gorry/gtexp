import { useEffect, useRef, useState } from 'preact/hooks';
import { PROFILE } from '../../shared/profile.gen';
import { UserIcon } from '../userIcon';

/** 見出しの右端のメニュー：ログインしている利用者（アイコンと名前。ユーザー情報へ）、ブックマーク、アプリについて・再読み込み */
export function HeaderMenu({ user }: { user: string }) {
  const [open, setOpen] = useState(false);
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

  return (
    <div class="header-menu" ref={box}>
      <button type="button" class="header-menu-btn" aria-label="メニュー" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
      {open && (
        <div class="header-menu-list" role="menu">
          {/* 利用者名（とアイコン）を押すと、ユーザー情報（アイコン・データの取り込み・パスワード・ログアウト） */}
          <a role="menuitem" class="header-menu-user" href="#/user">
            <UserIcon size={24} />
            <span>{user}</span>
          </a>
          <div class="header-menu-sep" role="separator" />
          <a role="menuitem" href="#/bookmarks">
            ブックマーク
          </a>
          <div class="header-menu-sep" role="separator" />
          <a role="menuitem" href="#/about">
            {PROFILE.shortTitle}について
          </a>
          {/* スマホの PWA では、地図のある画面で「下に引っ張って読み込み直す」がしにくいので、メニューから読み込み直せるようにする */}
          <button type="button" role="menuitem" onClick={() => location.reload()}>
            再読み込み
          </button>
        </div>
      )}
    </div>
  );
}
