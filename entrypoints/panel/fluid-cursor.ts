/**
 * A small GPU fluid field for the brand panel.
 *
 * Ported from the React/Vite "splash cursor" simulation: a velocity/dye pair
 * on half-float targets, curl + vorticity confinement, Jacobi pressure,
 * semi-Lagrangian advection, optional bloom, and a subtractive display pass so
 * the warm ink reads correctly on the paper-coloured card. The only behaviour
 * changed here is the plumbing — it mounts on a plain canvas, reacts to the
 * pointer only while it is over the panel, and parks the render loop once the
 * field has settled.
 */

const QUALITY = {
  low: { sim: 64, dye: 420, iterations: 8 },
  medium: { sim: 96, dye: 620, iterations: 12 },
  high: { sim: 128, dye: 900, iterations: 16 },
} as const;

type Quality = keyof typeof QUALITY;

const BLOOM_RESOLUTION = 192;
const BLOOM_ITERATIONS = 3;
const BLOOM_THRESHOLD = 0.32;
const BLOOM_KNEE = 0.7;

const VERTEX = `#version 300 es
precision highp float;
in vec2 aPosition;
uniform vec2 texelSize;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
`;

const SHADERS = {
  copy: `uniform sampler2D uTexture;
void main() {
  outColor = texture(uTexture, vUv);
}`,
  clear: `uniform sampler2D uTexture;
uniform float value;
void main() {
  outColor = value * texture(uTexture, vUv);
}`,
  splat: `uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 pointA;
uniform vec2 pointB;
uniform float radius;
void main() {
  vec2 scale = vec2(aspectRatio, 1.0);
  vec2 pa = (vUv - pointA) * scale;
  vec2 ba = (pointB - pointA) * scale;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  vec2 d = pa - ba * h;
  vec3 base = texture(uTarget, vUv).xyz;
  outColor = vec4(base + exp(-dot(d, d) / radius) * color, 1.0);
}`,
  burst: `uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec2 point;
uniform float radius;
uniform float strength;
uniform float seed;
void main() {
  vec2 d = (vUv - point) * vec2(aspectRatio, 1.0);
  float distance = length(d);
  vec2 direction = d / max(distance, 0.00001);
  float angle = atan(d.y, d.x);
  float petals = 0.78 + 0.22 * sin(angle * 5.0 + seed) * sin(angle * 3.0 - seed * 1.7);
  vec2 twist = vec2(-direction.y, direction.x) * 0.3 * sin(angle * 4.0 + seed * 2.3);
  float falloff = exp(-dot(d, d) / radius) * distance / sqrt(radius);
  outColor = vec4(texture(uTarget, vUv).xy + (direction * petals + twist) * falloff * strength, 0.0, 1.0);
}`,
  crown: `uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec2 point;
uniform float radius;
uniform vec3 colorA;
uniform vec3 colorB;
uniform float seed;
void main() {
  vec2 d = (vUv - point) * vec2(aspectRatio, 1.0);
  vec3 ink = exp(-dot(d, d) / (radius * 0.45)) * colorA;
  for (int i = 0; i < 7; i++) {
    float index = float(i);
    float angle = seed + index * 0.8975979 + sin(seed * 3.0 + index * 1.9) * 0.35;
    float reach = sqrt(radius) * (0.75 + 0.45 * fract(sin(seed * 7.1 + index * 3.7) * 43.7));
    float drop = radius * (0.08 + 0.12 * fract(sin(seed * 2.9 + index * 5.3) * 31.9));
    vec2 q = d - vec2(cos(angle), sin(angle)) * reach;
    ink += exp(-dot(q, q) / drop) * mix(colorA, colorB, fract(index * 0.37 + 0.2));
  }
  outColor = vec4(texture(uTarget, vUv).xyz + ink, 1.0);
}`,
  advection: `uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main() {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
  outColor = texture(uSource, coord) / (1.0 + dissipation * dt);
}`,
  divergence: `uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`,
  curl: `uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`,
  vorticity: `uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main() {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy + force * dt;
  outColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
}`,
  pressure: `uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  outColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`,
  gradient: `uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  outColor = vec4(velocity, 0.0, 1.0);
}`,
  prefilter: `uniform sampler2D uTexture;
uniform vec3 curve;
uniform float threshold;
void main() {
  vec3 c = texture(uTexture, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - curve.x, 0.0, curve.y);
  rq = curve.z * rq * rq;
  c *= max(rq, br - threshold) / max(br, 0.0001);
  outColor = vec4(c, 0.0);
}`,
  blur: `uniform sampler2D uTexture;
uniform float intensity;
void main() {
  vec4 sum = texture(uTexture, vL) + texture(uTexture, vR) + texture(uTexture, vT) + texture(uTexture, vB);
  outColor = sum * 0.25 * intensity;
}`,
  display: `uniform sampler2D uTexture;
uniform sampler2D uBloom;
uniform vec2 texelSize;
uniform float shading;
uniform float bloom;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec3 c = texture(uTexture, vUv).rgb;
  if (shading > 0.0) {
    float dx = length(texture(uTexture, vR).rgb) - length(texture(uTexture, vL).rgb);
    float dy = length(texture(uTexture, vT).rgb) - length(texture(uTexture, vB).rgb);
    vec3 n = normalize(vec3(dx, dy, length(texelSize)));
    c *= mix(1.0, clamp(n.z + 0.7, 0.7, 1.0), shading);
  }
  if (bloom > 0.0) {
    c += max(texture(uBloom, vUv).rgb, 0.0) * bloom;
  }
  c = max(c, 0.0);
  float peak = max(c.r, max(c.g, c.b));
  float grain = (hash(gl_FragCoord.xy) - 0.5) / 255.0 * smoothstep(0.0, 0.03, peak);
  vec3 transmit = exp(-2.4 * c);
  float low = min(transmit.r, min(transmit.g, transmit.b));
  float alpha = clamp(1.0 - low + grain, 0.0, 1.0);
  outColor = vec4(min(transmit - low, vec3(alpha)), alpha);
}`,
};

export interface FluidCursorOptions {
  /** Ink colours, hex. Blended in order along the pointer's path. */
  colors?: string[];
  /** Brush radius multiplier. */
  size?: number;
  force?: number;
  swirl?: number;
  trail?: number;
  momentum?: number;
  /** Bloom amount, 0 disables the prefilter chain. */
  glow?: number;
  /** Ink density; the panel runs hotter than the default splash look. */
  intensity?: number;
  quality?: Quality;
  /** Stamp a flower crown on click. Off by default: the panel only stirs. */
  clickSplash?: boolean;
}

interface Target {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelX: number;
  texelY: number;
  attach(unit: number): number;
}

interface DoubleTarget {
  read: Target;
  write: Target;
  width: number;
  height: number;
  texelX: number;
  texelY: number;
  swap(): void;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface Pointer {
  x: number;
  y: number;
  px: number;
  py: number;
  ready: boolean;
  moved: boolean;
  offset: number;
}

const DEFAULTS: Required<FluidCursorOptions> = {
  // The panel's ink is a warm cream (#fff6d8) with two neighbours, so the
  // field drifts through a hue instead of sitting flat on one value.
  colors: ['#fff6d8', '#fdeec2', '#fffcf0'],
  size: 1.2,
  force: 1,
  swirl: 2.4,
  trail: 1.4,
  momentum: 1,
  glow: 0.18,
  intensity: 4,
  quality: 'low',
  // Upstream stamps a flower crown on every click; the panel only wants the
  // pointer to stir the paper, so this is off unless a caller opts in.
  clickSplash: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseColor(value: string): [number, number, number] {
  let hex = value.replace('#', '').trim();
  if (hex.length === 3) hex = [...hex].map((char) => char + char).join('');
  const number = Number.parseInt(hex.slice(0, 6), 16);
  if (Number.isNaN(number)) return [1, 1, 1];
  return [
    ((number >> 16) & 255) / 255,
    ((number >> 8) & 255) / 255,
    (number & 255) / 255,
  ];
}

function rgbToHsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const sector = ((i % 6) + 6) % 6;
  if (sector === 0) return [v, t, p];
  if (sector === 1) return [q, v, p];
  if (sector === 2) return [p, v, t];
  if (sector === 3) return [p, q, v];
  if (sector === 4) return [t, p, v];
  return [v, p, q];
}

function must<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

/**
 * Mount the field on `canvas`. Returns a disposer; calling it is idempotent.
 * A no-op disposer is returned when WebGL2 is unavailable or the visitor asked
 * for reduced motion — the panel simply keeps its CSS background.
 */
export function mountFluidCursor(
  canvas: HTMLCanvasElement,
  options: FluidCursorOptions = {},
): () => void {
  const settings = { ...DEFAULTS, ...options };
  const palette = settings.colors.map(parseColor);
  const quality = QUALITY[settings.quality] ?? QUALITY.low;

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return () => {};
  }

  const context = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!context) return () => {};
  // Rebound without the null so the hoisted shader helpers below keep the
  // narrowed type.
  const gl: WebGL2RenderingContext = context;

  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_color_buffer_half_float');

  const rgba = { internal: gl.RGBA16F, format: gl.RGBA };
  const rg = { internal: gl.RG16F, format: gl.RG };
  const r = { internal: gl.R16F, format: gl.RED };

  function compile(type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  if (!vertex) return () => {};

  const programs: Record<string, Program> = {};
  for (const [name, body] of Object.entries(SHADERS)) {
    const fragment = compile(gl.FRAGMENT_SHADER, HEADER + body);
    if (!fragment) return () => {};
    const program = gl.createProgram();
    if (!program) return () => {};
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return () => {};
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i += 1) {
      const info = gl.getActiveUniform(program, i);
      if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    programs[name] = { program, uniforms };
  }
  gl.deleteShader(vertex);

  const buffer = must(gl.createBuffer(), 'no buffer');
  const vao = must(gl.createVertexArray(), 'no vertex array');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const targets = new Set<Target>();
  let disposed = false;
  let lost = false;
  let raf = 0;
  let last = 0;
  let lastActivity = performance.now();

  function blit(target: Target | null): void {
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function createTarget(
    width: number,
    height: number,
    format: { internal: number; format: number },
    filter: number,
  ): Target {
    const texture = must(gl.createTexture(), 'no texture');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      format.internal,
      width,
      height,
      0,
      format.format,
      gl.HALF_FLOAT,
      null,
    );
    const fbo = must(gl.createFramebuffer(), 'no framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const target: Target = {
      texture,
      fbo,
      width,
      height,
      texelX: 1 / width,
      texelY: 1 / height,
      attach(unit: number) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return unit;
      },
    };
    targets.add(target);
    return target;
  }

  function destroyTarget(target: Target | null): void {
    if (!target) return;
    gl.deleteFramebuffer(target.fbo);
    gl.deleteTexture(target.texture);
    targets.delete(target);
  }

  function createDouble(
    width: number,
    height: number,
    format: { internal: number; format: number },
    filter: number,
  ): DoubleTarget {
    const pair: DoubleTarget = {
      read: createTarget(width, height, format, filter),
      write: createTarget(width, height, format, filter),
      width,
      height,
      texelX: 1 / width,
      texelY: 1 / height,
      swap() {
        const current = pair.read;
        pair.read = pair.write;
        pair.write = current;
      },
    };
    return pair;
  }

  function resolution(base: number): { width: number; height: number } {
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
    const short = Math.round(base);
    const long = Math.round(base * aspect);
    return width > height
      ? { width: long, height: short }
      : { width: short, height: long };
  }

  function fit(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
  }

  fit();

  // The panel grows while its entry animation unfolds and shrinks again when
  // the host clips it, so the drawing buffer follows the CSS box instead of
  // being captured once at mount (which stretched a 82px buffer over 405px).
  let dye: DoubleTarget;
  let velocity: DoubleTarget;
  let pressure: DoubleTarget;
  let divergence: Target;
  let curl: Target;
  let bloom: Target | null = null;
  let bloomChain: Target[] = [];

  function dropTargets(): void {
    targets.forEach((target) => {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.texture);
    });
    targets.clear();
    bloom = null;
    bloomChain = [];
  }

  function buildTargets(): void {
    const ink = resolution(Math.max(quality.sim, quality.dye));
    const sim = resolution(quality.sim);
    dye = createDouble(ink.width, ink.height, rgba, gl.LINEAR);
    velocity = createDouble(sim.width, sim.height, rg, gl.LINEAR);
    pressure = createDouble(sim.width, sim.height, r, gl.NEAREST);
    divergence = createTarget(sim.width, sim.height, r, gl.NEAREST);
    curl = createTarget(sim.width, sim.height, r, gl.NEAREST);
  }

  function syncSize(): void {
    const width = canvas.width;
    const height = canvas.height;
    fit();
    if (canvas.width === width && canvas.height === height) return;
    if (canvas.width === 0 || canvas.height === 0) return;
    dropTargets();
    buildTargets();
  }

  buildTargets();

  function ensureBloom(): Target {
    if (bloom) return bloom;
    const size = resolution(BLOOM_RESOLUTION);
    bloom = createTarget(size.width, size.height, rgba, gl.LINEAR);
    bloomChain = [];
    for (let i = 0; i < BLOOM_ITERATIONS; i += 1) {
      const width = size.width >> (i + 1);
      const height = size.height >> (i + 1);
      if (width < 2 || height < 2) break;
      bloomChain.push(createTarget(width, height, rgba, gl.LINEAR));
    }
    return bloom;
  }

  function use(name: keyof typeof SHADERS): Record<string, WebGLUniformLocation | null> {
    const item = programs[name];
    gl.useProgram(item.program);
    return item.uniforms;
  }

  const radiusFor = (scale: number): number => {
    const aspect = canvas.width / canvas.height;
    return ((0.2 * settings.size * scale) / 100) * (aspect > 1 ? aspect : 1);
  };

  function splat(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    vx: number,
    vy: number,
    color: [number, number, number],
    radius: number,
  ): void {
    const u = use('splat');
    gl.uniform1i(u.uTarget, velocity.read.attach(0));
    gl.uniform1f(u.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(u.pointA, ax, ay);
    gl.uniform2f(u.pointB, bx, by);
    gl.uniform3f(u.color, vx, vy, 0);
    gl.uniform1f(u.radius, radius);
    blit(velocity.write);
    velocity.swap();
    gl.uniform1i(u.uTarget, dye.read.attach(0));
    gl.uniform3f(u.color, color[0], color[1], color[2]);
    blit(dye.write);
    dye.swap();
  }

  /** The ink is subtractive on the pale card, so the channel is inverted. */
  const inkFor = (color: [number, number, number], amount: number): [number, number, number] => [
    (1 - color[0]) * amount,
    (1 - color[1]) * amount,
    (1 - color[2]) * amount,
  ];

  const colorAt = (offset: number, now: number): [number, number, number] => {
    const phase = (((offset + (now / 1000) * 0.12) % 1) + 1) % 1;
    if (palette.length === 1) return palette[0];
    const position = phase * palette.length;
    const from = palette[Math.floor(position) % palette.length];
    const to = palette[(Math.floor(position) + 1) % palette.length];
    const t = position - Math.floor(position);
    const blend = t * t * (3 - 2 * t);
    return [
      from[0] + (to[0] - from[0]) * blend,
      from[1] + (to[1] - from[1]) * blend,
      from[2] + (to[2] - from[2]) * blend,
    ];
  };

  function flush(pointer: Pointer, dt: number, now: number): void {
    const aspect = canvas.width / canvas.height;
    const length = Math.hypot(
      (pointer.x - pointer.px) * aspect,
      pointer.y - pointer.py,
    );
    if (length > 0.35) {
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      return;
    }
    let dx = pointer.x - pointer.px;
    let dy = pointer.y - pointer.py;
    if (aspect < 1) dx *= aspect;
    else dy /= aspect;
    const radius = radiusFor(1);
    const spread = 1 + length / (1.77 * Math.sqrt(radius));
    const push = (6000 * settings.force) / Math.sqrt(spread);
    const amount = (0.15 * settings.intensity * Math.min(dt * 60, 1)) / Math.sqrt(spread);
    const color = inkFor(colorAt(pointer.offset, now), amount);
    splat(
      pointer.px,
      pointer.py,
      pointer.x,
      pointer.y,
      dx * push,
      dy * push,
      color,
      radius,
    );
    pointer.px = pointer.x;
    pointer.py = pointer.y;
  }

  function burst(x: number, y: number, now: number): void {
    const seed = Math.random() * Math.PI * 2;
    const aspect = canvas.width / canvas.height;
    let u = use('burst');
    gl.uniform1i(u.uTarget, velocity.read.attach(0));
    gl.uniform1f(u.aspectRatio, aspect);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, radiusFor(3));
    gl.uniform1f(u.strength, 1100 * settings.force);
    gl.uniform1f(u.seed, seed);
    blit(velocity.write);
    velocity.swap();

    const offset = Math.random();
    const first = inkFor(colorAt(offset, now), 1.4 * settings.intensity);
    const second = inkFor(colorAt(offset + 0.3, now), 1.4 * settings.intensity);
    u = use('crown');
    gl.uniform1i(u.uTarget, dye.read.attach(0));
    gl.uniform1f(u.aspectRatio, aspect);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, radiusFor(1.6));
    gl.uniform3f(u.colorA, first[0], first[1], first[2]);
    gl.uniform3f(u.colorB, second[0], second[1], second[2]);
    gl.uniform1f(u.seed, seed);
    blit(dye.write);
    dye.swap();
  }

  function step(dt: number): void {
    gl.disable(gl.BLEND);

    let u = use('curl');
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    blit(curl);

    u = use('vorticity');
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uCurl, curl.attach(1));
    gl.uniform1f(u.curl, settings.swirl);
    gl.uniform1f(u.dt, dt);
    blit(velocity.write);
    velocity.swap();

    u = use('divergence');
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    blit(divergence);

    u = use('clear');
    gl.uniform1i(u.uTexture, pressure.read.attach(0));
    gl.uniform1f(u.value, 0.1);
    blit(pressure.write);
    pressure.swap();

    u = use('pressure');
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uDivergence, divergence.attach(0));
    for (let i = 0; i < quality.iterations; i += 1) {
      gl.uniform1i(u.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    u = use('gradient');
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uPressure, pressure.read.attach(0));
    gl.uniform1i(u.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    u = use('advection');
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uSource, velocity.read.attach(0));
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.dissipation, 2 / settings.momentum);
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uSource, dye.read.attach(1));
    gl.uniform1f(u.dissipation, 3.2 / settings.trail);
    blit(dye.write);
    dye.swap();
  }

  function applyBloom(amount: number): void {
    const base = ensureBloom();
    if (bloomChain.length === 0) return;
    gl.disable(gl.BLEND);
    let u = use('prefilter');
    const knee = BLOOM_THRESHOLD * BLOOM_KNEE + 0.0001;
    gl.uniform3f(u.curve, BLOOM_THRESHOLD - knee, knee * 2, 0.25 / knee);
    gl.uniform1f(u.threshold, BLOOM_THRESHOLD);
    gl.uniform1i(u.uTexture, dye.read.attach(0));
    blit(base);

    u = use('blur');
    gl.uniform1f(u.intensity, 1);
    let last = base;
    for (const target of bloomChain) {
      gl.uniform2f(u.texelSize, last.texelX, last.texelY);
      gl.uniform1i(u.uTexture, last.attach(0));
      blit(target);
      last = target;
    }
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    for (let i = bloomChain.length - 2; i >= 0; i -= 1) {
      const target = bloomChain[i];
      gl.uniform2f(u.texelSize, last.texelX, last.texelY);
      gl.uniform1i(u.uTexture, last.attach(0));
      blit(target);
      last = target;
    }
    gl.disable(gl.BLEND);
    gl.uniform1f(u.intensity, amount);
    gl.uniform2f(u.texelSize, last.texelX, last.texelY);
    gl.uniform1i(u.uTexture, last.attach(0));
    blit(base);
  }

  function render(): void {
    if (settings.glow > 0) applyBloom(2 * settings.glow);
    gl.disable(gl.BLEND);
    const u = use('display');
    gl.uniform2f(u.texelSize, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    gl.uniform1i(u.uTexture, dye.read.attach(0));
    gl.uniform1i(u.uBloom, (bloom ?? dye.read).attach(1));
    gl.uniform1f(u.shading, 1);
    gl.uniform1f(u.bloom, settings.glow > 0 ? 1 : 0);
    blit(null);
  }

  function clearScreen(): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  const pointers = new Map<string, Pointer>();
  const bursts: Array<{ x: number; y: number }> = [];

  function frame(now: number): void {
    raf = 0;
    if (disposed || lost) return;
    syncSize();
    const dt = clamp((now - last) / 1000, 0, 1 / 60);
    last = now;
    pointers.forEach((pointer) => {
      if (!pointer.moved) return;
      pointer.moved = false;
      flush(pointer, dt, now);
    });
    bursts.splice(0).forEach((point) => burst(point.x, point.y, now));
    step(dt);
    render();
    const quiet = (2.2 * settings.trail + 0.5) * 1000;
    if (now - lastActivity < quiet) raf = requestAnimationFrame(frame);
    else clearScreen();
  }

  function wake(): void {
    lastActivity = performance.now();
    if (raf || disposed || lost) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function locate(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = 1 - (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  function track(id: string, clientX: number, clientY: number): void {
    const point = locate(clientX, clientY);
    let pointer = pointers.get(id);
    if (!point) {
      if (pointer) pointer.ready = false;
      return;
    }
    if (!pointer) {
      pointer = { x: 0, y: 0, px: 0, py: 0, ready: false, moved: false, offset: Math.random() };
      pointers.set(id, pointer);
    }
    if (!pointer.ready) {
      pointer.x = pointer.px = point.x;
      pointer.y = pointer.py = point.y;
      pointer.ready = true;
      return;
    }
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.moved = true;
    wake();
  }

  function press(clientX: number, clientY: number): void {
    if (!settings.clickSplash) return;
    const point = locate(clientX, clientY);
    if (!point) return;
    bursts.push(point);
    wake();
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    track(`p${event.pointerId}`, event.clientX, event.clientY);
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    press(event.clientX, event.clientY);
  };
  const onLeave = (): void => {
    pointers.forEach((pointer) => {
      pointer.ready = false;
    });
  };
  const onLost = (event: Event): void => {
    event.preventDefault();
    lost = true;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const sizeObserver = new ResizeObserver(syncSize);
  sizeObserver.observe(canvas);

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('webglcontextlost', onLost);

  return () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerdown', onPointerDown);
    document.documentElement.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('webglcontextlost', onLost);
    sizeObserver.disconnect();
    Object.values(programs).forEach((item) => gl.deleteProgram(item.program));
    dropTargets();
    gl.deleteBuffer(buffer);
    gl.deleteVertexArray(vao);
  };
}
