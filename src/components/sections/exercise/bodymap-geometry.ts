// Hand-authored anatomical figure geometry for the BodyMap, kept separate from
// the component so a preview harness can import the exact same path data.
//
// One neutral silhouette (a fuller ~8-head fit-adult figure on the 200×540
// viewbox: squared shoulders ~116 wide, waist ~68, hips ~86, thighs meaningfully
// thicker than the shins, a visible calf bulge, elbows at the waist, hands ending
// mid-thigh, wedge feet) shared by both views, with the muscle groups drawn on it
// as true anatomical bezier shapes. Everything is bezier — no straight-segment
// chains in the outlines (only detail seams are straight strokes). The figure is
// symmetric about the centreline: paired muscles author only the RIGHT half and
// the component draws the mirror; the silhouette and the two central muscles
// (abs, traps) are authored whole here.

export const FIGURE_WIDTH = 200;
export const FIGURE_HEIGHT = 540;

type Pt = [number, number];
interface Seg {
  c1: Pt;
  c2: Pt;
  p: Pt;
}

function mirror(p: Pt): Pt {
  return [FIGURE_WIDTH - p[0], p[1]];
}

// The RIGHT side of the outline, top of the skull clockwise down to the crotch:
// head (y10–74), a thicker neck (to y92), a squared trapezius shelf to the
// shoulder corner (y100, x158), deltoid dropping vertically, down the outer arm
// to the elbow (y200, at the waist), forearm to the wrist (y262), round a simple
// mitt ending mid-thigh (y300), up the inner arm to the armpit (y131), down the
// flank to a fuller waist (y200), out over the hip (y258), down a thick thigh and
// bulging calf to a heel+forefoot wedge foot (y488–517), and up the inner leg to
// the crotch (y260).
const OUTLINE_START: Pt = [100, 12];
const OUTLINE_RIGHT: Seg[] = [
  { c1: [110, 12], c2: [118, 27], p: [118, 43] }, // skull
  { c1: [118, 58], c2: [113, 69], p: [104, 73] }, // to chin (narrower)
  { c1: [106, 77], c2: [110, 83], p: [111, 91] }, // thicker neck
  { c1: [124, 95], c2: [142, 99], p: [156, 102] }, // trapezius shelf, softened corner
  { c1: [163, 106], c2: [164, 117], p: [162, 132] }, // rounded deltoid drop
  { c1: [161, 155], c2: [160, 180], p: [159, 200] }, // outer upper arm to elbow
  { c1: [158, 222], c2: [157, 245], p: [156, 262] }, // outer forearm to wrist
  { c1: [156, 278], c2: [155, 292], p: [151, 300] }, // mitt to fingertips
  { c1: [148, 294], c2: [146, 278], p: [147, 262] }, // up inner hand/wrist
  { c1: [147, 245], c2: [148, 222], p: [149, 200] }, // inner forearm to elbow
  { c1: [150, 180], c2: [151, 150], p: [146, 131] }, // inner upper arm to armpit
  { c1: [151, 150], c2: [150, 175], p: [134, 200] }, // flank to fuller waist
  { c1: [141, 222], c2: [146, 244], p: [147, 258] }, // wider hip flare
  { c1: [147, 296], c2: [143, 340], p: [130, 382] }, // thick outer thigh to knee
  { c1: [132, 400], c2: [137, 422], p: [128, 456] }, // fuller calf bulge
  { c1: [123, 468], c2: [118, 478], p: [114, 484] }, // to outer ankle (shorter shin)
  { c1: [112, 496], c2: [110, 505], p: [108, 510] }, // ankle to heel
  { c1: [112, 516], c2: [122, 517], p: [128, 512] }, // sole to narrower forefoot wedge
  { c1: [123, 505], c2: [116, 498], p: [106, 484] }, // top of foot to inner ankle
  { c1: [103, 456], c2: [108, 422], p: [110, 382] }, // fuller inner calf to inner knee
  { c1: [110, 336], c2: [107, 296], p: [100, 260] }, // fuller inner thigh to crotch
];

function buildOutline(): string {
  let d = `M ${OUTLINE_START[0]} ${OUTLINE_START[1]}`;
  for (const s of OUTLINE_RIGHT) {
    d += ` C ${s.c1[0]} ${s.c1[1]} ${s.c2[0]} ${s.c2[1]} ${s.p[0]} ${s.p[1]}`;
  }
  // Return up the mirrored left side: the right segments reversed, each run
  // backwards (swap and mirror the control points, mirror the previous point).
  const froms: Pt[] = [OUTLINE_START, ...OUTLINE_RIGHT.map(s => s.p)];
  for (let i = OUTLINE_RIGHT.length - 1; i >= 0; i--) {
    const s = OUTLINE_RIGHT[i];
    const c1 = mirror(s.c2);
    const c2 = mirror(s.c1);
    const p = mirror(froms[i]);
    d += ` C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p[0]} ${p[1]}`;
  }
  return d + ' Z';
}

export const SILHOUETTE_PATH = buildOutline();

// Front-view shin hints (tibia + outer shin) so the lower legs don't read hollow.
// Drawn on the silhouette only, front view, as subtle strokes — not a region.
export const FRONT_SHIN_DETAIL =
  'M 119 388 C 121 420 120 450 117 474 M 124 392 C 127 420 126 446 122 468 ' +
  'M 81 388 C 79 420 80 450 83 474 M 76 392 C 73 420 74 446 78 468';

export interface MuscleRegionShape {
  id: string;
  // The filled anatomical outline(s), heat-coloured by the component.
  fill: string;
  // Optional stroke-only overlay (segmentation lines, fibre hints) drawn on top,
  // never filled or interactive.
  detail?: string;
  // Paired muscle: the component also renders the mirror about the centreline.
  // Central muscles (abs, traps) author the whole shape and set this false.
  mirrored: boolean;
}

// FRONT view. Right-half (or central) anatomical outlines. Delt cap wraps the
// shoulder corner and meets the biceps, which meets the forearm at the elbow;
// the hip-flexor meets the quad, which is centred on the front of the thigh.
export const FRONT_REGIONS: MuscleRegionShape[] = [
  {
    id: 'side-delts',
    mirrored: true,
    fill: 'M 148 102 C 158 101 165 111 164 129 C 160 134 153 133 150 126 C 148 117 147 108 148 102 Z',
  },
  {
    id: 'front-delts',
    mirrored: true,
    fill: 'M 135 106 C 143 102 151 107 152 123 C 152 132 147 135 140 133 C 134 124 133 114 135 106 Z',
  },
  {
    id: 'chest',
    mirrored: true,
    // One pec lobe: clavicle start near the sternum, sweep to the armpit tuck,
    // full rounded lower edge back to the midline; a slight notch at the top
    // centre (x103) leaves a V between the two lobes when mirrored.
    fill: 'M 103 116 C 118 112 131 114 141 120 C 147 125 149 133 145 140 C 139 149 124 153 112 152 C 107 151 103 150 100 149 C 100 138 101 126 103 116 Z',
    detail: 'M 104 123 C 118 120 131 124 142 133',
  },
  {
    id: 'biceps',
    mirrored: true,
    // Fuller fusiform mass centred on the upper arm, meeting the delt at the top
    // and overlapping the forearm at the elbow.
    fill: 'M 149 128 C 157 129 162 143 162 164 C 162 184 159 198 154 202 C 149 200 146 186 145 166 C 145 150 145 138 149 128 Z',
  },
  {
    id: 'forearms',
    mirrored: true,
    // Meets the biceps at the elbow and tapers INTO the wrist, never past it.
    fill: 'M 147 196 C 156 198 161 214 160 236 C 159 252 155 261 151 262 C 148 260 146 246 146 224 C 146 212 146 202 147 196 Z',
  },
  {
    id: 'obliques',
    mirrored: true,
    fill: 'M 116 154 C 124 158 129 174 129 196 C 129 214 125 228 118 244 C 115 238 114 216 114 194 C 114 176 114 162 116 154 Z',
  },
  {
    id: 'abs',
    mirrored: false,
    // ~28 wide, ending just past the navel (y250); 6-pack seams as strokes.
    fill: 'M 86 154 C 93 151 107 151 114 154 C 115 180 115 224 112 250 C 107 255 93 255 88 250 C 85 224 85 180 86 154 Z',
    detail: 'M 100 154 L 100 250 M 87 178 L 113 178 M 86 202 L 114 202 M 87 226 L 113 226',
  },
  {
    id: 'hip-flexors',
    mirrored: true,
    fill: 'M 101 253 C 110 255 118 261 122 270 C 117 273 110 271 106 265 C 103 260 101 256 101 253 Z',
  },
  {
    id: 'quads',
    mirrored: true,
    // Centred on the front of the thigh, from below the hip-flexor V down to
    // just above the knee (y381), with the vastus-medialis bulge at the bottom
    // inner edge nearly touching the kneecap line.
    fill: 'M 116 274 C 126 273 133 285 134 313 C 134 343 130 370 124 381 C 120 384 114 380 112 368 C 109 352 109 330 110 308 C 111 291 112 279 116 274 Z',
    detail: 'M 121 300 C 125 338 121 372 117 380',
  },
];

// BACK view.
export const BACK_REGIONS: MuscleRegionShape[] = [
  {
    id: 'traps',
    mirrored: false,
    // Kite with concave curved sides sweeping neck → shoulder (stopping short of
    // the delt caps), then a smooth taper to a higher mid-back point. Sized so it
    // doesn't read as a giant shield at heat 0.
    fill: 'M 100 90 C 115 97 129 101 140 106 C 130 120 116 143 100 160 C 84 143 70 120 60 106 C 71 101 85 97 100 90 Z',
    detail: 'M 100 94 L 100 158',
  },
  {
    id: 'rear-delts',
    mirrored: true,
    fill: 'M 148 102 C 158 101 165 111 164 128 C 160 134 153 133 149 130 C 147 120 147 110 148 102 Z',
  },
  {
    id: 'triceps',
    mirrored: true,
    fill: 'M 149 130 C 157 131 162 144 162 164 C 162 182 159 194 154 200 C 149 197 146 184 145 166 C 145 150 145 138 149 130 Z',
    detail: 'M 152 140 C 150 162 152 184 156 198',
  },
  {
    id: 'upper-back',
    mirrored: true,
    // Rhomboid, now owning more of the space under the smaller traps kite
    // (y160–194), between the lats.
    fill: 'M 100 160 C 112 160 122 168 124 181 C 122 191 112 194 102 192 C 101 182 100 171 100 160 Z',
  },
  {
    id: 'lats',
    mirrored: true,
    // Inner edge kept close to the spine so there's no void beside the erectors.
    fill: 'M 138 138 C 145 150 146 172 144 192 C 141 210 132 222 115 224 C 113 216 113 200 116 184 C 121 162 130 146 138 138 Z',
  },
  {
    id: 'lower-back',
    mirrored: true,
    // One lumbar erector column flanking the spine (x103–112, y206–257); the
    // mirror is the other, leaving a ~6px spine gap between.
    fill: 'M 103 206 C 109 206 112 216 112 232 C 112 248 109 256 104 257 C 102 240 102 222 103 206 Z',
  },
  {
    id: 'glutes',
    mirrored: true,
    // Dropped onto the pelvis, leaving a lumbar gap above; rounded pair meeting
    // at the centre cleft.
    fill: 'M 100 265 C 116 263 133 269 139 287 C 140 305 130 317 114 317 C 106 316 101 310 100 303 C 100 290 100 277 100 265 Z',
    detail: 'M 100 267 L 100 316',
  },
  {
    id: 'hamstrings',
    mirrored: true,
    fill: 'M 120 320 C 131 320 136 334 135 356 C 134 372 129 380 124 382 C 120 378 117 364 117 346 C 117 334 117 326 120 320 Z',
  },
  {
    id: 'calves',
    mirrored: true,
    fill: 'M 120 392 C 132 396 135 415 133 436 C 131 452 124 460 118 460 C 113 452 110 433 111 413 C 112 402 116 396 120 392 Z',
    detail: 'M 120 398 C 117 422 119 448 121 458',
  },
];

// The mirror transform for a paired muscle's second copy (reflect about the
// centreline). Exported so the harness can reproduce the component exactly.
export const MIRROR_TRANSFORM = `matrix(-1 0 0 1 ${FIGURE_WIDTH} 0)`;
