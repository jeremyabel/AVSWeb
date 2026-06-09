// Maps effect name strings to their constructor classes.
// No effect imports here — circular-import-free.
const _registry = new Map();

export const EffectRegistry = {
  register(name, cls) { _registry.set(name, cls); },
  get(name) { return _registry.get(name); },
  names() { return [..._registry.keys()]; },
};
