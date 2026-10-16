import { useEffect, useRef, useState } from 'preact/hooks';
import type { PlaceNote } from '../../shared/types';
import { api } from '../api';

/** "#ラーメン #出張" → ["ラーメン", "出張"]（空白・カンマ・読点で区切り、先頭の # は外す。# を付け忘れた語もタグにする） */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,、\s]+/).map((t) => t.replace(/^[#＃]+/, '').trim()).filter(Boolean))];
}

/** タグを「#タグ」の形で出す（空白は _ に） */
export function hashtag(tag: string): string {
  return `#${tag.trim().replace(/\s+/g, '_')}`;
}

interface Props {
  placeId: string;
  note: PlaceNote | null;
  onSaved: (note: PlaceNote) => void;
  onCancel: () => void;
}

/** 場所に自分で付ける名前・メモ・タグの入力欄。同じ placeId のすべての記録に付く */
export function NoteForm({ placeId, note, onSaved, onCancel }: Props) {
  const [name, setName] = useState(note?.name ?? '');
  const [memo, setMemo] = useState(note?.memo ?? '');
  const [tags, setTags] = useState((note?.tags ?? []).map(hashtag).join(' '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => nameInput.current?.focus(), []);

  const save = async (e: Event) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      onSaved(await api.saveNote(placeId, { name: name.trim(), memo: memo.trim(), tags: parseTags(tags) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form class="note-form" onSubmit={save} onClick={(e) => e.stopPropagation()}>
      <input ref={nameInput} value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="名前（例：〇〇食堂）" />
      <textarea value={memo} onInput={(e) => setMemo(e.currentTarget.value)} placeholder="メモ" rows={2} />
      <input value={tags} onInput={(e) => setTags(e.currentTarget.value)} placeholder="タグ（例：#ラーメン #出張）" />
      <div class="note-form-buttons">
        <button type="submit" disabled={saving}>保存</button>
        <button type="button" class="text-btn" onClick={onCancel}>キャンセル</button>
        <span class="muted">この場所のすべての訪問履歴に反映されます</span>
      </div>
      {error && <p class="error">{error}</p>}
    </form>
  );
}

export function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span class="tags">
      {tags.map((t) => (
        <a class="tag" href={`#/places?q=${encodeURIComponent(hashtag(t))}`} onClick={(e) => e.stopPropagation()}>
          {hashtag(t)}
        </a>
      ))}
    </span>
  );
}

/** 元データにない、経路から推定した立ち寄り */
export function EstimatedChip() {
  return (
    <span class="chip" title="移動経路とラベル付きの場所から推定された立ち寄り履歴です">
      推定
    </span>
  );
}
