/* 捷士通标志（矢量）：上面蓝色、下面红色两块，互为 180° 旋转；红色那块顶端是渐隐的网点。
   坐标照 static/img/jst/mark.png（105×105）描出来，液态标记的着色器用的是同一组顶点。 */

export const JST_BLUE = '#114A99';
export const JST_RED = '#E84746';
export const BLUE_POINTS = [[20, 80], [20, 18], [53, 0], [86, 18], [70, 27], [53, 17.5], [38, 27], [38, 74]];
export const RED_POINTS = BLUE_POINTS.map(([x, y]) => [106 - x, 104 - y]);

const path = points => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('') + 'Z';

// 红色竖条顶端的网点：越往上点越小
const DOTS = (() => {
    const dots = [];
    for (let y = 26; y < 52; y += 3.6) {
        for (let x = 68.6 + ((y - 26) / 3.6 % 2) * 1.8; x < 86; x += 3.6) {
            const r = 0.35 + 1.75 * ((y - 26) / 26) ** 1.4;
            dots.push([x, y, Math.min(r, 1.9)]);
        }
    }
    return dots;
})();

export function JstMark({ size = 28, className, title }) {
    const id = `jst-dots-${size}`;
    return <svg className={className} width={size} height={size} viewBox="17 -2 72 108" role={title ? 'img' : undefined}
        aria-label={title} aria-hidden={title ? undefined : true}>
        <defs>
            <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="106" height="106">
                <rect x="0" y="50" width="106" height="56" fill="#fff" />
                <rect x="0" y="0" width="66" height="50" fill="#fff" />
                {DOTS.map(([x, y, r]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="#fff" />)}
            </mask>
        </defs>
        <path d={path(BLUE_POINTS)} fill={JST_BLUE} />
        <path d={path(RED_POINTS)} fill={JST_RED} mask={`url(#${id})`} />
    </svg>;
}

/** 头像：白底圆形里放捷士通标志。 */
export function JstAvatar({ size = 34, className = '' }) {
    return <span className={`jst-avatar ${className}`} style={{ width: size, height: size }} aria-hidden="true">
        <JstMark size={Math.round(size * .62)} />
    </span>;
}

/* 加载动画：捷士通标志「拼装」。蓝色那块从左上、红色那块从右下一边画出来一边飞进来，
   在中间咬合时轻轻一弹，右上角的网点逐个亮起；停一下再各自散开，循环。
   形状是标志的简化版（圆角粗线条），两块之间留着标志特有的两处缺口，小尺寸也清楚。
   tone：brand 品牌色（页面里）；current 跟随文字颜色（按钮里）。 */
export function JstLoader({ size = 28, tone = 'brand', label }) {
    return <span className="jst-loader" data-tone={tone} style={{ width: size, height: size }}
        role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
        <svg viewBox="0 0 106 104" width={size} height={size}>
            <g className="jst-loader-body">
                <path className="jst-loader-piece blue" pathLength="100" d="M30 64 V24 L53 11 L74 23" />
                <path className="jst-loader-piece red" pathLength="100" d="M76 40 V80 L53 93 L32 81" />
                <g className="jst-loader-dots">
                    <circle cx="86" cy="32" r="3.4" /><circle cx="93" cy="25" r="2.5" /><circle cx="99" cy="19" r="1.8" />
                </g>
            </g>
        </svg>
    </span>;
}
