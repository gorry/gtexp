// 見出しのタブ（場所・集計・旅行・保存リスト）ごとに、最後に開いていた一覧の URL（絞り込みの条件付き）を覚えておく。
// ほかの画面へ移ってから見出しのタブで戻ったとき、同じ条件で開く。覚えるのは画面を読み込み直すまで。
// 一覧の画面は条件を変えるたびに history.replaceState で URL を書き換える（hashchange は起きない）ので、
// 画面が切り替わるとき（hashchange）に、離れる前の URL を覚える

const TABS = ['places', 'search', 'trips', 'lists'];
const last = new Map<string, string>();

/** URL の # 以降から画面の種類（#/places?q=... → places） */
const pageOf = (hash: string) => hash.replace(/^#\/?/, '').split(/[/?]/)[0];

addEventListener('hashchange', (e) => {
  const hash = new URL(e.oldURL).hash;
  const page = pageOf(hash);
  if (TABS.includes(page)) last.set(page, hash);
});

/** 見出しのタブで移る先（前に開いていた条件付きの一覧。なければ条件なし） */
export function tabHash(page: string): string {
  return last.get(page) ?? `#/${page}`;
}

/** 見出しのタブを押したとき。その一覧を開いているときは何もしない（今の条件のまま） */
export function openTab(page: string): void {
  if (pageOf(location.hash) !== page) location.hash = tabHash(page);
}
