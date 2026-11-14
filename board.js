'use strict';
// 作戦ボード（ValoPlant風）。座標はミニマップ0〜1000の単位、スキルの大きさは board-render.js の縮尺で実寸
const RANKED_POOL = ['Infinity', 'Duality', 'Rook', 'Triad', 'Jam', 'Plummet', 'Juliett'];
const ROLE_ORDER = ['デュエリスト', 'イニシエーター', 'コントローラー', 'センチネル'];
const SLOT_KEY = { Grenade: 'C', Ability1: 'Q', Ability2: 'E', Ultimate: 'X' };
const SLOT_ORDER = ['Grenade', 'Ability1', 'Ability2', 'Ultimate'];
const COLORS = ['#ffffff', '#ff4655', '#3ddc97', '#5aa9ff', '#f5c84c', '#c39bff', '#ff8a5c'];
const DIRECTIONAL = new Set(['rect', 'capsule', 'wall', 'dwall', 'cross', 'cone', 'mapline', 'view']);
const VIEW_LEN = [3, 80]; // 視界の扇の長さ（m）の範囲。実際の視界に終わりは無いので、見せたい所まで伸ばす目安
const NUM_KEYS =['x', 'y', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy', 'tx', 'ty', 'rot', 'len', 'r', 'w', 'h', 'ang', 'vrot', 'vlen', 'vang'];

const $ = id => document.getElementById(id);
const svg = $('board');
const S = {
  data: null, boards: {}, mapUuid: null, boardId: null, step: 0,
  tool: 'select', place: null,           // place: { kind:'agent'|'ability', agent, slot }
  color: '#ffffff', width: 3, team: 'ally', agent: null,
  selectedId: null, vb: { x: 0, y: 0, w: 1000, h: 1000 }, viewRot: 0,
  showCallouts: true, undo: {}, redo: {}, drag: null, playing: null, lineupFrom: null, game: {}
};

const uid = () => 'o' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const newBoardId = () => (crypto.randomUUID ? crypto.randomUUID() : uid() + uid());
const imgUrl = f => (window.valo.imgUrl ? window.valo.imgUrl(f) : 'vmimg://img/' + encodeURIComponent(f));
const newStepId = () => 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
// 招待URL（ブラウザ版の置き場所。#より後ろはサーバーに送られない）
const WEB_BASE = 'https://takubou316.github.io/valo-memo-web/';
const mapById = id => S.data.maps.find(m => m.uuid === id);
const agentById = id => S.data.agents.find(a => a.uuid === id);
const shortName = m => m.mapUrl.split('/').pop();
const cur = () => S.boardId ? S.boards[S.boardId] : null;
const curMap = () => mapById(S.mapUuid);
const stepObjs = () => { const b = cur(); const st = b && b.steps[S.step]; return st ? st.objects : []; };
const findObj = id => stepObjs().find(o => o.id === id);
const k = () => BoardRender.unitsPerMeter(curMap());
const clone = v => JSON.parse(JSON.stringify(v));
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

// ---------- 保存と取り消し ----------
// 保存は作戦ごとに少し待ってまとめる。別の作戦に移る・窓を閉じるときは待たずに書く
const pendingSaves = new Map(); // id → timer
function status(msg, err) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', !!err); }
// 作戦ごとの Yjs 文書（collab.js の BoardDoc）。画面は普通の作戦データを使い、
//  - 自分の変更は commitLocal で文書へ書く（取り消しの対象。一緒に作っている部屋なら自動で送られる）
//  - 他の人の変更・取り消し・やり直しは、文書から作戦データを作り直す（rebuildFromDoc）
// 注意: 文書を作るときと画面で、必ず同じ作戦データのオブジェクトを使う（別の写しだと置いた印がずれ、全部を書き直してしまう）
const docs = {};
function attachDoc(id, d) {
  docs[id] = d;
  // 作り直しで起きたエラーは、受信処理（Yjs の中）に飲み込まれないよう、ここで記録する
  d.onUpdate((u, origin) => { if (origin !== 'local' && origin !== 'init') { try { rebuildFromDoc(id); } catch (e) { console.error('作戦の作り直しに失敗', e && e.stack || e); } } });
  return d;
}
function docOf(b) { return docs[b.id] || attachDoc(b.id, window.Collab.BoardDoc.fromPlain(b)); }
// 保存してあった文書から読み直す（無い・壊れている・別の作戦なら、作戦データから作る）
function loadDoc(b) {
  const saved = typeof b.ydoc === 'string' && b.ydoc ? window.Collab.BoardDoc.fromSaved(b.ydoc, b) : null;
  if (!saved) return attachDoc(b.id, window.Collab.BoardDoc.fromPlain(b));
  const p = saved.project();
  for (const m of window.BoardSchema.META_KEYS) b[m] = p[m];
  b.steps = p.steps;
  return attachDoc(b.id, saved);
}
// 自分の変更を文書へ書く（一緒に作っている部屋なら、文書の変更として自動で送られる）
function commitLocal(id) {
  const b = S.boards[id]; if (!b || !window.Collab) return false;
  return docOf(b).commit(b, 'local');
}
// 文書から作戦データを作り直す（他の人の変更・取り消し・やり直しのあと）
function rebuildFromDoc(id) {
  const b = S.boards[id], d = docs[id]; if (!b || !d) return;
  const before = { step: S.stepId, sel: S.selectedId }; // 入力欄の戻し先の確認用（同じ手順の同じものの時だけ戻す）
  const p = d.project();
  for (const m of window.BoardSchema.META_KEYS) b[m] = p[m];
  b.steps = p.steps;
  if (b.id === S.boardId) {
    keepStep(b); // 見ている手順を先に合わせ直す（消えた手順の番号のままだと、次の確認で失敗する）
    if (S.selectedId && !findObj(S.selectedId)) S.selectedId = null;
    S.viewRot = b.rot || 0;
  } else ensureStep(b);
  saveBoardQuiet(b);
  if (b.id !== S.boardId) return;
  if (S.drag) { renderSide(); draw(); return; }
  // 右の「選んでいるもの」の欄で入力中なら、作り直したあとも同じ欄に入力を戻す
  // （欄の中身は作り直した作戦データから作るので、古いデータへ書き込むことはない。打った分は受信前の commitLocal で文書に入っている）
  // 見ている手順か選んでいるものが変わった（手順が消された等）ときは戻さない（別の手順の同じIDのものに書き込まないように）
  const ae = document.activeElement, box = $('sel-body');
  const fields = () => [...box.querySelectorAll('input, textarea, select')];
  const same = before.step === S.stepId && before.sel === S.selectedId && !!S.selectedId;
  const fi = same && ae && box.contains(ae) ? { i: fields().indexOf(ae), s: ae.selectionStart, e: ae.selectionEnd } : null;
  if (!same && ae && box.contains(ae)) status('入力していたものが他の人に消されました', true);
  renderAll();
  if (fi && fi.i >= 0) { const t = fields()[fi.i]; if (t) { t.focus(); try { if (fi.s != null) t.setSelectionRange(fi.s, fi.e); } catch {} } }
}
// 保存の前に必ず通す（すべての保存の経路で）: 変更を文書へ書き、文書ごと b.ydoc に入れる。
// 大きすぎる文書は保存側で捨てられ、読み直したときに別の履歴になってしまうので、保存そのものをやめて知らせる（前に保存できた分が残る）
function prepareSave(b) {
  commitLocal(b.id);
  const enc = docOf(b).encode(); // 文書ごと保存（抜けている間の変更も、戻ったときに正しくまとまる）
  if (enc.length > window.BoardSchema.MAX_YDOC) { status('作戦が大きすぎて保存できません（画像やペンの線を減らしてください）', true); return false; }
  b.ydoc = enc;
  return true;
}
async function saveBoardNow(id) {
  clearTimeout(pendingSaves.get(id)); pendingSaves.delete(id);
  const b = S.boards[id]; if (!b) return;
  if (!prepareSave(b)) return;
  const r = await window.valo.putBoard(b);
  status(r.ok ? '保存しました' : '保存できませんでした（' + r.error + '）', !r.ok);
}
function saveSoon(board) {
  const b = board || cur(); if (!b) return;
  if (S.collab && S.collab.boardId === b.id) collabSoon();
  clearTimeout(pendingSaves.get(b.id));
  status('保存中…');
  pendingSaves.set(b.id, setTimeout(() => saveBoardNow(b.id), 400));
}
function flushSaves() { for (const id of [...pendingSaves.keys()]) saveBoardNow(id); }
function cancelSave(id) { clearTimeout(pendingSaves.get(id)); pendingSaves.delete(id); }
window.addEventListener('beforeunload', () => {
  // 閉じる直前は返事を待てないので、送りっぱなしの保存を使う（その前に版付けする。しないと抜けている間の変更として比べられない）
  for (const id of [...pendingSaves.keys()]) { cancelSave(id); const b = S.boards[id]; if (b && prepareSave(b)) window.valo.putBoardNow(b); }
});
// ---------- 一緒に作る ----------
let collabTimer = null;
// 変更を少しまとめて相手へ送る（ドラッグ中も60msごとに送るので、相手の画面でも動いて見える）
function collabSoon() {
  if (!S.collab || collabTimer) return;
  collabTimer = setTimeout(() => { collabTimer = null; if (S.collab && S.collab.boardId) commitLocal(S.collab.boardId); }, 60);
}
const PEER_COLORS = ['#ff4655', '#3ddc97', '#5aa9ff', '#f5c84c', '#c39bff', '#ff8a5c', '#4fd1c5', '#f687b3'];
function myName() { return (localStorage.getItem('vb_name') || '').trim(); }
function myColor() {
  let c = localStorage.getItem('vb_color');
  if (!/^#[0-9a-f]{6}$/i.test(c || '')) { c = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)]; localStorage.setItem('vb_color', c); }
  return c;
}
function randomToken(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return Array.from(a, x => x.toString(36).padStart(2, '0')).join('').slice(0, bytes * 2);
}
function inviteUrl(share) { return WEB_BASE + '#room=' + share.room + '&k=' + share.key; }
// 表示名を聞く（最初の1回）。決まったら cb
function askName(cb) {
  const f = el('div', 'sheet-actions');
  f.append(el('p', null, '一緒に作る人に表示される名前を決めてください（あとで変えられます）'));
  const inp = el('input'); inp.maxLength = 24; inp.value = myName(); inp.placeholder = '例: たくと';
  const ok = el('button', 'primary', 'この名前にする');
  const done = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } localStorage.setItem('vb_name', v.slice(0, 24)); closeSheet(); cb(); };
  ok.onclick = done; inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(); };
  f.append(inp, ok);
  openSheet('あなたの名前', f);
  setTimeout(() => inp.focus(), 0);
}
// 今の作戦を共有して部屋を作る
function startShare() {
  const b = cur(); if (!b) return;
  if (!myName()) { askName(startShare); return; }
  if (!b.share) { snapshot(); b.share = { room: randomToken(12), key: randomToken(16) }; saveSoon(); }
  joinCollab(b.share, b.id);
  showInvite();
}
function showInvite() {
  const b = cur(); if (!b || !b.share) return;
  const url = inviteUrl(b.share);
  const f = el('div', 'sheet-actions');
  f.append(el('p', null, 'このURLを友達に送ってください（DiscordやLINEに貼るだけ）。開くと、アプリが入っていればアプリで、無ければブラウザでこの作戦に参加できます。'));
  const box = el('input'); box.value = url; box.readOnly = true; box.onclick = () => box.select();
  const copy = el('button', 'primary', 'URLをコピー');
  copy.onclick = async () => { try { await navigator.clipboard.writeText(url); copy.textContent = 'コピーしました'; } catch { box.select(); copy.textContent = 'Ctrl+C でコピーしてください'; } };
  f.append(box, copy, el('p', 'muted', 'URLを知っている人は誰でもこの作戦を編集できます。知らない人には送らないでください。'));
  openSheet('招待URL', f);
}
function joinCollab(share, boardId) {
  if (S.collab) { if (S.collab.o.room === share.room) return; leaveCollab(); }
  if (!window.Trystero) { status('一緒に作る機能を読み込めませんでした', true); return; }
  S.peers = []; S.cursors = {};
  S.collab = new window.Collab.Collab({
    boardId, room: share.room, key: share.key, name: myName() || 'ゲスト', color: myColor(),
    getDoc: id => docs[id] || null,
    // 受け取った作戦を開く（setMap は別の作戦を選んでしまうので使わない）
    // 戻り値 false = 受け取らない（同じIDの別の作戦がこのPCにある。上書きすると手元の作戦が消えるため）
    adoptDoc: d => {
      const p = d.project();
      const mine = S.boards[p.id];
      if (mine && !(mine.share && mine.share.room === share.room)) {
        status('同じ作戦がすでにこのPCにあるため参加できませんでした（上書きしないように止めました）', true);
        setTimeout(leaveCollab, 0);
        return false;
      }
      if (mine) { // 同じ部屋の作戦（前に参加したもの）: 手元の文書に受け取った分を足す（抜けている間の自分の変更も残る）
        if (mine.mapUuid !== p.mapUuid || docOf(mine).meta.get('mapUuid') !== p.mapUuid) {
          status('受け取った作戦のマップが手元の作戦と違うため参加できませんでした', true);
          setTimeout(leaveCollab, 0);
          return false;
        }
        cancelSave(mine.id); commitLocal(mine.id); // 保存待ちの書きかけを先に文書へ（作り直しで消えないように）
        window.Y.applyUpdate(docOf(mine).doc, window.Y.encodeStateAsUpdate(d.doc), 'remote');
        selectBoard(mine.id);
        return 'merged';
      }
      const b = { id: p.id, mapUuid: p.mapUuid, created: Date.now(), updated: Date.now(), share: { room: share.room, key: share.key } };
      for (const m of window.BoardSchema.META_KEYS) b[m] = p[m];
      b.steps = p.steps; ensureStep(b);
      S.boards[b.id] = b; attachDoc(b.id, d);
      commitLocal(b.id); // ensureStep で作った手順があれば文書へ
      if (prepareSave(b)) window.valo.putBoard(b);
      S.mapUuid = b.mapUuid; localStorage.setItem('vb_map', b.mapUuid); snapCallouts(mapById(b.mapUuid)); fitView(); selectBoard(b.id); updateBanner();
    },
    commitLocal,
    afterRemote: () => {}, // 作り直しは文書の変更の知らせ（attachDoc）で行う
    onImage: () => draw(),  // 画像が届いたら描き直すだけ
    imagesOf: id => (S.boards[id] ? window.BoardSchema.imagesUsedBy(S.boards[id]) : new Set()),
    onPeers: list => { S.peers = list; renderCollab(); },
    onCursor: map => { S.cursors = map; drawCursors(); },
    onStatus: (text, err) => { S.collabStatus = { text, err }; renderCollab(); },
    hasImage: name => window.valo.hasImage(name),
    readImage: async name => { try { const r = await fetch(imgUrl(name)); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } catch { return null; } },
    saveImage: async (name, bytes) => { const r = await window.valo.saveImageNamed(name, bytes); return !!(r && r.ok); }
  });
  S.collab.start();
  renderCollab();
}
// 手順が1つも無くなったら（全部が消された）、ふつうの新しい手順を作る（版付けされて全員に送られる）
function ensureStep(b) { if (!b.steps.length) b.steps.push({ id: newStepId(), ord: 0, objects: [], note: '' }); }
// 見ている手順を、ID で保つ（他の人が前に手順を足しても、見ている手順が変わらないように）
function keepStep(b) {
  ensureStep(b);
  const i = S.stepId ? b.steps.findIndex(st => st.id === S.stepId) : -1;
  S.step = i >= 0 ? i : Math.min(S.step, b.steps.length - 1);
  S.stepId = b.steps[S.step] && b.steps[S.step].id;
}
function leaveCollab() {
  if (!S.collab) return;
  if (S.collab.boardId) commitLocal(S.collab.boardId);
  S.collab.leave();
  S.collab = null; S.peers = []; S.cursors = {}; S.collabStatus = null;
  renderCollab(); draw();
}
// 受け取った変更の保存（相手へは送り返さない。版付けの基準は取り直し済みなので、保存時の commitLocal でも何も送られない）
function saveBoardQuiet(b) {
  clearTimeout(pendingSaves.get(b.id));
  pendingSaves.set(b.id, setTimeout(() => saveBoardNow(b.id), 400));
}
function renderCollab() {
  const box = $('collab'); if (!box) return;
  box.textContent = '';
  const b = cur();
  const active = S.collab && (!S.collab.boardId || (b && S.collab.boardId === b.id));
  if (!active) {
    const btn = el('button', 'primary wide', '👥 一緒に作る（招待URLを作る）');
    btn.disabled = !b; btn.onclick = startShare;
    box.append(btn);
    if (b && b.share) box.append(el('div', 'hint-text', 'この作戦は前に共有したことがあります。押すと同じURLでまた一緒に作れます。'));
    return;
  }
  const st = S.collabStatus;
  if (st) box.append(el('div', 'collab-status' + (st.err ? ' err' : ''), st.text));
  const list = el('div', 'peers');
  for (const p of S.peers || []) {
    const c = el('span', 'peer'); c.style.borderColor = p.color;
    const dot = el('i'); dot.style.background = p.color; c.append(dot, el('span', null, p.name + (p.self ? '（あなた）' : '')));
    list.append(c);
  }
  box.append(el('div', 'hint-text', `参加中 ${(S.peers || []).length}人`), list);
  const row = el('div', 'row-btns');
  const inv = el('button', null, '招待URL'); inv.onclick = showInvite;
  const nm = el('button', null, '名前'); nm.onclick = () => askName(() => S.collab && S.collab.setName(myName(), myColor()));
  const lv = el('button', 'danger', '抜ける'); lv.onclick = () => { if (confirm('一緒に作るのをやめますか？（作戦はあなたのPCに残ります）')) leaveCollab(); };
  row.append(inv, nm, lv);
  box.append(row);
}
// 他の人のカーソル（今見ている手順の人だけ）
function drawCursors() {
  const root = svg.querySelector('.board-root'); if (!root) return;
  const old = root.querySelector('.cursors'); if (old) old.remove();
  const b = cur(); if (!S.collab || !b || S.collab.boardId !== b.id) return;
  const stepId = b.steps[S.step] && b.steps[S.step].id;
  const NS = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'cursors'); g.setAttribute('pointer-events', 'none');
  const ui = Math.min(1.4, Math.max(0.22, S.vb.w / 1000));
  for (const [uid, c] of Object.entries(S.cursors || {})) {
    if (!c || c.s !== stepId) continue;
    const p = (S.peers || []).find(x => x.id === uid) || { name: '?', color: '#ffffff' };
    const cg = document.createElementNS(NS, 'g');
    cg.setAttribute('transform', `translate(${c.x} ${c.y}) rotate(${-(S.viewRot || 0)}) scale(${ui})`);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M0 0 L0 18 L5 13 L9 22 L12 21 L8 12 L15 12 Z');
    path.setAttribute('fill', p.color); path.setAttribute('stroke', '#0a1016'); path.setAttribute('stroke-width', '1.5');
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', 14); t.setAttribute('y', 30); t.setAttribute('class', 'cursor-label'); t.setAttribute('fill', p.color); t.setAttribute('font-size', 13);
    t.textContent = p.name;
    cg.append(path, t); g.append(cg);
  }
  root.append(g);
}

// ---------- 取り消し（Yjs の UndoManager） ----------
// 1回の操作（ドラッグ1回・置く・消すなど）の前に beginAction を呼ぶと、そこで取り消しのまとまりが区切られる。
// UndoManager は自分の変更（origin 'local'）だけを記録し、取り消しでも他の人の変更は消さない。
// 取り消し・やり直しも文書の変更なので、一緒に作っている相手に自動で送られる
function beginAction(board) {
  const b = board || cur(); if (!b) return;
  commitLocal(b.id); // ここまでの変更は前の操作のまとまりへ
  docOf(b).um.stopCapturing();
}
const snapshot = beginAction; // 呼び出し元の名前はそのまま
function restore(kind) {
  const b = cur(); if (!b) return;
  commitLocal(b.id); // 書きかけの変更を先に文書へ
  const um = docOf(b).um;
  if (kind === 'undo' ? !um.canUndo() : !um.canRedo()) return;
  stopPlay();
  if (kind === 'undo') um.undo(); else um.redo(); // 文書が変わる → rebuildFromDoc で作戦データを作り直す
  saveSoon();
}
const undo = () => restore('undo');
const redo = () => restore('redo');

// ---------- 地点名を通路の上に寄せる ----------
// ゲームのデータの地点名の点は、通路の端や壁の外（黒い所）にあることがある（パール・ブリーズ・サンセットなど）。
// ミニマップ画像の透明度を読み、通路の外にある点は近くの通路の上へ寄せて表示する（データ自体は変えない）
const calloutPosCache = {};
async function snapCallouts(map) {
  if (calloutPosCache[map.uuid] || !map.callouts) return;
  calloutPosCache[map.uuid] = 'loading';
  try {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = map.minimap;
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    const walk = (x, y) => { const px = Math.round(x / 1000 * c.width), py = Math.round(y / 1000 * c.height);
      return px >= 0 && py >= 0 && px < c.width && py < c.height && data[(py * c.width + px) * 4 + 3] >= 128; };
    calloutPosCache[map.uuid] = map.callouts.map(cl => {
      if (walk(cl.x, cl.y)) return { x: cl.x, y: cl.y };
      for (let r = 3; r <= 70; r += 3) for (let a = 0; a < 32; a++) {
        const x = cl.x + Math.cos(a / 32 * Math.PI * 2) * r, y = cl.y + Math.sin(a / 32 * Math.PI * 2) * r;
        // 通路の縁ぎりぎりにならないよう、少し内側（さらに4単位先も通路）を選ぶ
        if (walk(x, y) && walk(cl.x + Math.cos(a / 32 * Math.PI * 2) * (r + 4), cl.y + Math.sin(a / 32 * Math.PI * 2) * (r + 4))) return { x, y };
      }
      return { x: cl.x, y: cl.y }; // 近くに通路が無ければそのまま
    });
  } catch (e) { calloutPosCache[map.uuid] = null; console.warn('地点名の位置合わせに失敗', e); return; }
  if (S.mapUuid === map.uuid) draw();
}

// ---------- 表示 ----------
function applyVB() { svg.setAttribute('viewBox', `${S.vb.x} ${S.vb.y} ${S.vb.w} ${S.vb.h}`); updateScale(); }
function fitView() { S.vb = { x: 0, y: 0, w: 1000, h: 1000 }; applyVB(); }

function draw(objectsOverride) {
  const map = curMap(); if (!map) return;
  const b = cur() || { steps: [{ objects: [] }], rot: S.viewRot };
  const { root } = BoardRender.render(svg, b, map, S.data, {
    step: S.step, showCallouts: S.showCallouts, selectedId: S.selectedId, imgUrl, badge: 1.5, // 定点の画像の印は押しやすいよう大きめ
    calloutPos: Array.isArray(calloutPosCache[map.uuid]) ? calloutPosCache[map.uuid] : null, ui: Math.min(1.4, Math.max(0.22, S.vb.w / 1000)),
    objects: objectsOverride
  });
  if (!objectsOverride) drawSelection(root);
  drawCursors();
  updateScale();
}

function drawSelection(root) {
  const o = S.selectedId && findObj(S.selectedId); if (!o) return;
  const g = root.querySelector(`[data-id="${o.id}"]`); if (!g) return;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const a in attrs) e.setAttribute(a, attrs[a]); root.appendChild(e); return e; };
  // 選択の枠は視界の扇（class view）を除いた大きさで（扇まで含めると枠が大きすぎて分かりにくい）
  // （一時的に display:none にすると getBBox に含まれない）
  let bb;
  const views = [...g.querySelectorAll('.view')];
  try { views.forEach(v => v.setAttribute('display', 'none')); bb = g.getBBox(); }
  catch { return; }
  finally { views.forEach(v => v.removeAttribute('display')); }
  const pad = 4;
  mk('rect', { x: bb.x - pad, y: bb.y - pad, width: bb.width + pad * 2, height: bb.height + pad * 2, class: 'sel-outline', 'vector-effect': 'non-scaling-stroke' });
  const hr = 7 * S.vb.w / 1000;
  const handle = (name, x, y) => mk('circle', { cx: x, cy: y, r: hr, class: 'handle', 'data-handle': name, 'vector-effect': 'non-scaling-stroke' });
  if (o.kind === 'ability') {
    const a = agentById(o.agent);
    const geo = a ? BoardRender.geometryOf(a, o.slot) : null;
    if (geo && geo.move && typeof o.tx === 'number') handle('mto', o.tx, o.ty);
    if (geo && geo.s === 'view') {
      // 視界の扇: 先端の丸で向きと長さをいっぺんに変える
      const L = (o.len != null ? o.len : geo.len) * k(), rad = (o.rot || 0) * Math.PI / 180;
      handle('vtip', o.x + Math.cos(rad) * L, o.y + Math.sin(rad) * L);
    } else if (geo && geo.var && geo.s === 'wall') {
      // 長さを変えられる壁（トラップワイヤー・フェニックスの壁など）: 両端の丸。片方を引くと反対の端は動かず、向きと長さがいっぺんに変わる
      const L = (o.len != null ? o.len : geo.len) * k() / 2, rad = (o.rot || 0) * Math.PI / 180;
      const dx = Math.cos(rad) * L, dy = Math.sin(rad) * L;
      handle('end1', o.x - dx, o.y - dy); handle('end2', o.x + dx, o.y + dy);
    } else if (geo && geo.var && geo.s === 'rect') {
      // 長さを変えられる長方形（ブリーチのフォールトライン）: 先の端の丸で向きと長さ
      const L = ((geo.off || 0) + (o.len != null ? o.len : geo.len)) * k(), rad = (o.rot || 0) * Math.PI / 180;
      mk('line', { x1: o.x, y1: o.y, x2: o.x + Math.cos(rad) * L, y2: o.y + Math.sin(rad) * L, class: 'handle-line', 'vector-effect': 'non-scaling-stroke' });
      handle('rtip', o.x + Math.cos(rad) * L, o.y + Math.sin(rad) * L);
    } else if (geo && DIRECTIONAL.has(geo.s)) {
      const D = 46 * S.vb.w / 1000 + 20, rad = (o.rot || 0) * Math.PI / 180;
      const hx = o.x + Math.cos(rad) * D, hy = o.y + Math.sin(rad) * D;
      mk('line', { x1: o.x, y1: o.y, x2: hx, y2: hy, class: 'handle-line', 'vector-effect': 'non-scaling-stroke' });
      handle('rot', hx, hy);
    }
  } else if (o.kind === 'agent' && typeof o.vlen === 'number') {
    const L = o.vlen * k(), rad = (o.vrot || 0) * Math.PI / 180;
    handle('vtip', o.x + Math.cos(rad) * L, o.y + Math.sin(rad) * L);
  } else if (o.kind === 'line' || o.kind === 'rect' || o.kind === 'ellipse') {
    handle('p1', o.x1, o.y1); handle('p2', o.x2, o.y2);
  } else if (o.kind === 'image') {
    handle('size', o.x + o.w, o.y + o.h);
  } else if (o.kind === 'lineup') {
    handle('from', o.fx, o.fy); handle('to', o.tx, o.ty);
  }
}

function updateScale() {
  const map = curMap(); if (!map) return;
  const ctm = svg.getScreenCTM(); if (!ctm) return;
  const pxPerUnit = Math.hypot(ctm.a, ctm.b);
  let m = 10;
  for (const c of [5, 10, 20, 50]) { m = c; if (c * k() * pxPerUnit >= 60) break; }
  $('scale-bar').style.width = Math.round(m * k() * pxPerUnit) + 'px';
  $('scale-label').textContent = m + 'm';
  $('scale-info').textContent = `このマップの縮尺: 画像の横幅 ≒ ${Math.round(1000 / k())}m。スキルの大きさはこの縮尺の実寸で描いています（数値の確かさは、スキルを選ぶと表示）。`;
}

function renderAll() { renderSide(); renderSteps(); renderSel(); renderTools(); renderCollab(); draw(); }

// ---------- 左: マップ・作戦一覧 ----------
function boardsForMap() {
  let list = Object.values(S.boards).filter(b => b.mapUuid === S.mapUuid);
  if ($('filter-agent').checked && S.agent) { const a = agentById(S.agent); list = list.filter(b => b.agent === S.agent || (a && a.roleId && b.agent === 'role:' + a.roleId)); }
  return list.sort((a, b) => b.updated - a.updated);
}
function renderSide() {
  const map = curMap();
  $('map-name').textContent = map ? map.name : '—';
  if (map) $('map-thumb').src = map.thumb || map.splash;
  const ul = $('board-list'); ul.textContent = '';
  const list = boardsForMap();
  if (!list.length) { const li = el('li', 'none', 'まだありません'); ul.append(li); }
  for (const b of list) {
    const li = el('li', b.id === S.boardId ? 'cur' : '');
    const a = whoOf(b.agent);
    if (a) { const i = el('img', a.role ? 'role-icon' : null); i.src = a.icon; i.alt = ''; li.append(i); }
    li.append(el('span', 'bname', b.name));
    li.append(el('span', 'meta', (b.side === 'atk' ? '攻め・' : b.side === 'def' ? '守り・' : '') + b.steps.length + '手順'));
    li.onclick = () => selectBoard(b.id);
    ul.append(li);
  }
  const b = cur();
  $('board-settings').hidden = !b;
  $('empty').hidden = !!b;
  if (b) {
    if (document.activeElement !== $('board-name')) $('board-name').value = b.name;
    const a = whoOf(b.agent);
    if (a) $('board-agent-img').src = a.icon; else $('board-agent-img').removeAttribute('src');
    $('board-agent-img').classList.toggle('role-icon', !!(a && a.role));
    $('board-agent-name').textContent = a ? a.name : '指定なし（全キャラ）';
    for (const btn of $('board-side').children) btn.classList.toggle('on', (btn.dataset.side || null) === (b.side || null));
  }
}
function selectBoard(id) {
  if (S.collab && S.collab.boardId && id !== S.collab.boardId) { leaveCollab(); status('別の作戦を開いたので、一緒に作るのを抜けました'); }
  stopPlay();
  cancelPaletteDrag();
  flushSaves(); // 前の作戦の書きかけを先に保存
  S.boardId = id; S.step = 0; S.selectedId = null; S.lineupFrom = null; S.drag = null;
  if (id) S.viewRot = S.boards[id].rot || 0;
  renderAll();
}
function setMap(uuid) {
  if (!mapById(uuid)) return;
  S.mapUuid = uuid; localStorage.setItem('vb_map', uuid);
  snapCallouts(mapById(uuid));
  const list = boardsForMap();
  selectBoard(list[0] ? list[0].id : null);
  fitView();
  updateBanner();
}
function newBoard() {
  if (!S.mapUuid) return;
  const n = Object.values(S.boards).filter(b => b.mapUuid === S.mapUuid).length + 1;
  const b = { id: newBoardId(), mapUuid: S.mapUuid, name: '作戦 ' + n, agent: S.agent || null, side: 'atk', rot: S.viewRot || 0,
    steps: [{ id: newStepId(), ord: 0, objects: [], note: '' }], created: Date.now(), updated: Date.now(), ver: {}, tomb: {}, stomb: {}, share: null };
  S.boards[b.id] = b; attachDoc(b.id, window.Collab.BoardDoc.fromPlain(b));
  selectBoard(b.id);
  saveSoon();
}
async function deleteBoard() {
  const b = cur(); if (!b) return;
  if (!confirm(`「${b.name}」を削除します。元に戻せません。よろしいですか？`)) return;
  cancelSave(b.id); // 書きかけの保存で復活させない
  const r = await window.valo.removeBoard(b.id);
  if (!r.ok) { status('削除できませんでした（' + r.error + '）', true); return; }
  delete S.boards[b.id];
  const list = boardsForMap();
  selectBoard(list[0] ? list[0].id : null);
  status('削除しました');
}
function duplicateBoard() {
  const b = cur(); if (!b) return;
  const c = clone(b); c.id = newBoardId(); c.name = b.name + ' のコピー'; c.created = c.updated = Date.now();
  c.share = null; c.ver = {}; c.tomb = {}; c.stomb = {}; // 複製は一緒に作っている部屋とは別の作戦
  for (const st of c.steps) { delete st.nv; delete st.sv; for (const o of st.objects) { delete o.v; delete o.z; } }
  delete c.ydoc; S.boards[c.id] = c; attachDoc(c.id, window.Collab.BoardDoc.fromPlain(c)); selectBoard(c.id); saveSoon();
}

// ---------- 手順 ----------
function renderSteps() {
  const b = cur();
  const box = $('steps'); box.textContent = '';
  for (const id of ['add-step', 'del-step', 'play', 'step-note']) $(id).disabled = !b;
  if (!b) return;
  if (S.step >= b.steps.length) S.step = b.steps.length - 1;
  S.stepId = b.steps[S.step] && b.steps[S.step].id; // 見ている手順を ID でも覚える（他の人の変更で並びが変わっても保つ）
  b.steps.forEach((s, i) => {
    const btn = el('button', i === S.step ? 'on' : '', String(i + 1));
    btn.onclick = () => { stopPlay(); S.step = i; S.selectedId = null; renderAll(); };
    box.append(btn);
  });
  $('del-step').disabled = b.steps.length <= 1 || !!S.playing; // 再生中は手順の数を変えない
  $('add-step').disabled = b.steps.length >= 30 || !!S.playing;
  // メモ欄は手順のIDに結びつける（書いている途中に他の人がその手順を消したら、別の手順へ書き込まないよう打ち切る）
  const noteEl = $('step-note'), curStep = b.steps[S.step];
  if (document.activeElement !== noteEl) { noteEl.value = curStep.note || ''; noteEl.dataset.step = curStep.id; }
  else if (noteEl.dataset.step !== curStep.id && !b.steps.some(st => st.id === noteEl.dataset.step)) { noteEl.blur(); noteEl.value = curStep.note || ''; noteEl.dataset.step = curStep.id; status('書いていた手順が他の人に消されました', true); }
  $('play').textContent = S.playing ? '■ 止める' : '▶ 最初から再生';
  $('play').disabled = b.steps.length < 2 && !S.playing;
}
function addStep() {
  const b = cur(); if (!b || b.steps.length >= 30 || S.playing) return;
  snapshot();
  // 今の手順と次の手順の間の位置にする。位置が同じ・近すぎる（同時に足した手順どうし）なら、全部を並べ直してから
  let curOrd = b.steps[S.step].ord || 0, next = b.steps[S.step + 1];
  if (next && !(next.ord - curOrd > 1e-6)) { b.steps.forEach((st, i) => { st.ord = i * 1024; }); curOrd = b.steps[S.step].ord; }
  const ord = next ? (curOrd + next.ord) / 2 : curOrd + 1024;
  const ns = { id: newStepId(), ord, objects: clone(b.steps[S.step].objects).map(o => { delete o.v; return o; }), note: '' }; // 同じidのまま写す（再生で動きがつながる）
  b.steps.push(ns); b.steps.sort(window.BoardSchema.stepOrder);
  S.step = b.steps.indexOf(ns); S.stepId = ns.id; S.selectedId = null;
  saveSoon(); renderAll();
}
function delStep() {
  const b = cur(); if (!b || b.steps.length <= 1 || S.playing) return;
  snapshot();
  b.steps.splice(S.step, 1); // 取り消せば中身ごと戻る（Yjs の UndoManager）
  S.step = Math.max(0, S.step - 1); S.selectedId = null;
  saveSoon(); renderAll();
}
// スキルの長さ・半径は、変えていなければ標準値（保存されていない）なので、補間の前に実際の値をそろえる
function effective(o, key) {
  if (typeof o[key] === 'number') return o[key];
  if (o.kind === 'ability' && (key === 'len' || key === 'r')) {
    const a = agentById(o.agent); const g = a && BoardRender.geometryOf(a, o.slot);
    if (g && typeof g[key] === 'number') return g[key];
  }
  if (o.kind === 'ability' && key === 'ang') {
    const a = agentById(o.agent); const g = a && BoardRender.geometryOf(a, o.slot);
    if (g && g.s === 'view') return g.angle;
  }
  if (o.kind === 'agent' && typeof o.vlen === 'number') {
    if (key === 'vrot') return 0;
    if (key === 'vang') return BoardRender.VIEW_DEFAULT;
  }
  return undefined;
}
function lerpObjects(a, b, t) {
  const prev = new Map(a.map(o => [o.id, o]));
  const out = [];
  for (const o of b) {
    const p = prev.get(o.id);
    if (!p) { out.push({ ...o, __opacity: t }); continue; }
    const m = { ...o };
    for (const key of NUM_KEYS) {
      let from = effective(p, key), to = effective(o, key);
      if (typeof from !== 'number' || typeof to !== 'number') continue;
      if (key === 'rot' || key === 'vrot') { let d = ((to - from + 180) % 360 + 360) % 360 - 180; to = from + d; } // 負の値でも最短の向きで回す
      m[key] = from + (to - from) * t;
    }
    if (o.kind === 'pen' && p.points && o.points && p.points.length === o.points.length)
      m.points = o.points.map((q, i) => [p.points[i][0] + (q[0] - p.points[i][0]) * t, p.points[i][1] + (q[1] - p.points[i][1]) * t]);
    out.push(m);
  }
  const next = new Set(b.map(o => o.id));
  for (const o of a) if (!next.has(o.id)) out.push({ ...o, __opacity: 1 - t });
  return out;
}
function play() {
  if (S.playing) { stopPlay(); return; }
  const b = cur(); if (!b || b.steps.length < 2) return;
  S.selectedId = null;
  const MOVE = 800, HOLD = 700;
  const seq = { i: 0, t0: performance.now() };
  S.playing = seq;
  S.step = 0; renderAll();
  const frame = now => {
    if (S.playing !== seq) return;
    if (cur() !== b || seq.i + 1 >= b.steps.length) { stopPlay(); return; } // 作戦が変わった・手順が減ったら止める
    const e = now - seq.t0;
    if (e < HOLD) { requestAnimationFrame(frame); return; }
    const t = Math.min(1, (e - HOLD) / MOVE);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    draw(lerpObjects(b.steps[seq.i].objects, b.steps[seq.i + 1].objects, ease));
    if (t >= 1) {
      seq.i++; S.step = seq.i; seq.t0 = now; renderSteps();
      if (seq.i >= b.steps.length - 1) { setTimeout(() => { if (S.playing === seq) stopPlay(); }, HOLD); draw(); return; }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
function stopPlay() { if (!S.playing) return; S.playing = null; renderSteps(); draw(); }

// ---------- ツール ----------
function renderTools() {
  for (const b of $('tools').children) b.classList.toggle('on', !S.place && b.dataset.tool === S.tool);
  for (const b of $('colors').children) b.classList.toggle('on', b.dataset.color === S.color);
  for (const b of $('team').children) b.classList.toggle('on', b.dataset.team === S.team);
  svg.classList.toggle('tool-select', S.tool === 'select' && !S.place);
  svg.classList.toggle('tool-eraser', S.tool === 'eraser' && !S.place);
  svg.classList.toggle('tool-draw', !!S.place || !['select', 'eraser'].includes(S.tool));
  renderAgentBar();
  let hint = '';
  if (S.place) {
    const a = agentById(S.place.agent);
    if (S.place.kind === 'agent') hint = `${a.name}を置く場所をクリック`;
    else { const ab = a.abilities.find(x => x.slot === S.place.slot); hint = `${ab ? ab.name : ''}を置く場所をクリック（向きは置いた後に白い丸で回せます）`; }
  } else if (S.tool === 'lineup') {
    const la = S.lastAbility && agentById(S.lastAbility.agent);
    const ab = la && la.abilities.find(x => x.slot === S.lastAbility.slot);
    hint = (S.lineupFrom ? '次に、投げる先（着弾点）をクリック' : '立ち位置をクリック → 投げる先をクリック') + (ab ? `（スキル: ${la.name} ${ab.name}）` : '（スキルは後から下のバーで付けられます）');
  }
  else if (S.tool === 'text') hint = '文字を置く場所をクリック';
  if (!cur()) hint = '';
  $('hint').textContent = hint;
}
function setTool(t) { S.tool = t; S.place = null; S.lineupFrom = null; if (t !== 'select') S.selectedId = null; renderTools(); renderSel(); draw(); }

// 移動系の行き先が無ければ、画面の上方向に置く（届く距離の7割、上限なしなら10m）。付けたら true
function ensureMoveTarget(o, mapForK) {
  if (o.kind !== 'ability' || typeof o.tx === 'number') return false;
  const a = agentById(o.agent); const geo = a && BoardRender.geometryOf(a, o.slot);
  if (!geo || !geo.move) return false;
  const kk = BoardRender.unitsPerMeter(mapForK || curMap());
  const d = (geo.move.max ? geo.move.max * 0.7 : 10) * kk, rad = (-90 - (S.viewRot || 0)) * Math.PI / 180;
  o.tx = o.x + Math.cos(rad) * d; o.ty = o.y + Math.sin(rad) * d;
  return true;
}
// 読み込んだ作戦で、移動系の行き先が確定した届く距離を超えていたら収める
function normalizeBoard(b) {
  const map = mapById(b.mapUuid); if (!map) return;
  const kk = BoardRender.unitsPerMeter(map);
  for (const st of b.steps) for (const o of st.objects) {
    if (o.kind !== 'ability' || typeof o.tx !== 'number') continue;
    const a = agentById(o.agent); const geo = a && BoardRender.geometryOf(a, o.slot);
    if (geo && geo.move) Object.assign(o, BoardRender.clampMove(o, geo, kk));
  }
}

// キャラかスキルを p（マップの座標）に置いて選んだ状態にする。戻り値は置いたもの
function placeObject(place, p) {
  snapshot();
  const up = -90 - (S.viewRot || 0); // 画面の上向き
  let o;
  if (place.kind === 'agent') o = { id: uid(), kind: 'agent', agent: place.agent, team: S.team, x: p.x, y: p.y };
  else {
    o = { id: uid(), kind: 'ability', agent: place.agent, slot: place.slot, team: S.team, x: p.x, y: p.y, rot: up };
    // 移動系は、行き先を画面の上方向に置いておく（届く距離の7割、上限なしなら10m）。白い丸で動かす
    ensureMoveTarget(o);
  }
  stepObjs().push(o);
  S.place = null; S.tool = 'select'; S.selectedId = o.id;
  saveSoon(); renderTools(); renderSel(); draw();
  return o;
}

// 下のバーからマップへドラッグ＆ドロップで置く。少し動かすまではクリック扱い（click イベントで onClick）
// 同時に1つだけ。始めたポインター以外の動きは無視。Esc・作戦の切替・外からの更新で取り消す（cancelPaletteDrag）
let paletteActive = null; // { cancel }
function cancelPaletteDrag() { if (paletteActive) paletteActive.cancel(); }
function paletteDrag(btn, getPlace, iconSrc, onClick) {
  let justDragged = false;
  // ふつうのクリック（キーボードの Enter/Space も含む）は click で受ける。ドラッグした直後の click だけ無視
  btn.addEventListener('click', () => { if (justDragged) { justDragged = false; return; } onClick(); });
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0 || paletteActive) return;
    e.preventDefault();
    justDragged = false;
    const pid = e.pointerId, sx = e.clientX, sy = e.clientY, boardAtStart = S.boardId;
    let ghost = null;
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelEv);
      if (ghost) ghost.remove(); ghost = null; svg.classList.remove('drop-target');
      paletteActive = null;
    };
    const move = ev => {
      if (ev.pointerId !== pid) return;
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!ghost) {
        if (!cur()) { status('先に「＋ 新しい作戦」を作ってください', true); cleanup(); return; }
        if (S.playing) { status('再生中は置けません（■ 止める を押してから）', true); cleanup(); return; }
        ghost = el('img', 'drag-ghost'); ghost.src = iconSrc; document.body.append(ghost);
        svg.classList.add('drop-target');
      }
      ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      ghost.classList.toggle('ok', !!(over && svg.contains(over)));
    };
    const up = ev => {
      if (ev.pointerId !== pid) return;
      const dragged = !!ghost;
      cleanup();
      if (!dragged) return; // クリックは click で処理する
      justDragged = true; setTimeout(() => { justDragged = false; }, 0);
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!(over && svg.contains(over))) { status('マップの上で離すと置けます'); return; }
      if (!cur() || S.boardId !== boardAtStart || S.playing) { status('作戦が変わったか再生中のため、置きませんでした', true); return; }
      placeObject(getPlace(), toMap(ev));
    };
    const cancelEv = ev => { if (ev.pointerId === pid) cleanup(); };
    paletteActive = { cancel: cleanup };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancelEv);
  });
}

function renderAgentBar() {
  const box = $('agents');
  if (!box.childElementCount) {
    const list = [...S.data.agents].sort((a, b) => (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) || a.name.localeCompare(b.name, 'ja'));
    for (const a of list) {
      const btn = el('button'); btn.title = a.name + '（' + a.role + '）'; btn.dataset.agent = a.uuid;
      const i = el('img'); i.src = a.icon; i.alt = a.name; btn.append(i);
      const select = () => { S.agent = a.uuid; S.place = null; renderTools(); if ($('filter-agent').checked) renderSide(); };
      paletteDrag(btn, () => { S.agent = a.uuid; renderTools(); return { kind: 'agent', agent: a.uuid }; }, a.icon, select);
      box.append(btn);
    }
  }
  for (const b of box.children) b.classList.toggle('on', b.dataset.agent === S.agent);
  const ab = $('abilities'); ab.textContent = '';
  const a = S.agent && agentById(S.agent);
  if (!a) { ab.append(el('span', 'muted', '← キャラを選ぶと、そのキャラとスキルを置けます')); return; }
  const mk = (label, key, icon, place) => {
    const b = el('button'); b.title = label;
    const on = S.place && S.place.kind === place.kind && S.place.slot === place.slot && S.place.agent === place.agent;
    b.classList.toggle('on', !!on);
    const i = el('img'); i.src = icon; i.alt = ''; b.append(i);
    b.append(el('span', 'key', key)); b.append(el('span', null, label.length > 7 ? label.slice(0, 7) + '…' : label));
    const click = () => {
      if (!cur()) { status('先に「＋ 新しい作戦」を作ってください', true); return; }
      if (place.kind === 'ability') S.lastAbility = place; // ラインナップに付けるスキルとしても覚える
      // ラインナップを選んでいるときは、置かずにそのラインナップのスキルを変える
      const sel = S.selectedId && findObj(S.selectedId);
      if (sel && sel.kind === 'lineup' && place.kind === 'ability') { snapshot(); sel.agent = place.agent; sel.slot = place.slot; syncLineup(sel); saveSoon(); renderSel(); draw(); return; }
      S.place = on ? null : place; S.selectedId = null; renderTools(); renderSel(); draw();
    };
    paletteDrag(b, () => { if (place.kind === 'ability') S.lastAbility = place; return place; }, icon, click);
    ab.append(b);
  };
  mk(a.name, 'キャラ', a.icon, { kind: 'agent', agent: a.uuid });
  for (const slot of SLOT_ORDER) {
    const x = a.abilities.find(s => s.slot === slot); if (!x) continue;
    mk(x.name, SLOT_KEY[slot], x.icon, { kind: 'ability', agent: a.uuid, slot });
  }
}

// ---------- 選んでいるもの ----------
function geoText(o, a, geo) {
  const len = o.len != null ? o.len : geo.len, r = o.r != null ? o.r : geo.r;
  switch (geo.s) {
    case 'circle': return `半径 ${r}m（直径 ${+(r * 2).toFixed(2)}m）`;
    case 'rings': return `内側 半径${geo.r[0]}m／外側 半径${geo.r[1]}m`;
    case 'rect': return `長さ ${len}m × 幅 ${geo.w}m` + (geo.off ? `（使う人から${geo.off}m先から）` : '（使う人の位置から）');
    case 'capsule': return `${len}m 進む・半径 ${geo.r}m（使う人の位置から）` + (geo.end ? `、終点は半径 ${geo.end}m` : '');
    case 'wall': return `長さ ${len}m` + (geo.var ? `（${geo.var[0]}〜${geo.var[1]}m）` : '') + `・厚さ ${geo.w}m`;
    case 'dwall': return `前 ${geo.front}m・後ろ ${geo.back}m、2枚の壁の内側の間 ${geo.gap}m`;
    case 'cross': return `中心から ${geo.arm}m ずつの十字`;
    case 'cone': return `半径 ${geo.r}m・角度 ${geo.angle}°`;
    case 'mapline': return 'マップを横切る壁（向きだけ合わせる）';
    case 'view': return `見える範囲 長さ ${len}m・広さ ${o.ang != null ? o.ang : geo.angle}°`;
    default:
      if (geo.move) {
        const dist = typeof o.tx === 'number' ? Math.hypot(o.tx - o.x, o.ty - o.y) / k() : 0;
        const kind = geo.move.type === 'tp' ? 'テレポート（点線の矢印）' : 'ダッシュ・移動（実線の矢印）';
        const hard = BoardRender.moveHardMax(geo);
        const lim = hard ? `／届く距離 ${hard}m（ゲームデータで確認済み。それより先へは動かせません）`
          : geo.move.max ? `／届く距離の目安 ${geo.move.max}m（未確認の数値なので、それより先にも動かせます）` : '／距離の上限なし';
        return `${kind}。今の距離 ${dist.toFixed(1)}m` + lim + '。矢印の先の白い丸で行き先を動かせます';
      }
      return '範囲なし（アイコンだけ）';
  }
}
function renderSel() {
  const body = $('sel-body'); body.textContent = '';
  const o = S.selectedId && findObj(S.selectedId);
  if (o && ensureMoveTarget(o)) { saveSoon(); draw(); } // 移動系の行き先を付けた（前の版で置いたもの）
  if (!o) { body.append(el('p', 'muted', 'マップ上のものをクリックすると、ここで向き・長さ・文字などを変えられます。')); return; }
  const change = (fn, live) => { if (!live) snapshot(); fn(); saveSoon(); draw(); };
  const row = (...kids) => { const d = el('div', 'row-btns'); d.append(...kids); return d; };
  const delBtn = el('button', 'danger', '削除（Delete）'); delBtn.onclick = deleteSelected;
  const teamSeg = () => {
    const d = el('div', 'seg');
    for (const [t, label] of [['ally', '味方'], ['enemy', '敵']]) {
      const b = el('button', t + (o.team === t ? ' on' : ''), label);
      b.onclick = () => change(() => { o.team = t; renderSel(); });
      d.append(b);
    }
    return d;
  };
  const slider = (label, min, max, step, value, unit, onInput) => {
    const wrap = el('div', 'field');
    const l = el('label', null, `${label}: ${value}${unit}`);
    const s = el('input'); s.type = 'range'; s.min = min; s.max = max; s.step = step; s.value = value;
    let first = true;
    s.oninput = () => { if (first) { snapshot(); first = false; } l.textContent = `${label}: ${s.value}${unit}`; onInput(+s.value); saveSoon(); draw(); };
    s.onchange = () => { first = true; };
    wrap.append(l, s); return wrap;
  };
  const colorRow = () => {
    const d = el('div', 'colors');
    for (const c of COLORS) { const b = el('button'); b.style.background = c; b.dataset.color = c; b.classList.toggle('on', o.color === c); b.onclick = () => change(() => { o.color = c; renderSel(); }); d.append(b); }
    return d;
  };

  if (o.kind === 'agent') {
    const a = agentById(o.agent);
    const t = el('div', 'title'); if (a) { const i = el('img'); i.src = a.icon; t.append(i); } t.append(el('span', null, a ? a.name : 'キャラ'));
    body.append(t, teamSeg());
    // 人の視界（見ている向き）。ONで扇を出し、先端の白い丸で向きと長さを動かす
    const vb = el('button', typeof o.vlen === 'number' ? 'on' : null, typeof o.vlen === 'number' ? '視界を消す' : '視界（見ている向き）を出す');
    vb.onclick = () => change(() => {
      if (typeof o.vlen === 'number') { delete o.vlen; delete o.vrot; delete o.vang; }
      else { o.vlen = 20; o.vrot = typeof o.vrot === 'number' ? o.vrot : 0; o.vang = BoardRender.VIEW_DEFAULT; }
      renderSel();
    });
    body.append(vb);
    if (typeof o.vlen === 'number') {
      body.append(el('div', 'dims', `扇＝見ている範囲（初期値 ${BoardRender.VIEW_DEFAULT}°。画面の端から端まではゲームの視野角 ${BoardRender.PLAYER_FOV}°）。先の白い丸で向きと長さを動かせます`));
      body.append(slider('向き', 0, 359, 1, Math.round(((o.vrot || 0) % 360 + 360) % 360), '°', v => { o.vrot = v; }));
      body.append(slider('長さ', VIEW_LEN[0], VIEW_LEN[1], 0.5, o.vlen, 'm', v => { o.vlen = v; }));
      body.append(slider('広さ', 10, 150, 1, o.vang || BoardRender.VIEW_DEFAULT, '°', v => { o.vang = v; }));
    }
    body.append(delBtn);
  } else if (o.kind === 'ability') {
    const a = agentById(o.agent); const ab = a && a.abilities.find(x => x.slot === o.slot);
    const geo = a ? BoardRender.geometryOf(a, o.slot) : { s: 'icon' };
    const t = el('div', 'title'); if (ab) { const i = el('img'); i.src = ab.icon; t.append(i); }
    t.append(el('span', null, (ab ? ab.name : 'スキル') + (a ? `（${a.name} ${SLOT_KEY[o.slot] || ''}）` : '')));
    body.append(t);
    if (geo.s !== 'icon' || geo.conf || geo.move) {
      const conf = (geo.move && geo.move.conf) || geo.conf || (geo.move ? 'game' : geo.s === 'icon' ? null : 'none');
      if (conf) body.append(el('div', 'conf ' + conf, window.ABILITY_CONF_LABEL[conf]));
    }
    body.append(el('div', 'dims', geoText(o, a, geo)));
    if (geo.note) body.append(el('div', 'dims', geo.note));
    if (geo.ring) body.append(el('div', 'dims', '点線の円: ' + geo.ring.map(r => `${r.label} ${r.r}m`).join('・')));
    if (DIRECTIONAL.has(geo.s)) body.append(slider('向き', 0, 359, 1, Math.round(((o.rot || 0) % 360 + 360) % 360), '°', v => { o.rot = v; }));
    if (geo.var && (geo.s === 'wall' || geo.s === 'rect')) body.append(slider('長さ', geo.var[0], geo.var[1], 0.5, o.len != null ? o.len : geo.len, 'm', v => { o.len = v; }));
    if (geo.s === 'view') {
      body.append(slider('長さ', (geo.var || VIEW_LEN)[0], (geo.var || VIEW_LEN)[1], 0.5, o.len != null ? o.len : geo.len, 'm', v => { o.len = v; }));
      body.append(slider('広さ', 10, 150, 1, o.ang != null ? o.ang : geo.angle, '°', v => { o.ang = v; }));
    }
    if (geo.var && geo.s === 'circle') body.append(slider('半径', geo.var[0], geo.var[1], 0.25, o.r != null ? o.r : geo.r, 'm', v => { o.r = v; }));
    body.append(teamSeg());
    // 定点の画像（2026-11-14 ユーザーの要望「定点があるスキルに画像を埋め込みたい、ぱっとクリックで開く」）
    body.append(el('div', 'title small', '定点の画像'));
    const imgs = el('div', 'imgs');
    for (const f of o.images || []) {
      const w = el('div', 'thumb'); const im = el('img'); im.src = imgUrl(f); im.onclick = () => showImages(o.images, f);
      const x = el('button', 'x', '×'); x.title = 'この画像を外す';
      x.onclick = () => change(() => { o.images = o.images.filter(g => g !== f); if (!o.images.length) delete o.images; syncAbilityImages(o); renderSel(); });
      w.append(im, x); imgs.append(w);
    }
    const add = el('button', null, '画像を追加');
    add.onclick = () => pickImageFile(name => { const b = cur(); const now = b && findObj(o.id); if (!now) return; snapshot(); now.images = [...(now.images || []), name]; syncAbilityImages(now); saveSoon(); renderSel(); draw(); });
    body.append(el('div', 'dims', '置く場所・狙う場所のスクショを付けると、マップのカメラの印を押すだけで開けます（Ctrl+V でも貼れます）'), imgs, add, delBtn);
  } else if (o.kind === 'text') {
    const ta = el('textarea'); ta.value = o.text || ''; ta.rows = 2;
    let first = true;
    ta.oninput = () => { if (first) { snapshot(); first = false; } o.text = ta.value; saveSoon(); draw(); };
    const size = el('select'); for (const [v, l] of [[16, '小'], [22, '中'], [32, '大'], [48, '特大']]) { const op = el('option', null, l); op.value = v; op.selected = (o.size || 22) == v; size.append(op); }
    size.onchange = () => change(() => { o.size = +size.value; });
    body.append(el('div', 'title', '文字'), ta, row(el('span', 'muted', '大きさ'), size), colorRow(), delBtn);
  } else if (o.kind === 'image') {
    const big = el('button', null, '大きく見る'); big.onclick = () => showImage(o.file);
    body.append(el('div', 'title', '画像'), el('div', 'dims', '右下の白い丸で大きさを変えられます'), row(big, delBtn));
  } else if (o.kind === 'lineup') {
    const a = o.agent && agentById(o.agent); const ab = a && a.abilities.find(x => x.slot === o.slot);
    const t = el('div', 'title'); if (ab) { const i = el('img'); i.src = ab.icon; t.append(i); } t.append(el('span', null, 'ラインナップ' + (ab ? `（${a.name} ${ab.name}）` : '')));
    const name = el('input'); name.value = o.title || ''; name.placeholder = '名前（例: Aメインから設置位置へ）';
    let f1 = true; name.oninput = () => { if (f1) { snapshot(); f1 = false; } o.title = name.value; syncLineup(o); saveSoon(); draw(); };
    const useBar = el('div', 'dims', 'スキルを変えるには、これを選んだまま下のバーでスキルを押します');
    const note = el('textarea'); note.value = o.note || ''; note.rows = 3; note.placeholder = '投げ方のメモ（例: 右クリック・ジャンプ投げ、壁のシミに合わせる）';
    let f2 = true; note.oninput = () => { if (f2) { snapshot(); f2 = false; } o.note = note.value; syncLineup(o); saveSoon(); };
    const imgs = el('div', 'imgs');
    for (const f of o.images || []) {
      const w = el('div', 'thumb'); const im = el('img'); im.src = imgUrl(f); im.onclick = () => showImage(f);
      const x = el('button', 'x', '×'); x.title = 'この画像を外す';
      x.onclick = () => change(() => { o.images = o.images.filter(g => g !== f); syncLineup(o); renderSel(); });
      w.append(im, x); imgs.append(w);
    }
    body.append(t, name, useBar, note, el('div', 'dims', 'スクショは Ctrl+V で追加（立ち位置・狙う場所など）'), imgs, delBtn);
  } else {
    const label = { pen: 'ペン', line: o.arrow ? '矢印' : '直線', rect: '四角', ellipse: '丸' }[o.kind] || o.kind;
    body.append(el('div', 'title', label), colorRow());
    const w = el('select'); for (const [v, l] of [[2, '細い'], [3, 'ふつう'], [6, '太い']]) { const op = el('option', null, l); op.value = v; op.selected = (o.width || 3) == v; w.append(op); }
    w.onchange = () => change(() => { o.width = +w.value; });
    body.append(row(el('span', 'muted', '太さ'), w));
    if (o.kind === 'line') { const b = el('button', null, o.arrow ? '矢印をやめる' : '矢印にする'); b.onclick = () => change(() => { o.arrow = !o.arrow; renderSel(); }); body.append(b); }
    if (o.kind === 'rect' || o.kind === 'ellipse') { const b = el('button', null, o.fill ? '塗りをやめる' : '中を薄く塗る'); b.onclick = () => change(() => { o.fill = !o.fill; renderSel(); }); body.append(b); }
    body.append(delBtn);
  }
}
// ラインナップの名前・メモ・画像・スキルは、同じ作戦の全部の手順の写しでそろえる（位置は手順ごとに別）
function syncLineup(o, board) {
  const b = board || cur(); if (!b || !o || o.kind !== 'lineup') return;
  for (const st of b.steps) for (const x of st.objects) if (x !== o && x.id === o.id && x.kind === 'lineup') {
    x.title = o.title; x.note = o.note; x.images = [...(o.images || [])]; x.agent = o.agent; x.slot = o.slot;
  }
}
// スキルの定点の画像も、同じ作戦の全部の手順の写し（同じID）でそろえる
function syncAbilityImages(o, board) {
  const b = board || cur(); if (!b || !o || o.kind !== 'ability') return;
  for (const st of b.steps) for (const x of st.objects) if (x !== o && x.id === o.id && x.kind === 'ability') {
    if (o.images && o.images.length) x.images = [...o.images]; else delete x.images;
  }
}
// ファイルを選んで画像として保存する（貼り付けが分からない人向け）
function pickImageFile(done) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
  inp.onchange = async () => {
    const file = inp.files && inp.files[0]; if (!file) return;
    const r = await window.valo.saveImage(new Uint8Array(await file.arrayBuffer()), file.type);
    if (!r.ok) { status('画像を保存できませんでした（' + r.error + '）', true); return; }
    done(r.name); status('画像を付けました');
  };
  inp.click();
}
function deleteSelected() {
  const b = cur(); if (!b || !S.selectedId) return;
  snapshot();
  b.steps[S.step].objects = stepObjs().filter(o => o.id !== S.selectedId);
  S.selectedId = null; saveSoon(); renderSel(); draw();
}

// ---------- マップ上の操作 ----------
function toMap(e) {
  const root = svg.querySelector('.board-root');
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  return pt.matrixTransform((root || svg).getScreenCTM().inverse());
}
function toView(e) { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); }
function moveObj(o, dx, dy) {
  for (const [a, b] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2'], ['fx', 'fy'], ['tx', 'ty']]) if (typeof o[a] === 'number') { o[a] += dx; o[b] += dy; }
  if (o.points) o.points = o.points.map(p => [p[0] + dx, p[1] + dy]);
}
let spaceDown = false;
function cap(e) { try { svg.setPointerCapture(e.pointerId); } catch {} }

svg.addEventListener('contextmenu', e => e.preventDefault());
svg.addEventListener('pointerdown', e => {
  if (S.playing) return;
  hideTextInput(true);
  const b = cur();
  if (e.button === 1 || e.button === 2 || spaceDown) { // 中ボタン・右ボタン・Space+ドラッグで移動
    const v = toView(e); S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vb: { ...S.vb }, scale: S.vb.w / svg.getBoundingClientRect().width };
    cap(e); svg.classList.add('panning'); void v; return;
  }
  if (e.button !== 0 || !b) return;
  const p = toMap(e);
  // 定点の画像のカメラの印: 押すとすぐ画像を開く（選択はするが動かさない）
  const badge = e.target.closest && e.target.closest('.img-badge');
  if (badge && !S.place) {
    const o = findObj(badge.getAttribute('data-obj'));
    if (o && o.images && o.images.length) { S.selectedId = o.id; renderSel(); draw(); showImages(o.images); return; }
  }
  const handle = e.target.closest && e.target.getAttribute && e.target.getAttribute('data-handle');
  if (handle && S.selectedId) { snapshot(); S.drag = { type: 'handle', handle }; cap(e); return; }
  const hitG = e.target.closest && e.target.closest('g.obj');
  const hitId = hitG && hitG.getAttribute('data-id');

  if (S.place) {
    const o = placeObject(S.place, p);
    S.drag = { type: 'move', id: o.id, last: p, moved: false, noSnap: true }; cap(e);
    return;
  }
  switch (S.tool) {
    case 'select':
      if (hitId) {
        S.selectedId = hitId; renderSel(); draw();
        S.drag = { type: 'move', id: hitId, last: p, moved: false }; cap(e);
      } else { S.selectedId = null; renderSel(); draw(); }
      break;
    case 'eraser':
      S.drag = { type: 'erase', snapped: false }; cap(e);
      if (hitId) eraseId(hitId);
      break;
    case 'pen': {
      snapshot();
      const o = { id: uid(), kind: 'pen', color: S.color, width: S.width, points: [[p.x, p.y]] };
      stepObjs().push(o); S.drag = { type: 'pen', id: o.id }; cap(e); draw();
      break;
    }
    case 'line': case 'arrow': case 'rect': case 'ellipse': {
      snapshot();
      const kind = S.tool === 'arrow' ? 'line' : S.tool;
      const o = { id: uid(), kind, color: S.color, width: S.width, x1: p.x, y1: p.y, x2: p.x, y2: p.y, arrow: S.tool === 'arrow' };
      stepObjs().push(o); S.drag = { type: 'shape', id: o.id }; cap(e); draw();
      break;
    }
    case 'text': showTextInput(e, p); break;
    case 'lineup':
      if (!S.lineupFrom) { S.lineupFrom = { x: p.x, y: p.y }; renderTools(); }
      else {
        snapshot();
        const la = S.lastAbility;
        const o = { id: uid(), kind: 'lineup', fx: S.lineupFrom.x, fy: S.lineupFrom.y, tx: p.x, ty: p.y,
          agent: la ? la.agent : (S.agent || null), slot: la ? la.slot : null, title: '', note: '', images: [] };
        stepObjs().push(o); S.lineupFrom = null; S.tool = 'select'; S.selectedId = o.id;
        saveSoon(); renderTools(); renderSel(); draw();
      }
      break;
  }
});
svg.addEventListener('pointermove', e => {
  if (S.collab && cur() && S.collab.boardId === S.boardId) {
    const pm = toMap(e); const st = cur().steps[S.step];
    if (st) S.collab.setCursor({ x: Math.round(pm.x * 10) / 10, y: Math.round(pm.y * 10) / 10, s: st.id });
    if (S.drag && S.drag.type !== 'pan') collabSoon();
  }
  const d = S.drag; if (!d) return;
  if (d.type === 'pan') {
    S.vb.x = d.vb.x - (e.clientX - d.sx) * d.scale; S.vb.y = d.vb.y - (e.clientY - d.sy) * d.scale; applyVB(); return;
  }
  const p = toMap(e);
  if (d.type === 'move') {
    const o = findObj(d.id); if (!o) return;
    if (!d.moved) { if (Math.hypot(p.x - d.last.x, p.y - d.last.y) < 1.5) return; if (!d.noSnap) snapshot(); d.moved = true; }
    moveObj(o, p.x - d.last.x, p.y - d.last.y); d.last = p; draw();
  } else if (d.type === 'handle') {
    const o = findObj(S.selectedId); if (!o) return;
    if (d.handle === 'rot') { let deg = Math.atan2(p.y - o.y, p.x - o.x) * 180 / Math.PI; if (e.shiftKey) deg = Math.round(deg / 15) * 15; o.rot = Math.round(deg * 10) / 10; }
    else if (d.handle === 'vtip') {
      // 視界の扇の先端: 向き（Shiftで15°刻み）と長さ。長さは決めた範囲の中に収める
      let deg = Math.atan2(p.y - o.y, p.x - o.x) * 180 / Math.PI; if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      const m = Math.hypot(p.x - o.x, p.y - o.y) / k();
      if (o.kind === 'agent') { o.vrot = Math.round(deg * 10) / 10; o.vlen = Math.round(Math.max(VIEW_LEN[0], Math.min(VIEW_LEN[1], m)) * 2) / 2; }
      else {
        const a = agentById(o.agent); const geo = a && BoardRender.geometryOf(a, o.slot); const v = (geo && geo.var) || VIEW_LEN;
        o.rot = Math.round(deg * 10) / 10; o.len = Math.round(Math.max(v[0], Math.min(v[1], m)) * 2) / 2;
      }
    }
    else if (d.handle === 'end1' || d.handle === 'end2' || d.handle === 'rtip') {
      const a = agentById(o.agent); const geo = a && BoardRender.geometryOf(a, o.slot);
      if (geo && geo.var) {
        const len0 = (o.len != null ? o.len : geo.len) * k(), r0 = (o.rot || 0) * Math.PI / 180;
        // 動かさない側の点は押した瞬間に決めておく（長さの上限で止まったときに、反対の端がずれていかないように）
        if (!d.fixed) d.fixed = d.handle === 'rtip' ? { x: o.x, y: o.y }
          : { x: o.x + (d.handle === 'end2' ? -1 : 1) * Math.cos(r0) * len0 / 2, y: o.y + (d.handle === 'end2' ? -1 : 1) * Math.sin(r0) * len0 / 2 };
        const F = d.fixed;
        let deg = Math.atan2(p.y - F.y, p.x - F.x) * 180 / Math.PI; if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        const off = d.handle === 'rtip' ? (geo.off || 0) : 0;
        const m = Math.hypot(p.x - F.x, p.y - F.y) / k() - off;
        o.len = Math.round(Math.max(geo.var[0], Math.min(geo.var[1], m)) * 2) / 2;
        const rad = deg * Math.PI / 180;
        if (d.handle !== 'rtip') { o.x = F.x + Math.cos(rad) * o.len * k() / 2; o.y = F.y + Math.sin(rad) * o.len * k() / 2; }
        o.rot = Math.round((d.handle === 'end1' ? deg + 180 : deg) * 10) / 10;
      }
    }
    else if (d.handle === 'p1') { o.x1 = p.x; o.y1 = p.y; }
    else if (d.handle === 'p2') { o.x2 = p.x; o.y2 = p.y; }
    else if (d.handle === 'from') { o.fx = p.x; o.fy = p.y; }
    else if (d.handle === 'to') { o.tx = p.x; o.ty = p.y; }
    else if (d.handle === 'mto') {
      // 移動系の行き先。届く距離があればそれより先へは行かない
      const a = agentById(o.agent); const geo = a && BoardRender.geometryOf(a, o.slot);
      o.tx = p.x; o.ty = p.y;
      Object.assign(o, BoardRender.clampMove(o, geo, k())); // 確定した距離があればそれより先へは行かない
    }
    else if (d.handle === 'size') { const ratio = o.h / o.w; o.w = Math.max(20, p.x - o.x); o.h = o.w * ratio; }
    draw();
  } else if (d.type === 'pen') {
    const o = findObj(d.id); const last = o.points[o.points.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) > 1.2 * S.vb.w / 1000) { o.points.push([p.x, p.y]); draw(); }
  } else if (d.type === 'shape') {
    const o = findObj(d.id); o.x2 = p.x; o.y2 = p.y;
    if (e.shiftKey && o.kind === 'line') { const a = Math.round(Math.atan2(o.y2 - o.y1, o.x2 - o.x1) / (Math.PI / 4)) * Math.PI / 4, L = Math.hypot(o.x2 - o.x1, o.y2 - o.y1); o.x2 = o.x1 + Math.cos(a) * L; o.y2 = o.y1 + Math.sin(a) * L; }
    draw();
  } else if (d.type === 'erase') {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const g = t && t.closest && t.closest('g.obj');
    if (g) eraseId(g.getAttribute('data-id'));
  }
});
function endDrag(e) {
  const d = S.drag; if (!d) return;
  S.drag = null; svg.classList.remove('panning');
  try { svg.releasePointerCapture(e.pointerId); } catch {}
  if (d.type === 'pan') return;
  if (d.type === 'move' && !d.moved) return;
  if (d.type === 'shape') {
    const o = findObj(d.id);
    if (o && Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3) { const b = cur(); b.steps[S.step].objects = stepObjs().filter(x => x.id !== o.id); draw(); return; }
    S.selectedId = null;
  }
  if (d.type === 'pen') {
    const o = findObj(d.id);
    if (o && o.points.length < 2) { const b = cur(); b.steps[S.step].objects = stepObjs().filter(x => x.id !== o.id); draw(); return; }
  }
  saveSoon(); renderSel(); draw();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
function eraseId(id) {
  const b = cur(); if (!b || !id) return;
  if (S.drag && S.drag.type === 'erase' && !S.drag.snapped) { snapshot(); S.drag.snapped = true; }
  b.steps[S.step].objects = stepObjs().filter(o => o.id !== id);
  if (S.selectedId === id) S.selectedId = null;
  saveSoon(); draw();
}
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const v = toView(e);
  const f = Math.exp(e.deltaY * 0.0015);
  const w = Math.min(1600, Math.max(120, S.vb.w * f)), h = w;
  const r = w / S.vb.w;
  S.vb = { x: v.x - (v.x - S.vb.x) * r, y: v.y - (v.y - S.vb.y) * r, w, h };
  applyVB(); draw();
}, { passive: false });

// 文字の入力欄
let textAt = null;
function showTextInput(e, p) {
  const inp = $('text-input'); const r = $('stage').getBoundingClientRect();
  inp.style.left = (e.clientX - r.left) + 'px'; inp.style.top = (e.clientY - r.top - 14) + 'px';
  inp.value = ''; inp.hidden = false; textAt = p;
  setTimeout(() => inp.focus(), 0);
}
function hideTextInput(commit) {
  const inp = $('text-input'); if (inp.hidden) return;
  const v = inp.value.trim(); inp.hidden = true;
  if (commit && v && textAt && cur()) {
    snapshot();
    const o = { id: uid(), kind: 'text', x: textAt.x, y: textAt.y, text: v, color: S.color, size: 22 };
    stepObjs().push(o); saveSoon(); draw();
  }
  textAt = null;
}
$('text-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); hideTextInput(true); }
  else if (e.key === 'Escape') { e.preventDefault(); hideTextInput(false); }
  e.stopPropagation();
});
$('text-input').addEventListener('blur', () => hideTextInput(true));

// ---------- 画像の貼り付け ----------
async function pastedImage(e) {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])];
  const it = items.find(i => i.kind === 'file' && /^image\//.test(i.type));
  if (!it) return null;
  e.preventDefault();
  const file = it.getAsFile();
  const buf = new Uint8Array(await file.arrayBuffer());
  const r = await window.valo.saveImage(buf, file.type);
  if (!r.ok) { status('画像を保存できませんでした（' + r.error + '）', true); return null; }
  return r.name;
}
// 今見えている範囲の中心を、マップの座標で返す（回転・拡大していても正しく）
function viewCenterOnMap() {
  const r = svg.getBoundingClientRect();
  return toMap({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
}
document.addEventListener('paste', async e => {
  if (!cur()) { if ([...(e.clipboardData ? e.clipboardData.items : [])].some(i => /^image\//.test(i.type))) status('先に「＋ 新しい作戦」を作ってください', true); return; }
  // 貼る先（作戦・手順・ラインナップ）は貼った瞬間に決める。保存を待つ間に切り替えても、そこへ入れる
  const boardId = S.boardId, stepId = cur().steps[S.step] && cur().steps[S.step].id;
  const selId = S.selectedId;
  const center = viewCenterOnMap();
  const width = Math.min(320, S.vb.w * 0.4);
  const name = await pastedImage(e); if (!name) return;
  const stepOf = b => b && b.steps.find(st => st.id === stepId);
  const target = () => { const b = S.boards[boardId]; return stepOf(b) ? b : null; };
  const lineup = () => { const b = target(); return b && selId ? stepOf(b).objects.find(o => o.id === selId && o.kind === 'lineup') : null; };
  const ability = () => { const b = target(); return b && selId ? stepOf(b).objects.find(o => o.id === selId && o.kind === 'ability') : null; };
  const snapFor = () => beginAction(target()); // 入れる直前に、取り消しのまとまりを始める
  if (ability()) {
    snapFor(); const a = ability();
    a.images = [...(a.images || []), name];
    syncAbilityImages(a, target());
    saveSoon(target()); renderSel(); draw(); status('スキルに定点の画像を付けました（カメラの印を押すと開きます）'); return;
  }
  if (lineup()) {
    snapFor(); const l = lineup();
    l.images = [...(l.images || []), name];
    syncLineup(l, target());
    saveSoon(target()); renderSel(); draw(); status('ラインナップに画像を付けました'); return;
  }
  const img = new Image();
  img.onload = () => {
    const b = target(); if (!b) { status('貼る先の作戦が無くなったため、画像を置けませんでした', true); return; }
    const h = width * img.naturalHeight / img.naturalWidth;
    snapFor();
    const o = { id: uid(), kind: 'image', file: name, x: center.x - width / 2, y: center.y - h / 2, w: width, h };
    stepOf(b).objects.push(o);
    if (S.boardId === boardId && S.stepId === stepId) { S.tool = 'select'; S.selectedId = o.id; }
    saveSoon(b); renderTools(); renderSel(); draw();
    status('画像を貼りました（ドラッグで動かせます）');
  };
  img.onerror = () => status('画像を表示できませんでした', true);
  img.src = imgUrl(name);
});
function showImage(f) {
  const i = el('img', 'big-img'); i.src = imgUrl(f);
  openSheet('画像', i);
}
// 何枚かの画像をまとめて縦に並べて開く（first を一番上に）
function showImages(list, first) {
  const box = el('div', 'img-stack');
  const order = first ? [first, ...list.filter(f => f !== first)] : list;
  for (const f of order) { const i = el('img', 'big-img'); i.src = imgUrl(f); box.append(i); }
  openSheet(list.length > 1 ? `定点の画像（${list.length}枚）` : '定点の画像', box);
}

// ---------- シート（マップ・キャラ選択） ----------
function openSheet(title, body) { $('sheet-title').textContent = title; const b = $('sheet-body'); b.textContent = ''; b.append(body); $('sheet').hidden = false; }
function closeSheet() { $('sheet').hidden = true; }
function openMapPicker() {
  const f = document.createDocumentFragment();
  const sort = arr => arr.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  for (const [title, list] of [['いまのランク戦のマップ', sort(S.data.maps.filter(m => RANKED_POOL.includes(shortName(m))))], ['そのほか', sort(S.data.maps.filter(m => !RANKED_POOL.includes(shortName(m))))]]) {
    f.append(el('div', 'group-title', title));
    const g = el('div', 'map-grid');
    for (const m of list) {
      const b = el('button', 'map-opt' + (m.uuid === S.mapUuid ? ' cur' : ''));
      const i = el('img'); i.src = m.thumb || m.splash; i.alt = '';
      const n = Object.values(S.boards).filter(x => x.mapUuid === m.uuid).length;
      b.append(i, el('span', null, m.name + (n ? `（${n}）` : '')));
      b.onclick = () => { closeSheet(); setMap(m.uuid); };
      g.append(b);
    }
    f.append(g);
  }
  openSheet('マップを選ぶ（かっこ内は作戦の数）', f);
}
// 作戦の「どのキャラの作戦か」の表示用: キャラ → そのキャラ、'role:'+UUID → { name:'コントローラー全員', icon, role:true }
function rolesList() {
  const m = new Map();
  for (const a of S.data.agents) if (a.roleId && !m.has(a.roleId)) m.set(a.roleId, { id: a.roleId, name: a.role, icon: a.roleIcon });
  return [...m.values()].sort((x, y) => ROLE_ORDER.indexOf(x.name) - ROLE_ORDER.indexOf(y.name));
}
function whoOf(v) {
  if (!v) return null;
  if (v.startsWith('role:')) { const r = rolesList().find(r => r.id === v.slice(5)); return r ? { name: r.name + '全員', icon: r.icon, role: true } : null; }
  return agentById(v);
}
function openBoardAgentPicker() {
  const b = cur(); if (!b) return;
  const f = document.createDocumentFragment();
  const none = el('button', null, '指定なし（どのキャラでもパネルに出す）'); none.onclick = () => { snapshot(); b.agent = null; saveSoon(); closeSheet(); renderSide(); }; f.append(none);
  // ロール全員（例: コントローラー全員なら、オーメン・ブリム・アストラ…のだれを選んでもパネルに出る）
  f.append(el('div', 'sheet-sub', 'ロールの全員（そのロールのどのキャラを選んでもパネルに出ます）'));
  const rg = el('div', 'agent-grid');
  for (const r of rolesList()) {
    const v = 'role:' + r.id;
    const btn = el('button', 'agent-opt role-opt' + (b.agent === v ? ' cur' : ''));
    const i = el('img'); i.src = r.icon; i.alt = ''; btn.append(i, el('span', null, r.name + '全員'));
    btn.onclick = () => { snapshot(); b.agent = v; saveSoon(); closeSheet(); renderSide(); };
    rg.append(btn);
  }
  f.append(rg, el('div', 'sheet-sub', '1人のキャラだけ'));
  const g = el('div', 'agent-grid');
  for (const a of [...S.data.agents].sort((x, y) => x.name.localeCompare(y.name, 'ja'))) {
    const btn = el('button', 'agent-opt' + (b.agent === a.uuid ? ' cur' : ''));
    const i = el('img'); i.src = a.icon; i.alt = ''; btn.append(i, el('span', null, a.name));
    btn.onclick = () => { snapshot(); b.agent = a.uuid; saveSoon(); closeSheet(); renderSide(); };
    g.append(btn);
  }
  f.append(g);
  openSheet('この作戦のキャラ', f);
}

function updateBanner() {
  const ban = $('game-banner');
  const m = S.game && S.game.mapUrl && S.data.maps.find(x => x.mapUrl.toLowerCase() === S.game.mapUrl.toLowerCase());
  if (!m || m.uuid === S.mapUuid || !['pregame', 'ingame'].includes(S.game.phase)) { ban.hidden = true; return; }
  ban.hidden = false; ban.textContent = `試合のマップは ${m.name} です`;
  const b = el('button', null, m.name + ' に切り替える'); b.onclick = () => setMap(m.uuid); ban.append(b);
}

// ---------- キー操作 ----------
document.addEventListener('keydown', e => {
  if (e.key === ' ' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { spaceDown = true; e.preventDefault(); return; }
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (!$('sheet').hidden) { if (e.key === 'Escape') closeSheet(); return; }
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (e.ctrlKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === 'Escape') { cancelPaletteDrag(); if (S.playing) stopPlay(); S.place = null; S.lineupFrom = null; S.selectedId = null; setTool('select'); return; }
  const map = { v: 'select', p: 'pen', a: 'arrow', l: 'line', r: 'rect', o: 'ellipse', t: 'text', n: 'lineup', e: 'eraser' };
  const t = map[e.key.toLowerCase()]; if (t) setTool(t);
});
document.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });

// ---------- 起動 ----------
async function boot() {
  for (const b of $('tools').children) b.onclick = () => setTool(b.dataset.tool);
  for (const c of COLORS) { const b = el('button'); b.style.background = c; b.dataset.color = c; b.title = '色'; b.onclick = () => { S.color = c; renderTools(); }; $('colors').append(b); }
  $('width').onchange = () => { S.width = +$('width').value; };
  for (const b of $('team').children) b.onclick = () => { S.team = b.dataset.team; renderTools(); };
  $('undo').onclick = undo; $('redo').onclick = redo;
  $('show-callouts').onchange = () => { S.showCallouts = $('show-callouts').checked; draw(); };
  $('rotate').onclick = () => { const b = cur(); S.viewRot = ((S.viewRot || 0) + 90) % 360; if (b) { snapshot(); b.rot = S.viewRot; saveSoon(); } draw(); };
  $('fit').onclick = () => { fitView(); draw(); };
  $('map-btn').onclick = openMapPicker;
  $('new-board').onclick = newBoard; $('empty-new').onclick = newBoard;
  $('dup-board').onclick = duplicateBoard; $('del-board').onclick = deleteBoard;
  $('board-agent').onclick = openBoardAgentPicker;
  $('filter-agent').onchange = renderSide;
  let nameSnap = true;
  $('board-name').oninput = () => { const b = cur(); if (!b) return; if (nameSnap) { snapshot(); nameSnap = false; } b.name = $('board-name').value || '名前なし'; saveSoon(); renderSide(); };
  $('board-name').onblur = () => { nameSnap = true; };
  for (const btn of $('board-side').children) btn.onclick = () => { const b = cur(); if (!b) return; snapshot(); b.side = btn.dataset.side || null; saveSoon(); renderSide(); };
  $('add-step').onclick = addStep; $('del-step').onclick = delStep; $('play').onclick = play;
  let noteSnap = true;
  $('step-note').oninput = () => {
    const b = cur(); if (!b) return;
    const st = b.steps.find(s => s.id === $('step-note').dataset.step); // 書き始めた手順へ（消されていたら書かない）
    if (!st) { $('step-note').blur(); renderSteps(); return; }
    if (noteSnap) { snapshot(); noteSnap = false; }
    st.note = $('step-note').value; saveSoon();
  };
  $('step-note').onblur = () => { noteSnap = true; };
  $('sheet-close').onclick = closeSheet;
  $('sheet').onclick = e => { if (e.target === $('sheet')) closeSheet(); };
  window.addEventListener('resize', updateScale);
  // キャラ一覧はマウスホイールでも横に動く
  $('agents').addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $('agents').scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

  const init = await window.valo.init();
  S.data = init.gameData;
  if (!S.data) { $('map-name').textContent = '読み込めませんでした'; status('マップとキャラの一覧を読み込めませんでした。インターネット接続を確認して開き直してください', true); return; }
  for (const b of init.boards || []) { S.boards[b.id] = b; loadDoc(b); normalizeBoard(b); }
  S.game = init.state || {};
  let params = {};
  try { params = JSON.parse(new URLSearchParams(location.search).get('p') || '{}'); } catch {}
  applyParams(params, true);

  window.valo.onBoardOpen(p => applyParams(p, false));
  window.valo.onState(s => { S.game = s; updateBanner(); });
  window.valo.onBoardsChanged(d => {
    // 外から差し替わった作戦は、書きかけの保存・取り消し履歴を捨てる（古い内容で上書きしないため）
    const replaced = d.reload ? d.reload.map(b => b.id) : d.put ? [d.put.id] : d.removed ? [d.removed] : [];
    for (const id of replaced) { cancelSave(id); delete docs[id]; }
    if (replaced.includes(S.boardId)) { stopPlay(); cancelPaletteDrag(); S.drag = null; S.selectedId = null; }
    if (d.reload) { S.boards = {}; for (const b of d.reload) { normalizeBoard(b); S.boards[b.id] = b; } }
    if (d.put) { normalizeBoard(d.put); S.boards[d.put.id] = d.put; }
    if (d.removed) delete S.boards[d.removed];
    // 一緒に作っている作戦が消えたら（全件の読み直しで無くなった場合も）、先に部屋を抜ける
    if (S.collab && S.collab.boardId && !S.boards[S.collab.boardId]) leaveCollab();
    if (S.boardId && !S.boards[S.boardId]) { S.boardId = null; selectBoard(null); return; }
    const b = cur(); if (b && S.step >= b.steps.length) S.step = b.steps.length - 1;
    for (const id of replaced) if (S.boards[id]) loadDoc(S.boards[id]);
    // 一緒に作っている作戦の文書が差し替わったら、部屋の送信を新しい文書へつなぎ直す（古い文書のままだと変更が送られない）
    if (S.collab && S.collab.boardId && replaced.includes(S.collab.boardId)) { S.collab.hookDoc(); S.collab.sendSv(); }
    renderAll();
  });
}
function applyParams(p, first) {
  if (p.join && window.BoardSchema && window.BoardSchema.cleanShare(p.join)) {
    const share = window.BoardSchema.cleanShare(p.join);
    const mine = Object.values(S.boards).find(b => b.share && b.share.room === share.room);
    const go = () => {
      if (mine) { setMap(mine.mapUuid); selectBoard(mine.id); joinCollab(share, mine.id); }
      else { joinCollab(share, null); }
    };
    if (!S.mapUuid) setMap((S.data.maps.find(m => RANKED_POOL.includes(shortName(m))) || S.data.maps[0]).uuid);
    if (!myName()) askName(go); else go();
    return;
  }
  const gameMap = S.game.mapUrl && S.data.maps.find(x => x.mapUrl.toLowerCase() === S.game.mapUrl.toLowerCase());
  if (p.agent && agentById(p.agent)) S.agent = p.agent;
  const target = (p.boardId && S.boards[p.boardId] && S.boards[p.boardId].mapUuid) || (p.mapUuid && mapById(p.mapUuid) && p.mapUuid)
    || (first && ((gameMap && gameMap.uuid) || localStorage.getItem('vb_map'))) || S.mapUuid
    || (S.data.maps.find(m => RANKED_POOL.includes(shortName(m))) || S.data.maps[0]).uuid;
  setMap(mapById(target) ? target : S.data.maps[0].uuid);
  if (p.boardId && S.boards[p.boardId]) selectBoard(p.boardId);
}
boot();
