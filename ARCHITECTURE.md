# Winamp AVS Remake — Architecture

## Overview

A browser-based JavaScript + WebGL2 remake of Winamp's Advanced Visualization Studio (AVS). The original was a Windows C++ plugin that operated on a shared CPU pixel buffer via DirectDraw. The remake replaces that buffer with a GPU ping-pong framebuffer pair, drives rendering through GLSL shaders, and sources audio from the Web Audio API.

---

## Technology Stack

| Concern | Choice |
|---|---|
| Module bundler | Vite (ES modules, HMR, `?raw` shader imports) |
| Rendering | WebGL2 (RGBA8 textures, FBOs, VAOs, `texelFetch`) |
| Audio input | Web Audio API — `AnalyserNode` (microphone or MP3 file) |
| UI | Vanilla JS DOM, no framework |
| Presets | JSON (save/load via download / file picker) |

---

## File Structure

```
AVS_Remake/
  index.html                    Single-page app entry, canvas + toolbar HTML
  style.css                     Dark theme, chain panel, config panel, drag UI
  vite.config.js

  src/
    core/
      engine.js                 AVSEngine — render loop, resize, frame dispatch
      audio.js                  AudioAnalyzer — FFT, waveform, beat detection, BPM
      audio-data.js             AudioGLBuffer (GPU texture), makeAudioScope (JS closures), AUDIO_GLSL_SRC (GLSL helpers)
      framebuffer-manager.js    FBOManager — ping-pong pair + 8 scratch FBOs
      effect-chain.js           EffectChain + EffectEntry — ordered effect list
      blend.js                  BlendMode constants
      line-draw.js              CPU Bresenham line / point draw into Uint8Array
      preset.js                 Preset.toJSON() / fromJSON() / download()
      registry.js               EffectRegistry — maps name string → class

    effects/
      effect.js                 Effect base class + GL helpers (createProgram, getQuadVAO, getEmptyVAO)
      scriptable-effect.js      ScriptableEffect base class + scanVarDecls — shared JS runner for Init/Frame/Beat blocks
      register.js               Imports and registers every effect class
      ... (one file per effect, see Effects section below)

    ui/
      app.js                    Wires engine, chain UI, drag-drop, toolbar, config panel
      config-panels.js          Auto-generates config UI from effect descriptors

    shaders/
      fullscreen.vert           Shared clip-space quad vertex shader
      blit.frag                 Copy texture to output (passthrough)
      blend.frag                Unused global blend library (modes live in effect-list.js)

  presets/
    default.json                Loaded on startup if present
```

---

## Core Architecture

### Render Loop — `AVSEngine` (`core/engine.js`)

`AVSEngine` owns the WebGL2 context, audio analyzer, FBO manager, and effect chain. Each `requestAnimationFrame` tick:

1. `audio.update()` — pull FFT + waveform from Web Audio, run beat detection.
2. `audioBuffer.update(gl, visdata)` — upload the current audio data to the GPU audio texture (576×1 RGBA8 + mipmaps).
3. Build a `ctx` object: `{ gl, visdata, audioTex, isBeat, fboManager, w, h, frame, time }`.
4. `chain.render(ctx)` — iterate effects; each reads `getCurrent()` and writes to `getNext()`, then calls `fboManager.swap()`.
5. `chain.blitToCanvas()` — blit the final texture to the canvas framebuffer.

The canvas renders at the display size (capped at 1600×1200). `window.resize` triggers FBO reallocation.

---

### Audio — `AudioAnalyzer` (`core/audio.js`)

Wraps a stereo `AudioContext` with two `AnalyserNode`s (fftSize=2048) split by a `ChannelSplitter`. Each frame, both L and R channels produce:

- `visdata[0][ch]` — spectrum (576 bins, 0–255 float, log-scaled from dB)
- `visdata[1][ch]` — waveform (576 samples, 0–255 float, 128 = silence)

Beat detection is a port of AVS `main.cpp`'s rolling-RMS threshold logic, with an optional smart BPM tracker (`bpm.cpp`) that learns tempo, discriminates sub-divisions, and predicts beats — toggled via `smartBeat` (off by default, matching the original's `cfg_smartbeat=0`).

Sources: `connectMicrophone()` (getUserMedia) or `connectAudioElement(el)` (MP3 file via `<audio>`).

---

### Audio Scripting Access — `audio-data.js`

Three exports make audio data available to every script block:

**`AudioGLBuffer`** — Manages a 576×1 RGBA8 texture with a full mipmap chain. Pixel layout:

| Channel | Data |
|---|---|
| R | `spec_L` — spectrum left (0–255) |
| G | `spec_R` — spectrum right (0–255) |
| B | `osc_L` — waveform left (0–255, 128=silence) |
| A | `osc_R` — waveform right (0–255, 128=silence) |

`update(gl, visdata)` uploads the 576-bin arrays via `texSubImage2D` then calls `gl.generateMipmap`, so each LOD contains a power-of-2 average of the bins below it. The texture handle is exposed as `AudioGLBuffer.texture` and passed to the render context as `ctx.audioTex`.

**`AUDIO_GLSL_SRC`** — A GLSL string injected into every dynamically-built shader. Declares `uniform sampler2D uAudioData` and provides two functions:

```glsl
float getspec(float band, float bandw, float chan_f)  // returns [0, 1]
float getosc(float band, float bandw, float chan_f)   // returns [-1, 1]
```

`band` is a normalized bin position (0–1), `bandw` is a normalized averaging width (0–1), `chan_f` is 0=center, 1=left, 2=right. Wider bands are approximated by selecting a higher mipmap LOD (`lod = floor(log2(bandw × 576))`), making the lookup O(1) regardless of `bandw`. `texelFetch` bypasses sampler filtering to read directly from the pre-averaged mip texel.

**`makeAudioScope(getVisdata)`** — Returns `{ getspec, getosc }` JS closures that read `visdata` at call time (not creation time). Effects call `this._visdata = ctx.visdata` before `_runJS`, then pass the closures as named parameters into the `new Function(...)` scope. The `typeof result[k] === 'number'` guard in `_runJS` prevents user code from overwriting them. Both names are listed in each effect's `BUILTIN_VARS` set so `scanVarDecls` doesn't treat `var getspec = ...` as a user bridged variable.

**Texture unit convention:**

| Unit | Name | Purpose |
|---|---|---|
| TEXTURE0 | `uInput` | Current ping-pong frame (all effects) |
| TEXTURE1 | `uSource` | Previous frame (Dynamic Movement only) |
| TEXTURE2 | `uAudioData` | Audio texture (all scriptable effects with GLSL) |

---

### Framebuffer Manager — `FBOManager` (`core/framebuffer-manager.js`)

Manages 10 WebGL2 RGBA8 FBOs:

- **pingPong[2]** — the main chain's double-buffer. `getCurrent()` is the input texture; `getNext()` is where the next effect writes. `swap()` toggles the index.
- **scratch[8]** — named slots 0–7, matching the original's `NBUF=8`. Used by Buffer Save/Restore and Effect List's Buffer blend mode.

On canvas resize, all textures are reallocated and cleared to black.

---

### Effect Chain — `EffectChain` + `EffectEntry` (`core/effect-chain.js`)

`EffectEntry` wraps an `Effect` instance with an `enabled` flag. `EffectChain.render()` iterates entries: for each enabled effect, it clears the destination FBO (so partial-draw effects start clean), then calls `effect.render(ctx)`. The effect is responsible for calling `fboManager.swap()` before returning.

`blitToCanvas()` uses a simple passthrough shader to copy the final ping-pong texture to the canvas.

---

### Effect Base Class — `Effect` (`effects/effect.js`)

All effects extend this class and implement four methods:

```js
render(ctx)        // read ctx.inputTex, write to ctx.outputFBO, call fboManager.swap()
getConfig()        // return a plain serialisable object
setConfig(cfg)     // apply a config object
getDescriptor()    // return { name, params: [{name, label, type, ...}] }
destroy()          // free GL resources
```

`getDescriptor()` drives the auto-generated config UI. Param types: `range`, `color`, `select`, `bool`, `number`, `glsl` (textarea with live shader recompile), `colors` (dynamic color list).

Shared GL helpers on the module: `createProgram(gl, vertSrc, fragSrc)`, `compileShader(gl, type, src)`, `getQuadVAO(gl)`, `getEmptyVAO(gl)` — all lazy-created per context via WeakMap. `getEmptyVAO` provides an attribute-free VAO for draws that source all data from `gl_VertexID` and uniforms (e.g. Movement's source-map scatter).

---

### Scriptable Effects — `ScriptableEffect` (`effects/scriptable-effect.js`)

Five effects with Init/Frame/Beat JavaScript code blocks extend `ScriptableEffect` instead of `Effect` directly: **Color Modifier**, **Dynamic Movement**, **DDM**, **Dynamic Shift**, **SuperScope**.

`ScriptableEffect` provides:

```js
_runJS(code, paramName)       // execute a JS block against this._jsScope; store errors in this._jsErrors
getJsError(paramName)         // return the last error string for a block, or ''
_getScopeKeys()               // returns Object.keys(this._jsScope); override to cache
```

Each effect is responsible for seeding `this._jsScope` with its own built-in variables (e.g. `b`, `w`, `h`, `alpha`) and for updating them on `_jsScope` before calling `_runJS` — no beat/frame state is passed as a parameter. `getJsError` is queried by `config-panels.js` to display runtime errors below each JS textarea.

The module also exports `scanVarDecls(code, builtins)`: scans `initCode` for `var name` declarations (excluding the effect's built-in names) to discover user variables that need to be seeded into `_jsScope` or bridged as GLSL uniforms. SuperScope overrides `_getScopeKeys()` to return a cached key array, avoiding repeated `Object.keys()` calls in its N-point per-frame loop.

---

### Preset System — `Preset` (`core/preset.js`)

JSON format:
```json
{
  "version": "1.0",
  "effects": [
    { "type": "Fadeout", "enabled": true, "config": { "speed": 0.04 } }
  ]
}
```

`fromJSON()` destroys the existing chain, then reconstructs each effect by looking up its class in `EffectRegistry` and calling `setConfig()`. `download()` serialises and triggers a browser download.

---

### Registry — `EffectRegistry` (`core/registry.js`)

A simple `Map<string, class>`. `register.js` imports every effect class and registers it under its display name. The UI effect-select dropdown is populated by iterating `EffectRegistry.names()`.

---

### UI — `app.js` + `config-panels.js`

**`app.js`** manages:
- **Chain panel** — renders a list of `chain-item` divs; supports enable/disable toggle, remove, click-to-select, drag-to-reorder (module-level `dragState` holds the live `EffectEntry` reference to avoid serialization). Drag works across Effect List boundaries.
- **Effect List expansion** — sub-effects render as an indented `sub-chain` div. The expand-button doubles as a drop target (appending to the list). A "drop here to append" zone appears at the bottom of the sub-chain.
- **Toolbar** — Add effect (dropdown), Save preset, Load preset, Mic toggle, MP3 play/pause.

**`config-panels.js`** auto-generates a config panel from `getDescriptor().params`:
- `range` → `<input type="range">` with live update
- `color` → `<input type="color">`
- `select` → `<select>`
- `bool` → `<input type="checkbox">`
- `number` → `<input type="number">`
- `glsl` → `<textarea>` with live shader recompile and error display
- `colors` → dynamic color list with add/remove and color pickers

---

### CPU Overlay Pattern (`core/line-draw.js`)

Several effects (Simple, Timescope, Ring, Dot Grid, Moving Particle, Dot Fountain) draw into a CPU-side `Uint8Array` (`w × h × 4` RGBA) then upload it via `gl.texSubImage2D`. A composite shader blends this overlay on top of the current frame. Because `texSubImage2D` with a typed array places row 0 at the bottom of the GL texture, screen-space Y coordinates must be flipped: `bufIdx = (h - 1 - sy) * w + sx`.

`line-draw.js` provides `drawLine(buf, w, h, x0, y0, x1, y1, r, g, b)` (Bresenham) and `drawDot(buf, w, h, x, y, r, g, b)`.

---

## Effect Rendering Modes

Effects fall into four broad categories:

| Mode | Description | Examples |
|---|---|---|
| **Full-screen shader** | Fullscreen quad reads `inputTex`, outputs to `outputFBO` | Fadeout, Blur, Invert, Mirror, Movement |
| **CPU overlay** | Draw into Uint8Array, upload as texture, composite in GLSL | Simple, Ring, Dot Fountain, Timescope |
| **Particle/state CPU** | Maintain particle state on CPU, upload per frame | Starfield, Moving Particle, Dot Fountain |
| **Container** | Run a nested sub-chain in isolated FBOs, blend result back | Effect List |

---

## Effects Reference

### Render / Generative

| Name | File | Description |
|---|---|---|
| **Clear** | `clear.js` | Fills the buffer with a solid color. Supports a blend mode for compositing on top of the existing frame rather than replacing it. |
| **Simple** | `simple.js` | Classic AVS waveform/spectrum analyzer. Draws bars or lines from audio data. Supports up to 16 animated colors and four display modes (solid/line × scope/spectrum). CPU Bresenham line draw. |
| **Timescope** | `timescope.js` | Horizontal waveform display that scrolls each frame. The left column shows the current waveform sample; previous frames shift right, producing a waterfall view. CPU line draw. |
| **SuperScope** | `superscope.js` | Per-point GLSL stub. The user writes a fragment that maps per-sample audio values to `(x, y, r, g, b)`. Compiled live with error feedback. |
| **Starfield** | `starfield.js` | 3D starfield with configurable star count, speed, and color. Stars are simulated on CPU and plotted as pixels, with depth-based brightness. |
| **Moving Particle** | `moving-particle.js` | A single bouncing particle that leaves an animated color trail. Position and velocity updated each frame on CPU. |
| **Dot Grid** | `dot-grid.js` | A grid of dots whose positions are displaced vertically by the audio spectrum. Grid spacing and dot size are configurable. CPU blit. |
| **Ring** | `ring.js` | Draws a circular ring whose radius is modulated by the waveform or spectrum. 80 segments, animated color cycling, configurable size and audio source. CPU Bresenham lines. |
| **Dot Fountain** | `dot-fountain.js` | 3D particle fountain: 256 generations × 30 angular positions. Particles are spawned from audio data at gen 0, advance ballistically each frame (gravity, radial acceleration), and are rendered via a 4×4 matrix transform with perspective projection. 5-color gradient map indexed by audio amplitude. |
| **Interferences** | `interferences.js` | Draws interference wave patterns (concentric rings or ripples) driven by configurable frequencies and audio reactivity. |
| **Texer II** | `texer2.js` | Places a user-defined texture image (or generated shape) at per-point positions computed from a GLSL stub, similar to SuperScope but image-stamped. |

### Transform / Filter

| Name | File | Description |
|---|---|---|
| **Fadeout** | `fadeout.js` | Multiplies each pixel toward black (or a target color) by a configurable speed. The primary decay/trail effect in AVS. |
| **Blur** | `blur.js` | Separable box blur at three intensity levels (1, 2, or 3 pixel radius). GLSL. |
| **Brightness** | `brightness.js` | Per-channel multiply and offset. GLSL. |
| **Fast Brightness** | `fast-brightness.js` | Simplified brightness scale (integer multiply, matching original's MMX path). |
| **Invert** | `invert.js` | Inverts all RGB channels (`1.0 - color`). GLSL. |
| **Mirror** | `mirror.js` | Flips the frame horizontally, vertically, or both. Optional on-beat trigger. GLSL. |
| **Mosaic** | `mosaic.js` | Pixelates the frame into rectangular blocks. Block size is configurable and optionally audio-reactive. GLSL `texelFetch`. |
| **Grain** | `grain.js` | Adds per-pixel random noise (film grain). Noise seed changes each frame. GLSL. |
| **Channel Shift** | `channel-shift.js` | Spatially offsets the R, G, and B channels independently. GLSL. |
| **Color Modifier** | `color-modifier.js` | Applies per-channel brightness/saturation curves via a GLSL pixel stub that runs once per channel (red→R, green→G, blue→B). Init/Frame/Beat JS blocks and the GLSL pixel stub all have access to `getspec`/`getosc`. |
| **Colorfade** | `colorfade.js` | Smoothly rotates the hue of the entire frame over time. GLSL. |
| **Color Reduction** | `color-reduction.js` | Quantizes pixel colors to a reduced palette (configurable bit depth per channel). GLSL. |
| **Color Clip** | `color-clip.js` | Clamps pixel values below a threshold to zero (black). Effectively a brightness gate. GLSL. |
| **Contrast** | `contrast.js` | Adjusts contrast around mid-grey. GLSL. |
| **Normalize** | `normalize.js` | Scales the frame so the brightest pixel reaches full white. Per-frame histogram. GLSL. |
| **Unique Tone** | `unique-tone.js` | Maps the frame to a single hue/tint, preserving luminance. GLSL. |
| **Multiplier** | `multiplier.js` | Multiplies pixel values by a configurable factor (can brighten or dim). GLSL. |
| **Scatter** | `scatter.js` | Randomly displaces each pixel by a small amount, producing a soft scatter blur. GLSL. |
| **Interleave** | `interleave.js` | Blends alternating lines or columns from the current and previous frame, simulating interlaced display. GLSL. |
| **Add Borders** | `add-borders.js` | Draws solid color borders around the frame edges. Width per edge is configurable. GLSL. |
| **Convolution Filter** | `convolution.js` | Applies a user-editable 3×3 or 5×5 convolution kernel. Useful for sharpen, emboss, edge-detect. GLSL. |
| **Multi Filter** | `multi-filter.js` | Applies one of several preset convolution-style filters (blur, sharpen, emboss, etc.) selected from a dropdown. GLSL. |
| **Color Map** | `colormap.js` | Maps the luminance of each pixel through a 256-entry color gradient table. The gradient is configurable per channel. GLSL. |

### Movement / Displacement

| Name | File | Description |
|---|---|---|
| **Movement** | `movement.js` | Per-pixel coordinate remap. User writes a GLSL stub that computes new sample coordinates `(nx, ny)` as a function of `(x, y, d, r)`. Shader recompiled live. |
| **Dynamic Movement** | `dynamic-movement.js` | Enhanced version of Movement with on-beat parameter switching and configurable interpolation (bilinear/nearest). GLSL stub. Init/Frame/Beat JS blocks and the GLSL pixel stub all have access to `getspec`/`getosc`. |
| **Dynamic Distance Modifier** | `ddm.js` | Remaps pixels radially: user stub computes a new radius as a function of distance from center and audio data. GLSL stub. Init/Frame/Beat JS blocks and the GLSL pixel stub all have access to `getspec`/`getosc`. |
| **Dynamic Shift** | `dynamic-shift.js` | Shifts the frame contents by a user-specified pixel offset (dx, dy) each frame, optionally audio-reactive. GLSL fixed shader; `getspec`/`getosc` available in the Init/Frame/Beat JS blocks only. |
| **Roto Blitter** | `roto-blitter.js` | Rotates and scales the frame around its center, optionally zooming in each frame to produce a spinning tunnel effect. GLSL transform matrix. |
| **Water** | `water.js` | Simulates a water-ripple displacement field using a two-buffer wave equation updated each frame. Drops are triggered by beat or on a timer. GLSL. |
| **Water Bump** | `waterbump.js` | Simulates a 2D wave equation on a CPU-side `Int32Array` height field and displaces pixels each frame by `dx>>3`/`dy>>3` offsets derived from local height gradients. On beat, stamps a sinusoidal radial blob into the height field at a fixed or random position. The height field is uploaded as an `R32F` float texture each frame for the GPU displacement pass. |
| **Bump** | `bump.js` | Computes a normal map from frame luminance and applies diffuse + specular lighting from a configurable light position. GLSL. |

### Timing / Utility

| Name | File | Description |
|---|---|---|
| **Effect List** | `effect-list.js` | Container effect that runs a nested sub-chain in two isolated internal ping-pong FBOs, then blends the result back into the parent chain. Supports all 14 original blend modes (Ignore, Replace, 50/50, Maximum, Additive, Subtractive 1/2, Every Other Line/Pixel, XOR, Adjustable, Multiply, Buffer, Minimum) for both input and output blending. `clearFrame` controls whether the internal buffer persists between frames. |
| **Buffer Save** | `buffer-save.js` | Copies the current frame to or from one of 8 named scratch buffers (matching the original's `NBUF=8`). Used to composite effects from different points in the chain. |
| **Blit** | `blit.js` | Copies the frame scaled and offset back onto itself (feedback loop). Used with Fadeout to create zoom-trail effects. |
| **Video Delay** | `video-delay.js` | Holds N frames of history and outputs a delayed version of the frame. |
| **Multi Delay** | `multi-delay.js` | Like Video Delay but with multiple independently configurable delay slots blended together. |
| **Custom BPM** | `custom-bpm.js` | Overrides the detected BPM with a manually specified value, driving beat pulses at that tempo instead. |
| **OnBeat Clear** | `onbeat-clear.js` | Clears the frame to a color only on detected beats. Useful for flash/strobe effects. |
| **Set Render Mode** | `set-render-mode.js` | Sets the global line blend mode used by CPU line-drawing effects (e.g. additive vs. replace). |
| **Comment** | `comment.js` | No-op effect that stores a text annotation. Used to document preset chain sections. |

---

## Key Implementation Notes

### Ping-Pong Convention

Every effect reads from `ctx.inputTex` (= `fboManager.getCurrent().texture`) and writes to `ctx.outputFBO` (= `fboManager.getNext().fbo`), then calls `fboManager.swap()`. The chain pre-clears `getNext().fbo` to black before each effect so partial-draw effects (CPU overlay types) start from a known state.

### CPU Texture Upload and Y-Flip

Effects that draw on the CPU upload their `Uint8Array` via `gl.texSubImage2D`. WebGL texture row 0 maps to the bottom of the screen, opposite to screen-space coordinates (row 0 = top). All CPU-side drawing must flip the Y axis: `bufferIndex = (h - 1 - screenY) * w + screenX`.

### CPU Wave Simulation + R32F Upload (Water Bump)

Water Bump runs its entire wave simulation on the CPU (two `Int32Array` ping-pong buffers, matching the original's integer arithmetic exactly) and uploads the current height field to the GPU as a single-channel `R32F` texture via `texSubImage2D` each frame. The displacement shader reads height gradients from this texture using `texelFetch` and applies the same `>> 3` shift as the original. The Y-axis mismatch between the CPU buffer (row 0 = top) and the GL texture (row 0 = bottom) is corrected inside the shader with `hc = ivec2(c.x, sz.y - 1 - c.y)`.

### GLSL Stubs and JS Script Blocks (Scripting Replacement)

Effects that used NSEEL/EEL scripting in the original (SuperScope, Dynamic Movement, DDM, Color Modifier) expose one or more `<textarea>` fields in their config panel. GLSL pixel stubs are embedded into a full shader template and recompiled live via `gl.compileShader`; GLSL compile errors are shown below the textarea in red.

JS script blocks (Init, Frame, Beat — and Point for SuperScope) run via `ScriptableEffect._runJS()` using `new Function(...)`. Runtime errors are caught per-block, stored in `_jsErrors`, and displayed by `config-panels.js` via `effect.getJsError(paramName)`.

All GLSL stubs have access to `getspec(band, bandw, chan)` and `getosc(band, bandw, chan)` via the injected `AUDIO_GLSL_SRC` block. All JS script blocks similarly have `getspec` and `getosc` injected into `_jsScope` via `makeAudioScope`.

User variables declared with `var name` in Init code are discovered by `scanVarDecls(initCode, BUILTIN_VARS)` and seeded into `_jsScope` as persistent state. Effects that bridge JS variables to GLSL (Color Modifier, Dynamic Movement, DDM) also declare them as `uniform float` in the shader so the pixel stub can read frame-state values.

### visdata Format

`visdata[type][channel][bin]` where type 0=spectrum, 1=waveform; channel 0=L, 1=R; bin 0–575. All values are float 0–255, with waveform centred at 128 (silence). This matches the original C++ `(uint8_t)val ^ 128` convention — no XOR is needed in JS because the Web Audio API delivers waveform as -1..1 float which is then mapped to 0–255 with 128=0.

### Effect List Internal Buffers

`EffectListEffect` maintains two private ping-pong FBOs that persist across frames (matching the original's `list_framebuffer`). Sub-effects run against these internal buffers using a shim `fboManager` that delegates `getScratch()` to the parent chain's scratch pool.
