import { useEffect, useRef } from "react";

const VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;

  uniform sampler2D u_image;
  uniform vec2 u_image_size;
  uniform vec2 u_viewport_size;
  uniform float u_cell_size;
  varying vec2 v_uv;

  float bayer4(vec2 point) {
    float x = mod(point.x, 4.0);
    float y = mod(point.y, 4.0);

    if (y < 1.0) {
      if (x < 1.0) return 0.0;
      if (x < 2.0) return 8.0;
      if (x < 3.0) return 2.0;
      return 10.0;
    }
    if (y < 2.0) {
      if (x < 1.0) return 12.0;
      if (x < 2.0) return 4.0;
      if (x < 3.0) return 14.0;
      return 6.0;
    }
    if (y < 3.0) {
      if (x < 1.0) return 3.0;
      if (x < 2.0) return 11.0;
      if (x < 3.0) return 1.0;
      return 9.0;
    }
    if (x < 1.0) return 15.0;
    if (x < 2.0) return 7.0;
    if (x < 3.0) return 13.0;
    return 5.0;
  }

  void main() {
    float viewport_aspect = u_viewport_size.x / u_viewport_size.y;
    float image_aspect = u_image_size.x / u_image_size.y;
    vec2 image_uv = v_uv;

    if (image_aspect > viewport_aspect) {
      image_uv.x = (image_uv.x - 0.5) * (viewport_aspect / image_aspect) + 0.5;
    } else {
      image_uv.y = (image_uv.y - 0.5) * (image_aspect / viewport_aspect) + 0.5;
    }

    vec3 color = texture2D(u_image, image_uv).rgb;
    float threshold = (bayer4(floor(gl_FragCoord.xy / u_cell_size)) + 0.5) / 16.0;
    const float levels = 6.0;
    vec3 dithered = floor(color * (levels - 1.0) + threshold) / (levels - 1.0);
    gl_FragColor = vec4(dithered, 1.0);
  }
`;

function compileShader(
  context: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = context.createShader(type);
  if (!shader) return null;
  context.shaderSource(shader, source);
  context.compileShader(shader);
  if (context.getShaderParameter(shader, context.COMPILE_STATUS)) return shader;
  context.deleteShader(shader);
  return null;
}

function createProgram(context: WebGLRenderingContext): WebGLProgram | null {
  const vertexShader = compileShader(context, context.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) context.deleteShader(vertexShader);
    if (fragmentShader) context.deleteShader(fragmentShader);
    return null;
  }

  const program = context.createProgram();
  if (!program) return null;
  context.attachShader(program, vertexShader);
  context.attachShader(program, fragmentShader);
  context.linkProgram(program);
  context.deleteShader(vertexShader);
  context.deleteShader(fragmentShader);
  if (context.getProgramParameter(program, context.LINK_STATUS)) return program;
  context.deleteProgram(program);
  return null;
}

export function DitheredWallpaperCanvas({ url }: { readonly url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!context) return;

    const program = createProgram(context);
    if (!program) return;
    const positionLocation = context.getAttribLocation(program, "a_position");
    const imageSizeLocation = context.getUniformLocation(program, "u_image_size");
    const viewportSizeLocation = context.getUniformLocation(program, "u_viewport_size");
    const cellSizeLocation = context.getUniformLocation(program, "u_cell_size");
    const buffer = context.createBuffer();
    const texture = context.createTexture();
    if (!buffer || !texture || positionLocation < 0) {
      context.deleteProgram(program);
      if (buffer) context.deleteBuffer(buffer);
      if (texture) context.deleteTexture(texture);
      return;
    }

    context.useProgram(program);
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(
      context.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      context.STATIC_DRAW,
    );
    context.enableVertexAttribArray(positionLocation);
    context.vertexAttribPointer(positionLocation, 2, context.FLOAT, false, 0, 0);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, 1);

    let disposed = false;
    let animationFrame = 0;
    const image = new Image();

    const render = () => {
      animationFrame = 0;
      if (disposed || !image.naturalWidth || !image.naturalHeight) return;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.viewport(0, 0, width, height);
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texImage2D(
        context.TEXTURE_2D,
        0,
        context.RGBA,
        context.RGBA,
        context.UNSIGNED_BYTE,
        image,
      );
      context.uniform2f(imageSizeLocation, image.naturalWidth, image.naturalHeight);
      context.uniform2f(viewportSizeLocation, width, height);
      context.uniform1f(cellSizeLocation, pixelRatio);
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    };

    const queueRender = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(render);
    };
    image.addEventListener("load", queueRender, { once: true });
    image.src = url;
    const resizeObserver = new ResizeObserver(queueRender);
    resizeObserver.observe(canvas);

    return () => {
      disposed = true;
      image.removeEventListener("load", queueRender);
      resizeObserver.disconnect();
      if (animationFrame) cancelAnimationFrame(animationFrame);
      context.deleteTexture(texture);
      context.deleteBuffer(buffer);
      context.deleteProgram(program);
    };
  }, [url]);

  return <canvas aria-hidden className="app-wallpaper__dither" ref={canvasRef} />;
}
