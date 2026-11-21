// Semantic appearance configuration (VRoid Studio-style): which materials
// belong to skin / hair / eyes / brows, and the VRoid eye-adjust bones the
// face sliders drive. Material names follow VRoid conventions
// (*_SKIN, *HAIR*, *EYE*, bare "Face"/"Body") — the patterns match loosely so
// both VRoid exports and plain samples group correctly.

export interface ColorGroup {
  key: string;
  label: string;
  pattern: RegExp;
}

/** Materials whose base color the group tints. "Eyes" matches only the iris —
 *  whites and highlights must stay white for the eyes to read as eyes. */
export const COLOR_GROUPS: ColorGroup[] = [
  { key: 'skin', label: 'Skin', pattern: /skin|^(face|body)( \(instance\))?$/i },
  { key: 'hair', label: 'Hair', pattern: /hair/i },
  { key: 'eyes', label: 'Eyes', pattern: /iris/i },
  { key: 'brows', label: 'Brows', pattern: /brow/i },
];

/** The semantic group a material name belongs to (null = ungrouped). */
export function materialGroup(name: string): string | null {
  for (const g of COLOR_GROUPS) {
    if (g.pattern.test(name)) return g.key;
  }
  return null;
}

/** VRoid eye-adjust bones: scaling/offsetting them reshapes the eye region
 *  (the eye meshes are weighted to them on VRoid-exported models). */
export const EYE_ADJ_BONES = ['J_Adj_L_FaceEye', 'J_Adj_R_FaceEye'];

export const SKIN_SWATCHES = ['#ffe3d3', '#f7d2b2', '#eec096', '#d9a26f', '#b97c4e', '#8a5a3b', '#5c3a25'];
export const HAIR_SWATCHES = ['#1c1c22', '#4a2c17', '#8a5a2b', '#c98a3d', '#e6c88a', '#b0b6bd', '#d94f4f', '#6a7bd9', '#8a4fd9', '#d94f9e'];
export const EYE_SWATCHES = ['#3a2a1a', '#2a4a8a', '#2a6a4a', '#6a4a2a', '#8a2a2a', '#4a2a6a', '#5a6a7a', '#c9a53d'];
export const BROW_SWATCHES = ['#1c1c22', '#3a2a1a', '#5a3a22', '#8a6a4a', '#b0b6bd', '#6a4a2a'];
