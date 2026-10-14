import { useEffect, useState } from 'preact/hooks';

// 利用者のアイコン。版（置いた日時）を覚えておき、メニューとユーザー情報の画面で同じものを出す。
// 版が変わったら（画像を変えた・初期のアイコンに戻した）、出しているところを描き直す

let version: string | null = null;
const listeners = new Set<() => void>();

export function setIconVersion(v: string | null): void {
  version = v;
  listeners.forEach((fn) => fn());
}

/** 初期のアイコン（人の形）。画像を設定していないときと、読み込めなかったときに出す */
const DEFAULT_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#8b949e"/>' +
      '<circle cx="32" cy="25" r="12" fill="#f0f3f6"/><path d="M10 60c2-13 11-20 22-20s20 7 22 20z" fill="#f0f3f6"/></svg>',
  );

export function UserIcon({ size }: { size: number }) {
  const [, redraw] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const fn = () => redraw((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  const src = version && failed !== version ? `/api/me/icon?v=${version}` : DEFAULT_ICON;
  return <img class="user-icon" src={src} width={size} height={size} alt="" onError={() => setFailed(version)} />;
}

/** アイコンの最大の大きさ（px）。これより大きい画像は縮める */
const ICON_MAX = 512;

/**
 * 選んだ画像を、中央の正方形に切り抜き、512px 四方まで縮めた画像にする（小さい画像は縮めない）。
 * WebP で書けるブラウザーは WebP、書けなければ PNG
 */
export async function makeIcon(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(side, ICON_MAX);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (blob && blob.type === 'image/webp') return blob;
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('画像を読み込めませんでした。別の画像を選んでください。');
  return png;
}
