import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PlaceSummary } from '../../shared/types';
import { api } from '../api';
import { areaHint, visitName } from './MapView';
import { hashtag } from './NoteForm';

/** まとめてタグ付けで並べる上限。これより多いときは絞り込むよう案内する（見えていない分に黙って付けないため） */
export const BULK_MAX = 1000;

interface Saved {
  tagInput: string;
  tag: string;
  edits: Map<string, boolean>;
  focused: string | null;
  message: string;
  undo: { tag: string; added: string[]; removed: string[] } | null;
}

/**
 * 作業中の状態。場所の詳細を開くと一覧の画面ごと作り直されるので、ここに覚えておき、戻ってきたときに続きから始める
 */
let saved: Saved | null = null;

/** 作業中の状態を捨てる（新しく開くとき・閉じるとき） */
export function resetBulkTags() {
  saved = null;
}

interface Props {
  /** 場所の一覧と同じ絞り込み条件（limit / offset は含めない） */
  params: URLSearchParams;
  onClose: () => void;
  /** タグを変えたあと（一覧を読み直させる） */
  onChanged: () => void;
  /** 地図に出す場所と、チェックが入っている場所を親に知らせる */
  onItems: (items: PlaceSummary[], checked: Set<string>) => void;
  /** その場所に地図を寄せて拡大する */
  onFocus: (placeId: string) => void;
}

/**
 * 検索で絞り込んだ場所に、まとめてハッシュタグを付ける・外す。
 * チェックは「そのタグが（自分のタグとして）付いているべきか」を表す。初めは、いま付いている場所にだけチェックが入り
 * （初めて使うタグなら全部オフ）、チェックを変えて「決定」すると、初めの状態から変わった場所だけを DB に反映する
 */
export function BulkTags({ params, onClose, onChanged, onItems, onFocus }: Props) {
  const [tagInput, setTagInput] = useState(saved?.tagInput ?? '');
  const [tag, setTag] = useState(saved?.tag ?? '');
  const [items, setItems] = useState<PlaceSummary[]>([]);
  const [total, setTotal] = useState(0);
  // 初めの状態から変えたチェック（placeId → 付いているべきか）。一覧を読み直しても（読み直しが操作より後に終わっても）消えない
  const [edits, setEdits] = useState<Map<string, boolean>>(saved?.edits ?? new Map());
  const [focused, setFocused] = useState<string | null>(saved?.focused ?? null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(saved?.message ?? '');
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<Saved['undo']>(saved?.undo ?? null);
  const request = useRef(0);
  // 戻ってきたときは、読み込み後に押していた行まで一覧を送る
  const scrollTo = useRef(saved?.focused ?? null);

  useEffect(() => {
    saved = { tagInput, tag, edits, focused, message, undo };
  }, [tagInput, tag, edits, focused, message, undo]);

  useEffect(() => {
    if (!scrollTo.current || !items.length) return;
    document.getElementById(`bulk-${scrollTo.current}`)?.scrollIntoView({ block: 'center' });
    scrollTo.current = null;
  }, [items]);

  // タグは打ち終わってから反映する（先頭の # や空白をそろえる）。タグが変わったら、変えたチェックは捨てる
  useEffect(() => {
    const t = setTimeout(() => {
      const next = tagInput.replace(/^[#＃]+/, '').trim().replace(/\s+/g, '_');
      if (next !== tag) {
        setTag(next);
        setEdits(new Map());
        setMessage('');
        setUndo(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [tagInput]);

  const load = async () => {
    const id = ++request.current;
    setLoading(true);
    setError('');
    const p = new URLSearchParams(params);
    p.set('limit', String(BULK_MAX));
    p.set('offset', '0');
    if (tag) p.set('checkTag', tag);
    try {
      const r = await api.places(p);
      if (id !== request.current) return;
      setItems(r.items);
      setTotal(r.total);
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [params.toString(), tag]);

  /** いま DB で自分のタグとして付いているか（初めのチェック） */
  const initial = (p: PlaceSummary) => p.tagState === 'note';
  /** いまのチェック */
  const isChecked = (p: PlaceSummary) => (edits.has(p.placeId) ? edits.get(p.placeId)! : initial(p));

  const checked = useMemo(() => new Set(items.filter(isChecked).map((p) => p.placeId)), [items, edits]);
  const toAdd = useMemo(() => items.filter((p) => isChecked(p) && !initial(p)), [items, edits]);
  const toRemove = useMemo(() => items.filter((p) => !isChecked(p) && initial(p)), [items, edits]);

  useEffect(() => onItems(items, checked), [items, checked]);

  const tooMany = total > BULK_MAX;
  const ready = !!tag && !tooMany && !loading;

  /** チェックを変える。初めの状態に戻ったら「変えたもの」から外す */
  const setCheck = (list: PlaceSummary[], value: boolean) =>
    setEdits((prev) => {
      const next = new Map(prev);
      for (const p of list) {
        if (value === initial(p)) next.delete(p.placeId);
        else next.set(p.placeId, value);
      }
      return next;
    });

  const apply = async () => {
    if (!tag || (!toAdd.length && !toRemove.length)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const added = toAdd.length ? (await api.bulkTags({ placeIds: toAdd.map((p) => p.placeId), add: [tag] })).changed : [];
      const removed = toRemove.length ? (await api.bulkTags({ placeIds: toRemove.map((p) => p.placeId), remove: [tag] })).changed : [];
      const parts = [added.length && `${added.length.toLocaleString()} か所に追加しました`, removed.length && `${removed.length.toLocaleString()} か所から解除しました`].filter(Boolean);
      setMessage(`${hashtag(tag)} を${parts.join('・') || '変更しませんでした'}`);
      setUndo(added.length || removed.length ? { tag, added, removed } : null);
      // 反映したので、変えたチェックは捨てて DB の状態を読み直す
      setEdits(new Map());
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    if (!undo) return;
    setBusy(true);
    setError('');
    try {
      if (undo.added.length) await api.bulkTags({ placeIds: undo.added, remove: [undo.tag] });
      if (undo.removed.length) await api.bulkTags({ placeIds: undo.removed, add: [undo.tag] });
      setMessage(`元に戻しました（${(undo.added.length + undo.removed.length).toLocaleString()} か所）`);
      setUndo(null);
      setEdits(new Map());
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changes = toAdd.length + toRemove.length;

  return (
    <div class="bulk">
      <div class="bulk-head">
        <strong>まとめてタグ付け</strong>
        <button type="button" class="text-btn" onClick={() => {
          resetBulkTags();
          onClose();
        }}>閉じる</button>
      </div>
      <input value={tagInput} onInput={(e) => setTagInput(e.currentTarget.value)} placeholder="タグ（例：#レストラン）" aria-label="タグ" />
      {tooMany && (
        <p class="error">条件に合う場所が {total.toLocaleString()} か所あります。まとめて操作できるのは {BULK_MAX.toLocaleString()} か所までなので、検索語や期間で絞り込んでください。</p>
      )}
      <p class="muted note">
        {tag
          ? `チェックした場所に ${hashtag(tag)} が設定されます。選択を変更して「適用」を押してください。`
          : 'タグを入力すると、現在そのタグが付いている場所にチェックが入ります。'}
      </p>
      <div class="bulk-actions">
        <button type="button" class="text-btn" disabled={!ready} onClick={() => setCheck(items, true)}>すべて選択</button>
        <button type="button" class="text-btn" disabled={!ready} onClick={() => setCheck(items, false)}>すべて解除</button>
        <button type="submit" disabled={busy || !ready || !changes} onClick={apply}>
          {changes
            ? `適用（${[toAdd.length && `追加 ${toAdd.length.toLocaleString()}`, toRemove.length && `解除 ${toRemove.length.toLocaleString()}`].filter(Boolean).join('・')}）`
            : '適用'}
        </button>
      </div>
      {message && (
        <p class="success">
          {message}
          {undo && (
            <button type="button" class="link-btn undo" disabled={busy} onClick={revert}>元に戻す</button>
          )}
        </p>
      )}
      {error && <p class="error">{error}</p>}
      <p class="muted result-count">
        {loading ? '読み込んでいます…' : `${items.length.toLocaleString()} か所${tag ? `（チェック ${checked.size.toLocaleString()} か所）` : ''}`}
      </p>
      <ul class="bulk-list">
        {items.map((p) => {
          const on = isChecked(p);
          const change = on !== initial(p) ? (on ? '追加' : '解除') : '';
          return (
            // 行全体を押すと地図をその場所に寄せる。チェックボックスと地点名（label）だけがチェックの切り替え
            <li
              id={`bulk-${p.placeId}`}
              class={`${focused === p.placeId ? 'focused' : ''}${tag ? '' : ' disabled'}`}
              title="クリックで地図をこの場所に移動"
              onClick={() => {
                setFocused(p.placeId);
                onFocus(p.placeId);
              }}
            >
              <div class="bulk-row">
                <label class="bulk-check" onClick={(e) => e.stopPropagation()} title={tag ? 'チェックを切り替える' : undefined}>
                  <input type="checkbox" checked={!!tag && on} disabled={!ready} onChange={() => setCheck([p], !on)} />
                  <span class="bulk-name">{visitName(p)}</span>
                </label>
                {change && <span class={`chip change-${change === '追加' ? 'add' : 'remove'}`}>{change}</span>}
                {tag && p.tagState === 'list' && <span class="chip">保存リストで {hashtag(tag)}</span>}
              </div>
              <div class="muted bulk-meta">
                {areaHint(p) && `${areaHint(p)}・`}
                {p.count.toLocaleString()} 回
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
