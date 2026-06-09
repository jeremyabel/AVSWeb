import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uText;
uniform int uBlend;
out vec4 fragColor;

void main() {
  vec4 base = texture(uInput, vUv);
  vec4 txt  = texture(uText, vUv);

  vec3 blended;
  if (uBlend == 1) {
    blended = clamp(base.rgb + txt.rgb, 0.0, 1.0);
  } else if (uBlend == 2) {
    blended = 0.5 * base.rgb + 0.5 * txt.rgb;
  } else {
    blended = txt.rgb;
  }

  fragColor = vec4(mix(base.rgb, blended, txt.a), 1.0);
}`;

const HALIGN_OPTIONS = [
  { value: 0, label: 'Left'   },
  { value: 1, label: 'Center' },
  { value: 2, label: 'Right'  },
];
const VALIGN_OPTIONS = [
  { value: 0, label: 'Top'    },
  { value: 1, label: 'Middle' },
  { value: 2, label: 'Bottom' },
];
const BLEND_OPTIONS = [
  { value: 0, label: 'Replace'  },
  { value: 1, label: 'Additive' },
  { value: 2, label: '50/50'    },
];

export class TextEffect extends Effect {
  constructor(gl) {
    super(gl);

    this.text         = 'Hello;World';
    this.color        = [255, 255, 255];
    this.outlineColor = [0, 0, 0];
    this.outline       = false;
    this.legacyOutline = false;
    this.shadow        = false;
    this.outlineSize   = 2;
    this.fontFamily   = 'Arial';
    this.fontSize     = 32;
    this.bold         = false;
    this.italic       = false;
    this.halign       = 1;   // 0=left, 1=center, 2=right
    this.valign       = 1;   // 0=top,  1=middle, 2=bottom
    this.xshift       = 0;   // 0-100%
    this.yshift       = 0;   // 0-100%
    this.randomPos    = false;
    this.blendMode    = 0;   // 0=replace, 1=additive, 2=50/50
    this.onbeat       = false;
    this.normSpeed    = 15;
    this.onbeatSpeed  = 15;
    this.insertBlank  = false;
    this.randomWord   = false;

    // Effective (may differ from stored when randomPos active)
    this._effHAlign = 1;
    this._effVAlign = 1;
    this._effXShift = 0;
    this._effYShift = 0;

    // Word cycling counters
    this._nf      = 0;
    this._nb      = 0;
    this._curword = 0;
    this._oddeven = 0;

    // Canvas redraw state
    this._lastText = null;
    this._dirty    = true;

    this._canvas = document.createElement('canvas');
    this._ctx    = this._canvas.getContext('2d');
    this._tex    = null;

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uText  = gl.getUniformLocation(this._prog, 'uText');
    this._uBlend = gl.getUniformLocation(this._prog, 'uBlend');
  }

  _fontString() {
    return `${this.italic ? 'italic' : 'normal'} ${this.bold ? 'bold' : 'normal'} ${this.fontSize}px "${this.fontFamily}"`;
  }

  _css(rgb) {
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  _loadFont() {
    const family = this.fontFamily;
    if (!family) return;
    const systemFonts = new Set(['Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana',
      'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'sans-serif', 'serif', 'monospace']);
    if (systemFonts.has(family)) return;
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=swap`;
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
    }
    document.fonts.load(this._fontString()).then(() => { this._dirty = true; });
  }

  _redrawCanvas(w, h, displayText) {
    const c   = this._canvas;
    const ctx = this._ctx;
    if (c.width !== w)  c.width  = w;
    if (c.height !== h) c.height = h;
    ctx.clearRect(0, 0, w, h);
    if (!displayText) return;

    const os = this.outlineSize;
    const dx = this._effXShift * w / 100;
    const dy = this._effYShift * h / 100;

    let ax;
    if      (this._effHAlign === 0) ax = dx;
    else if (this._effHAlign === 1) ax = w / 2 + dx;
    else                             ax = w + dx;

    let ay;
    if      (this._effVAlign === 0) ay = dy;
    else if (this._effVAlign === 1) ay = h / 2 + dy;
    else                             ay = h + dy;

    ctx.font         = this._fontString();
    ctx.textAlign    = ['left', 'center', 'right'][this._effHAlign];
    ctx.textBaseline = ['top',  'middle', 'bottom'][this._effVAlign];

    if (this.outline) {
      if (this.legacyOutline) {
        ctx.fillStyle = this._css(this.outlineColor);
        for (const [ddx, ddy] of [[-1,-1],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0]]) {
          ctx.fillText(displayText, ax + ddx * os, ay + ddy * os);
        }
      } else {
        ctx.strokeStyle = this._css(this.outlineColor);
        ctx.lineWidth   = os * 2;
        ctx.lineJoin    = 'round';
        ctx.strokeText(displayText, ax, ay);
      }
    } else if (this.shadow) {
      ctx.fillStyle = this._css(this.outlineColor);
      ctx.fillText(displayText, ax + os, ay + os);
    }

    ctx.fillStyle = this._css(this.color);
    ctx.fillText(displayText, ax, ay);
  }

  _uploadTexture(gl) {
    if (!this._tex) {
      this._tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    const words    = this.text ? this.text.split(';') : [''];
    const numWords = words.length;

    // Determine if we should advance to next word this frame
    const shouldAdvance = (!this.onbeat && this._nf >= this.normSpeed)
                       || (this.onbeat && isBeat && this._nb === 0);

    if (shouldAdvance) {
      // insertBlank suppresses word change on even oddeven cycles
      if (!(this.insertBlank && this._oddeven % 2 === 0)) {
        this._curword = this.randomWord
          ? Math.floor(Math.random() * numWords)
          : (this._curword + 1) % numWords;
      }
      this._oddeven = (this._oddeven + 1) % 2;
    }

    // Start on-beat display window
    if (this.onbeat && isBeat && this._nb === 0) {
      this._nb = this.onbeatSpeed;
    }

    if (shouldAdvance) {
      this._nf = 0;
      if (this.randomPos) {
        this._effHAlign = 0;
        this._effVAlign = 0;
        this._ctx.font = this._fontString();
        const tw = this._ctx.measureText(words[this._curword] ?? '').width;
        const th = this.fontSize;
        this._effXShift = tw < w ? Math.random() * ((w - tw) / w * 100) : 0;
        this._effYShift = th < h ? Math.random() * ((h - th) / h * 100) : 0;
      } else {
        this._effHAlign = this.halign;
        this._effVAlign = this.valign;
        this._effXShift = this.xshift;
        this._effYShift = this.yshift;
      }
      this._dirty = true;
    }

    // Empty string when insertBlank is active on even cycles
    const displayText = (this.insertBlank && this._oddeven === 0)
      ? '' : (words[this._curword] ?? '');

    // Visibility: hidden when onbeat mode is on but no active beat window
    const visible = !(this.onbeat && this._nb === 0);

    if (!this.onbeat) this._nf++;
    if (this.onbeat && this._nb > 0) this._nb--;

    if (!visible) return;

    // Redraw canvas if text, position, or size changed
    if (this._dirty
     || displayText !== this._lastText
     || this._canvas.width  !== w
     || this._canvas.height !== h) {
      this._dirty    = false;
      this._lastText = displayText;
      this._redrawCanvas(w, h, displayText);
      this._uploadTexture(gl);
    }

    if (!this._tex) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.uniform1i(this._uText, 1);

    gl.uniform1i(this._uBlend, this.blendMode);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    fboManager.swap();
  }

  getConfig() {
    return {
      text:         this.text,
      color:        this.color,
      outlineColor: this.outlineColor,
      outline:       this.outline,
      legacyOutline: this.legacyOutline,
      shadow:        this.shadow,
      outlineSize:  this.outlineSize,
      fontFamily:   this.fontFamily,
      fontSize:     this.fontSize,
      bold:         this.bold,
      italic:       this.italic,
      halign:       this.halign,
      valign:       this.valign,
      xshift:       this.xshift,
      yshift:       this.yshift,
      randomPos:    this.randomPos,
      blendMode:    this.blendMode,
      onbeat:       this.onbeat,
      normSpeed:    this.normSpeed,
      onbeatSpeed:  this.onbeatSpeed,
      insertBlank:  this.insertBlank,
      randomWord:   this.randomWord,
    };
  }

  setConfig(cfg) {
    let needsRedraw = false;

    if (cfg.text         !== undefined && cfg.text !== this.text) { this.text = cfg.text; needsRedraw = true; }
    if (cfg.color        !== undefined) { this.color        = cfg.color;        needsRedraw = true; }
    if (cfg.outlineColor !== undefined) { this.outlineColor = cfg.outlineColor; needsRedraw = true; }
    if (cfg.outline       !== undefined) { this.outline       = cfg.outline;       needsRedraw = true; }
    if (cfg.legacyOutline !== undefined) { this.legacyOutline = cfg.legacyOutline; needsRedraw = true; }
    if (cfg.shadow        !== undefined) { this.shadow        = cfg.shadow;        needsRedraw = true; }
    if (cfg.outlineSize  !== undefined) { this.outlineSize  = cfg.outlineSize;  needsRedraw = true; }
    if (cfg.fontSize     !== undefined) { this.fontSize     = cfg.fontSize;     needsRedraw = true; }
    if (cfg.bold         !== undefined) { this.bold         = cfg.bold;         needsRedraw = true; }
    if (cfg.italic       !== undefined) { this.italic       = cfg.italic;       needsRedraw = true; }
    if (cfg.fontFamily !== undefined && cfg.fontFamily !== this.fontFamily) {
      this.fontFamily = cfg.fontFamily;
      this._loadFont();
      needsRedraw = true;
    }
    if (cfg.halign !== undefined) {
      this.halign = cfg.halign;
      if (!this.randomPos) { this._effHAlign = cfg.halign; needsRedraw = true; }
    }
    if (cfg.valign !== undefined) {
      this.valign = cfg.valign;
      if (!this.randomPos) { this._effVAlign = cfg.valign; needsRedraw = true; }
    }
    if (cfg.xshift !== undefined) {
      this.xshift = cfg.xshift;
      if (!this.randomPos) { this._effXShift = cfg.xshift; needsRedraw = true; }
    }
    if (cfg.yshift !== undefined) {
      this.yshift = cfg.yshift;
      if (!this.randomPos) { this._effYShift = cfg.yshift; needsRedraw = true; }
    }
    if (cfg.randomPos !== undefined) {
      this.randomPos = cfg.randomPos;
      if (!cfg.randomPos) {
        this._effHAlign = this.halign;
        this._effVAlign = this.valign;
        this._effXShift = this.xshift;
        this._effYShift = this.yshift;
        needsRedraw = true;
      }
    }
    if (cfg.blendMode   !== undefined) this.blendMode   = cfg.blendMode;
    if (cfg.onbeat      !== undefined) this.onbeat      = cfg.onbeat;
    if (cfg.normSpeed   !== undefined) this.normSpeed   = Math.max(1, Math.min(256, cfg.normSpeed));
    if (cfg.onbeatSpeed !== undefined) this.onbeatSpeed = Math.max(1, Math.min(256, cfg.onbeatSpeed));
    if (cfg.insertBlank !== undefined) this.insertBlank = cfg.insertBlank;
    if (cfg.randomWord  !== undefined) this.randomWord  = cfg.randomWord;

    if (needsRedraw) this._dirty = true;
  }

  getDescriptor() {
    return {
      name: 'Text',
      params: [
        { name: 'text',         label: 'Text (;-separated)',   type: 'text',        default: 'Hello;World' },
        { name: 'fontFamily',   label: 'Font',                 type: 'font-select', default: 'Arial'       },
        { name: 'fontSize',     label: 'Font Size',            type: 'range',   min: 8,  max: 200, step: 1, default: 32  },
        { name: 'bold',         label: 'Bold',                 type: 'bool',    default: false },
        { name: 'italic',       label: 'Italic',               type: 'bool',    default: false },
        { name: 'color',        label: 'Color',                type: 'color',   default: [255,255,255] },
        { name: 'outlineColor', label: 'Outline/Shadow Color', type: 'color',   default: [0,0,0]       },
        { name: 'outline',       label: 'Outline',              type: 'bool',    default: false },
        { name: 'legacyOutline', label: 'Legacy Outline',       type: 'bool',    default: false,
          visibleWhen: { param: 'outline', value: true } },
        { name: 'shadow',        label: 'Shadow',               type: 'bool',    default: false },
        { name: 'outlineSize',  label: 'Outline/Shadow Size',  type: 'range',   min: 1, max: 16, step: 1, default: 2 },
        { name: 'blendMode',    label: 'Blend Mode',           type: 'select',  options: BLEND_OPTIONS,  default: 0 },
        { name: 'halign',       label: 'Horizontal Align',     type: 'select',  options: HALIGN_OPTIONS, default: 1 },
        { name: 'valign',       label: 'Vertical Align',       type: 'select',  options: VALIGN_OPTIONS, default: 1 },
        { name: 'xshift',       label: 'X Shift (%)',          type: 'range',   min: 0, max: 100, step: 1, default: 0 },
        { name: 'yshift',       label: 'Y Shift (%)',          type: 'range',   min: 0, max: 100, step: 1, default: 0 },
        { name: 'randomPos',    label: 'Random Position',      type: 'bool',    default: false },
        { name: 'onbeat',       label: 'On Beat',              type: 'bool',    default: false },
        { name: 'normSpeed',    label: 'Frames Per Word',      type: 'range',   min: 1, max: 256, step: 1, default: 15,
          disabledWhen: { param: 'onbeat', value: true  } },
        { name: 'onbeatSpeed',  label: 'Visible Frames',       type: 'range',   min: 1, max: 256, step: 1, default: 15,
          disabledWhen: { param: 'onbeat', value: false } },
        { name: 'insertBlank',  label: 'Insert Blank',         type: 'bool',    default: false },
        { name: 'randomWord',   label: 'Random Word',          type: 'bool',    default: false },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
