import { EffectEntry } from './effect-chain.js';
import { EffectRegistry } from './registry.js';

export const Preset = {
  toJSON(chain) {
    return {
      version: '1.0',
      effects: chain.entries.map(e => ({
        type: e.effect.getDescriptor().name,
        enabled: e.enabled,
        config: e.effect.getConfig(),
      })),
    };
  },

  fromJSON(gl, chain, json) {
    for (const e of chain.entries) e.effect.destroy();
    chain.entries = [];

    if (!json || !Array.isArray(json.effects)) return;

    for (const item of json.effects) {
      const EffectClass = EffectRegistry.get(item.type);
      if (!EffectClass) { console.warn(`Unknown effect type: ${item.type}`); continue; }
      const effect = new EffectClass(gl);
      if (item.config) effect.setConfig(item.config);
      const entry = new EffectEntry(effect);
      entry.enabled = item.enabled !== false;
      chain.add(entry);
    }
  },

  download(chain, filename = 'preset.json') {
    const json = Preset.toJSON(chain);
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  },
};
