export const BlendMode = Object.freeze({
  REPLACE:    0,
  ADDITIVE:   1,
  MAX:        2,
  AVERAGE:    3,
  SUB:        4,
  REV_SUB:    5,
  INTERLACE_Y:6,
  INTERLACE_X:7,
  XOR:        8,
  ADJUSTABLE: 9,
  MULTIPLY:   10,
  MINIMUM:    11,
});

export const BlendModeNames = [
  'Replace', 'Additive', 'Maximum', 'Average',
  'Subtract', 'Rev Subtract', 'Interlace Y', 'Interlace X',
  'XOR', 'Adjustable', 'Multiply', 'Minimum',
];

// GLSL source for blend operations used in composite passes.
// Each function takes src (effect output) and dst (main buffer) and returns blended color.
export const BLEND_GLSL = /* glsl */`
vec3 blendReplace(vec3 src, vec3 dst) { return src; }
vec3 blendAdditive(vec3 src, vec3 dst) { return min(src + dst, vec3(1.0)); }
vec3 blendMaximum(vec3 src, vec3 dst) { return max(src, dst); }
vec3 blendAverage(vec3 src, vec3 dst) { return (src + dst) * 0.5; }
vec3 blendSub(vec3 src, vec3 dst) { return max(dst - src, vec3(0.0)); }
vec3 blendRevSub(vec3 src, vec3 dst) { return max(src - dst, vec3(0.0)); }
vec3 blendXor(vec3 src, vec3 dst) {
  uvec3 a = uvec3(src * 255.0); uvec3 b = uvec3(dst * 255.0);
  return vec3(a ^ b) / 255.0;
}
vec3 blendAdjustable(vec3 src, vec3 dst, float alpha) { return mix(dst, src, alpha); }
vec3 blendMultiply(vec3 src, vec3 dst) { return src * dst; }
vec3 blendMinimum(vec3 src, vec3 dst) { return min(src, dst); }

vec3 applyBlend(int mode, vec3 src, vec3 dst, float alpha, ivec2 coord) {
  if (mode == 0) return blendReplace(src, dst);
  if (mode == 1) return blendAdditive(src, dst);
  if (mode == 2) return blendMaximum(src, dst);
  if (mode == 3) return blendAverage(src, dst);
  if (mode == 4) return blendSub(src, dst);
  if (mode == 5) return blendRevSub(src, dst);
  if (mode == 6) return ((coord.y & 1) == 0) ? src : dst;
  if (mode == 7) return ((coord.x & 1) == 0) ? src : dst;
  if (mode == 8) return blendXor(src, dst);
  if (mode == 9) return blendAdjustable(src, dst, alpha);
  if (mode == 10) return blendMultiply(src, dst);
  if (mode == 11) return blendMinimum(src, dst);
  return src;
}
`;
