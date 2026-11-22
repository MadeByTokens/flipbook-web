// WebGL2 renderer: brush stamps are drawn into an off-screen layer texture at
// document resolution, and the layer is then drawn to the screen over paper.

export type Rgb = readonly [number, number, number];

export interface View {
  /** Device pixels per document pixel. */
  scale: number;
  /** Device-pixel position of the document's top-left corner. */
  x: number;
  y: number;
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

const BLIT_VS = `#version 300 es
layout(location=0) in vec2 aCorner; // -1..1
uniform vec2 uDocSize;
uniform vec4 uXform;
out vec2 vUv;
void main() {
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = vec4(vUv * uDocSize * uXform.xy + uXform.zw, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uLayer;
uniform vec3 uPaper;
out vec4 outColor;
void main() {
  vec4 c = texture(uLayer, vUv);
  outColor = vec4(c.rgb + uPaper * (1.0 - c.a), 1.0);
}`;

const BACKDROP: Rgb = [0.13, 0.14, 0.16];
const PAPER: Rgb = [1, 1, 1];
const FLOATS_PER_STAMP = 3;

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

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private stampProgram!: WebGLProgram;
  private blitProgram!: WebGLProgram;
  private stampVao!: WebGLVertexArrayObject;
  private blitVao!: WebGLVertexArrayObject;
  private stampBuffer!: WebGLBuffer;
  private stampBufferFloats = 0;
  private layerTexture!: WebGLTexture;
  private layerFbo!: WebGLFramebuffer;
  private u!: {
    stampXform: WebGLUniformLocation; stampAA: WebGLUniformLocation; stampColor: WebGLUniformLocation;
    blitXform: WebGLUniformLocation; blitDocSize: WebGLUniformLocation; blitPaper: WebGLUniformLocation;
  };
  view: View = { scale: 1, x: 0, y: 0 };
  contextLost = false;

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
    this.init();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // The drawing is lost with the context in this spike; storage arrives in a later phase.
      this.init();
      this.contextLost = false;
    });
  }

  private init(): void {
    const gl = this.gl;
    this.stampProgram = compile(gl, STAMP_VS, STAMP_FS);
    this.blitProgram = compile(gl, BLIT_VS, BLIT_FS);
    const loc = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name)!;
    this.u = {
      stampXform: loc(this.stampProgram, 'uXform'),
      stampAA: loc(this.stampProgram, 'uAA'),
      stampColor: loc(this.stampProgram, 'uColor'),
      blitXform: loc(this.blitProgram, 'uXform'),
      blitDocSize: loc(this.blitProgram, 'uDocSize'),
      blitPaper: loc(this.blitProgram, 'uPaper'),
    };

    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.blitVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.blitVao);
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

    this.layerTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.docWidth, this.docHeight);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.layerFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.layerTexture, 0);
    this.clearLayer();
    gl.enable(gl.BLEND);
  }

  /** Bytes of GPU memory held by the layer texture. */
  get layerBytes(): number {
    return this.docWidth * this.docHeight * 4;
  }

  clearLayer(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private uploadStamps(batch: StampBatch): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer);
    const view = batch.data.subarray(0, batch.count * FLOATS_PER_STAMP);
    if (batch.data.length > this.stampBufferFloats) {
      gl.bufferData(gl.ARRAY_BUFFER, batch.data.byteLength, gl.DYNAMIC_DRAW);
      this.stampBufferFloats = batch.data.length;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
  }

  private screenXform(): [number, number, number, number] {
    const { scale, x, y } = this.view;
    const w = this.canvas.width;
    const h = this.canvas.height;
    return [(2 * scale) / w, (-2 * scale) / h, (2 * x) / w - 1, 1 - (2 * y) / h];
  }

  /** Draws stamps permanently into the layer. An eraser removes ink instead of adding it. */
  stampToLayer(batch: StampBatch, color: Rgb, erase: boolean): void {
    if (batch.count === 0 || this.contextLost) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.useProgram(this.stampProgram);
    gl.bindVertexArray(this.stampVao);
    this.uploadStamps(batch);
    // Texture row 0 is document row 0, so no vertical flip here.
    gl.uniform4f(this.u.stampXform, 2 / this.docWidth, 2 / this.docHeight, -1, -1);
    gl.uniform1f(this.u.stampAA, 1);
    if (erase) {
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(this.u.stampColor, 0, 0, 0, 1);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(this.u.stampColor, color[0], color[1], color[2], 1);
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  }

  /** Draws the layer to the screen, then `transient` stamps on top for this frame only. */
  present(transient: StampBatch | null, color: Rgb, erase: boolean): void {
    if (this.contextLost) return;
    const gl = this.gl;
    const xform = this.screenXform();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(BACKDROP[0], BACKDROP[1], BACKDROP[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.useProgram(this.blitProgram);
    gl.bindVertexArray(this.blitVao);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
    gl.uniform4f(this.u.blitXform, ...xform);
    gl.uniform2f(this.u.blitDocSize, this.docWidth, this.docHeight);
    gl.uniform3f(this.u.blitPaper, PAPER[0], PAPER[1], PAPER[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

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
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      // With a single layer, erasing looks the same as painting paper colour.
      const c = erase ? PAPER : color;
      gl.uniform4f(this.u.stampColor, c[0], c[1], c[2], 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, transient.count);
      gl.disable(gl.SCISSOR_TEST);
    }
  }

  /** Reads one layer pixel (straight from the layer, ignoring paper). For tests and tools. */
  readLayerPixel(docX: number, docY: number): [number, number, number, number] {
    const gl = this.gl;
    const out = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.readPixels(Math.floor(docX), Math.floor(docY), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0]!, out[1]!, out[2]!, out[3]!];
  }
}
