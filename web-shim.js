'use strict';
// ブラウザ版の作戦ボード用: アプリ本体（preload の window.valo）の代わり。
// 作戦と画像はこのブラウザの中（IndexedDB）に保存する。マップ・キャラの情報は valorant-api.com から直接読む。
(function () {
  const DB_NAME = 'valo-memo-web', DB_VER = 1;
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('boards')) d.createObjectStore('boards'); if (!d.objectStoreNames.contains('images')) d.createObjectStore('images'); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  // 1つのトランザクションで fn(store) を行う。fn の失敗も呼び出し元に返す
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode); const st = t.objectStore(store);
      let out, failed = null;
      Promise.resolve().then(() => fn(st)).then(v => { out = v; }, e => { failed = e; try { t.abort(); } catch {} });
      t.oncomplete = () => (failed ? reject(failed) : resolve(out));
      t.onerror = () => reject(failed || t.error); t.onabort = () => reject(failed || t.error);
    });
  }
  const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  const urls = new Map(); // 画像名 → blob: URL
  const EMPTY = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  const MAX_IMG = 15 * 1024 * 1024;
  const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

  async function storeImage(name, bytes) {
    const blob = new Blob([bytes], { type: MIME[name.split('.').pop()] });
    await tx('images', 'readwrite', st => st.put(blob, name));
    urls.set(name, URL.createObjectURL(blob));
  }
  async function fetchJson(u) { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  async function loadGameData() {
    try {
      const c = JSON.parse(sessionStorage.getItem('vm_gamedata') || 'null');
      if (c && c.version === 4 && Date.now() - c.fetchedAt < 6 * 3600 * 1000) return c;
    } catch {}
    const [m, a, en] = await Promise.all([
      fetchJson('https://valorant-api.com/v1/maps?language=ja-JP'),
      fetchJson('https://valorant-api.com/v1/agents?language=ja-JP&isPlayableCharacter=true'),
      fetchJson('https://valorant-api.com/v1/agents?isPlayableCharacter=true')
    ]);
    const data = window.GameData.shapeGameData(m.data, a.data, en.data, 4);
    try { sessionStorage.setItem('vm_gamedata', JSON.stringify(data)); } catch {}
    return data;
  }
  const BS = () => window.BoardSchema;
  const newStep = () => 's' + Math.random().toString(36).slice(2, 10);

  window.valo = {
    web: true,
    async init() {
      let gameData = null;
      try { gameData = await loadGameData(); } catch (e) { console.warn(e); }
      const boards = await tx('boards', 'readonly', st => req(st.getAll()));
      // 画像は名前と中身を1つのトランザクションで一緒に読む（別々に読むと、ほかのタブの変更で組み合わせがずれる）
      await tx('images', 'readonly', st => new Promise((resolve, reject) => {
        const c = st.openCursor();
        c.onsuccess = () => { const cur = c.result; if (!cur) { resolve(); return; } if (!urls.has(cur.key)) urls.set(cur.key, URL.createObjectURL(cur.value)); cur.continue(); };
        c.onerror = () => reject(c.error);
      }));
      return { gameData, memos: {}, memoImages: {}, boards: boards.map(b => BS().cleanBoard(b, newStep)).filter(Boolean), settings: {}, state: {}, mock: false };
    },
    async putBoard(board) {
      const c = BS().cleanBoard(board, newStep);
      if (!c) return { ok: false, error: 'ボードの形式が正しくありません' };
      c.updated = Date.now();
      try { await tx('boards', 'readwrite', st => st.put(c, c.id)); return { ok: true, board: c }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    putBoardNow(board) { this.putBoard(board); },
    async removeBoard(id) { try { await tx('boards', 'readwrite', st => st.delete(id)); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; } },
    async saveImage(bytes, mime) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
      if (!ext) return { ok: false, error: 'PNG・JPEG・WebP・GIFの画像だけ貼れます' };
      if (!bytes || bytes.length > MAX_IMG || BS().sniffImage(bytes) !== ext) return { ok: false, error: '画像の中身が読み取れませんでした' };
      const name = randomId() + '.' + ext;
      await storeImage(name, bytes);
      return { ok: true, name };
    },
    async hasImage(name) { return urls.has(name); },
    async saveImageNamed(name, bytes) {
      if (!BS().IMG_NAME.test(name || '')) return { ok: false };
      if (urls.has(name)) return { ok: true };
      if (!bytes || bytes.length > MAX_IMG || BS().sniffImage(bytes) !== name.split('.').pop()) return { ok: false };
      await storeImage(name, bytes);
      return { ok: true };
    },
    imgUrl(name) { return urls.get(name) || EMPTY; },
    // アプリにしか無い機能（ブラウザ版では何もしない）
    openBoard() {}, hide() {}, fitHeight() {},
    onState() {}, onSettings() {}, onBoardsChanged() {}, onBoardOpen() {}
  };

  // ---- 招待URLで開いたとき: アプリで開くか、ブラウザで参加するか ----
  window.addEventListener('DOMContentLoaded', () => {
    const h = new URLSearchParams(location.hash.slice(1));
    const room = h.get('room'), key = h.get('k');
    const share = window.BoardSchema.cleanShare({ room, key });
    const box = document.getElementById('invite');
    if (!share || !box) return;
    const appUrl = 'valo-memo://join?room=' + encodeURIComponent(share.room) + '&k=' + encodeURIComponent(share.key);
    box.hidden = false;
    let autoTimer = null;
    const openApp = () => { location.href = appUrl; document.getElementById('invite-after').hidden = false; };
    document.getElementById('invite-app').onclick = () => { clearTimeout(autoTimer); openApp(); };
    document.getElementById('invite-web').onclick = () => {
      clearTimeout(autoTimer); // ブラウザを選んだら、アプリの自動起動はしない
      box.hidden = true;
      const go = () => (typeof window.applyParams === 'function' && typeof S !== 'undefined' && S.data ? window.applyParams({ join: share }, false) : setTimeout(go, 200));
      go();
    };
    // アプリが入っていれば優先して開く（ブラウザが「valo-memoを開きますか」と聞く。入っていなければ何も起きない）
    if (!sessionStorage.getItem('vm_tried_' + share.room)) { sessionStorage.setItem('vm_tried_' + share.room, '1'); autoTimer = setTimeout(openApp, 600); }
  });
})();
