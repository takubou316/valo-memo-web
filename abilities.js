'use strict';
// 各スキルの「マップ上の形と実寸（メートル）」
// 出典: VALORANT Wiki（valorant.fandom.com）の各スキルの Stats 表（2026-11-13取得、パッチ13.10時点）
//   conf: 'game' = wikiで「Game files / パッチノート」確認済み ／ 'wiki' = wikiに数値はあるが未確認 ／
//         'est' = 公式の数値が無く推定 ／ 'none' = 不明（大きさは自分で調整する）
// 形 s:
//   circle {r}              … 置いた点が中心の円（スモーク・モロリーなど）
//   rings  {r:[内,外]}      … ダメージ等の内側/外側の半径
//   rect   {len,w,off,var} … 置いた点（=使う人の位置）から向きの方向へ off〜off+len の長方形（幅w）
//   capsule{len,r,end}      … 置いた点から向きの方向へ len m 進む、半径rの帯（両端は半円。端から端は len+2r）。end=終点の円の半径
//   wall   {len,w,var}      … 置いた点が中心の壁（向きで回せる）。var=[最小,最大] なら長さを変えられる
//   dwall  {front,back,gap} … ネオンのファストレーン（平行な2枚の壁）
//   cross  {arm,w}          … デッドロックのバリアメッシュ（中心から4方向）
//   cone   {r,angle}        … 扇形（angle=全体の角度）
//   view   {len,angle,var}  … 視界の扇（カメラ）。向き・長さ（var=[最小,最大]）・広さを変えられる。o.ang=広さ
//   mapline                 … アストラのコズミックディバイド（マップを横切る壁）
//   icon                    … 範囲が無い（フラッシュ・移動技など）。アイコンだけ置く
// color: スキルの実際の色（ゲーム画面の見た目に近い色。公式の数値は無い）。無ければキャラの色
// move: 移動系。{ type: 'tp'(テレポート・点線) | 'dash' | 'run'(実線), max: 届く距離m（null=上限なし）, conf }。矢印の始点=使う位置、終点=行き先
//   move.conf が 'wiki'/'est'/'none'（未確認）なら、max は目安として円を出すだけで、それより先にも動かせる
// ring: 選んだときだけ点線で出す補助の円（有効範囲など） [{r, label}]
// kind（色分け）: smoke / damage / cc（スロウ・脳震盪など）/ info（索敵）/ wall / heal / util
window.ABILITY_GEOMETRY = {
  // ---------- イニシエーター ----------
  'Gekko|Ability1':  { s: 'icon', kind: 'info', note: '目標を見つけるとコンカッション' },
  'Gekko|Ability2':  { s: 'icon', kind: 'info', note: '着弾点で半径2.5mの爆発（目くらまし）' },
  'Gekko|Grenade':   { s: 'rings', r: [5.5, 6.2], kind: 'damage', conf: 'game' },
  'Gekko|Ultimate':  { s: 'icon', kind: 'cc', note: '飛びかかりの範囲 半径5m', ring: [{ r: 5, label: '飛びかかり' }], conf: 'game' },
  'Fade|Ability1':   { s: 'circle', r: 6.58, kind: 'cc', conf: 'game' },
  'Fade|Ability2':   { s: 'circle', r: 30, kind: 'info', conf: 'game', note: '索敵（見えている範囲だけ）' },
  'Fade|Grenade':    { s: 'icon', kind: 'info', note: '探知 15m' },
  'Fade|Ultimate':   { s: 'rect', len: 40, w: 20, off: 0, kind: 'info', conf: 'game' },
  'Breach|Ability1': { s: 'icon', kind: 'util', note: '壁越しフラッシュ（壁の厚さ10mまで）' },
  'Breach|Ability2': { s: 'rect', len: 56, w: 8, off: 8, var: [8, 56], kind: 'cc', conf: 'wiki', note: '溜めで長さ8〜56m、幅8mは確認済み' },
  'Breach|Grenade':  { s: 'rect', len: 10, w: 6, off: 0, kind: 'damage', conf: 'game', note: '壁の向こうへ長さ10m・半径3mの円柱' },
  'Breach|Ultimate': { s: 'rect', len: 32, w: 18, off: 8, kind: 'cc', conf: 'wiki', note: '幅18mは確認済み、長さ32mは未確認' },
  'Tejo|Ability1':   { s: 'rings', r: [1.25, 5.25], kind: 'cc', conf: 'game' },
  'Tejo|Ability2':   { s: 'rings', r: [2.5, 4.5], kind: 'damage', conf: 'game' },
  'Tejo|Ultimate':   { s: 'rect', len: 32, w: 12, off: 0, kind: 'damage', conf: 'game', note: '置いた点から32m（2m×16区画）' },
  'Tejo|Grenade':    { s: 'icon', kind: 'info', ring: [{ r: 18, label: '索敵' }], conf: 'game' },
  'KAY/O|Grenade':   { s: 'rings', r: [1, 4], kind: 'damage', conf: 'game' },
  'KAY/O|Ability1':  { s: 'icon', kind: 'util' },
  'KAY/O|Ability2':  { s: 'circle', r: 15, kind: 'cc', conf: 'game', note: 'スキル封じ' },
  'KAY/O|Ultimate':  { s: 'circle', r: 42.5, kind: 'cc', conf: 'game', note: '本人中心のパルス' },
  'Skye|Ability1':   { s: 'icon', kind: 'cc', note: '爆発 半径3.5m', ring: [{ r: 3.5, label: '爆発' }], conf: 'game' },
  'Skye|Ability2':   { s: 'icon', kind: 'util' },
  'Skye|Grenade':    { s: 'circle', r: 18, kind: 'heal', conf: 'game', note: '本人中心の回復' },
  'Skye|Ultimate':   { s: 'icon', kind: 'info' },
  'Sova|Ability1':   { s: 'rings', r: [1.5, 4], kind: 'damage', conf: 'game' },
  'Sova|Ability2':   { s: 'circle', r: 30, kind: 'info', conf: 'game', note: '索敵（見えている範囲だけ）' },
  'Sova|Grenade':    { s: 'icon', kind: 'info' },
  'Sova|Ultimate':   { s: 'rect', len: 66, w: 3.52, off: 0, kind: 'damage', conf: 'game', note: '長さ66m・半径1.76m（壁を貫通）' },
  // ---------- デュエリスト ----------
  'Raze|Ability1':   { s: 'rings', r: [2, 5], kind: 'damage', conf: 'game', color: '#ff8c3a' },
  'Raze|Ability2':   { s: 'rings', r: [2.5, 5.5], kind: 'damage', conf: 'game', color: '#ff8c3a' },
  'Raze|Grenade':    { s: 'rings', r: [2, 6], kind: 'damage', conf: 'game', note: '爆発の範囲（索敵は前方15m）', color: '#ff8c3a' },
  'Raze|Ultimate':   { s: 'rings', r: [4, 7], kind: 'damage', conf: 'game', color: '#ff8c3a' },
  'Phoenix|Grenade': { s: 'wall', len: 21, w: 1, var: [1, 21], kind: 'wall', conf: 'wiki', note: '長さ1〜21m（曲げられる。ここでは直線）', color: '#ff7b2e' },
  'Phoenix|Ability1':{ s: 'circle', r: 4.5, kind: 'damage', conf: 'wiki', color: '#ff6a1f' },
  'Phoenix|Ability2':{ s: 'icon', kind: 'util' },
  'Phoenix|Ultimate':{ s: 'icon', kind: 'util', move: { type: 'tp', max: null }, note: '倒されるとマーカーの位置に戻る（矢印の先＝マーカー）' },
  'Jett|Ability1':   { s: 'icon', kind: 'util' },
  'Jett|Ability2':   { s: 'icon', kind: 'util', move: { type: 'dash', max: 11, conf: 'wiki' } },
  'Jett|Grenade':    { s: 'circle', r: 3.35, kind: 'smoke', conf: 'game', color: '#d6e8f7' },
  'Jett|Ultimate':   { s: 'icon', kind: 'damage' },
  'Reyna|Ability1':  { s: 'icon', kind: 'heal' },
  'Reyna|Ability2':  { s: 'icon', kind: 'util', move: { type: 'run', max: null } },
  'Reyna|Grenade':   { s: 'icon', kind: 'util' },
  'Reyna|Ultimate':  { s: 'icon', kind: 'util' },
  'Yoru|Grenade':    { s: 'icon', kind: 'util' },
  'Yoru|Ability1':   { s: 'icon', kind: 'util' },
  'Yoru|Ability2':   { s: 'icon', kind: 'util', note: 'テレポートの音は42.5m先まで聞こえる。テザーの位置へテレポート', move: { type: 'tp', max: null } },
  'Yoru|Ultimate':   { s: 'icon', kind: 'util', move: { type: 'run', max: null } },
  'Neon|Ability2':   { s: 'icon', kind: 'util', move: { type: 'run', max: null } },
  'Neon|Ability1':   { s: 'circle', r: 5, kind: 'cc', conf: 'game', color: '#5cb8ff' },
  'Neon|Grenade':    { s: 'dwall', front: 45, back: 1.5, gap: 3.5, kind: 'wall', conf: 'game', color: '#4aa3ff' },
  'Neon|Ultimate':   { s: 'icon', kind: 'damage' },
  'Iso|Ability1':    { s: 'capsule', len: 34.875, r: 3, kind: 'cc', conf: 'game' },
  'Iso|Ultimate':    { s: 'rect', len: 36, w: 15, off: 0, kind: 'cc', conf: 'game' },
  'Iso|Ability2':    { s: 'icon', kind: 'util' },
  'Iso|Grenade':     { s: 'rect', len: 27.5, w: 8, off: 5, kind: 'wall', conf: 'est', note: '進む距離27.5mは確認済み、壁の幅は推定' },
  'Waylay|Ability2': { s: 'icon', kind: 'util', move: { type: 'tp', max: null }, note: '置いたビーコンへ戻る（矢印の先＝ビーコン）' },
  'Waylay|Grenade':  { s: 'circle', r: 6, kind: 'cc', conf: 'game' },
  'Waylay|Ability1': { s: 'icon', kind: 'util', move: { type: 'dash', max: 18, conf: 'wiki' }, note: '1回9m（未確認）のダッシュを2回' },
  'Waylay|Ultimate': { s: 'rect', len: 36, w: 13.5, off: 3, kind: 'cc', conf: 'game' },
  'Hush|Ability1':   { s: 'icon', kind: 'util', conf: 'none' },
  'Hush|Ability2':   { s: 'circle', r: 5, kind: 'cc', conf: 'none', var: [1, 15], note: '公式の数値なし（新キャラ）。大きさを自分で合わせてください' },
  'Hush|Grenade':    { s: 'icon', kind: 'util', conf: 'none', move: { type: 'dash', max: null, conf: 'none' }, note: '動き方の公式の数値なし（新キャラ）' },
  'Hush|Ultimate':   { s: 'circle', r: 6, kind: 'cc', conf: 'none', var: [1, 20], note: '公式の数値なし（新キャラ）。大きさを自分で合わせてください' },
  // ---------- コントローラー ----------
  'Omen|Ability1':   { s: 'capsule', len: 25, r: 4.3, kind: 'cc', conf: 'game', color: '#4a3a80' },
  'Omen|Ability2':   { s: 'circle', r: 4.1, kind: 'smoke', conf: 'game', color: '#5b3f9e' },
  'Omen|Grenade':    { s: 'icon', kind: 'util', move: { type: 'tp', max: 15 }, conf: 'game' },
  'Omen|Ultimate':   { s: 'icon', kind: 'util', move: { type: 'tp', max: null }, note: 'マップのどこへでもテレポート' },
  'Brimstone|Grenade':  { s: 'circle', r: 6, kind: 'heal', conf: 'game', color: '#ffb347' },
  'Brimstone|Ability1': { s: 'circle', r: 4.5, kind: 'damage', conf: 'game', color: '#ff6a2a' },
  'Brimstone|Ability2': { s: 'circle', r: 4.15, kind: 'smoke', conf: 'game', note: '本人から55mまで', color: '#6f7d8f' },
  'Brimstone|Ultimate': { s: 'circle', r: 9, kind: 'damage', conf: 'game', color: '#ff4b2b' },
  'Viper|Ability1':  { s: 'circle', r: 4.5, kind: 'smoke', conf: 'wiki', color: '#3faa4a' },
  'Viper|Ability2':  { s: 'wall', len: 60, w: 1, var: [2, 60], kind: 'smoke', conf: 'wiki', note: '最大60m（2mごとの発生器）', color: '#3faa4a' },
  'Viper|Grenade':   { s: 'circle', r: 4.5, kind: 'damage', conf: 'game', color: '#7ee03a' },
  'Viper|Ultimate':  { s: 'circle', r: 9, kind: 'smoke', conf: 'wiki', note: '最大半径9m（未確認）', color: '#3faa4a' },
  'Astra|Ability1':  { s: 'circle', r: 4.75, kind: 'cc', conf: 'game', color: '#b07cff' },
  'Astra|Ability2':  { s: 'circle', r: 4.75, kind: 'smoke', conf: 'game', color: '#8d4fd6' },
  'Astra|Grenade':   { s: 'circle', r: 4.75, kind: 'cc', conf: 'game', color: '#6a3fd1' },
  'Astra|Ultimate':  { s: 'mapline', kind: 'wall', note: 'マップを横切る壁', color: '#9b6bff' },
  'Harbor|Ability1': { s: 'wall', len: 60, w: 1, var: [5, 60], kind: 'wall', conf: 'game', note: '最大60m（曲げられる。ここでは直線）', color: '#3fb4e6' },
  'Harbor|Grenade':  { s: 'circle', r: 6, kind: 'cc', conf: 'game', color: '#2a86c9' },
  'Harbor|Ability2': { s: 'circle', r: 4.6, kind: 'smoke', conf: 'game', color: '#2e9bd6' },
  'Harbor|Ultimate': { s: 'rect', len: 34, w: 21, off: 8, kind: 'cc', conf: 'wiki', note: '幅21m・進む距離34m（未確認）', color: '#2f7fd0' },
  'Clove|Grenade':   { s: 'icon', kind: 'heal' },
  'Clove|Ability2':  { s: 'circle', r: 4, kind: 'smoke', conf: 'game', note: '生存時60m・死亡時42.5mまで', color: '#c757c9' },
  'Clove|Ultimate':  { s: 'icon', kind: 'util' },
  'Clove|Ability1':  { s: 'circle', r: 4, kind: 'cc', conf: 'game', color: '#e07ad8' },
  'Miks|Grenade':    { s: 'circle', r: 5.5, kind: 'cc', conf: 'game' },
  'Miks|Ability2':   { s: 'circle', r: 4.72, kind: 'smoke', conf: 'wiki' },
  'Miks|Ability1':   { s: 'icon', kind: 'heal' },
  'Miks|Ultimate':   { s: 'cone', r: 40, angle: 60, kind: 'cc', conf: 'game' },
  // ---------- センチネル ----------
  'Sage|Ability1':   { s: 'circle', r: 3.5, kind: 'cc', conf: 'est', note: '公式の数値なし。直径約7m（プレイヤーの実測）', color: '#6fd6c9' },
  'Sage|Ability2':   { s: 'icon', kind: 'heal' },
  'Sage|Grenade':    { s: 'wall', len: 10.4, w: 1.5, kind: 'wall', conf: 'game', note: '2.6m×4区画', color: '#9fe3f0' },
  'Sage|Ultimate':   { s: 'icon', kind: 'heal' },
  'Killjoy|Grenade': { s: 'circle', r: 4.5, kind: 'damage', conf: 'wiki', note: '探知 半径5.25m', ring: [{ r: 40, label: '有効範囲（離れると停止）' }], color: '#f2c230' },
  'Killjoy|Ability1':{ s: 'icon', kind: 'info', ring: [{ r: 40, label: '有効範囲（離れると停止）' }], conf: 'game' },
  'Killjoy|Ability2':{ s: 'cone', r: 20, angle: 100, kind: 'info', conf: 'est', note: '角度100°は確認済み、見える距離は目安', ring: [{ r: 40, label: '有効範囲（離れると停止）' }] },
  'Killjoy|Ultimate':{ s: 'circle', r: 32.5, kind: 'cc', conf: 'game', color: '#f2c230' },
  'Cypher|Ability1': { s: 'circle', r: 3.72, kind: 'smoke', conf: 'game', color: '#e6e6e6' },
  'Cypher|Ability2': { s: 'view', len: 25, angle: 60, var: [3, 80], kind: 'info', conf: 'est', note: '扇＝カメラに映る範囲。先の白い丸を動かして向きと長さを変える（画角は公式の数値が無いので、ミニマップに出る扇から約60°。広さは下で変えられます）' },
  'Cypher|Grenade':  { s: 'wall', len: 15, w: 0.4, var: [1, 15], kind: 'info', conf: 'game', note: 'ワイヤーは最大15m', color: '#cfd8ff' },
  'Cypher|Ultimate': { s: 'icon', kind: 'info' },
  'Chamber|Ability2':{ s: 'icon', kind: 'util', move: { type: 'tp', max: 18 }, note: 'アンカーから18m以内にいればアンカーへテレポート（矢印の先＝アンカー）', conf: 'game' },
  'Chamber|Grenade': { s: 'circle', r: 6, kind: 'cc', conf: 'game', note: '探知 半径10m', ring: [{ r: 10, label: '探知' }, { r: 50, label: '有効範囲' }] },
  'Chamber|Ability1':{ s: 'icon', kind: 'damage' },
  'Chamber|Ultimate':{ s: 'icon', kind: 'damage', note: 'キルした所に半径6mのスロウ' },
  'Deadlock|Ability1': { s: 'rect', len: 9, w: 8, off: 0, kind: 'info', conf: 'game', note: '置いた点の前方 9m×8m を探知' },
  'Deadlock|Grenade':  { s: 'cross', arm: 5, w: 1, kind: 'wall', conf: 'est', note: '「バリアの長さ10m」をもとに中心から5mずつの十字にしています（目安）' },
  'Deadlock|Ability2': { s: 'circle', r: 6.5, kind: 'cc', conf: 'game' },
  'Deadlock|Ultimate': { s: 'capsule', len: 40, r: 3, end: 6.5, kind: 'cc', conf: 'wiki', note: '最大40m進む（確認済み）。途中の半径3mは未確認、終点の半径6.5mは確認済み' },
  'Vyse|Ability1':   { s: 'wall', len: 12, w: 1, var: [1, 12], kind: 'wall', conf: 'game' },
  'Vyse|Ability2':   { s: 'icon', kind: 'util' },
  'Vyse|Grenade':    { s: 'circle', r: 6.25, kind: 'damage', conf: 'game' },
  'Vyse|Ultimate':   { s: 'circle', r: 28, kind: 'cc', conf: 'game' },
  'Veto|Ability2':   { s: 'circle', r: 18, kind: 'util', conf: 'game' },
  'Veto|Grenade':    { s: 'icon', kind: 'util', move: { type: 'tp', max: 30 }, note: 'ボルテックスから30m以内でテレポート（矢印の先＝ボルテックス）', conf: 'game' },
  'Veto|Ultimate':   { s: 'icon', kind: 'util' },
  'Veto|Ability1':   { s: 'circle', r: 6.58, kind: 'cc', conf: 'game' }
};

// 色は board-render.js の abilityStyle（実際の色 color か、キャラの色）で決める

window.ABILITY_CONF_LABEL = {
  game: '実寸（ゲームデータで確認済み）',
  wiki: '実寸（wikiの数値・未確認）',
  est: '目安（公式の数値なし・推定）',
  none: '不明（公式の数値なし）'
};
