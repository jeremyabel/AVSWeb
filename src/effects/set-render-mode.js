import { Effect } from './effect.js';

// Sets ctx.lineBlendMode for downstream line-drawing effects (Simple, SuperScope, etc.).
// Matches g_line_blend_mode in r_linemode.cpp.
//
// ctx.lineBlendMode packing (same as g_line_blend_mode):
//   bits 16-23: lineWidth  (1-255)
//   bits  8-15: alpha      (0-255, used by Adjustable blend mode)
//   bits  0-7:  blendMode  (0-9)
//
// Blend modes: 0=Replace 1=Add 2=Max 3=50/50 4=Sub1 5=Sub2 6=Mul 7=Adjustable 8=XOR 9=Min

const BLEND_OPTIONS = [
  { value: 0, label: 'Replace'    },
  { value: 1, label: 'Add'        },
  { value: 2, label: 'Max'        },
  { value: 3, label: '50/50'      },
  { value: 4, label: 'Sub 1'      },
  { value: 5, label: 'Sub 2'      },
  { value: 6, label: 'Multiply'   },
  { value: 7, label: 'Adjustable' },
  { value: 8, label: 'XOR'        },
  { value: 9, label: 'Minimum'    },
];

export class SetRenderModeEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.enabled   = true;
    this.blendMode = 0;
    this.lineWidth = 1;
    this.alpha     = 0;
  }

  render(ctx) {
    if (!this.enabled) return;
    ctx.lineBlendMode = (this.lineWidth << 16) | (this.alpha << 8) | this.blendMode;
  }

  getConfig() {
    return {
      enabled:   this.enabled,
      blendMode: this.blendMode,
      lineWidth: this.lineWidth,
      alpha:     this.alpha,
    };
  }

  setConfig(cfg) {
    if (cfg.enabled   !== undefined) this.enabled   = cfg.enabled;
    if (cfg.blendMode !== undefined) this.blendMode = Math.max(0, Math.min(9,   cfg.blendMode));
    if (cfg.lineWidth !== undefined) this.lineWidth = Math.max(1, Math.min(255, cfg.lineWidth));
    if (cfg.alpha     !== undefined) this.alpha     = Math.max(0, Math.min(255, cfg.alpha));
  }

  getDescriptor() {
    return {
      name: 'Set Render Mode',
      params: [
        { name: 'enabled',   label: 'Enable Mod Change', type: 'bool',   default: true },
        { name: 'blendMode', label: 'Blend Mode',        type: 'select', options: BLEND_OPTIONS, default: 0, visibleWhen: { param: 'enabled', value: true } },
        { name: 'lineWidth', label: 'Line Width',  type: 'range',  min: 1, max: 255, step: 1, default: 1 },
        { name: 'alpha',     label: 'Alpha',       type: 'range',  min: 0, max: 255, step: 1, default: 0 },
      ],
    };
  }

  destroy() {}
}
