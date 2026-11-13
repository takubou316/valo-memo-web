'use strict';
// valorant-api.com のマップ・キャラの情報を、アプリで使う形に整える（アプリ本体とブラウザ版で共通）
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameData = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function shapeGameData(maps, agents, agentsEn, version) {
    const enName = {};
    for (const a of agentsEn || []) enName[a.uuid.toLowerCase()] = a.displayName;
    return {
      version,
      fetchedAt: Date.now(),
      maps: maps.filter(m => m.tacticalDescription && m.displayIcon && Number.isFinite(m.xMultiplier)).map(m => {
        const map = {
          uuid: m.uuid, name: m.displayName, mapUrl: m.mapUrl, sites: m.tacticalDescription,
          minimap: m.displayIcon, thumb: m.listViewIcon, splash: m.splash,
          // ゲーム内座標 → ミニマップ（0〜1）の変換係数。1m = 100単位
          xMul: m.xMultiplier, yMul: m.yMultiplier, xAdd: m.xScalarToAdd, yAdd: m.yScalarToAdd
        };
        map.callouts = (m.callouts || []).map(c => ({
          name: [c.superRegionName, c.regionName].filter(Boolean).join(' '),
          x: (c.location.y * m.xMultiplier + m.xScalarToAdd) * 1000,
          y: (c.location.x * m.yMultiplier + m.yScalarToAdd) * 1000
        }));
        return map;
      }),
      agents: agents.filter(a => a.isPlayableCharacter).map(a => ({
        uuid: a.uuid.toLowerCase(), name: a.displayName, dev: a.developerName, en: enName[a.uuid.toLowerCase()] || a.displayName,
        icon: a.displayIcon, role: a.role ? a.role.displayName : '', roleId: a.role ? a.role.uuid.toLowerCase() : '', roleIcon: a.role ? a.role.displayIcon : '',
        grad: Array.isArray(a.backgroundGradientColors) ? a.backgroundGradientColors : [], // キャラの色（ボードのスキルの色に使う）
        abilities: (a.abilities || []).filter(x => x.slot !== 'Passive').map(x => ({ slot: x.slot, name: x.displayName, icon: x.displayIcon }))
      }))
    };
  }
  return { shapeGameData };
});
