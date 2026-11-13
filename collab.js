'use strict';
// 作戦の中身の土台（Yjs）と、一緒に作る（同時編集）の部屋（Trystero）。
//
// 2026-11-13: 自作の同期（版とLWW）は Codex レビュー3回でも穴が残ったため、実績のある CRDT ライブラリ Yjs に置き換えた。
// Yjs が引き受けること: 届く順番・抜けている間の変更・削除と復活・届かなかった分の取り直し（状態ベクトルの交換）、
// 「自分の操作だけを戻す」取り消し（Y.UndoManager の trackedOrigins）。
//
// BoardDoc: 1つの作戦の Yjs 文書
//   meta  … Y.Map { id, mapUuid, name, agent, side, rot }
//   steps … Y.Map 手順ID → Y.Map { ord, note, objs: Y.Map もののID → もの（JSON） }
//   画面（board.js）は今どおりの普通の作戦データを使い、
//    - 自分の変更は commit（前回の状態との差分を、検査してから文書へ書く。origin 'local' ＝取り消しの対象）
//    - 他の人の変更・取り消し・やり直しは、文書から作戦データを作り直す（project）
// Collab: 部屋。参加したら状態ベクトルを送り合い、足りない分だけ受け取る。15秒ごとにも確かめ合う（取りこぼし対策）
(function () {
  const BS = () => window.BoardSchema;
  const APP_ID = 'takubou316/valo-memo';
  const MAX_IMG = 15 * 1024 * 1024;
  // 1回に受け取る更新の上限。保存できる文書の大きさと同じにする（後から参加した人へ送る「全部」もこの大きさまでになるため。
  // 送るときの分割は Trystero が行う）
  const MAX_UPDATE = () => BS().MAX_YDOC_BYTES;
  // 受け取る量の上限（いたずら・暴走で文書が膨らみ続けたり、作り直しで固まったりしないように）
  //   1人から1分あたり MAX_RATE（最大の文書1つ分＋24MB。参加直後に全部を受け取っても、その後の編集を止めない）まで、部屋にいる間の合計 MAX_TOTAL まで。超えたら受け取りをやめて知らせる
  const MAX_RATE = () => BS().MAX_YDOC_BYTES + 24 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024;
  const RESYNC_MS = 15000;

  // 重なりの順番（置いたときの印）。形は版と同じ "<13桁ms>.<連番>.<人の印>"
  const SESSION = Math.random().toString(36).slice(2, 6);
  function myTag() {
    let t = localStorage.getItem('vb_uid');
    if (!t || !/^[0-9a-z]{6,20}$/.test(t)) { t = Math.random().toString(36).slice(2, 10); localStorage.setItem('vb_uid', t); }
    return (t + SESSION).replace(/[^0-9a-z]/g, '').slice(0, 30);
  }
  const zc = { ms: 0, n: 0 };
  function zTick() {
    const now = Date.now();
    if (now > zc.ms) { zc.ms = now; zc.n = 0; } else if (zc.n >= 999999999) { zc.ms++; zc.n = 0; } else zc.n++;
    return String(zc.ms).padStart(13, '0') + '.' + zc.n + '.' + myTag();
  }
  const b64 = {
    enc: u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
    dec: str => { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  };
  // 文書に書くもの（検査して、画面だけの項目を除く）
  function canon(o) {
    const c = BS().cleanObject(o); if (!c) return null;
    delete c.v; return c;
  }

  class BoardDoc {
    constructor() {
      this.doc = new window.Y.Doc();
      this.meta = this.doc.getMap('meta');
      this.steps = this.doc.getMap('steps');
      this.cache = new Map(); // 前回 commit / project したときの状態（記録の名前 → JSON）
      this.um = new window.Y.UndoManager([this.meta, this.steps], { trackedOrigins: new Set(['local']), captureTimeout: 3600 * 1000 });
      this.listeners = new Set();
      this.doc.on('update', (u, origin) => { for (const f of this.listeners) f(u, origin); });
    }
    static fromPlain(board) {
      const d = new BoardDoc();
      d.doc.transact(() => { d.meta.set('id', board.id); d.meta.set('mapUuid', board.mapUuid); }, 'init');
      d.commit(board, 'init');
      return d;
    }
    // 保存してあった文書から。中身が壊れている・別の作戦なら null
    static fromSaved(str, board) {
      try {
        const d = new BoardDoc();
        window.Y.applyUpdate(d.doc, b64.dec(str), 'init');
        if (d.meta.get('id') !== board.id || d.meta.get('mapUuid') !== board.mapUuid) return null;
        d.project();
        return d;
      } catch { return null; }
    }
    encode() { return b64.enc(window.Y.encodeStateAsUpdate(this.doc)); }
    // 作戦のID・マップが決まった値のままか。書き戻して直すと、違う値を持つ人どうしで書き戻し合いが止まらなくなるので、
    // 変わっていたら部屋を抜ける（Collab.onUpdate）。直しはしない
    sameIdentity(id, mapUuid) { return this.meta.get('id') === id && this.meta.get('mapUuid') === mapUuid; }
    onUpdate(f) { this.listeners.add(f); return () => this.listeners.delete(f); }

    // 文書から作戦データを作る（全員で同じ結果: 手順は (ord, id)、ものは (z, id) の順。検査に通らないものは出さない）
    project() {
      const S = BS();
      const steps = [];
      this.cache.clear();
      for (const m of S.META_KEYS) this.cache.set('m:' + m, JSON.stringify(S.cleanMeta(m, this.meta.get(m))));
      // 先に手順を並べて上限で切り、見せる手順・ものだけを控え（cache）に入れる。
      // 控えに無いもの（上限を超えて見せていないもの）は、次の commit で「消された」と扱われない（勝手に消さない）
      const heads = [];
      this.steps.forEach((sm, sid) => {
        if (!S.STEP_ID.test(sid) || !(sm instanceof window.Y.Map)) return;
        const ordRaw = sm.get('ord'), ord = typeof ordRaw === 'number' && Number.isFinite(ordRaw) && Math.abs(ordRaw) < 1e15 ? ordRaw : 0;
        heads.push({ id: sid, ord, sm });
      });
      heads.sort(S.stepOrder);
      if (heads.length > S.MAX_STEPS) heads.length = S.MAX_STEPS;
      for (const { id: sid, ord, sm } of heads) {
        const noteRaw = sm.get('note'), note = typeof noteRaw === 'string' ? noteRaw.slice(0, 2000) : '';
        const objs = [];
        const om = sm.get('objs');
        if (om instanceof window.Y.Map) om.forEach((v, oid) => { const c = canon(v); if (c && c.id === oid) objs.push(c); });
        objs.sort(S.objOrder);
        if (objs.length > S.MAX_OBJECTS) objs.length = S.MAX_OBJECTS;
        steps.push({ id: sid, ord, note, objects: objs });
        this.cache.set('s:' + sid, JSON.stringify({ ord, note }));
        for (const o of objs) this.cache.set('o:' + sid + '/' + o.id, JSON.stringify(o));
      }
      const out = { steps };
      for (const m of S.META_KEYS) out[m] = S.cleanMeta(m, this.meta.get(m));
      out.id = this.meta.get('id'); out.mapUuid = this.meta.get('mapUuid');
      return out;
    }
    // 画面の作戦データの変更を文書へ書く（前回との差分だけ）。戻り値: 書いたか
    // 検査で直した・捨てたものは、画面の作戦データにも反映する（全員が同じものを見るように）
    commit(b, origin = 'local') {
      const S = BS(), Y = window.Y;
      const writes = [];
      const seen = new Set();
      for (const m of S.META_KEYS) {
        const v = S.cleanMeta(m, b[m]); b[m] = v;
        const j = JSON.stringify(v);
        if (this.cache.get('m:' + m) !== j) writes.push(() => this.meta.set(m, v)), this.cache.set('m:' + m, j);
      }
      for (const st of b.steps) {
        if (!S.STEP_ID.test(st.id || '')) continue;
        if (typeof st.ord !== 'number' || !Number.isFinite(st.ord)) st.ord = 0;
        st.note = typeof st.note === 'string' ? st.note.slice(0, 2000) : '';
        seen.add('s:' + st.id);
        const sj = JSON.stringify({ ord: st.ord, note: st.note });
        const isNew = !this.cache.has('s:' + st.id);
        if (this.cache.get('s:' + st.id) !== sj) {
          const sid = st.id, ord = st.ord, note = st.note;
          writes.push(() => {
            let sm = this.steps.get(sid);
            if (!(sm instanceof Y.Map)) { sm = new Y.Map(); sm.set('objs', new Y.Map()); this.steps.set(sid, sm); }
            if (sm.get('ord') !== ord) sm.set('ord', ord);
            if (sm.get('note') !== note) sm.set('note', note);
          });
          this.cache.set('s:' + st.id, sj);
        }
        const kept = [];
        let fixed = false;
        for (const o of st.objects) {
          if (!o.z) o.z = zTick(); // 新しく置いたものは、置いた印が重なりの順番
          const c = canon(o);
          if (!c) { fixed = true; continue; } // 検査に通らないものは書かない（画面からも消える）
          // 検査で中身が変わったものだけ写しに置き換える（変わらないものは同じオブジェクトのまま。操作中の参照を壊さない）
          const raw = { ...o }; delete raw.v; delete raw.__opacity;
          if (JSON.stringify(raw) !== JSON.stringify(c)) { fixed = true; kept.push(c); } else kept.push(o);
          const kk = 'o:' + st.id + '/' + c.id, j = JSON.stringify(c);
          seen.add(kk);
          if (this.cache.get(kk) !== j || isNew) {
            const sid = st.id;
            writes.push(() => { const sm = this.steps.get(sid); if (sm instanceof Y.Map) { let om = sm.get('objs'); if (!(om instanceof Y.Map)) { om = new Y.Map(); sm.set('objs', om); } om.set(c.id, c); } });
            this.cache.set(kk, j);
          }
        }
        if (fixed) st.objects = kept;
      }
      for (const k of [...this.cache.keys()]) {
        if (seen.has(k) || k.startsWith('m:')) continue;
        if (k.startsWith('s:')) { const sid = k.slice(2); writes.push(() => this.steps.delete(sid)); }
        else if (k.startsWith('o:')) {
          const [sid, oid] = k.slice(2).split('/');
          if (seen.has('s:' + sid)) writes.push(() => { const sm = this.steps.get(sid); const om = sm instanceof Y.Map ? sm.get('objs') : null; if (om instanceof Y.Map) om.delete(oid); });
        }
        this.cache.delete(k);
      }
      if (!writes.length) return false;
      this.doc.transact(() => { for (const w of writes) w(); }, origin);
      return true;
    }
  }

  // ---- 部屋 ----
  class Collab {
    // opts: { boardId, room, key, name, color, getDoc(boardId) → BoardDoc|null, adoptDoc(boardDoc),
    //         commitLocal(boardId), afterRemote(), onPeers(list), onCursor(map), onStatus(text, isError),
    //         hasImage(name), readImage(name), saveImage(name, bytes), imagesOf(boardId) → Set }
    constructor(opts) {
      this.o = opts;
      this.boardId = opts.boardId || null;
      this.cursors = {};
      this.imgWant = new Map(); // 画像名 → { sources: Set, asked: Set, tries, at }
      this.left = false;
      this.pending = null; // 参加する側: 作戦が決まるまでの文書
    }
    doc() { return this.boardId ? this.o.getDoc(this.boardId) : this.pending; }
    start() {
      const { room, key } = this.o;
      const S = BS();
      this.room = window.Trystero.joinRoom({ appId: APP_ID, password: key, relayConfig: { warnOnRelayFailure: false } }, room);
      this.room.onError && this.room.onError(e => {
        const code = e && (e.code || e.message);
        if (code === 'peer-connect-failed') this.o.onStatus('相手とつながりませんでした（回線の制限の可能性。別の回線にするかVPNを切って試してください）', true);
        else if (code === 'relay-failed') this.o.onStatus('取り次ぎのリレーにつながりません（インターネット接続を確認してください）', true);
      });
      this.aSv = this.room.makeAction('ysv');   // 状態ベクトル（持っている範囲）
      this.aUp = this.room.makeAction('yup');   // 更新
      this.aImgReq = this.room.makeAction('imgreq');
      this.aImg = this.room.makeAction('img');
      this.who = this.room.makeUserState('who', null, { maxBytes: 256, validate: v => v === null || (S.isPlainObject(v) && typeof v.name === 'string' && v.name.length <= 24 && typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color)) });
      this.cur = this.room.makeUserState('cur', null, { maxBytes: 128, validate: v => v === null || (S.isPlainObject(v) && Number.isFinite(v.x) && Number.isFinite(v.y) && Math.abs(v.x) < 5000 && Math.abs(v.y) < 5000 && typeof v.s === 'string' && S.STEP_ID.test(v.s)) });
      this.who.set({ name: this.o.name.slice(0, 24), color: this.o.color });

      if (!this.boardId) this.pending = new BoardDoc();
      else { const d0 = this.doc(); if (d0) this.pin = { id: this.boardId, mapUuid: d0.meta.get('mapUuid') }; } // 部屋に入った時点のID・マップで固定
      this.hookDoc();
      this.aSv.onMessage((bytes, { userId }) => this.onSv(bytes, userId));
      this.aUp.onMessage((bytes, { userId }) => this.onUpdate(bytes, userId));
      this.aImgReq.onMessage((data, { userId }) => this.answerImage(data, userId));
      this.aImg.onMessage((bytes, { userId, metadata }) => this.receiveImage(bytes, metadata, userId));
      this.room.onUserJoin(({ userId }) => { this.sendSv(userId); this.updatePeers(); });
      this.room.onUserLeave(({ userId }) => { delete this.cursors[userId]; this.updatePeers(); this.o.onCursor(this.cursors); });
      this.who.onChange(() => this.updatePeers());
      this.cur.onChange((v, { userId, self }) => { if (self) return; if (v) this.cursors[userId] = v; else delete this.cursors[userId]; this.o.onCursor(this.cursors); });
      Promise.resolve(this.room.getSelf ? this.room.getSelf() : null).then(me => { this.selfId = me && me.userId; this.updatePeers(); }).catch(() => {});
      this.timer = setInterval(() => { this.sendSv(); this.retryImages(); }, RESYNC_MS);
      this.updatePeers();
    }
    // 自分の文書の変更（自分の編集・取り消し・やり直し）を全員へ送る。受け取った分（'remote'）は送り返さない
    hookDoc() {
      if (this.unhook) this.unhook();
      const d = this.doc(); if (!d) return;
      this.unhook = d.onUpdate((u, origin) => { if (origin !== 'remote' && !this.left && !this.stopped) this.aUp.send(u).catch(() => {}); });
    }
    sendSv(target) {
      const d = this.doc(); if (!d || this.left) return;
      if (this.boardId) this.o.commitLocal(this.boardId);
      this.aSv.send(window.Y.encodeStateVector(d.doc), target ? { target } : undefined).catch(() => {});
    }
    // 相手の持っている範囲を受け取ったら、相手に足りない分だけ送る
    onSv(bytes, userId) {
      const d = this.doc(); if (!d || this.left || !(bytes instanceof Uint8Array) || bytes.length > 1024 * 1024) return;
      if (this.boardId) this.o.commitLocal(this.boardId);
      let diff; try { diff = window.Y.encodeStateAsUpdate(d.doc, bytes); } catch { return; }
      if (diff.length > 2) this.aUp.send(diff, { target: userId }).catch(() => {});
    }
    // 受け取り量の確認。超えていたら false
    budget(userId, n) {
      if (this.stopped) return false;
      const now = Date.now();
      this.rates = this.rates || new Map();
      let r = this.rates.get(userId);
      if (!r || now - r.at > 60000) { r = { at: now, n: 0 }; this.rates.set(userId, r); }
      r.n += n; this.total = (this.total || 0) + n;
      if (this.total > MAX_TOTAL) {
        this.stopped = true;
        this.o.onStatus('受け取る量が多すぎるので、受け取りを止めました（作戦を開き直すと再開します）', true);
        return false;
      }
      // その1分で最初に届いた分は、大きくても受け取る（後から参加した人への「全部」は1回で最大 MAX_UPDATE になるため）
      if (r.n > MAX_RATE() && r.n - n > 0) { if (!r.warned) { r.warned = true; this.o.onStatus('相手から届く量が多すぎるので、少しのあいだ受け取りを止めています', true); } return false; }
      return true;
    }
    onUpdate(bytes, userId) {
      if (this.left || !(bytes instanceof Uint8Array) || bytes.length > MAX_UPDATE()) return;
      if (!this.budget(userId, bytes.length)) return;
      const d = this.doc(); if (!d) return;
      if (this.boardId) this.o.commitLocal(this.boardId); // 先に自分の未送信の変更を文書へ（作り直しで消えないように）
      try { window.Y.applyUpdate(d.doc, bytes, 'remote'); } catch (e) { console.error('更新を当てられませんでした', e && e.stack || e); return; }
      if (!this.boardId) {
        // 参加する側: 作戦の名前（id・マップ）と手順が届いたら、自分の作戦にする
        const id = d.meta.get('id'), mapUuid = d.meta.get('mapUuid');
        if (typeof id !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(id) || typeof mapUuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(mapUuid) || d.steps.size === 0) return;
        const r = this.o.adoptDoc(d);
        if (r === false) return; // 受け取らなかった（同じIDの別の作戦が手元にある）
        this.boardId = id; this.pending = null;
        const dd = this.o.getDoc(id); this.pin = { id, mapUuid: (dd && dd.meta.get('mapUuid')) || mapUuid };
        this.hookDoc(); // 手元の文書に足した場合（前に参加した作戦）は、そちらの変更を送る
        this.o.onStatus('作戦を受け取りました', false);
        this.updatePeers();
      } else {
        if (this.pin && !d.sameIdentity(this.pin.id, this.pin.mapUuid)) {
          this.stopped = true;
          this.o.onStatus('相手の作戦のIDかマップが変わったため、受け取りを止めました（一度抜けて、招待URLから入り直してください）', true);
          return;
        }
        this.o.afterRemote();
      }
      this.wantImages(userId);
    }
    // ---- 画像: 持っていない画像を、文書を送ってきた人たちに頼み、頼んだ相手からだけ受け取る ----
    async wantImages(from) {
      const S = BS();
      if (!this.boardId) return;
      for (const f of this.o.imagesOf(this.boardId)) {
        if (!S.IMG_NAME.test(f)) continue;
        const w = this.imgWant.get(f);
        if (w) { if (from) w.sources.add(from); continue; }
        if (await this.o.hasImage(f)) continue;
        this.imgWant.set(f, { sources: new Set(from ? [from] : []), asked: new Set(from ? [from] : []), tries: 1, at: Date.now() });
        if (from) this.aImgReq.send({ name: f }, { target: from }).catch(() => {});
      }
    }
    async retryImages() {
      if (this.left) return;
      const users = Object.keys(this.room.getUsers ? this.room.getUsers() : {});
      for (const [f, w] of [...this.imgWant]) {
        if (Date.now() - w.at < 8000) continue;
        if (await this.o.hasImage(f)) { this.imgWant.delete(f); continue; }
        if (w.tries >= 8) { this.imgWant.delete(f); continue; }
        const cands = [...w.sources].filter(u => users.includes(u));
        const list = cands.length ? cands : users;
        if (!list.length) continue;
        const target = list[w.tries % list.length];
        w.tries++; w.at = Date.now(); w.asked.add(target);
        this.aImgReq.send({ name: f }, { target }).catch(() => {});
      }
    }
    async answerImage(data, userId) {
      const S = BS();
      if (this.left || !this.boardId || !S.isPlainObject(data) || typeof data.name !== 'string' || !S.IMG_NAME.test(data.name)) return;
      if (!this.o.imagesOf(this.boardId).has(data.name)) return; // この作戦で使っている画像だけ渡す
      const bytes = await this.o.readImage(data.name);
      if (bytes) this.aImg.send(bytes, { target: userId, metadata: { name: data.name } }).catch(() => {});
    }
    async receiveImage(bytes, meta, userId) {
      const S = BS();
      const name = meta && meta.name;
      const w = typeof name === 'string' ? this.imgWant.get(name) : null;
      if (!w || !w.asked.has(userId)) return; // 頼んだ相手からだけ受け取る
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_IMG || S.sniffImage(bytes) !== name.split('.').pop()) return;
      if (await this.o.saveImage(name, bytes)) { this.imgWant.delete(name); this.o.onImage(); } // 画像は描き直すだけ（作戦データは作り直さない）
    }
    // ---- 参加者・カーソル ----
    updatePeers() {
      if (!this.who || !this.room) return;
      const S = BS();
      const all = this.who.getAll ? this.who.getAll() : {};
      const users = this.room.getUsers ? this.room.getUsers() : {};
      const list = Object.entries(all).filter(([id, v]) => v && (S.own(users, id) || this.selfId === id)).map(([id, v]) => ({ id, name: v.name, color: v.color, self: id === this.selfId }));
      this.o.onPeers(list);
      const others = Object.keys(users).length;
      if (others > 0) this.o.onStatus('つながっています（あなたを入れて' + (others + 1) + '人）', false);
      else if (this.boardId) this.o.onStatus('友達の参加を待っています', false);
      else this.o.onStatus('作戦を持っている人を待っています（招待した人が作戦ボードを開いているか確かめてください）', false);
    }
    setCursor(p) { if (!this.left && this.cur) this.cur.set(p); }
    setName(name, color) { if (this.who) this.who.set({ name: name.slice(0, 24), color }); }
    async leave() { this.left = true; clearInterval(this.timer); if (this.unhook) this.unhook(); try { await this.room.leave(); } catch {} }
  }

  window.Collab = { Collab, BoardDoc, zTick, b64 };
})();
