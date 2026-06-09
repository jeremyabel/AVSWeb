const NBUF = 8;

function createFBO(gl, w, h) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return { fbo, texture, w, h };
}

export class FBOManager {
  constructor(gl, w, h) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this._current = 0;

    this.pingPong = [createFBO(gl, w, h), createFBO(gl, w, h)];
    this.scratch = Array.from({ length: NBUF }, () => createFBO(gl, w, h));

    // Clear all FBOs to black
    this._clearAll();
  }

  _clearAll() {
    const gl = this.gl;
    for (const buf of [...this.pingPong, ...this.scratch]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buf.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  getCurrent() { return this.pingPong[this._current]; }
  getNext() { return this.pingPong[1 - this._current]; }

  swap() { this._current = 1 - this._current; }

  getScratch(idx) { return this.scratch[idx % NBUF]; }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    const gl = this.gl;
    for (const buf of [...this.pingPong, ...this.scratch]) {
      buf.w = w; buf.h = h;
      gl.bindTexture(gl.TEXTURE_2D, buf.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._clearAll();
  }

  destroy() {
    const gl = this.gl;
    for (const buf of [...this.pingPong, ...this.scratch]) {
      gl.deleteTexture(buf.texture);
      gl.deleteFramebuffer(buf.fbo);
    }
  }
}
