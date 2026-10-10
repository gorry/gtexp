import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';

/** 見出しの右端のメニュー：ログインしている利用者の名前、このアプリについて、ログアウト */
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
          <div class="header-menu-user muted" title="ログインしている利用者">
            {user}
          </div>
          <a role="menuitem" href="#/about">
            このアプリについて
          </a>
          <button
            type="button"
            role="menuitem"
            // 画面が覚えている前の利用者の状態（地図の位置・作業中のタグ付けなど）を残さないよう、読み込み直す
            onClick={() => api.logout().finally(() => location.replace('/'))}
          >
            ログアウト
          </button>
        </div>
      )}
    </div>
  );
}
