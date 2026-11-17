'use strict';
// 作戦ボードの描画（編集画面とパネルのプレビューで共通）
// 座標: ミニマップ画像を 0〜1000 とした単位（どの画面サイズでも同じ）。
// 1メートル = 100（ゲーム内単位cm）× xMultiplier × 1000 単位。valorant-api の変換式と同じ係数なので、
// 地点名の座標がミニマップの正しい場所に乗ることで縮尺が正しいことを確認済み（2026-11-13）。
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const TEAM_COLOR = { ally: '#3ddc97', enemy: '#ff4655' };
  const PLAYER_FOV = 103; // VALORANTの横の視野角（設定で変えられない固定値。16:9のとき）
  const VIEW_DEFAULT = 45; // 人の視界の扇の初期値（画面全体の103°は広すぎるとユーザーの指定、2026-11-13）

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  const unitsPerMeter = map => 100 * Math.abs(map.xMul) * 1000;

  function mapToUnits(map, loc) {
    // valorant-api の式: u = y*xMultiplier + xScalarToAdd, v = x*yMultiplier + yScalarToAdd
    return { x: (loc.y * map.xMul + map.xAdd) * 1000, y: (loc.x * map.yMul + map.yAdd) * 1000 };
  }

  function abilityKey(agent, slot) { return agent.en + '|' + slot; }
  function geometryOf(agent, slot) { return (window.ABILITY_GEOMETRY || {})[abilityKey(agent, slot)] || { s: 'icon', kind: 'util', conf: 'none' }; }

  // 回転していても文字やアイコンが上向きのままになるよう、置いた点を中心に逆回転させる
  function upright(g, x, y, rot) { if (rot) g.setAttribute('transform', `rotate(${-rot} ${x} ${y})`); }

  function drawAbilityShape(parent, o, g, k, style) {
    const len = (o.len != null ? o.len : g.len);
    const r = (o.r != null ? o.r : g.r);
    const sw = 2.2;
    const common = { fill: style.fill, stroke: style.stroke, 'stroke-width': sw, 'stroke-dasharray': style.dash ? '8 6' : null, 'vector-effect': 'non-scaling-stroke' };
    // 索敵の範囲（点線）は広いので、下にあるものを選べるようクリックを素通りさせる（アイコンで選ぶ）
    const grp = el('g', { transform: `translate(${o.x} ${o.y}) rotate(${o.rot || 0})`, 'pointer-events': style.dash ? 'none' : null }, parent);
    switch (g.s) {
      case 'circle': el('circle', { cx: 0, cy: 0, r: r * k, ...common }, grp); break;
      case 'rings':
        el('circle', { cx: 0, cy: 0, r: g.r[1] * k, ...common }, grp);
        el('circle', { cx: 0, cy: 0, r: g.r[0] * k, ...common, fill: style.fill.replace(/[\d.]+\)$/, '0.5)') }, grp);
        break;
      case 'rect': el('rect', { x: (g.off || 0) * k, y: -g.w / 2 * k, width: len * k, height: g.w * k, ...common }, grp); break;
      // capsule: 半径rの範囲が、使う人の位置から len m 進む（両端は半円）。end があれば終点にその半径の円
      case 'capsule':
        el('rect', { x: -g.r * k, y: -g.r * k, width: (len + 2 * g.r) * k, height: 2 * g.r * k, rx: g.r * k, ...common }, grp);
        if (g.end) el('circle', { cx: len * k, cy: 0, r: g.end * k, ...common }, grp);
        break;
      // 壁は実寸の厚さで描く（細くても枠線は画面上の太さで描かれるので見える）
      case 'wall': el('rect', { x: -len / 2 * k, y: -g.w / 2 * k, width: len * k, height: g.w * k, ...common }, grp); break;
      case 'dwall':
        // gap = 2枚の壁の内側の間隔（走る通路の幅）。壁の厚さ0.6mは外側に足す
        for (const s of [-1, 1]) el('rect', { x: -g.back * k, y: (s < 0 ? -g.gap / 2 - 0.6 : g.gap / 2) * k, width: (g.front + g.back) * k, height: 0.6 * k, ...common }, grp);
        break;
      case 'cross':
        el('rect', { x: -g.arm * k, y: -g.w / 2 * k, width: 2 * g.arm * k, height: g.w * k, ...common }, grp);
        el('rect', { x: -g.w / 2 * k, y: -g.arm * k, width: g.w * k, height: 2 * g.arm * k, ...common }, grp);
        break;
      case 'cone': {
        const a = (g.angle / 2) * Math.PI / 180, R = g.r * k;
        el('path', { d: `M0 0 L${R * Math.cos(-a)} ${R * Math.sin(-a)} A${R} ${R} 0 0 1 ${R * Math.cos(a)} ${R * Math.sin(a)} Z`, ...common }, grp);
        break;
      }
      case 'view': drawView(grp, 0, 0, 0, len, o.ang != null ? o.ang : g.angle, k, style.base); break;
      case 'mapline': el('rect', { x: -1500, y: -0.6 * k, width: 3000, height: 1.2 * k, ...common }, grp); break;
      default: break;
    }
    return grp;
  }

  // 視界の扇（カメラ・人の見ている範囲）。下のものを選べるようクリックは素通り。選択枠の計算からも外す（class view）
  // 中心 (x,y)、向き rotDeg（度、0=右）、長さ lenM（m）、広さ angDeg（度、全体）
  function drawView(parent, x, y, rotDeg, lenM, angDeg, k, color) {
    const a = Math.max(1, Math.min(179, angDeg)) / 2 * Math.PI / 180, R = lenM * k, r0 = rotDeg * Math.PI / 180;
    const p1 = [x + R * Math.cos(r0 - a), y + R * Math.sin(r0 - a)], p2 = [x + R * Math.cos(r0 + a), y + R * Math.sin(r0 + a)];
    const g = el('g', { class: 'view', 'pointer-events': 'none' }, parent);
    el('path', { d: `M${x} ${y} L${p1[0]} ${p1[1]} A${R} ${R} 0 0 1 ${p2[0]} ${p2[1]} Z`, fill: rgba(color, 0.16), stroke: 'none' }, g);
    // 両端の線は見ている範囲の境目なのでくっきり、先の弧は「ここで視界が終わるわけではない」ので点線
    el('path', { d: `M${p1[0]} ${p1[1]} L${x} ${y} L${p2[0]} ${p2[1]}`, fill: 'none', stroke: rgba(color, 0.85), 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' }, g);
    el('path', { d: `M${p1[0]} ${p1[1]} A${R} ${R} 0 0 1 ${p2[0]} ${p2[1]}`, fill: 'none', stroke: rgba(color, 0.5), 'stroke-width': 1.2, 'stroke-dasharray': '4 5', 'vector-effect': 'non-scaling-stroke' }, g);
    return g;
  }

  // ---- 色 ----
  // キャラの色: 公式データの背景色（暗い）を、色相はそのままに明るくして使う
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(0, 6), 16); let r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
    return [h, s, l];
  }
  function hslToHex(h, s, l) {
    const f = n => { const k2 = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); const c = l - a * Math.max(-1, Math.min(k2 - 3, 9 - k2, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
    return '#' + f(0) + f(8) + f(4);
  }
  const colorCache = new Map();
  function agentColor(a) {
    if (!a) return '#cccccc';
    if (colorCache.has(a.uuid)) return colorCache.get(a.uuid);
    const list = Array.isArray(a.grad) ? a.grad : [];
    const hex = list.find(c => typeof c === 'string' && /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c) && !/^0f1923/i.test(c) && !/^ffffff/i.test(c));
    let out = '#9aa5ad';
    // 彩度がほぼ無い色（灰色）は灰色のまま明るくする（無理に彩度を上げると赤くなるため）
    if (hex) { const [h, s] = hexToHsl(hex); out = hslToHex(h, s < 0.1 ? s : Math.max(s, 0.5), 0.62); }
    colorCache.set(a.uuid, out);
    return out;
  }
  // 移動系の「届く距離」が確定値か（未確認・推定の距離は目安として円を出すだけで、制限はしない）
  function moveHardMax(geo) {
    return geo && geo.move && geo.move.max && !['wiki', 'est', 'none'].includes(geo.move.conf) ? geo.move.max : null;
  }
  // 行き先を届く距離の中に収める（確定値のときだけ）。戻り値 { tx, ty }
  function clampMove(o, geo, k) {
    const max = moveHardMax(geo);
    if (!max || typeof o.tx !== 'number') return { tx: o.tx, ty: o.ty };
    const dx = o.tx - o.x, dy = o.ty - o.y, L = Math.hypot(dx, dy), lim = max * k;
    return L <= lim ? { tx: o.tx, ty: o.ty } : { tx: o.x + dx * lim / L, ty: o.y + dy * lim / L };
  }
  const KIND_ALPHA = { smoke: 0.62, damage: 0.38, cc: 0.32, info: 0.12, wall: 0.6, heal: 0.25, util: 0.22 };
  function rgba(hex, a) { const n = parseInt(hex.slice(1, 7), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
  // スキルの塗りと枠: 実際の色（geo.color）があればそれ、無ければキャラの色。敵は枠を赤に
  function abilityStyle(a, geo, team) {
    const base = geo.color || agentColor(a);
    return { fill: rgba(base, KIND_ALPHA[geo.kind] != null ? KIND_ALPHA[geo.kind] : 0.25), stroke: team === 'enemy' ? TEAM_COLOR.enemy : base, dash: geo.kind === 'info', base };
  }

  function drawIcon(parent, x, y, href, color, size, rot, opts = {}) {
    const g = el('g', null, parent);
    el('circle', { cx: x, cy: y, r: size / 2 + 1, fill: opts.bg || 'rgba(10,16,22,0.85)', stroke: color, 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke' }, g);
    if (href) el('image', { href, x: x - size / 2 * 0.86, y: y - size / 2 * 0.86, width: size * 0.86, height: size * 0.86, 'clip-path': opts.clip }, g);
    upright(g, x, y, rot);
    return g;
  }

  // 1つのものを描く。戻り値は data-id 付きの <g>
  function drawObject(layer, o, ctx) {
    const { map, agents, k, rot, imgUrl, opacity } = ctx;
    const ui = ctx.ui || 1; // アイコン・ラベルの大きさ（拡大しても画面上で同じ大きさに保つ）
    const g = el('g', { 'data-id': o.id, class: 'obj obj-' + o.kind, opacity: opacity != null ? opacity : null }, layer);
    const color = o.color || '#ffffff';
    const sw = o.width || 3;
    const stroke = { stroke: color, 'stroke-width': sw, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
    switch (o.kind) {
      case 'agent': {
        const a = agents[o.agent];
        const R = 17 * ui;
        // 人の視界（見ている向きと範囲）。キャラの丸の下に描く
        if (typeof o.vlen === 'number') drawView(g, o.x, o.y, o.vrot || 0, o.vlen, o.vang || VIEW_DEFAULT, k, TEAM_COLOR[o.team] || '#ffffff');
        el('circle', { cx: o.x, cy: o.y, r: R, fill: 'rgba(10,16,22,0.9)' }, g);
        if (a) {
          const ig = el('g', null, g);
          el('image', { href: a.icon, x: o.x - R, y: o.y - R, width: 2 * R, height: 2 * R, 'clip-path': 'url(#clipAgent)' }, ig);
          upright(ig, o.x, o.y, rot);
        }
        el('circle', { cx: o.x, cy: o.y, r: R, fill: 'none', stroke: TEAM_COLOR[o.team] || '#fff', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, g);
        break;
      }
      case 'ability': {
        const a = agents[o.agent];
        const ab = a && a.abilities.find(x => x.slot === o.slot);
        const geo = a ? geometryOf(a, o.slot) : { s: 'icon', kind: 'util' };
        const style = abilityStyle(a, geo, o.team);
        // 移動系: 使う位置 → 行き先 の矢印（テレポートは点線）と、行き先にキャラの影
        if (geo.move && typeof o.tx === 'number' && typeof o.ty === 'number') {
          o = { ...o, ...clampMove(o, geo, k) }; // 読み込んだデータで距離を超えていても、描くときは収める
          const mc = style.stroke;
          const mg = el('g', { class: 'move' }, g);
          if (ctx.showRings && geo.move.max) {
            el('circle', { cx: o.x, cy: o.y, r: geo.move.max * k, fill: 'none', stroke: '#ffffffaa', 'stroke-width': 1.5, 'stroke-dasharray': '6 6', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, mg);
            const t = el('text', { x: o.x, y: o.y - geo.move.max * k - 4 * ui, 'text-anchor': 'middle', class: 'ring-label', 'font-size': 14 * ui, 'stroke-width': 3 * ui }, mg);
            t.textContent = (moveHardMax(geo) ? '届く距離 ' : '届く距離の目安 ') + geo.move.max + 'm'; upright(t, o.x, o.y, rot);
          }
          const dx = o.tx - o.x, dy = o.ty - o.y, L = Math.hypot(dx, dy) || 1;
          const back = 13 * ui; // 矢じりが行き先の丸に隠れないよう少し手前で止める
          ensureArrowMarker(layer.ownerSVGElement, mc);
          el('line', { x1: o.x, y1: o.y, x2: o.tx - dx / L * back, y2: o.ty - dy / L * back, stroke: mc, 'stroke-width': 3, 'stroke-linecap': 'round',
            'stroke-dasharray': geo.move.type === 'tp' ? '2 7' : null, 'marker-end': `url(#arrow-${mc.replace('#', '')})`, 'vector-effect': 'non-scaling-stroke' }, mg);
          const dest = el('g', { opacity: 0.75 }, mg);
          el('circle', { cx: o.tx, cy: o.ty, r: 12 * ui, fill: 'rgba(10,16,22,0.8)' }, dest);
          if (a) { const ig = el('g', null, dest); el('image', { href: a.icon, x: o.tx - 12 * ui, y: o.ty - 12 * ui, width: 24 * ui, height: 24 * ui, 'clip-path': 'url(#clipAgent)' }, ig); upright(ig, o.tx, o.ty, rot); }
          el('circle', { cx: o.tx, cy: o.ty, r: 12 * ui, fill: 'none', stroke: mc, 'stroke-width': 1.5, 'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke' }, dest);
        }
        drawAbilityShape(g, o, geo, k, style);
        if (ctx.showRings && geo.ring) for (const rg of geo.ring) {
          el('circle', { cx: o.x, cy: o.y, r: rg.r * k, fill: 'none', stroke: '#ffffffaa', 'stroke-width': 1.5, 'stroke-dasharray': '6 6', 'vector-effect': 'non-scaling-stroke' }, g);
          const t = el('text', { x: o.x, y: o.y - rg.r * k - 4 * ui, 'text-anchor': 'middle', class: 'ring-label', 'font-size': 14 * ui, 'stroke-width': 3 * ui }, g); t.textContent = rg.label + ' ' + rg.r + 'm';
          upright(t, o.x, o.y, rot);
        }
        drawIcon(g, o.x, o.y, ab && ab.icon, TEAM_COLOR[o.team] || '#fff', 20 * ui, rot);
        // 定点の画像（2026-11-14）: 画像が付いていたら右上にカメラの印。押すと画像が開く（class img-badge、data-obj にもののID）
        if (Array.isArray(o.images) && o.images.length) drawImgBadge(g, o, ui * (ctx.badge || 1), rot);
        break;
      }
      case 'pen': {
        if (!o.points || o.points.length < 2) break;
        el('path', { d: 'M' + o.points.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L'), ...stroke }, g);
        break;
      }
      case 'line': {
        el('line', { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, ...stroke, 'marker-end': o.arrow ? `url(#arrow-${color.replace('#', '')})` : null }, g);
        if (o.arrow) ensureArrowMarker(layer.ownerSVGElement, color);
        break;
      }
      case 'rect': el('rect', { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), width: Math.abs(o.x2 - o.x1), height: Math.abs(o.y2 - o.y1), ...stroke, fill: o.fill ? color + '33' : 'none' }, g); break;
      case 'ellipse': el('ellipse', { cx: (o.x1 + o.x2) / 2, cy: (o.y1 + o.y2) / 2, rx: Math.abs(o.x2 - o.x1) / 2, ry: Math.abs(o.y2 - o.y1) / 2, ...stroke, fill: o.fill ? color + '33' : 'none' }, g); break;
      case 'text': {
        const fs = (o.size || 22) * (ctx.textScale || 1); // パネルで寄せたとき、文字は画面上の大きさを保つ（2026-11-17）
        const t = el('text', { x: o.x, y: o.y, fill: color, 'font-size': fs, 'stroke-width': fs * 0.18, class: 'board-text' }, g);
        t.textContent = o.text || '';
        upright(t, o.x, o.y, rot);
        break;
      }
      case 'image': {
        if (o.file) el('image', { href: imgUrl(o.file), x: o.x, y: o.y, width: o.w, height: o.h, preserveAspectRatio: 'none' }, g);
        break;
      }
      case 'lineup': {
        const a = agents[o.agent];
        const ab = a && a.abilities.find(x => x.slot === o.slot);
        const c = '#f5c84c';
        el('line', { x1: o.fx, y1: o.fy, x2: o.tx, y2: o.ty, stroke: c, 'stroke-width': 2, 'stroke-dasharray': '7 6', 'vector-effect': 'non-scaling-stroke' }, g);
        // 目標（×）
        const tg = el('g', null, g);
        el('circle', { cx: o.tx, cy: o.ty, r: 9 * ui, fill: 'rgba(10,16,22,.85)', stroke: c, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, tg);
        el('path', { d: `M${o.tx - 5 * ui} ${o.ty - 5 * ui} L${o.tx + 5 * ui} ${o.ty + 5 * ui} M${o.tx + 5 * ui} ${o.ty - 5 * ui} L${o.tx - 5 * ui} ${o.ty + 5 * ui}`, stroke: c, 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke' }, tg);
        // 立ち位置（スキルのアイコン）
        drawIcon(g, o.fx, o.fy, ab && ab.icon, c, 18 * ui, rot);
        if (o.title) {
          const t = el('text', { x: o.fx, y: o.fy + 26 * ui, 'text-anchor': 'middle', class: 'lineup-label', 'font-size': 15 * ui, 'stroke-width': 3 * ui }, g);
          t.textContent = o.title;
          upright(t, o.fx, o.fy, rot);
        }
        break;
      }
    }
    return g;
  }

  function drawImgBadge(parent, o, s, rot) {
    const cx = o.x + 15 * s, cy = o.y - 15 * s;
    const b = el('g', { class: 'img-badge', 'data-obj': o.id, cursor: 'pointer' }, parent);
    el('title', null, b).textContent = '画像を見る（' + o.images.length + '枚）';
    el('circle', { cx, cy, r: 9 * s, fill: '#f5c84c', stroke: '#0f1923', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, b);
    // カメラの形（本体＋レンズ）
    el('rect', { x: cx - 5 * s, y: cy - 3 * s, width: 10 * s, height: 7 * s, rx: 1.5 * s, fill: '#0f1923' }, b);
    el('rect', { x: cx - 2 * s, y: cy - 5 * s, width: 4 * s, height: 2.5 * s, fill: '#0f1923' }, b);
    el('circle', { cx, cy: cy + 0.5 * s, r: 2 * s, fill: '#f5c84c' }, b);
    upright(b, o.x, o.y, rot);
    return b;
  }

  const markers = new WeakMap();
  function ensureArrowMarker(svg, color) {
    if (!svg) return;
    let set = markers.get(svg); if (!set) { set = new Set(); markers.set(svg, set); }
    const id = 'arrow-' + color.replace('#', '');
    if (set.has(id) && svg.querySelector('#' + id)) return;
    set.add(id);
    const defs = svg.querySelector('defs') || el('defs', null, svg);
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0 0 L10 5 L0 10 z', fill: color }, m);
  }

  // ボード全体を svg に描く。opts: { rot, showCallouts, showRings, objects（省略時は step の中身）, selectedId, imgUrl }
  function render(svg, board, map, gameData, opts = {}) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const defs = el('defs', null, svg);
    const cp = el('clipPath', { id: 'clipAgent', clipPathUnits: 'objectBoundingBox' }, defs);
    el('circle', { cx: 0.5, cy: 0.5, r: 0.5 }, cp);
    const rot = opts.rot != null ? opts.rot : (board.rot || 0);
    const root = el('g', { class: 'board-root', transform: rot ? `rotate(${rot} 500 500)` : null }, svg);
    el('image', { href: map.minimap, x: 0, y: 0, width: 1000, height: 1000, class: 'minimap' }, root);
    const agents = {};
    for (const a of gameData.agents) agents[a.uuid] = a;
    const k = unitsPerMeter(map);
    if (opts.showCallouts && map.callouts) {
      const cl = el('g', { class: 'callouts' }, root);
      const ui = opts.ui || 1;
      const pos = opts.calloutPos || map.callouts; // 通路の上に寄せた位置（無ければデータそのまま）
      const rad = rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const toScreen = (x, y) => ({ x: (x - 500) * cos - (y - 500) * sin + 500, y: (x - 500) * sin + (y - 500) * cos + 500 });
      const toMapDelta = (dx, dy) => ({ x: dx * cos + dy * sin, y: -dx * sin + dy * cos });
      const placed = [];
      const hit = (a) => placed.some(b => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1);
      map.callouts.forEach((c, i) => {
        const p = pos[i] || c;
        const t = el('text', { x: p.x, y: p.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'callout', 'font-size': 15 * ui, 'stroke-width': 3 * ui }, cl);
        t.textContent = c.name;
        let w = 15 * ui * c.name.length, h = 15 * ui;
        try { const bb = t.getBBox(); if (bb.width) { w = bb.width; h = bb.height; } } catch {}
        const sc = toScreen(p.x, p.y), gap = 2 * ui;
        // 重ならない位置を、元の位置 → 上下 → 左右 の順に探す（画面の上下左右で判定）
        const tries = [[0, 0], [0, h], [0, -h], [0, 2 * h], [0, -2 * h], [w * 0.6, 0], [-w * 0.6, 0], [w * 0.6, h], [-w * 0.6, -h], [0, 3 * h], [0, -3 * h]];
        let best = tries[0];
        for (const tr of tries) {
          const box = { x1: sc.x + tr[0] - w / 2 - gap, x2: sc.x + tr[0] + w / 2 + gap, y1: sc.y + tr[1] - h / 2, y2: sc.y + tr[1] + h / 2 };
          if (!hit(box)) { best = tr; break; }
        }
        const d = toMapDelta(best[0], best[1]);
        const nx = p.x + d.x, ny = p.y + d.y;
        t.setAttribute('x', nx); t.setAttribute('y', ny);
        placed.push({ x1: sc.x + best[0] - w / 2 - gap, x2: sc.x + best[0] + w / 2 + gap, y1: sc.y + best[1] - h / 2, y2: sc.y + best[1] + h / 2 });
        upright(t, nx, ny, rot);
      });
    }
    const layer = el('g', { class: 'objects' }, root);
    const objs = opts.objects || ((board.steps[opts.step || 0] || {}).objects || []);
    const ctx = { map, agents, k, rot, ui: opts.ui || 1, badge: opts.badge || 1, textScale: opts.textScale || 1, imgUrl: opts.imgUrl || (f => 'vmimg://img/' + encodeURIComponent(f)), showRings: false };
    for (const o of objs) {
      ctx.showRings = opts.showRings === true || (opts.selectedId && opts.selectedId === o.id);
      ctx.opacity = o.__opacity;
      drawObject(layer, o, ctx);
    }
    return { root, layer, k };
  }

  window.BoardRender = { PLAYER_FOV, VIEW_DEFAULT, drawView, render, unitsPerMeter, mapToUnits, geometryOf, agentColor, abilityStyle, moveHardMax, clampMove, TEAM_COLOR };
})();
