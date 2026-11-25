import { useEffect, useRef } from 'react';

/* 液态球体：WebGL 片元着色器。
   3D simplex 噪声做表面起伏（边缘随时间流动），内部用两层域扭曲（domain
   warping）的分形噪声做旋转的液态纹理，再加菲涅尔边缘光和高光。
   energy 控制流动速度和起伏幅度（0 平静 ~ 1 活跃），变化时平滑过渡。
   不支持 WebGL、或系统要求减少动态效果时，退回静态的一帧 / CSS 球。 */

const VERTEX = `
attribute vec2 p;
varying vec2 uv;
void main() { uv = p; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAGMENT = `
precision highp float;
varying vec2 uv;
uniform float t;
uniform float energy;
uniform float dark;

// Ashima simplex noise 3D (MIT)
vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p) {
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++) { v += a * snoise(p); p *= 1.85; a *= 0.45; }
  return v;
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  vec2 q = uv;
  float r = length(q);
  float ang = atan(q.y, q.x);
  float speed = 0.35 + energy * 0.65;

  // 边缘：低频噪声驱动的缓慢起伏，像一滴悬浮的液体
  vec3 dir = vec3(cos(ang), sin(ang), 0.0);
  float wobble = snoise(dir * 0.85 + vec3(0.0, 0.0, t * 0.32 * speed)) * 0.65
               + snoise(dir * 1.6 + vec3(3.1, 0.0, t * 0.5 * speed)) * 0.3;
  float radius = 0.72 + wobble * (0.035 + energy * 0.045);
  float edge = radius - r;
  float body = smoothstep(0.0, 0.018, edge);

  // 球面坐标：让内部纹理像贴在会转动的球上
  float z = sqrt(max(0.0, 1.0 - (r * r) / (radius * radius)));
  vec3 n = normalize(vec3(q / radius, z));
  vec3 sp = n * 0.55;
  sp.xz *= rot(t * 0.22 * speed);
  sp.xy *= rot(t * 0.1 * speed);

  // 双层域扭曲：大尺度、慢速的液态涡旋
  float tt = t * 0.12 * speed;
  vec3 w1 = vec3(fbm(sp + vec3(0.0, 0.0, tt)), fbm(sp + vec3(5.2, 1.3, tt)), fbm(sp + vec3(2.1, 7.7, tt)));
  vec3 w2 = vec3(fbm(sp + 1.1 * w1 + vec3(1.7, 9.2, tt * 1.4)), fbm(sp + 1.1 * w1 + vec3(8.3, 2.8, tt * 1.3)), 0.0);
  float f = fbm(sp * 0.7 + 1.3 * w2);

  // 三色：深蓝 → 紫罗兰 → 粉，按噪声平滑过渡
  vec3 deep = vec3(0.10, 0.30, 1.00);
  vec3 violet = vec3(0.52, 0.30, 1.00);
  vec3 pink = vec3(1.00, 0.42, 0.78);
  float k = clamp(f * 0.85 + 0.5, 0.0, 1.0);
  vec3 col = mix(deep, violet, smoothstep(0.15, 0.6, k));
  col = mix(col, pink, smoothstep(0.55, 0.95, k) * (0.55 + energy * 0.35));
  // 液体里缓慢流动的柔光带
  float bands = smoothstep(0.5, 0.0, abs(sin((f + w2.x) * 3.2 + t * 0.45 * speed)));
  col = mix(col, vec3(0.85, 0.9, 1.0), bands * (0.10 + energy * 0.10));
  col *= 0.72 + 0.45 * z;                        // 体积感
  vec3 c1 = deep;
  vec3 c2 = violet;

  // 菲涅尔边缘光 + 高光
  float fres = pow(1.0 - z, 2.6);
  col += fres * vec3(0.55, 0.75, 1.0) * 0.9;
  vec3 light = normalize(vec3(-0.45, 0.55, 0.75));
  float spec = pow(max(dot(n, light), 0.0), 36.0);
  col += spec * 0.7;
  float spec2 = pow(max(dot(n, normalize(vec3(0.5, -0.6, 0.6))), 0.0), 12.0);
  col += spec2 * vec3(0.6, 0.4, 1.0) * 0.18;

  // 外圈柔光
  float glow = exp(-max(r - radius, 0.0) * 11.0) * (1.0 - body) * (0.30 + energy * 0.25) * smoothstep(0.98, 0.8, r);
  vec3 glowCol = mix(c1, c2, 0.5 + 0.5 * sin(ang * 2.0 + t * 0.6));

  float alpha = max(body, glow);
  vec3 outCol = body > 0.0 ? mix(glowCol, col, body) : glowCol;
  gl_FragColor = vec4(outCol * alpha, alpha);   // 预乘 alpha
}`;

function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
}

export function LiquidOrb({ size = 72, energy = 0.5, label }) {
    const canvas = useRef(null);
    const target = useRef(energy);
    const fallback = useRef(false);
    target.current = energy;

    useEffect(() => {
        const node = canvas.current;
        const gl = node.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: true });
        if (!gl) { fallback.current = true; node.dataset.fallback = 'true'; return; }
        let program;
        try {
            program = gl.createProgram();
            gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
            gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        } catch {
            node.dataset.fallback = 'true';
            return;
        }
        gl.useProgram(program);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(program, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        const uT = gl.getUniformLocation(program, 't');
        const uEnergy = gl.getUniformLocation(program, 'energy');
        gl.uniform1f(gl.getUniformLocation(program, 'dark'), matchMedia('(prefers-color-scheme: dark)').matches ? 1 : 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        node.width = node.height = Math.round(size * dpr);
        gl.viewport(0, 0, node.width, node.height);

        const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
        let frame = 0;
        let visible = true;
        let current = target.current;
        let last = performance.now();
        let clock = Math.random() * 100;   // 每个球从不同的形态开始
        const draw = now => {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            current += (target.current - current) * Math.min(1, dt * 2.5);   // 能量平滑过渡
            clock += dt * (0.8 + current * 0.9);
            gl.uniform1f(uT, clock);
            gl.uniform1f(uEnergy, current);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            if (!still && visible && !document.hidden) frame = requestAnimationFrame(draw);
        };
        const resume = () => {
            cancelAnimationFrame(frame);
            last = performance.now();
            if (!still && visible && !document.hidden) frame = requestAnimationFrame(draw);
        };
        const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; resume(); });
        observer.observe(node);
        document.addEventListener('visibilitychange', resume);
        draw(performance.now());
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            document.removeEventListener('visibilitychange', resume);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        };
    }, [size]);

    return <span className="liquid-orb" style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
        <canvas ref={canvas} style={{ width: size, height: size }} />
    </span>;
}
