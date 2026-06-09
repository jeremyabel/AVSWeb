import { Effect } from './effect.js';

// Base class for effects that have Init/Frame/Beat JavaScript code blocks.
// Provides _runJS(), getJsError(), and _jsErrors storage.
// Subclasses must initialise this._jsScope with their effect-specific built-ins.
export class ScriptableEffect extends Effect {
  constructor(gl, effectName) {
    super(gl);
    this._effectName = effectName;
    this._jsErrors   = {};
  }

  // Returns the scope keys used to build Function parameter lists.
  // Override in subclasses to return a cached array (SuperScope does this for
  // its N-point hot loop to avoid repeated Object.keys() calls).
  _getScopeKeys() {
    return Object.keys(this._jsScope);
  }

  // Run a JS code block against this._jsScope. Callers are responsible for
  // updating all relevant scope vars (beat/b, w, h, etc.) before calling.
  _runJS(code, paramName) {
    if (!code?.trim()) { delete this._jsErrors[paramName]; return; }
    const scope = this._jsScope;
    const keys  = this._getScopeKeys();
    const vals  = keys.map(k => scope[k]);
    try {
      const fn     = new Function(...keys, `${code}\nreturn{${keys.join(',')}}`);
      const result = fn(...vals);
      for (const k of keys) {
        if (typeof result[k] === 'number') scope[k] = result[k];
      }
      delete this._jsErrors[paramName];
    } catch (e) {
      this._jsErrors[paramName] = e.message;
      console.error(`${this._effectName} ${paramName}:`, e);
    }
  }

  getJsError(paramName) { return this._jsErrors[paramName] ?? ''; }
}

// Scans a single code string (initCode) for `var name` declarations.
// Names in `builtins` are excluded — they are engine-provided, not user vars.
// Used by all five scriptable effects.
export function scanVarDecls(code, builtins) {
  const names = new Set();
  const re = /\bvar\s+([a-zA-Z_]\w*)/g;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  for (const b of builtins) names.delete(b);
  return names;
}
