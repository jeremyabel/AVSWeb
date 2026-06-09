// Base class for all AVS effects.
// Subclasses must implement: render(ctx), getConfig(), setConfig(cfg), getDescriptor()
// ctx = { gl, visdata, isBeat, fboManager, w, h, frame }
export class Effect {
  constructor(gl) {
    this.gl = gl;
  }

  // Called each frame. Must read from ctx.fboManager.getCurrent().texture
  // and write to ctx.fboManager.getNext().fbo, then call ctx.fboManager.swap().
  // If the effect only composites (doesn't need the previous frame), it can
  // skip reading the input and just draw on top via the engine's composite pass.
  render(_ctx) {}

  getConfig() { return {}; }
  setConfig(_cfg) {}

  // Returns { name: string, params: Array<ParamDescriptor> }
  // ParamDescriptor: { name, label, type: 'range'|'color'|'select'|'bool'|'glsl', ...type-specific }
  getDescriptor() { return { name: 'Unknown', params: [] }; }

  destroy() {}
}

// Compile a WebGL shader. Throws on error.
export function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const err = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(err);
  }
  return shader;
}

// Link a program from a vertex and fragment shader source.
export function createProgram(gl, vertSrc, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const err = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(err);
  }
  return prog;
}

// Empty VAO for attribute-free draws (e.g. gl_VertexID-based point scatter).
const emptyVAOs = new WeakMap();

export function getEmptyVAO(gl) {
  if (emptyVAOs.has(gl)) return emptyVAOs.get(gl);
  const vao = gl.createVertexArray();
  emptyVAOs.set(gl, vao);
  return vao;
}

// Shared fullscreen quad VAO (lazy-created per GL context via WeakMap).
const quadVAOs = new WeakMap();

export function getQuadVAO(gl) {
  if (quadVAOs.has(gl)) return quadVAOs.get(gl);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // Two triangles covering [-1,1]^2
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1, 1,-1, -1,1,
    -1, 1, 1,-1,  1,1,
  ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  quadVAOs.set(gl, vao);
  return vao;
}
