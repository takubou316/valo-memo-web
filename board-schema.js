'use strict';
// 作戦ボードのデータの検査と、同時編集のための「時計（版）」の決まり。
// アプリ本体（boards.js、Node）と画面（board.js・collab.js、ブラウザ）の両方から使う。
//
// 同時編集のための項目（2026-11-13追加）:
//   steps[].id   … 手順のID
//   steps[].ord  … 手順の並びの位置（数値。小さい順に並ぶ。同じなら ID 順）。手順1つずつ独立した記録なので、同時に足しても両方残る
//   steps[].sv   … 手順の記録（あること・位置）の版
//   steps[].nv   … 手順のメモの版
//   objects[].v  … もの1つずつの版（新しい方が勝つ）
//   objects[].z  … 重なりの順番（置いたときの版。小さい順に下から描く。同じなら ID 順）→ 全員で同じ重なりになる
//   ver          … 作戦の名前・キャラ・攻守・向き の版 { name, agent, side, rot }
//   tomb         … 消したものの印 { "<手順ID>/<もののID>": 版 }（抜けていた人が戻っても復活させない）
//   stomb        … 消した手順の印 { <手順ID>: 版 }
//   hidden       … 消した手順の中身（捨てずに隠すだけ。新しい版で作り直されたら中身ごと戻る → 届く順番に関係なく同じ結果）
//   share        … 一緒に作っている部屋 { room, key } または null
// 版の形: "<ミリ秒13桁>.<連番（先頭0なし）>.<人の印>"。比べるときは ミリ秒 → 連番 → 人の印 の順（全員で同じ結果になる）
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardSchema = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const OBJ_KINDS = new Set(['agent', 'ability', 'pen', 'line', 'rect', 'ellipse', 'text', 'image', 'lineup']);
  const IMG_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;
  const UUID = /^[0-9a-f-]{36}$/i;
  const OBJ_ID = /^[0-9a-z]{1,40}$/i;
  const STEP_ID = /^[0-9a-z]{4,40}$/i;
  const COLOR = /^#[0-9a-f]{6}$/i;
  const VER = /^\d{13}\.(0|[1-9]\d{0,8})\.[0-9a-z]{1,40}$/;
  const ROOM = /^[0-9a-z]{16,64}$/i;
  const KEY = /^[0-9a-z_-]{16,128}$/i;
  const SLOTS = new Set(['Ability1', 'Ability2', 'Grenade', 'Ultimate']);
  const META_KEYS = ['name', 'agent', 'side', 'rot'];
  const MAX_TOMB = 50000, MAX_STOMB = 5000;
  // データとして持てる上限（受け取りを断らないよう、画面で作れる数より大きく取る。画面での上限は board.js: 手順30）
  const MAX_OBJECTS = 4000, MAX_STEPS = 60, MAX_HIDDEN = 60;
  // 保存する Yjs 文書（base64の文字数）の上限と、そのバイト数。超える文書は保存しない（board.js が知らせる）
  const MAX_YDOC = 40 * 1024 * 1024, MAX_YDOC_BYTES = Math.floor(MAX_YDOC * 3 / 4);
  // 消えていても「確実にある」手順（全部の手順が同時に消されたとき、全員が同じ空の手順を作る）
  const FALLBACK_STEP = { id: 'step0000', ord: 0, sv: '0000000000001.0.0' };

  const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  // 座標は 0〜1000 が地図。少しはみ出しても良いが、極端な値や数値以外は捨てる
  const num = (v, min = -3000, max = 4000) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
  const ver = v => (typeof v === 'string' && VER.test(v) ? v : null);
  // 辞書から「自分の項目」だけを読む（constructor などの名前で、元から付いている機能を読まないように）
  const own = (map, k) => (map && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined);

  // 版の比較: a が新しければ正、古ければ負、同じなら0。無い版（版の形でないものも）は一番古い
  function cmpVer(a, b) {
    a = ver(a); b = ver(b);
    if (a === b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    const [am, ac, au] = a.split('.'), [bm, bc, bu] = b.split('.');
    const dm = Number(am) - Number(bm); if (dm) return dm > 0 ? 1 : -1;
    const dc = Number(ac) - Number(bc); if (dc) return dc > 0 ? 1 : -1;
    return au > bu ? 1 : au < bu ? -1 : 0;
  }
  // 手順の並び・ものの重なりの順番（全員で同じになる）
  const stepOrder = (a, b) => (a.ord - b.ord) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const objOrder = (a, b) => { const c = cmpVer(a.z, b.z); return c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); };

  // 1つのもの（キャラ・スキル・線など）を、種類ごとに決まった項目だけ・正しい型だけにして返す。だめなら null
  function cleanObject(o) {
    if (!isPlainObject(o) || typeof o.id !== 'string' || !OBJ_ID.test(o.id) || !OBJ_KINDS.has(o.kind)) return null;
    const c = { id: o.id, kind: o.kind };
    const need = (...keys) => { for (const k of keys) { const v = num(o[k]); if (v === null) return false; c[k] = v; } return true; };
    const color = () => { c.color = COLOR.test(o.color || '') ? o.color : '#ffffff'; c.width = [2, 3, 6].includes(o.width) ? o.width : 3; };
    const team = () => { c.team = o.team === 'enemy' ? 'enemy' : 'ally'; };
    switch (o.kind) {
      case 'agent':
        if (!need('x', 'y') || typeof o.agent !== 'string' || !UUID.test(o.agent)) return null;
        c.agent = o.agent.toLowerCase(); team();
        // 視界の扇（vlen があるときだけ出す）: 向き vrot・長さ vlen(m)・広さ vang(度)
        if (num(o.vlen, 1, 150) !== null) {
          c.vlen = o.vlen; c.vrot = num(o.vrot, -3600, 3600) || 0;
          c.vang = num(o.vang, 5, 179) !== null ? o.vang : 45; // 初期値（board-render の VIEW_DEFAULT と同じ）
        }
        break;
      case 'ability':
        if (!need('x', 'y') || typeof o.agent !== 'string' || !UUID.test(o.agent) || !SLOTS.has(o.slot)) return null;
        c.agent = o.agent.toLowerCase(); c.slot = o.slot; team();
        c.rot = num(o.rot, -3600, 3600) || 0;
        if (num(o.len, 0, 300) !== null) c.len = o.len;
        if (num(o.r, 0, 100) !== null) c.r = o.r;
        if (num(o.ang, 5, 179) !== null) c.ang = o.ang; // 視界の扇（カメラ）の広さ
        if (num(o.tx) !== null && num(o.ty) !== null) { c.tx = o.tx; c.ty = o.ty; } // 移動系の行き先
        // 定点の画像（2026-11-14）。付いているときだけ持つ（前の版の作戦の中身を変えないように）
        if (Array.isArray(o.images)) { const im = o.images.filter(f => typeof f === 'string' && IMG_NAME.test(f)).slice(0, 20); if (im.length) c.images = im; }
        break;
      case 'pen': {
        if (!Array.isArray(o.points)) return null;
        const pts = o.points.slice(0, 5000).filter(p => Array.isArray(p) && p.length === 2 && num(p[0]) !== null && num(p[1]) !== null).slice(0, 5000).map(p => [p[0], p[1]]);
        if (pts.length < 2) return null;
        c.points = pts; color(); break;
      }
      case 'line': case 'rect': case 'ellipse':
        if (!need('x1', 'y1', 'x2', 'y2')) return null;
        color(); if (o.kind === 'line') c.arrow = o.arrow === true; else c.fill = o.fill === true; break;
      case 'text':
        if (!need('x', 'y')) return null;
        c.text = str(o.text, 500); c.size = [16, 22, 32, 48].includes(o.size) ? o.size : 22;
        c.color = COLOR.test(o.color || '') ? o.color : '#ffffff'; break;
      case 'image':
        if (!need('x', 'y') || num(o.w, 1, 4000) === null || num(o.h, 1, 4000) === null || !IMG_NAME.test(o.file || '')) return null;
        c.w = o.w; c.h = o.h; c.file = o.file; break;
      case 'lineup':
        if (!need('fx', 'fy', 'tx', 'ty')) return null;
        c.agent = typeof o.agent === 'string' && UUID.test(o.agent) ? o.agent.toLowerCase() : null;
        c.slot = SLOTS.has(o.slot) ? o.slot : null;
        c.title = str(o.title, 80); c.note = str(o.note, 2000);
        c.images = Array.isArray(o.images) ? o.images.filter(f => typeof f === 'string' && IMG_NAME.test(f)).slice(0, 20) : [];
        break;
    }
    const v = ver(o.v); if (v) c.v = v;
    const z = ver(o.z); if (z) c.z = z;
    return c;
  }

  function cleanShare(s) {
    return isPlainObject(s) && typeof s.room === 'string' && ROOM.test(s.room) && typeof s.key === 'string' && KEY.test(s.key)
      ? { room: s.room, key: s.key } : null;
  }

  // 作戦のメタ情報（名前など）の値を検査
  function cleanMeta(key, value) {
    switch (key) {
      case 'name': return str(value, 80) || '名前なし';
      // キャラのUUID、またはロール全員なら 'role:' + ロールのUUID
      case 'agent': return typeof value === 'string' && (UUID.test(value) || (value.startsWith('role:') && UUID.test(value.slice(5)))) ? value.toLowerCase() : null;
      case 'side': return value === 'atk' || value === 'def' ? value : null;
      case 'rot': return [0, 90, 180, 270].includes(value) ? value : 0;
      default: return undefined;
    }
  }

  // 手順1つを整える（見えている手順・隠した手順の両方に使う）
  function cleanStep(s, stepIds, mkId, index) {
    if (!isPlainObject(s) || !Array.isArray(s.objects)) return null;
    let id = typeof s.id === 'string' && STEP_ID.test(s.id) && !stepIds.has(s.id) ? s.id : null;
    while (!id || stepIds.has(id)) id = mkId();
    stepIds.add(id);
    const seen = new Set();
    const objects = [];
    for (const o of s.objects.slice(0, MAX_OBJECTS * 2)) {
      const c = cleanObject(o);
      if (c && !seen.has(c.id) && objects.length < MAX_OBJECTS) { seen.add(c.id); objects.push(c); }
    }
    const ord = typeof s.ord === 'number' && Number.isFinite(s.ord) && Math.abs(s.ord) < 1e15 ? s.ord : index * 1024;
    const step = { id, ord, objects, note: str(s.note, 2000) };
    const nv = ver(s.nv); if (nv) step.nv = nv;
    const sv = ver(s.sv); if (sv) step.sv = sv;
    return step;
  }

  // 外から来たボード（画面・読み込みファイル・他の人）を、保存してよい形に整える。だめなら null
  // newId: 手順IDが無い・重複したときに作る関数
  function cleanBoard(b, newId) {
    if (!isPlainObject(b) || typeof b.id !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(b.id)) return null;
    if (typeof b.mapUuid !== 'string' || !UUID.test(b.mapUuid)) return null;
    if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.length > MAX_STEPS) return null;
    const mkId = newId || (() => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4));
    const steps = [];
    const stepIds = new Set();
    for (const s of b.steps) { const st = cleanStep(s, stepIds, mkId, steps.length); if (!st) return null; steps.push(st); }
    steps.sort(stepOrder);
    const hidden = [];
    if (Array.isArray(b.hidden)) for (const s of b.hidden.slice(0, MAX_HIDDEN)) {
      if (isPlainObject(s) && typeof s.id === 'string' && stepIds.has(s.id)) continue; // 見えている手順と同じIDは捨てる
      const st = cleanStep(s, stepIds, mkId, hidden.length); if (st) hidden.push(st);
    }
    const out = {
      id: b.id, mapUuid: b.mapUuid.toLowerCase(),
      name: cleanMeta('name', b.name),
      agent: cleanMeta('agent', b.agent),
      side: cleanMeta('side', b.side),
      rot: cleanMeta('rot', b.rot),
      steps,
      created: Number.isFinite(b.created) ? b.created : Date.now(),
      updated: Number.isFinite(b.updated) ? b.updated : Date.now()
    };
    const vers = {};
    if (isPlainObject(b.ver)) for (const k of META_KEYS) { const v = ver(b.ver[k]); if (v) vers[k] = v; }
    out.ver = vers;
    const tomb = {};
    if (isPlainObject(b.tomb)) {
      const list = Object.entries(b.tomb).filter(([k, v]) => /^[0-9a-z]{4,40}\/[0-9a-z]{1,40}$/i.test(k) && ver(v));
      list.sort((x, y) => cmpVer(y[1], x[1])); // 新しい方を残す
      for (const [k, v] of list.slice(0, MAX_TOMB)) tomb[k] = v;
    }
    out.tomb = tomb;
    const stomb = {};
    if (isPlainObject(b.stomb)) {
      const list = Object.entries(b.stomb).filter(([k, v]) => STEP_ID.test(k) && ver(v));
      list.sort((x, y) => cmpVer(y[1], x[1])); // 新しい方を残す
      for (const [k, v] of list.slice(0, MAX_STOMB)) stomb[k] = v;
    }
    out.stomb = stomb;
    out.hidden = hidden;
    // 作戦の Yjs 文書（同時編集の土台。base64）。中身の検査は読み込むとき（BoardDoc.fromSaved と project）に行う
    if (typeof b.ydoc === 'string' && b.ydoc.length <= MAX_YDOC && /^[A-Za-z0-9+/]*={0,2}$/.test(b.ydoc)) out.ydoc = b.ydoc;
    out.share = cleanShare(b.share);
    return out;
  }

  function imagesUsedBy(board) {
    const out = new Set();
    for (const s of board.steps) for (const o of s.objects) {
      if (o.kind === 'image' && IMG_NAME.test(o.file || '')) out.add(o.file);
      if ((o.kind === 'lineup' || o.kind === 'ability') && Array.isArray(o.images)) for (const f of o.images) if (IMG_NAME.test(f)) out.add(f);
    }
    return out;
  }

  // 中身の先頭のバイトで画像の種類を判定（種類の申告だけを信じない）。buf は Uint8Array / Buffer
  function sniffImage(buf) {
    if (!buf || buf.length < 12) return null;
    const a = i => buf[i];
    const ascii = (s, e) => String.fromCharCode(...Array.from(buf.slice(s, e)));
    if (a(0) === 0x89 && a(1) === 0x50 && a(2) === 0x4e && a(3) === 0x47) return 'png';
    if (a(0) === 0xff && a(1) === 0xd8 && a(2) === 0xff) return 'jpg';
    if (ascii(0, 4) === 'GIF8') return 'gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    return null;
  }

  return { cleanObject, cleanBoard, cleanMeta, cleanShare, cmpVer, stepOrder, objOrder, imagesUsedBy, sniffImage, own,
    IMG_NAME, VER, ROOM, KEY, STEP_ID, OBJ_ID, META_KEYS, MAX_TOMB, MAX_STOMB, MAX_OBJECTS, MAX_STEPS, MAX_HIDDEN, MAX_YDOC, MAX_YDOC_BYTES, FALLBACK_STEP, isPlainObject };
});
