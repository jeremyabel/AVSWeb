#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;   // effect output
uniform sampler2D uDst;   // current main buffer
uniform int uMode;
uniform float uAlpha;
out vec4 fragColor;

vec3 blendReplace(vec3 s, vec3 d) { return s; }
vec3 blendAdd(vec3 s, vec3 d) { return min(s + d, vec3(1.0)); }
vec3 blendMax(vec3 s, vec3 d) { return max(s, d); }
vec3 blendAvg(vec3 s, vec3 d) { return (s + d) * 0.5; }
vec3 blendSub(vec3 s, vec3 d) { return max(d - s, vec3(0.0)); }
vec3 blendRevSub(vec3 s, vec3 d) { return max(s - d, vec3(0.0)); }
vec3 blendXor(vec3 s, vec3 d) {
  uvec3 a = uvec3(s * 255.0), b = uvec3(d * 255.0);
  return vec3(a ^ b) / 255.0;
}
vec3 blendAdj(vec3 s, vec3 d, float a) { return mix(d, s, a); }
vec3 blendMul(vec3 s, vec3 d) { return s * d; }
vec3 blendMin(vec3 s, vec3 d) { return min(s, d); }

void main() {
  vec3 src = texture(uSrc, vUv).rgb;
  vec3 dst = texture(uDst, vUv).rgb;
  ivec2 coord = ivec2(gl_FragCoord.xy);
  vec3 result;
  if      (uMode ==  0) result = blendReplace(src, dst);
  else if (uMode ==  1) result = blendAdd(src, dst);
  else if (uMode ==  2) result = blendMax(src, dst);
  else if (uMode ==  3) result = blendAvg(src, dst);
  else if (uMode ==  4) result = blendSub(src, dst);
  else if (uMode ==  5) result = blendRevSub(src, dst);
  else if (uMode ==  6) result = ((coord.y & 1) == 0) ? src : dst;
  else if (uMode ==  7) result = ((coord.x & 1) == 0) ? src : dst;
  else if (uMode ==  8) result = blendXor(src, dst);
  else if (uMode ==  9) result = blendAdj(src, dst, uAlpha);
  else if (uMode == 10) result = blendMul(src, dst);
  else if (uMode == 11) result = blendMin(src, dst);
  else result = src;
  fragColor = vec4(result, 1.0);
}
