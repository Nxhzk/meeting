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
