// WebGL2 renderer. Each drawing (cel) is a texture at document resolution.
// Brush stamps are drawn into the current cel; the screen shows paper, onion
// skins, the cel, and this frame's temporary ink on top.

export type Rgb = readonly [number, number, number];

export interface View {
  /** Device pixels per document pixel. */
  scale: number;
  /** Device-pixel position of the document's top-left corner. */
  x: number;
  y: number;
}

export interface OnionSkin {
  cel: number;
  /** Replace the ink colour with this one, or null to keep the drawing's colours. */
  tint: Rgb | null;
  opacity: number;
}

export interface Scene {
  cel: number | null;
  onion: readonly OnionSkin[];
  /** Stamps drawn on screen for this frame only (ink that is not committed yet). */
  transient: StampBatch | null;
  colour: Rgb;
}

const STAMP_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aStamp; // x, y, radius in document pixels
uniform vec4 uXform; // clip = doc * xy + zw
uniform float uAA;   // one target pixel, in document pixels
out vec2 vLocal;
out float vRadius;
void main() {
  float extent = aStamp.z + uAA;
  vLocal = aCorner * extent;
  vRadius = aStamp.z;
  gl_Position = vec4((aStamp.xy + vLocal) * uXform.xy + uXform.zw, 0.0, 1.0);
}`;

const STAMP_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vRadius;
uniform vec4 uColor; // premultiplied
uniform float uAA;
out vec4 outColor;
void main() {
  float coverage = clamp((vRadius - length(vLocal)) / uAA + 0.5, 0.0, 1.0);
  outColor = uColor * coverage;
}`;

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aCorner; // -1..1
uniform vec2 uDocSize;
uniform vec4 uXform;
out vec2 vUv;
void main() {
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = vec4(vUv * uDocSize * uXform.xy + uXform.zw, 0.0, 1.0);
}`;

const QUAD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uTint;     // rgb, amount
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv);
  outColor = vec4(mix(c.rgb, uTint.rgb * c.a, uTint.a), c.a) * uOpacity;
}`;

const BACKDROP: Rgb = [0.13, 0.14, 0.16];
const PAPER: Rgb = [1, 1, 1];
const FLOATS_PER_STAMP = 3;
export const THUMB_W = 480;
export const THUMB_H = 270;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/** A growable list of stamps, reused between frames to avoid allocation. */
export class StampBatch {
  data = new Float32Array(FLOATS_PER_STAMP * 1024);
  count = 0;

  readonly push = (x: number, y: number, radius: number): void => {
    const i = this.count * FLOATS_PER_STAMP;
    if (i + FLOATS_PER_STAMP > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[i] = x;
    this.data[i + 1] = y;
    this.data[i + 2] = radius;
    this.count++;
  };

  clear(): void {
    this.count = 0;
  }
}

type Xform = [number, number, number, number];

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private stampProgram!: WebGLProgram;
  private quadProgram!: WebGLProgram;
  private stampVao!: WebGLVertexArrayObject;
  private quadVao!: WebGLVertexArrayObject;
  private stampBuffer!: WebGLBuffer;
  private stampBufferFloats = 0;
  private drawFbo!: WebGLFramebuffer;
  private readFbo!: WebGLFramebuffer;
  private backup!: WebGLTexture;
  private white!: WebGLTexture;
  private thumb!: WebGLTexture;
  private readonly cels = new Map<number, WebGLTexture>();
  private readonly zeros: Uint8Array;
  private u!: Record<
    'stampXform' | 'stampAA' | 'stampColor' | 'quadXform' | 'quadDocSize' | 'quadTint' | 'quadOpacity',
    WebGLUniformLocation
  >;
  view: View = { scale: 1, x: 0, y: 0 };
  contextLost = false;
  /** Called after the GPU context was lost and rebuilt; every cel texture is gone. */
  onRestored: () => void = () => {};

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly docWidth: number,
    readonly docHeight: number,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.zeros = new Uint8Array(docWidth * 4 * 256);
    this.init();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.cels.clear();
      this.init();
      this.contextLost = false;
      this.onRestored();
    });
  }

  private makeTexture(width: number, height: number, filter: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Storage allocated this way starts out fully transparent.
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private init(): void {
    const gl = this.gl;
    this.stampProgram = compile(gl, STAMP_VS, STAMP_FS);
    this.quadProgram = compile(gl, QUAD_VS, QUAD_FS);
    const loc = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name)!;
    this.u = {
      stampXform: loc(this.stampProgram, 'uXform'),
      stampAA: loc(this.stampProgram, 'uAA'),
      stampColor: loc(this.stampProgram, 'uColor'),
      quadXform: loc(this.quadProgram, 'uXform'),
      quadDocSize: loc(this.quadProgram, 'uDocSize'),
      quadTint: loc(this.quadProgram, 'uTint'),
      quadOpacity: loc(this.quadProgram, 'uOpacity'),
    };

    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.stampVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.stampVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.stampBuffer = gl.createBuffer()!;
    this.stampBufferFloats = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, FLOATS_PER_STAMP, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    this.drawFbo = gl.createFramebuffer()!;
    this.readFbo = gl.createFramebuffer()!;
    this.backup = this.makeTexture(this.docWidth, this.docHeight, gl.NEAREST);
    this.thumb = this.makeTexture(THUMB_W, THUMB_H, gl.NEAREST);
    this.white = this.makeTexture(1, 1, gl.NEAREST);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.enable(gl.BLEND);
  }

  // --- cels -------------------------------------------------------------------

  get celCount(): number {
    return this.cels.size;
  }

  /** Bytes of GPU memory held by drawings and the undo backup. */
  get gpuBytes(): number {
    return (this.cels.size + 1) * this.docWidth * this.docHeight * 4;
  }

  hasCel(id: number): boolean {
    return this.cels.has(id);
  }

  /** Creates an empty, fully transparent cel. */
  createCel(id: number): void {
    if (this.cels.has(id)) this.deleteCel(id);
    this.cels.set(id, this.makeTexture(this.docWidth, this.docHeight, this.gl.LINEAR));
  }

  deleteCel(id: number): void {
    const tex = this.cels.get(id);
    if (tex) this.gl.deleteTexture(tex);
    this.cels.delete(id);
  }

  private tex(id: number): WebGLTexture {
    const tex = this.cels.get(id);
    if (!tex) throw new Error(`Cel ${id} is not loaded`);
    return tex;
  }

  private target(tex: WebGLTexture): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.drawFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  }

  private copy(from: WebGLTexture, to: WebGLTexture): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, from, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.drawFbo);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, to, 0);
    const w = this.docWidth;
    const h = this.docHeight;
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  copyCel(from: number, to: number): void {
    this.createCel(to);
    this.copy(this.tex(from), this.tex(to));
  }

  /** Remembers the cel as it is now, so the stroke can be diffed or cancelled. */
  beginStroke(id: number): void {
    this.copy(this.tex(id), this.backup);
  }

  /** Puts the cel back to how it was at `beginStroke`. */
  cancelStroke(id: number): void {
    this.copy(this.backup, this.tex(id));
  }

  /** Reads RGBA bytes from a cel, or from the stroke backup. Row 0 is the top of the document. */
  readRegion(source: number | 'backup', x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      source === 'backup' ? this.backup : this.tex(source), 0,
    );
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  /** Overwrites a rectangle of a cel; null clears it. */
  writeRegion(id: number, x: number, y: number, w: number, h: number, data: Uint8Array | null): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex(id));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data ?? this.zeros.subarray(0, w * h * 4));
  }

  // --- drawing ----------------------------------------------------------------

  private uploadStamps(batch: StampBatch): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer);
    if (batch.data.length > this.stampBufferFloats) {
      gl.bufferData(gl.ARRAY_BUFFER, batch.data.byteLength, gl.DYNAMIC_DRAW);
      this.stampBufferFloats = batch.data.length;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data.subarray(0, batch.count * FLOATS_PER_STAMP));
  }

  /** Document row 0 maps to texture row 0, so off-screen targets need no vertical flip. */
  private docXform(): Xform {
    return [2 / this.docWidth, 2 / this.docHeight, -1, -1];
  }

  private screenXform(): Xform {
    const { scale, x, y } = this.view;
    const w = this.canvas.width;
    const h = this.canvas.height;
    return [(2 * scale) / w, (-2 * scale) / h, (2 * x) / w - 1, 1 - (2 * y) / h];
  }

  /** Draws stamps permanently into a cel. An eraser removes ink instead of adding it. */
  stampToCel(id: number, batch: StampBatch, colour: Rgb, erase: boolean): void {
    if (batch.count === 0 || this.contextLost) return;
    const gl = this.gl;
    this.target(this.tex(id));
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.useProgram(this.stampProgram);
    gl.bindVertexArray(this.stampVao);
    this.uploadStamps(batch);
    gl.uniform4f(this.u.stampXform, ...this.docXform());
    gl.uniform1f(this.u.stampAA, 1);
    if (erase) {
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(this.u.stampColor, 0, 0, 0, 1);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(this.u.stampColor, colour[0], colour[1], colour[2], 1);
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  }

  private quad(tex: WebGLTexture, xform: Xform, tint: Rgb | null, opacity: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform4f(this.u.quadXform, ...xform);
    gl.uniform4f(this.u.quadTint, tint?.[0] ?? 0, tint?.[1] ?? 0, tint?.[2] ?? 0, tint ? 1 : 0);
    gl.uniform1f(this.u.quadOpacity, opacity);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private layers(scene: Pick<Scene, 'cel' | 'onion'>, xform: Xform): void {
    const gl = this.gl;
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.quadProgram);
    gl.bindVertexArray(this.quadVao);
    gl.uniform2f(this.u.quadDocSize, this.docWidth, this.docHeight);
    this.quad(this.white, xform, PAPER, 1);
    for (const skin of scene.onion) {
      const tex = this.cels.get(skin.cel);
      if (tex) this.quad(tex, xform, skin.tint, skin.opacity);
    }
    const tex = scene.cel === null ? undefined : this.cels.get(scene.cel);
    if (tex) this.quad(tex, xform, null, 1);
  }

  /** Draws the scene to the screen. */
  present(scene: Scene): void {
    if (this.contextLost) return;
    const gl = this.gl;
    const xform = this.screenXform();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(BACKDROP[0], BACKDROP[1], BACKDROP[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.layers(scene, xform);

    const transient = scene.transient;
    if (transient && transient.count > 0) {
      // Keep temporary ink inside the paper.
      const { scale, x, y } = this.view;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(
        Math.round(x),
        Math.round(this.canvas.height - y - this.docHeight * scale),
        Math.round(this.docWidth * scale),
        Math.round(this.docHeight * scale),
      );
      gl.useProgram(this.stampProgram);
      gl.bindVertexArray(this.stampVao);
      this.uploadStamps(transient);
      gl.uniform4f(this.u.stampXform, ...xform);
      gl.uniform1f(this.u.stampAA, 1 / scale);
      gl.uniform4f(this.u.stampColor, scene.colour[0], scene.colour[1], scene.colour[2], 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, transient.count);
      gl.disable(gl.SCISSOR_TEST);
    }
  }

  /** Renders a cel over paper at thumbnail size and returns its pixels, top row first. */
  thumbnail(id: number): Uint8ClampedArray<ArrayBuffer> {
    const gl = this.gl;
    const out = new Uint8ClampedArray(THUMB_W * THUMB_H * 4);
    this.target(this.thumb);
    gl.viewport(0, 0, THUMB_W, THUMB_H);
    this.layers({ cel: id, onion: [] }, this.docXform());
    gl.readPixels(0, 0, THUMB_W, THUMB_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  /** One pixel of a cel (not including paper). For tests and tools. */
  readCelPixel(id: number, docX: number, docY: number): [number, number, number, number] {
    const p = this.readRegion(id, Math.floor(docX), Math.floor(docY), 1, 1);
    return [p[0]!, p[1]!, p[2]!, p[3]!];
  }

  /**
   * One pixel of what is on screen at a document position. Only valid straight
   * after `present`, before the browser has shown the frame.
   */
  readScreenPixel(docX: number, docY: number): [number, number, number, number] {
    const gl = this.gl;
    const out = new Uint8Array(4);
    const px = Math.floor(this.view.x + docX * this.view.scale);
    const py = Math.floor(this.canvas.height - (this.view.y + docY * this.view.scale) - 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0]!, out[1]!, out[2]!, out[3]!];
  }
}
