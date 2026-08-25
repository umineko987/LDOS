export const BUILT_IN_SCENES = Object.freeze([
  Object.freeze({ id: "graphite", label: "夜航石墨", description: "右上月光、左下深蓝与中央微金远光。" }),
  Object.freeze({ id: "slate", label: "月岩", description: "右上冷灰蓝与左下墨蓝光井。" }),
  Object.freeze({ id: "deep-ocean", label: "深海", description: "右上海蓝、左下深青与微金远光。" }),
  Object.freeze({ id: "forest", label: "深林", description: "右上柔绿、左下墨绿与中央微金光。" }),
  Object.freeze({ id: "plum-gray", label: "雾褐", description: "右上暖灰、左下深褐与克制冷月光。" }),
  Object.freeze({ id: "warm-paper", label: "暖夜", description: "右上琥珀、左下深棕与克制月光。" }),
] as const);

export type SceneId = typeof BUILT_IN_SCENES[number]["id"];
export const BUILT_IN_SCENE_IDS: readonly SceneId[] = Object.freeze(BUILT_IN_SCENES.map(({ id }) => id));
