/* ════════════════════════════════════════════════════════════
   「五个领域」实时三维沙盘 · sol3d.js
   three.js r170（ES Module），没有别的依赖。信中伟业官网「解决方案」板块使用：
   页面滚到哪个领域，沙盘就切到哪个领域。

   ▍用法
     import * as THREE from './vendor/three.module.min.js';
     import { create } from './sol3d.js';
     const sol = await create(canvas, THREE, { start: 0 });
     sol.goTo(2);   // 切到第 3 个领域（从 0 数），按时间播放；往回切会倒着放
     opts 可选：start   初始领域（默认 0）
               duration 每切一格用几秒（默认 1.6；跨两格以上按 √格数 加长）
               dof      false = 关掉移轴景深
               dust     true  = 打开光柱里的浮尘

   ▍坐标和单位（看懂下面这些数字的关键）
     - 台面是半径 R = 1 的圆，圆心在原点。x 向右，z 朝向镜头（屏幕下方），y 向上。
       所以布局里的坐标都在 -1 ~ 1 之间：z 为负 = 台面远处（画面上方），z 为正 = 台面近处（画面下方）。
     - 一层楼高 0.021，约 3.5 米，所以 1 个单位约 170 米，整个台面直径约 340 米。
     - 角度绕 y 轴，0 = +x 方向。
     - 代码里的 [r, g, b] 颜色都是线性空间的 0~1（三维渲染用），比网页颜色看起来深；
       地貌图里写的 '#xxxxxx' 是普通网页颜色（sRGB）。

   ▍文件结构（从上到下）
     §1  渲染器、场景、相机、转台
     §2  环境反射与灯光
     §3  台面地貌材质：两个领域的地面图之间从圆心扫开过渡
     §4  台座侧面的土层剖面、展台、地面
     §5  建筑材质：按楼层程序化画窗、夜里亮灯；常用颜色
     §6  几何工具：挤出、合并
     §7  折线 / 路径工具：道路、车道、步行路线共用
     §8  地貌画布 terrain()：在 2D canvas 上按世界坐标画地面、道路、停车场
     §9  场景对象登记（属于哪个领域、什么时候升起）与建筑生成器 tower / slab
     §10 活物：车流、停车、行人、树、路灯、喷泉、树林
     §11 五个领域的具体布置 ← 想改场景内容，主要看这一节
         §11-1 智慧城市   §11-2 智慧政务   §11-3 教育医疗   §11-4 金融保险   §11-5 能源智造
     §12 光柱与浮尘
     §13 后期：环境光遮蔽、泛光、景深、ACES 调色、颗粒、边缘羽化
     §14 画布尺寸、镜头距离、自适应画质
     §15 切换状态机 goTo / update
     §16 每帧循环与对外接口

   ▍一帧里发生了什么
     update() 推进状态 s → 每个物体按自己的先后（delay）算出升起高度 → 地面和土层的扫开进度
     → anim 列表里的动画各自更新（车、人、羊、风机、国旗…）→ 转台慢慢来回摆、镜头跟随鼠标
     → renderFrame()：场景渲染到 HDR 缓冲，再做后期，输出到画布
   ════════════════════════════════════════════════════════════ */

// 五个领域：name 只是给外部读的；accent 是领域色（和页面左侧色点同色），只用在切换时的扫光上
const DOMAINS = [
  { name: '智慧城市', accent: [1.00, 0.42, 0.10] },
  { name: '智慧政务', accent: [0.20, 0.42, 1.00] },
  { name: '教育医疗', accent: [0.12, 0.85, 0.42] },
  { name: '金融保险', accent: [1.00, 0.50, 0.24] },
  { name: '能源智造', accent: [1.00, 0.86, 0.66] },
];
const R = 1.0;          // 台面半径（世界坐标的基本单位）
const PH = 0.22;        // 台座总高度（土层 + 底下的展台）

export async function create(canvas, THREE, opts = {}) {
  const T = THREE;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };   // x 从 a 到 b 时平滑地从 0 变到 1
  const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;                         // 缓入缓出（三次）
  // 固定种子的随机数：每次打开页面，树的位置、车的颜色、窗户亮灯都一样，方便对着截图提意见
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  /* ── §1 渲染器、场景、相机、转台 ──────────────────────────
     渲染器只输出线性颜色、不做色调映射：这两步放到 §13 后期里统一做 */
  const renderer = new T.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
  renderer.outputColorSpace = T.LinearSRGBColorSpace;
  renderer.toneMapping = T.NoToneMapping;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 1);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(26, 1, 0.1, 40);     // 26° 的窄视角，像长焦镜头拍沙盘，透视不夸张
  const turntable = new T.Group(); scene.add(turntable);       // 转台：台座和所有领域的物体都挂在它下面，一起慢慢摆动
  // 物体“升起 / 沉下”其实是整体上下平移；台面（y = 0）以下的部分用这个裁剪面切掉，看起来就像从地里长出来
  const CLIP = [new T.Plane(new T.Vector3(0, 1, 0), 0)];
  const U = { time: { value: 0 } };                            // 共享的时间（秒），国旗飘动、草摆动、光柱起伏都用它

  /* ── §2 环境反射与灯光 ─────────────────────────────────
     环境反射：一个暗色摄影棚 + 三块发光板，预先烘成环境贴图；玻璃幕墙、水面、展台清漆里能看到它们的倒影 */
  {
    const env = new T.Scene();
    const box = new T.Mesh(new T.BoxGeometry(20, 12, 20), new T.MeshBasicMaterial({ color: new T.Color(0.004, 0.004, 0.005), side: T.BackSide }));
    box.position.y = 4; env.add(box);
    const panel = (w, h, c, pos, look) => {
      const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(...c), side: T.DoubleSide }));
      m.position.set(...pos); m.lookAt(...look); env.add(m);
    };
    panel(4.5, 3.0, [7.0, 5.2, 3.6], [-3.5, 6.5, 2.5], [0, 0, 0]);      // 暖色主光柔光箱（左上，跟聚光灯同方向）
    panel(0.8, 5.0, [1.2, 1.6, 2.4], [5.5, 3.0, -4.5], [0, 1, 0]);      // 冷色轮廓光灯条（右后）
    panel(6.0, 0.6, [0.6, 0.55, 0.5], [0, 7.5, -6], [0, 0, 0]);         // 顶部弱条光，给台面边缘一道高光
    const pm = new T.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(env, 0.02).texture;
    scene.environmentIntensity = 0.7;
    pm.dispose();
  }

  /* 灯光：左上方一盏暖色聚光灯（主光，投影子）+ 右后方冷色轮廓光 + 很弱的天空补光。
     整体是“夜景展厅里一束射灯打在沙盘上”的感觉，所以周围是黑的 */
  const key = new T.SpotLight(new T.Color(1.0, 0.80, 0.58), 85, 0, 0.36, 0.7, 2);   // 颜色、强度、距离(0=不限)、光锥半角(弧度)、边缘柔和度、衰减
  key.position.set(-3.0, 3.3, 1.0); key.target.position.set(0.05, 0, 0);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0002; key.shadow.normalBias = 0.004;
  key.shadow.camera.near = 2.5; key.shadow.camera.far = 7.5;
  scene.add(key, key.target);
  const rim = new T.DirectionalLight(new T.Color(0.55, 0.68, 1.0), 0.9); rim.position.set(3, 2.2, -3.2); scene.add(rim);
  const fill = new T.HemisphereLight(new T.Color(0.30, 0.34, 0.42), new T.Color(0.05, 0.04, 0.035), 0.32); scene.add(fill);

  /* 共用 GLSL 噪声函数（§3~§5 的着色器都会拼进去）：xzH 哈希随机，xzN 平滑噪声，xzF 五层叠加的分形噪声 */
  const NOISE = /* glsl */`
    float xzH(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float xzN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
      return mix(mix(xzH(i), xzH(i + vec2(1, 0)), f.x), mix(xzH(i + vec2(0, 1)), xzH(i + vec2(1, 1)), f.x), f.y); }
    float xzF(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 5; i++){ s += a * xzN(p); p = p * 2.03 + vec2(17.1, 9.2); a *= .5; } return s; }`;

  const TAU = Math.PI * 2;

  /* ── §3 台面地貌材质 ───────────────────────────────────
     每个领域在 §8 里画好两张图：颜色图 + 材质图（R = 粗糙度，G = 是否草地，B = 夜间路灯光斑）。
     台面同时拿着“当前领域 A”和“下一个领域 B”两张图，切换时以圆心为起点、半径 uWipe 的圆往外扩，
     圆内显示 B，圆外显示 A；扩的那条边上有一圈领域色的光（uSeam）。
     uniform：tCA/tMA = 领域 A 的颜色图/材质图，tCB/tMB = 领域 B 的；uWipe = 扫开半径；
              uSeam/uSeamOn = 扫光颜色和强度；uLA/uLB = A、B 两个领域路灯光斑的亮度（0~1，跟楼窗亮灯同步） */
  const blank = new T.DataTexture(new Uint8Array([12, 12, 13, 255]), 1, 1); blank.needsUpdate = true;
  const terrU = {
    tCA: { value: blank }, tMA: { value: blank }, tCB: { value: blank }, tMB: { value: blank },
    uWipe: { value: 0 }, uSeam: { value: new T.Color() }, uSeamOn: { value: 0 }, uLA: { value: 0 }, uLB: { value: 0 },
  };
  const terrM = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, envMapIntensity: 0.7 });
  terrM.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, terrU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vTP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTP = position.xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vTP; uniform sampler2D tCA, tMA, tCB, tMB; uniform float uWipe, uSeamOn, uLA, uLB; uniform vec3 uSeam;
      vec3 tMat; float tW, tR;
      ${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 tuv = vTP * ${(0.5 / R).toFixed(4)} + 0.5;
        tR = length(vTP);
        tW = 1.0 - smoothstep(uWipe - 0.018, uWipe, tR);
        vec3 tcol = mix(texture2D(tCA, tuv).rgb, texture2D(tCB, tuv).rgb, tW);
        tMat = mix(texture2D(tMA, tuv).rgb, texture2D(tMB, tuv).rgb, tW);
        // 草地上叠三层噪声（细碎 / 中等 / 大片），只作用在材质图 G 通道标成草地的地方
        float g1 = xzN(vTP * 620.0), g2 = xzN(vTP * 170.0 + 7.0), g3 = xzF(vTP * 26.0 + 3.0);
        tcol *= mix(0.95 + 0.10 * g1, (0.74 + 0.42 * g1 * g2) * (0.82 + 0.36 * g3), tMat.g);   // 草地有细碎的深浅，路面只有一点颗粒
        float tl = dot(tcol, vec3(0.2126, 0.7152, 0.0722)), dryP = smoothstep(0.42, 0.78, xzF(vTP * 5.0 + 21.0));
        tcol = mix(tcol, mix(vec3(tl), vec3(tl * 1.32, tl * 1.12, tl * 0.55), 0.55 + 0.45 * dryP), tMat.g * (0.2 + 0.22 * dryP));   // 草色压一点饱和，带几片发黄的草
        diffuseColor.rgb = tcol;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(tMat.r, 0.04, 1.0);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.70, 0.40) * tMat.b * mix(uLA, uLB, tW) * 0.30;     // 路灯照在地上的光斑
        float sd = abs(tR - uWipe);                                                             // 离扫光边缘的距离：一条细亮线 + 一圈淡淡的光晕
        totalEmissiveRadiance += uSeam * uSeamOn * (exp(-sd / 0.008) * 3.2 + exp(-sd / 0.05) * 0.35);`);
  };
  terrM.customProgramCacheKey = () => 'terrain';
  /* ── §4 台座侧面：土层剖面 + 展台 + 地面 ───────────────────
     侧面像把一块地切下来看到的断面，各领域不一样：
       城市、金融：碎石垫层 → 黑土 → 黏土 → 岩层
       政务、校园：黑土 → 黏土 → 岩层
       能源（草原）：黑土 → 黄土 → 砂砾
     最上面薄薄一层直接取台面边缘的颜色，所以草地边上是草皮，广场边上是石材。
     切换时，新领域的土层在台面扫完之后从上往下换（uK = 已经换到的深度，0~1）。
     土层下面垫一圈深色展台（高 SB）。 */
  const sideU = { uDA: { value: 0 }, uDB: { value: 0 }, uK: { value: 0 } };
  const SB = 0.024, SH = PH - SB;     // SB 展台高度，SH 土层高度
  const earthM = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, envMapIntensity: 0.9 });
  earthM.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, terrU, sideU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vMP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMP = transformed;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vMP; uniform sampler2D tCA, tCB; uniform float uDA, uDB, uK, uSeamOn; uniform vec3 uSeam; float eR;
      ${NOISE}
      // d = 领域编号，t = 深度（0 顶面 ~ 1 底），q = 侧面展开坐标，top = 台面边缘颜色；返回颜色，r 输出粗糙度
      vec3 strata(float d, float t, vec2 q, vec3 top, out float r){
        float n1 = xzN(q * 300.0), n2 = xzN(q * vec2(36.0, 140.0) + 5.0), peb = smoothstep(0.74, 0.84, xzN(q * 560.0 + 9.0));
        vec3 soil = vec3(0.075, 0.05, 0.032) * (0.75 + 0.5 * n2) + peb * 0.04;
        vec3 loess = vec3(0.40, 0.27, 0.14) * (0.82 + 0.3 * n2) * (1.0 - 0.25 * smoothstep(0.8, 0.9, xzN(vec2(q.x * 90.0, q.y * 8.0))));
        vec3 clay = vec3(0.27, 0.13, 0.07) * (0.82 + 0.35 * n2);
        vec3 grav = mix(vec3(0.17, 0.16, 0.15), vec3(0.42, 0.40, 0.36), peb) * (0.8 + 0.4 * n1);
        vec3 rock = vec3(0.19, 0.175, 0.16) * (0.7 + 0.6 * xzN(q * vec2(24.0, 50.0) + 2.0));
        r = 0.92;
        if (t < 0.045) { r = 0.8; return top * (0.75 + 0.2 * n1); }
        if (d > 3.5) { if (t < 0.22) return soil; if (t < 0.64) return loess; return grav; }                    // 草原
        if (d > 2.5 || d < 0.5) { if (t < 0.15) return grav; if (t < 0.32) return soil; if (t < 0.66) return clay; return rock; }   // 城市、金融
        if (t < 0.26) return soil; if (t < 0.62) return clay; return rock;                                        // 政务、校园
      }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 q = vec2(atan(vMP.z, vMP.x) * ${R.toFixed(3)}, vMP.y);
        // dep：深度 0~1；wob：让土层分界线有一点起伏，不是一刀切的直线
        float dep = -vMP.y / ${SH.toFixed(4)}, wob = (xzF(vec2(q.x * 7.0, 3.0)) - 0.5) * 0.08 + (xzN(vec2(q.x * 60.0, 1.0)) - 0.5) * 0.015;
        vec2 euv = normalize(vMP.xz) * 0.497 + 0.5;
        float rA, rB;
        vec3 cA = strata(uDA, dep + wob, q, texture2D(tCA, euv).rgb, rA), cB = strata(uDB, dep + wob, q, texture2D(tCB, euv).rgb, rB);
        float k = 1.0 - smoothstep(uK - 0.025, uK, dep);       // 新领域的土层从上往下换
        diffuseColor.rgb = mix(cA, cB, k); eR = mix(rA, rB, k);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = eR;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * (0.10 + 0.22 * (1.0 - dep));          // 侧面没有直射光，补一点柔光让土层看得出来
        totalEmissiveRadiance += uSeam * sin(3.14159 * clamp(uK, 0.0, 1.0)) * exp(-abs(dep - uK) / 0.012) * 1.6;`);
  };
  earthM.customProgramCacheKey = () => 'earth';
  {
    const prof = [[0, -SH], [R, -SH], [R, 0]].map(([x, y]) => new T.Vector2(x, y));
    const side = new T.Mesh(new T.LatheGeometry(prof, 200), earthM);
    const top = new T.Mesh(new T.CircleGeometry(R, 200).rotateX(-Math.PI / 2), terrM);
    const stand = new T.Mesh(new T.CylinderGeometry(R + 0.014, R + 0.02, SB, 200).translate(0, -PH + SB / 2, 0),
      new T.MeshPhysicalMaterial({ color: new T.Color(0.018, 0.017, 0.016), roughness: 0.38, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 0.8 }));
    side.receiveShadow = top.receiveShadow = stand.receiveShadow = true; side.castShadow = stand.castShadow = true;
    turntable.add(side, top, stand);
  }
  // 地面（台座外面）：接住聚光灯的光斑和台座的影子，离台座越远越暗
  const floorFO = { value: 2.3 };   // 竖屏时地面光斑收得更紧，画布边缘不露出亮边
  {
    const m = new T.MeshStandardMaterial({ color: new T.Color(0.018, 0.018, 0.019), roughness: 0.6, metalness: 0, envMapIntensity: 0.2 });
    // 地面离圆台越远越暗，画面四周回到网页的纯黑，不出现“方框”
    m.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFP = position.xz;');
      sh.uniforms.uFO = floorFO;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vFP; uniform float uFO;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb *= smoothstep(uFO, 1.02, length(vFP));');   // 半径 1.02 以内全亮，到 uFO 处全黑
    };
    const floor = new T.Mesh(new T.CircleGeometry(7, 64).rotateX(-Math.PI / 2), m);
    floor.position.y = -PH; floor.receiveShadow = true; scene.add(floor);
  }

  /* ── §5 建筑材质 ───────────────────────────────────────
     所有建筑共用一个材质，不用贴图，窗户是着色器按坐标算出来的：
       - 每个顶点带两组属性：aB = (窗型 style, 这栋楼的随机编号 id, 起算楼层的高度 floorOffset, 明暗 tone)，aC = 墙面颜色
       - 窗型 style：0 普通窗（住宅/办公）  1 玻璃幕墙  2 横向百叶/实墙  3 竖长窗（石材公建）  4 不画窗（屋顶设备、线脚等）
       - 屋面统一压暗成灰色卷材
       - 夜里亮灯：每扇窗单独随机决定亮不亮，楼层之间有成片“有人加班”的区域，亮度和色温（暖黄/白/冷白）各不相同
       - uLit：这个领域的亮灯程度 0~1，场景完全升起后才亮（见 §15）
     每个领域一份材质实例（MAT[d]），这样各领域可以单独控制亮灯 */
  function modelMaterial(litU) {
    const m = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0, envMapIntensity: 0.6, clippingPlanes: CLIP, clipShadows: true });
    m.onBeforeCompile = sh => {
      sh.uniforms.uLit = litU;
      sh.uniforms.uTime = U.time;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aB; attribute vec3 aC; flat varying vec4 vB; flat varying vec3 vC; varying vec3 vOP; varying vec3 vON;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOP = transformed; vON = objectNormal; vB = aB; vC = aC;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        flat varying vec4 vB; flat varying vec3 vC; varying vec3 vOP; varying vec3 vON; uniform float uLit, uTime; ${NOISE}
        float pI(float x, float a, float b){ return floor(x) * (b - a) + clamp(fract(x), a, b) - a; }
        float pF(float x, float a, float b, float w){ return (pI(x + 0.5 * w, a, b) - pI(x - 0.5 * w, a, b)) / w; }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float wM = 0.0, wL = 0.0, st = vB.x; vec3 litC = vec3(1.0, 0.64, 0.34);
          diffuseColor.rgb = vC * vB.w * (0.95 + 0.1 * xzN(vOP.xy * 140.0 + vOP.zy * 140.0 + vB.y * 50.0));
          if (vON.y > 0.5 && st < 3.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.16, 0.16), 0.5);   // 屋面：灰色卷材
          if (abs(vON.y) < 0.5 && st < 3.5) {
            float hor = abs(vON.x) > abs(vON.z) ? vOP.z : vOP.x;                       // 墙面上的水平坐标
            float isRes = step(0.15, st) * (1.0 - step(0.4, st));                      // 0.25 = 住宅/宿舍窗（暖色烟火气）
            float fh = st > 2.5 ? 0.046 : 0.021, cw = st > 2.5 ? 0.028 : st > 0.5 ? 0.0105 : 0.015;   // fh 层高，cw 窗间距
            // gp = (第几列窗, 第几层)；pF 是带抗锯齿的“窗洞”方波：在格子的 a~b 范围内为 1
            vec2 gp = vec2(hor / cw, (vOP.y - vB.z) / fh), fw = max(fwidth(gp), vec2(1e-4));
            if (st < 0.5)      wM = pF(gp.x, 0.22, 0.78, fw.x) * pF(gp.y, 0.30, 0.84, fw.y);
            else if (st < 1.5) wM = pF(gp.x, 0.07, 0.93, fw.x) * pF(gp.y, 0.16, 0.97, fw.y);
            else if (st < 2.5) wM = pF(gp.y, 0.55, 1.00, fw.y) * 0.35;
            else               wM = pF(gp.x, 0.30, 0.70, fw.x) * pF(gp.y, 0.14, 0.88, fw.y);
            // 夜里亮灯：升起时逐扇错落点亮，少量房间偶发明灭，住宅偏暖橘（偶见电视微光）、办公偏明快冷暖带
            float fl = floor(gp.y), sd = vB.y * 31.7, cx = floor(st > 1.5 && st < 2.5 ? gp.x / 3.0 : gp.x);
            float occ = xzH(vec2(fl, sd)), zone = xzN(vec2(hor * 7.0 + sd * 5.0, fl * (isRes > 0.5 ? 0.9 : 0.35) + sd * 1.7));
            float pOn = clamp((isRes > 0.5 ? 0.24 : 0.10) + 0.58 * zone + 0.3 * (occ - 0.5), 0.05, 0.88);
            float hWin = xzH(vec2(cx * 1.37 + sd * 3.1, fl * 2.11 - sd));
            float tOrd = xzH(vec2(cx * 2.91 - sd, fl * 1.13 + sd * 0.7)) * 0.68;
            float uL = smoothstep(tOrd, tOrd + 0.28, uLit);
            float hTog = xzH(vec2(cx * 4.13 + sd, fl * 3.71 - sd * 1.3));
            float cyc = sin(uTime * (0.22 + 0.18 * hWin) + sd * 9.0 + cx * 2.3 + fl * 3.7);
            float baseOn = hTog < 0.038 ? smoothstep(-0.14, 0.14, cyc) : step(hWin, pOn);
            float gf = 1.0 - step(1.0, gp.y);
            float on = baseOn * uL + gf * smoothstep(0.05, 0.45, uLit) * 0.88;
            float litable = (st < 1.5 || st > 2.5) ? 1.0 : 0.0;
            float br = 0.38 + 0.62 * xzH(vec2(cx * 0.71 + 5.3, fl * 1.9 + sd));
            wL = wM * litable * clamp(on, 0.0, 1.0) * br * (0.7 + 0.45 * fract(gp.y));      // 室内灯在顶棚，窗上沿更亮
            float tone = xzH(vec2(cx * 0.53 + 1.1, fl * 0.77 + sd * 2.0));
            if (isRes > 0.5) {
              float tv = 0.82 + 0.18 * sin(uTime * 6.5 + cx * 3.1 + fl * 5.0);
              litC = tone < 0.62 ? vec3(1.0, 0.58, 0.26) : tone < 0.93 ? vec3(1.0, 0.78, 0.48) : vec3(0.50, 0.72, 1.0) * tv;
            } else {
              litC = tone < 0.48 ? vec3(1.0, 0.66, 0.36) : tone < 0.82 ? vec3(1.0, 0.86, 0.66) : vec3(0.78, 0.88, 1.0);
            }
            litC = mix(litC, vec3(1.0, 0.72, 0.38), gf * 0.55);                             // 一楼门厅/底商暖光
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.02, 0.025, 0.032), vec3(0.065, 0.075, 0.09), xzH(vec2(cx * 2.3 - 4.0, fl * 1.3 + sd))), wM * 0.92);
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.08, wM);`)      // 玻璃窗光滑，能反射环境
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += litC * wL * 0.95;`);
    };
    m.customProgramCacheKey = () => 'model3';
    return m;
  }
  const litU = DOMAINS.map(() => ({ value: 0 }));                 // 每个领域的亮灯程度
  const MAT = DOMAINS.map((_, i) => modelMaterial(litU[i]));       // 每个领域一份建筑材质
  // 普通材质的简写：std(颜色, 粗糙度, 其他参数)
  const std = (c, r, extra = {}) => new T.MeshStandardMaterial({ color: new T.Color(...c), roughness: r, clippingPlanes: CLIP, clipShadows: true, ...extra });
  // 水面微风波纹与涟漪着色器增强（用于喷泉池与自然湖面）
  function waterMat(col, rough, extra, rings = false) {
    const m = std(col, rough, extra);
    m.onBeforeCompile = sh => {
      sh.uniforms.uTime = U.time;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vWP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = position.xz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec2 vWP; uniform float uTime;\n${NOISE}`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          float w1 = xzN(vWP * 190.0 + vec2(uTime * 0.45, -uTime * 0.32)), w2 = xzN(vWP * 340.0 - vec2(uTime * 0.38, uTime * 0.51));
          float wr = ${rings ? 'sin(length(vWP) * 260.0 - uTime * 5.2) * exp(-length(vWP) * 14.0) * 0.55' : '0.0'};
          normal = normalize(normal + vec3((w1 - 0.5) * 0.055 + wr * 0.03, (w2 - 0.5) * 0.055, 0.0));`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          float rip = xzN(vWP * 220.0 + vec2(uTime * 0.4, uTime * 0.25));
          roughnessFactor = clamp(roughnessFactor + (rip - 0.5) * 0.05, 0.02, 0.14);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          ${rings ? 'float rr = max(0.0, sin(length(vWP) * 260.0 - uTime * 5.2)) * exp(-length(vWP) * 13.0); totalEmissiveRadiance += vec3(0.08, 0.14, 0.16) * rr;' : ''}`);
    };
    m.customProgramCacheKey = () => rings ? 'waterRing' : 'waterLake';
    return m;
  }
  const M = {
    white: std([0.80, 0.80, 0.78], 0.45, { envMapIntensity: 0.7 }),
    dark: std([0.05, 0.05, 0.055], 0.5),
    bronze: std([0.85, 0.62, 0.24], 0.30, { metalness: 0.62, envMapIntensity: 1.5, emissive: new T.Color(0.08, 0.055, 0.015) }),
    water: waterMat([0.025, 0.055, 0.065], 0.05, { envMapIntensity: 1.5, emissive: new T.Color(0.02, 0.075, 0.09) }, true),   // 池底有灯，夜里泛青+落水涟漪
  };
  // 常用颜色（线性空间 0~1，见文件头说明）：混凝土、石材、白、米黄、红砖、浅红砖、玻璃、绿玻璃、深色、花岗岩、陶土、钢、蓝屋顶、绿、绿篱
  const C = {
    concrete: [0.50, 0.49, 0.47], stone: [0.60, 0.53, 0.42], white: [0.70, 0.69, 0.66], cream: [0.66, 0.60, 0.50],
    brick: [0.36, 0.12, 0.07], brickL: [0.46, 0.20, 0.12], glass: [0.24, 0.30, 0.36], glassG: [0.20, 0.30, 0.30],
    dark: [0.12, 0.12, 0.13], granite: [0.20, 0.19, 0.19], terracotta: [0.48, 0.24, 0.14], steel: [0.42, 0.45, 0.48],
    blueRoof: [0.10, 0.20, 0.38], green: [0.10, 0.20, 0.07], hedge: [0.07, 0.15, 0.05],
  };

  /* ── §6 几何工具 ───────────────────────────────────────
     平面形状都用 [[x, z], …] 的点列表示（俯视的轮廓），prism() 把它竖直挤出成体块。 */
  const shapeRect = (w, d, cx = 0, cz = 0) =>   // 矩形：宽 w（x 方向）、深 d（z 方向），中心 (cx, cz)
    [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];
  const shapeOct = (w, d, k) =>                  // 切角矩形（八角），k = 切角大小
    [[-w / 2 + k, -d / 2], [w / 2 - k, -d / 2], [w / 2, -d / 2 + k], [w / 2, d / 2 - k], [w / 2 - k, d / 2], [-w / 2 + k, d / 2], [-w / 2, d / 2 - k], [-w / 2, -d / 2 + k]];
  const shapeCircle = (r, n = 40, cx = 0, cz = 0) =>   // 圆（n 边形近似）
    Array.from({ length: n }, (_, i) => [cx + Math.cos(i / n * TAU) * r, cz + Math.sin(i / n * TAU) * r]);
  const toShape = (pts, Cls = T.Shape) => new Cls(pts.map(([x, z]) => new T.Vector2(x, -z)));
  // 竖直挤出：轮廓 pts，从高度 y0 起、高 h；holes 挖洞（比如水池沿）；bevel 棱边倒角，让边缘接住高光
  function prism(pts, y0, h, holes = [], bevel = 0.0014) {
    const s = toShape(pts);
    holes.forEach(hp => s.holes.push(toShape(hp, T.Path)));
    const b = Math.min(bevel, h * 0.3);
    const g = new T.ExtrudeGeometry(s, { depth: Math.max(0.0004, h - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1, curveSegments: 12 });
    g.rotateX(-Math.PI / 2); g.translate(0, y0 + b, 0);
    return g;
  }
  const boxAt = (w, h, d, x, y, z) =>             // 方块：底面中心在 (x, y, z)
    new T.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
  const cylAt = (r0, r1, h, x, y, z, n = 16) =>   // 圆柱 / 圆台：顶半径 r0、底半径 r1，底面中心在 (x, y, z)
    new T.CylinderGeometry(r0, r1, h, n).translate(x, y + h / 2, z);
  function strut(a, b, t) {                          // 两点之间的细杆（输电塔的钢架），粗细 t
    const A = new T.Vector3(...a), B = new T.Vector3(...b), d = B.clone().sub(A), L = d.length();
    const g = new T.BoxGeometry(t, L, t);
    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize()));
    return g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  }
  // 把一栋楼的所有部件合成一个几何体（一次绘制）。
  // parts 每项：[几何体, 窗型 style, 起算楼层的高度, 明暗, 颜色]；窗型见 §5。id 是这栋楼的随机编号（决定哪些窗亮）
  function merge(parts, id = rnd()) {
    const pos = [], nor = [], ab = [], ac = [];
    for (const [g0, style = 4, fo = 0, tone = 1, col = C.concrete] of parts) {
      const g = g0.index ? g0.toNonIndexed() : g0;
      if (!g.attributes.normal) g.computeVertexNormals();
      const p = g.attributes.position.array, n = g.attributes.normal.array;
      for (let i = 0; i < p.length; i++) { pos.push(p[i]); nor.push(n[i]); }
      for (let i = 0; i < p.length / 3; i++) { ab.push(style, id, fo, tone); ac.push(col[0], col[1], col[2]); }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    g.setAttribute('aB', new T.Float32BufferAttribute(ab, 4));
    g.setAttribute('aC', new T.Float32BufferAttribute(ac, 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  // 只带顶点色的合并（车、人、树、羊这些小东西）：parts 每项 [几何体, [r, g, b]]
  function mergeC(parts) {
    const pos = [], nor = [], col = [];
    for (const [g0, c] of parts) {
      const g = g0.index ? g0.toNonIndexed() : g0;
      if (!g.attributes.normal) g.computeVertexNormals();
      const p = g.attributes.position.array, n = g.attributes.normal.array;
      for (let i = 0; i < p.length; i++) { pos.push(p[i]); nor.push(n[i]); }
      for (let i = 0; i < p.length / 3; i++) col.push(c[0], c[1], c[2]);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    return g;
  }

  /* ── §7 折线 / 路径工具（道路、车道、步行路线共用） ──────────
     一条路 = 一串点 [[x, z], …]；closed = 首尾相连（环路）。 */
  const arcPts = (cx, cz, r, a0, a1, n = 48) =>   // 圆弧：圆心、半径、起止角
    Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + Math.cos(a) * r, cz + Math.sin(a) * r]; });
  const ellPts = (cx, cz, rx, rz, n = 64) =>      // 椭圆（闭合）
    Array.from({ length: n }, (_, i) => { const a = i / n * TAU; return [cx + Math.cos(a) * rx, cz + Math.sin(a) * rz]; });
  const EDGE = 0.985;                                // 道路通到台面边缘时停在这个半径
  // 贯穿台面的直路：chordX(x) = 竖向（沿 z）的路，位于 x；chordZ(z) = 横向的路，位于 z
  const chordX = (x, r = EDGE) => { const e = Math.sqrt(r * r - x * x); return [[x, -e], [x, e]]; };
  const chordZ = (z, r = EDGE) => { const e = Math.sqrt(r * r - z * z); return [[-e, z], [e, z]]; };
  // 圆角矩形（逆时针），用于园区环路、场地轮廓；r = 圆角半径
  function rrect(x0, z0, x1, z1, r, n = 6) {
    const out = [];
    for (const [cx, cz, a0] of [[x1 - r, z0 + r, -0.5], [x1 - r, z1 - r, 0], [x0 + r, z1 - r, 0.5], [x0 + r, z0 + r, 1]])
      for (let i = 0; i <= n; i++) { const a = (a0 + i / n * 0.5) * Math.PI; out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
    return out;
  }
  function spline(ctrl, n = 12) {                                    // 过控制点的平滑曲线（Catmull-Rom），草原上的公路用
    const out = [];
    for (let i = 0; i < ctrl.length - 1; i++) {
      const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
      for (let k = 0; k < n; k++) { const t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map(j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3))); }
    }
    out.push(ctrl[ctrl.length - 1]);
    return out;
  }
  function offsetLine(pts, d, closed = false) {                     // 把折线向行进方向的右侧平移 d（负数 = 左侧）。车道、人行道、行道树都靠它
    const n = pts.length, out = [];
    const nrm = (u, v) => { const dx = v[0] - u[0], dz = v[1] - u[1], l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; };
    for (let i = 0; i < n; i++) {
      const p = pts[i], hasA = i > 0 || closed, hasB = i < n - 1 || closed;
      const n1 = hasA ? nrm(pts[(i - 1 + n) % n], p) : null, n2 = hasB ? nrm(p, pts[(i + 1) % n]) : null;
      let nx, nz;
      if (n1 && n2) { nx = n1[0] + n2[0]; nz = n1[1] + n2[1]; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l; const c = Math.max(0.5, nx * n1[0] + nz * n1[1]); nx /= c; nz /= c; }
      else { const q = n1 || n2; nx = q[0]; nz = q[1]; }
      out.push([p[0] + nx * d, p[1] + nz * d]);
    }
    return out;
  }
  // 把折线变成可以按“走过的距离”取点的路径：P.at(s) → [x, z, 朝向角]；P.L = 总长。车和人沿路走就靠它
  function pathOf(pts, closed = false) {
    const P = closed ? [...pts, pts[0]] : pts, cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const L = cum[cum.length - 1];
    return { L, closed, at(s) {
      s = closed ? ((s % L) + L) % L : clamp(s, 0, L);
      let lo = 1, hi = P.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < s) lo = mid + 1; else hi = mid; }
      const a = P[lo - 1], b = P[lo], f = (s - cum[lo - 1]) / ((cum[lo] - cum[lo - 1]) || 1);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, Math.atan2(b[1] - a[1], b[0] - a[0])];
    } };
  }
  const bbox = pts =>          // 外接矩形 [xmin, zmin, xmax, zmax]
    pts.reduce((b, [x, z]) => [Math.min(b[0], x), Math.min(b[1], z), Math.max(b[2], x), Math.max(b[3], z)], [1e9, 1e9, -1e9, -1e9]);
  // 沿折线每隔 step 取一个点（行道树、路灯），offs 是一组侧向偏移（比如路两边各一排），超出台面 0.955 的点丢掉
  function along(pts, step, offs = [0], closed = false, jitter = 0) {
    const out = [];
    for (const o of offs) {
      const P = pathOf(o ? offsetLine(pts, o, closed) : pts, closed);
      for (let s = step * 0.5; s < P.L; s += step) { const [x, z, a] = P.at(s + (rnd() - 0.5) * jitter); if (Math.hypot(x, z) < 0.955) out.push([x, z, a]); }
    }
    return out;
  }

  /* ── §8 地貌画布 terrain() ───────────────────────────────
     每个领域调用一次 terrain(t => { …画… })，在两张 2D canvas 上按世界坐标作画：
       颜色图：地面看起来是什么颜色；材质图：R 粗糙度（水面低、草地高）、G 是否草地、B 路灯光斑。
     画法类似 Photoshop 图层，后画的盖住先画的：一般顺序是 底色 → 大块场地 → 道路 → 斑马线等细节。
     返回 { tc, tm 两张贴图, lampPts 道路自动布的路灯位置, sample(x, z) 读材质图（判断某点是不是草地） } */
  // 贴图分辨率：手机 1024²，桌面 2048²（1 像素 ≈ 0.1 ~ 0.2 米）
  const TPX = Math.min(window.innerWidth || 1200, window.innerHeight || 900) < 640 ? 1024 : 2048;
  // 材质图的颜色：MT(粗糙度, 草地 0/1, 灯光)。例：MT(0.05) 水面，MT(0.95, 1) 草地，MT(0.62) 沥青
  const MT = (r = 0.9, g = 0, b = 0) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  function terrain(draw) {
    const mk = () => { const cv = document.createElement('canvas'); cv.width = cv.height = TPX; return cv; };
    const cC = mk(), cM = mk(), c = cC.getContext('2d'), m = cM.getContext('2d', { willReadFrequently: true });
    const sc = TPX / (2 * R);
    for (const x of [c, m]) { x.setTransform(sc, 0, 0, sc, TPX / 2, TPX / 2); x.lineCap = 'round'; x.lineJoin = 'round'; }
    const trace = (x, pts, closed = true) => { x.beginPath(); pts.forEach(([px, pz], i) => i ? x.lineTo(px, pz) : x.moveTo(px, pz)); if (closed) x.closePath(); };
    const lampPts = [];
    const api = {
      c, m, lampPts,
      // 填充一块多边形区域 / 一个圆
      poly(pts, col, mt = MT()) { for (const [x, s] of [[c, col], [m, mt]]) { trace(x, pts); x.fillStyle = s; x.fill(); } },
      circle(cx, cz, r, col, mt = MT()) { for (const [x, s] of [[c, col], [m, mt]]) { x.beginPath(); x.arc(cx, cz, r, 0, TAU); x.fillStyle = s; x.fill(); } },
      line(pts, w, col, mt = null, { closed = false, dash = null, cap = 'round' } = {}) {   // 沿折线画宽 w 的线（步道、河、标线）；mt = null 时不改材质图
        for (const [x, s] of [[c, col], [m, mt]]) { if (!s) continue; trace(x, pts, closed); x.lineWidth = w; x.lineCap = cap; x.strokeStyle = s; x.setLineDash(dash || []); x.stroke(); x.setLineDash([]); }
      },
      speckle(pts, cols, n, s0, s1, alpha = [0.15, 0.4]) {          // 区域内撒斑点（草色深浅、碎石、泥土）
        const bb = bbox(pts);
        c.save(); trace(c, pts); c.clip();
        for (let i = 0; i < n; i++) {
          const x = bb[0] + rnd() * (bb[2] - bb[0]), z = bb[1] + rnd() * (bb[3] - bb[1]), r = s0 + rnd() * (s1 - s0);
          c.globalAlpha = alpha[0] + rnd() * (alpha[1] - alpha[0]); c.fillStyle = cols[(rnd() * cols.length) | 0];
          c.beginPath(); c.ellipse(x, z, r, r * (0.5 + rnd() * 0.5), rnd() * 3.14, 0, TAU); c.fill();
        }
        c.restore(); c.globalAlpha = 1;
      },
      grass(pts, base = '#41602b', n = 500, mt = MT(0.95, 1, 0)) {  // 草地：底色 + n 个深浅不一的斑点
        api.poly(pts, base, mt);
        api.speckle(pts, ['#36521f', '#4d6e33', '#5a7a39', '#3b5826', '#61803f'], n, 0.004, 0.03);
      },
      paving(pts, base, line, step = 0.018, mt = MT(0.7)) {          // 广场石材铺装：底色 + 分格缝
        api.poly(pts, base, mt);
        const bb = bbox(pts);
        c.save(); trace(c, pts); c.clip(); c.strokeStyle = line; c.lineWidth = 0.0009;
        for (let x = Math.floor(bb[0] / step) * step; x <= bb[2]; x += step) { c.beginPath(); c.moveTo(x, bb[1]); c.lineTo(x, bb[3]); c.stroke(); }
        for (let z = Math.floor(bb[1] / step) * step; z <= bb[3]; z += step) { c.beginPath(); c.moveTo(bb[0], z); c.lineTo(bb[2], z); c.stroke(); }
        c.restore();
      },
      glow(x, z, r, k = 1) {                                        // 夜间灯光光斑（写进材质图 B 通道，随亮灯程度显现）
        m.save(); m.globalCompositeOperation = 'lighter';
        const g = m.createRadialGradient(x, z, 0, x, z, r); g.addColorStop(0, `rgb(0,0,${Math.round(255 * k)})`); g.addColorStop(1, 'rgb(0,0,0)');
        m.fillStyle = g; m.beginPath(); m.arc(x, z, r, 0, TAU); m.fill(); m.restore();
      },
      // 道路：人行道 → 路缘 → 沥青 → 中央绿化带 → 车道线 / 双黄线；sw > 0 时自动沿人行道布路灯。
      // rd = { pts 中线, closed 是否环路, w 路面宽, lanes 单向车道数, median 中央隔离带宽, sw 人行道宽,
      //        kind ('dirt' = 土路), lampStep 路灯间距, speed 车速, n 每条车道的车数 }   ← speed 和 n 给 §10 的车流用
      road(rd) {
        const { pts, closed = false, w, lanes = 1, median = 0, sw = 0, kind = 'road', lampStep = 0.1 } = rd;
        if (kind === 'dirt') {
          api.line(pts, w * 1.25, 'rgba(96,84,58,0.55)', null, { closed });
          api.line(pts, w, '#76634a', MT(0.95, 0.1), { closed });
          for (const o of [-w * 0.24, w * 0.24]) api.line(offsetLine(pts, o, closed), w * 0.14, 'rgba(62,50,36,0.55)', null, { closed });
          return;
        }
        if (sw) api.line(pts, w + 2 * sw, '#8a8781', MT(0.85), { closed });
        api.line(pts, w + 0.004, '#5e5c58', MT(0.8), { closed });
        api.line(pts, w, '#2a2b2f', MT(0.62), { closed });
        if (median) api.line(pts, median, '#3d5a2a', MT(0.95, 0.9), { closed });
        const lw = (w - median) / 2 / lanes;
        for (const sd of [1, -1]) {
          for (let i = 1; i < lanes; i++) api.line(offsetLine(pts, sd * (median / 2 + lw * i), closed), 0.0011, 'rgba(232,232,222,0.8)', null, { closed, dash: [0.012, 0.014], cap: 'butt' });
          api.line(offsetLine(pts, sd * (w / 2 - 0.0024), closed), 0.0011, 'rgba(232,232,222,0.75)', null, { closed });
        }
        if (!median) for (const o of [-0.0011, 0.0011]) api.line(offsetLine(pts, o, closed), 0.0008, 'rgba(226,176,40,0.9)', null, { closed });
        if (sw && rd.lamps !== false) for (const [x, z] of along(pts, lampStep, [w / 2 + sw * 0.3, -(w / 2 + sw * 0.3)], closed)) { lampPts.push([x, z]); api.glow(x, z, 0.035, 0.85); }
      },
      zebra(x, z, ang, len, depth = 0.014) {                       // 斑马线：中心、方向角、长度（= 路宽）
        c.save(); c.translate(x, z); c.rotate(ang); c.fillStyle = 'rgba(232,232,222,0.85)';
        for (let s = -len / 2; s < len / 2; s += 0.006) c.fillRect(s, -depth / 2, 0.0034, depth);
        c.restore();
      },
      // 停车场：沥青 + 车位线；rows 排数，along 车位沿 x 还是 z 排；返回每个车位 [x, z, 朝向]（给 parked() 停车用）
      parking(x0, z0, x1, z1, { rows = 2, along = 'x' } = {}) {
        api.poly([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], '#303135', MT(0.6));
        api.line([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], 0.0016, '#77756f', null, { closed: true });
        const spots = [], sw = 0.017, depth = 0.032;
        const H = along === 'x', a0 = H ? x0 : z0, a1 = H ? x1 : z1, b0 = H ? z0 : x0, b1 = H ? z1 : x1, span = b1 - b0;
        for (let r = 0; r < rows; r++) {
          const pair = Math.floor(r / 2), npair = Math.ceil(rows / 2), band = span / npair, base = b0 + pair * band;
          const bc = r % 2 === 0 ? base + 0.004 + depth / 2 : base + band - 0.004 - depth / 2;
          for (let a = a0 + 0.006; a + sw <= a1 - 0.004; a += sw) {
            const ac = a + sw / 2;
            const ln = H ? [[a, bc - depth / 2], [a, bc + depth / 2]] : [[bc - depth / 2, a], [bc + depth / 2, a]];
            api.line(ln, 0.0009, 'rgba(225,225,215,0.75)', null, { cap: 'butt' });
            spots.push(H ? [ac, bc, Math.PI / 2] : [bc, ac, 0]);
          }
        }
        return spots;
      },
    };
    draw(api);
    const tc = new T.CanvasTexture(cC); tc.colorSpace = T.SRGBColorSpace; tc.flipY = false; tc.anisotropy = 8;
    const tm = new T.CanvasTexture(cM); tm.colorSpace = T.NoColorSpace; tm.flipY = false; tm.anisotropy = 8;
    return { tc, tm, lampPts, sample: (() => { let data = null; return (x, z) => {   // 读材质图（撒草丛时判断是不是草地）
      if (!data) data = m.getImageData(0, 0, TPX, TPX).data;
      const px = clamp(Math.round((x / (2 * R) + 0.5) * TPX), 0, TPX - 1), py = clamp(Math.round((z / (2 * R) + 0.5) * TPX), 0, TPX - 1), i = (py * TPX + px) * 4;
      return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]; }; })() };
  }
  const TER = [];

  /* ── §9 场景对象登记 + 建筑生成器 ──────────────────────────
     add(领域, 几何体, 材质, x, z, { delay, rotY, shadow })：登记一个物体。
       delay（0~1）决定切换时它升起的先后：0 最先，1 最后；不写就按离圆心的距离算（中间先起，外圈后起）。
       材质传 null 时用该领域的建筑材质 MAT[d]。
     addNode(…)：同上，但登记的是一组物体（车流、人群、树等实例化网格）。hgt = 它要沉下去的深度。
     animate(领域, fn)：登记每帧要跑的动画 fn(时间秒, 该领域可见度 0~1)；领域填 -1 表示一直跑。 */
  const groups = DOMAINS.map(() => { const g = new T.Group(); turntable.add(g); return g; });
  const objs = [];
  const anim = [];
  const animate = (d, fn) => { fn.d = d; anim.push(fn); };
  function add(d, geo, mat, x = 0, z = 0, { delay, rotY = 0, shadow = true } = {}) {
    const mesh = new T.Mesh(geo, mat ?? MAT[d]);
    mesh.position.set(x, 0, z); mesh.rotation.y = rotY;
    mesh.castShadow = shadow; mesh.receiveShadow = true;
    geo.computeBoundingBox();
    const hgt = geo.boundingBox.max.y + 0.01;
    objs.push({ mesh, d, hgt, delay: delay ?? clamp(Math.hypot(x, z) / 0.95, 0, 1) * 0.75 + rnd() * 0.25, h: -1 });
    groups[d].add(mesh);
    return mesh;
  }
  function addNode(d, node, x = 0, z = 0, delay, hgt) {
    node.position.set(x, 0, z);
    if (hgt === undefined) { const box = new T.Box3().setFromObject(node); hgt = box.max.y + 0.01; }
    objs.push({ mesh: node, d, hgt, delay: delay ?? clamp(Math.hypot(x, z) / 0.95, 0, 1) * 0.75 + rnd() * 0.25, h: -1 });
    groups[d].add(node);
    node.traverse(o => { if (o.isMesh && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = true; } });
    return node;
  }

  const scalePts = (pts, k) => pts.map(([x, z]) => [x * k, z * k]);
  // 圆角矩形轮廓（建筑平面用）：宽 w、深 d、圆角 r、中心 (cx, cz)
  const shapeRound = (w, d, r, cx = 0, cz = 0, n = 5) => {
    const out = [];
    for (const [qx, qz, a0] of [[1, 1, 0], [-1, 1, 0.5], [-1, -1, 1], [1, -1, 1.5]])
      for (let i = 0; i <= n; i++) { const a = (a0 + i / n * 0.5) * Math.PI; out.push([cx + qx * (w / 2 - r) + Math.cos(a) * r, cz + qz * (d / 2 - r) + Math.sin(a) * r]); }
    return out;
  };
  function fins(parts, ww, dd, y, hh, col) {         // 玻璃幕墙外的竖向肋板（每 0.038 一根）
    const step = 0.038, t = 0.0016, out = 0.0042;
    for (let x = -ww / 2 + step / 2; x < ww / 2 - 0.004; x += step)
      parts.push([boxAt(t, hh, out, x, y, dd / 2 + out / 2 - 0.0005), 4, 0, 1.05, col], [boxAt(t, hh, out, x, y, -dd / 2 - out / 2 + 0.0005), 4, 0, 1.05, col]);
    for (let z = -dd / 2 + step / 2; z < dd / 2 - 0.004; z += step)
      parts.push([boxAt(out, hh, t, ww / 2 + out / 2 - 0.0005, y, z), 4, 0, 1.05, col], [boxAt(out, hh, t, -ww / 2 - out / 2 + 0.0005, y, z), 4, 0, 1.05, col]);
  }
  // 一栋楼：裙房 + 1~3 段退台（楼板腰线、幕墙肋板、女儿墙）+ 屋顶设备 / 冠顶
  //   w, d 平面尺寸；h 总高；style 窗型（§5）；podium 裙房高度（0 = 没有）；tiers 退台段数（每段收进 22%）
  //   crown 屋顶：0 设备间 + 冷却塔，1 收顶 + 天线，2 两级收顶；oct 切角比例（0 = 方楼）
  //   col 墙面色，trim 线脚色（默认比墙面亮一点），pcol 裙房颜色（默认玻璃）
  function tower({ w, d, h, style = 1, podium = 0, tiers = 1, crown = 0, oct = 0, tone = 1, ribs = true, col = C.concrete, trim, pcol }) {
    trim = trim ?? col.map(v => Math.min(1, v * 1.25 + 0.05)); pcol = pcol ?? C.glass;
    const parts = []; let y = 0, ww = w, dd = d;
    if (podium) {
      const pp = shapeRound(w * 1.55, d * 1.5, 0.008);
      parts.push([prism(pp, 0, podium), 1, 0, 1, pcol], [prism(scalePts(pp, 1.025), podium, 0.004), 4, 0, 1, trim]);
      y = podium + 0.004;
    }
    const segH = (h - y) / tiers;
    for (let i = 0; i < tiers; i++) {
      const pts = oct ? shapeOct(ww, dd, Math.min(ww, dd) * oct) : shapeRect(ww, dd);
      parts.push([prism(pts, y, segH), style, y, tone, col]);
      for (let yy = y + 0.084; yy < y + segH - 0.03; yy += 0.084) parts.push([prism(scalePts(pts, 1.035), yy, 0.0024, [], 0.0006), 4, 0, 1, trim]);
      if (ribs && style === 1 && !oct) fins(parts, ww, dd, y, segH, trim);
      parts.push([prism(scalePts(pts, 1.01), y + segH, 0.007, [scalePts(pts, 0.88)], 0.0006), 4, 0, 1, trim]);
      y += segH; ww *= 0.78; dd *= 0.78;
    }
    if (crown === 1) parts.push([prism(shapeRect(ww * 0.7, dd * 0.7), y, 0.018), 2, y, 1, col], [prism(shapeRect(ww * 0.75, dd * 0.75), y + 0.018, 0.003), 4, 0, 1, trim], [cylAt(0.0016, 0.0016, 0.07, 0, y + 0.021, 0, 6), 4, 0, 1, C.steel]);
    else if (crown === 2) parts.push([prism(shapeRect(ww * 0.95, dd * 0.95), y, 0.014), 2, y, 1, col], [prism(shapeRect(ww * 0.6, dd * 0.6), y + 0.014, 0.012), 1, y + 0.014, 1, col], [prism(shapeRect(ww * 0.64, dd * 0.64), y + 0.026, 0.003), 4, 0, 1, trim]);
    else {
      parts.push([boxAt(ww * 0.36, 0.011, dd * 0.3, ww * 0.12, y, -dd * 0.12), 2, y, 1, C.concrete], [boxAt(ww * 0.22, 0.007, dd * 0.22, -ww * 0.22, y, dd * 0.16), 4, 0, 1, C.steel]);
      for (let k = 0; k < 3; k++) parts.push([cylAt(0.0045, 0.0045, 0.006, -ww * 0.25 + k * 0.012, y, -dd * 0.22, 10), 4, 0, 1, C.steel]);
    }
    return merge(parts);
  }
  // 住宅板楼：每层一道阳台横线，屋顶一个楼梯间。w 长、d 进深、h 高（style = 0.25 启用暖色万家灯火与偶发电视微光）
  function slab({ w, d, h, col = C.cream, trim = C.white }) {
    const parts = [[prism(shapeRect(w, d), 0, h), 0.25, 0, 1, col]];
    for (let y = 0.021; y < h - 0.01; y += 0.021) parts.push([boxAt(w * 0.96, 0.0016, 0.004, 0, y, d / 2 + 0.0015), 4, 0, 1, trim], [boxAt(w * 0.96, 0.0016, 0.004, 0, y, -d / 2 - 0.0015), 4, 0, 1, trim]);
    parts.push([prism(shapeRect(w * 1.01, d * 1.04), h, 0.006, [shapeRect(w * 0.9, d * 0.8)], 0.0006), 4, 0, 1, trim]);
    parts.push([boxAt(w * 0.2, 0.012, d * 0.5, w * 0.25, h, 0), 2, h, 1, col]);
    return merge(parts);
  }
  const plate = (pts, h = 0.004, col = C.concrete) =>   // 薄板（台阶、平台）
    merge([[prism(pts, 0, h, [], 0.0008), 4, 0, 1, col]]);
  // 树篱：沿折线的一溜矮绿篱（高 h、厚 t）
  function hedge(pts, closed = false, h = 0.006, t = 0.006) {
    const parts = [], P = closed ? [...pts, pts[0]] : pts;
    for (let i = 1; i < P.length; i++) { const [x0, z0] = P[i - 1], [x1, z1] = P[i], L = Math.hypot(x1 - x0, z1 - z0); if (L < 1e-4) continue;
      const g = new T.BoxGeometry(L + t, h, t); g.rotateY(-Math.atan2(z1 - z0, x1 - x0)); g.translate((x0 + x1) / 2, h / 2, (z0 + z1) / 2); parts.push([g, 4, 0, 1, C.hedge]); }
    return merge(parts);
  }

  /* ── §10 活物：车、人、树、路灯、喷泉 ─────────────────────────
     数量多的东西都用实例化网格（InstancedMesh）：同一个模型画几百份只要一次绘制，每帧只改每份的位置/朝向矩阵。 */
  const _m4 = new T.Matrix4(), _q = new T.Quaternion(), _p = new T.Vector3(), _s = new T.Vector3(), _Y = new T.Vector3(0, 1, 0), _c = new T.Color();
  // 设置第 i 份实例：位置 (x, y, z)、绕 y 轴转 ry、整体缩放 sc、竖向缩放 sy
  function setI(mesh, i, x, y, z, ry = 0, sc = 1, sy = sc) { _q.setFromAxisAngle(_Y, ry); _p.set(x, y, z); _s.set(sc, sy, sc); _m4.compose(_p, _q, _s); mesh.setMatrixAt(i, _m4); }
  const inst = (geo, mat, n, shadow = false) =>   // 新建实例化网格（n 份），shadow = 是否投影子
    { const m = new T.InstancedMesh(geo, mat, n); m.castShadow = shadow; m.receiveShadow = true; m.frustumCulled = false; if (!shadow) m.userData.noShadow = true; return m; };
  // lifeM 车身（有光泽）；matteM 人、树、羊（哑光）；lightM 车灯（自发光，不受光照）；beamM 车灯照在地上的光斑（叠加混合）
  const lifeM = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.25, envMapIntensity: 1.1, clippingPlanes: CLIP });
  const matteM = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.4, clippingPlanes: CLIP });
  const lightM = new T.MeshBasicMaterial({ vertexColors: true, clippingPlanes: CLIP });
  const beamM = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, clippingPlanes: CLIP });

  // 车辆模型：车身（颜色按实例随机）+ 车窗 + 底盘；车灯（前白后红，亮度 > 1 会产生泛光）；车头前方地上一片扇形光斑、车尾一小片红光
  // L 车长、Wd 车宽、H 车身高、cab 驾驶舱 [长, 高, 前后偏移]、kind 车型
  function vehicle({ L = 0.026, Wd = 0.0115, H = 0.0052, cab = [0.0135, 0.0040, -0.0016], kind = 'car' }) {
    const lift = 0.0014, glass = [0.035, 0.04, 0.045], parts = [[new T.BoxGeometry(L * 0.84, 0.0022, Wd * 1.03).translate(0, 0.0011, 0), [0.03, 0.03, 0.03]]];
    if (kind === 'truck') {
      parts.push([new T.BoxGeometry(L * 0.22, H * 1.5, Wd).translate(L * 0.39, lift + H * 0.75, 0), [1, 1, 1]],
        [new T.BoxGeometry(0.0012, H * 0.6, Wd * 0.86).translate(L * 0.5, lift + H * 1.1, 0), glass],
        [new T.BoxGeometry(L * 0.74, H * 1.9, Wd * 1.04).translate(-L * 0.12, lift + H * 0.95, 0), [0.78, 0.78, 0.76]]);
    } else if (kind === 'van' || kind === 'bus') {
      parts.push([new T.BoxGeometry(L, H, Wd).translate(0, lift + H / 2, 0), [1, 1, 1]],
        [new T.BoxGeometry(L * (kind === 'bus' ? 0.92 : 0.5), H * 0.32, Wd * 1.01).translate(kind === 'bus' ? 0 : L * 0.2, lift + H * 0.66, 0), glass],
        [new T.BoxGeometry(0.0012, H * 0.36, Wd * 0.9).translate(L / 2, lift + H * 0.66, 0), glass]);
    } else {
      parts.push([new T.BoxGeometry(L, H, Wd).translate(0, lift + H / 2, 0), [1, 1, 1]],
        [new T.BoxGeometry(cab[0], cab[1], Wd * 0.84).translate(cab[2], lift + H + cab[1] / 2, 0), glass]);
    }
    const body = mergeC(parts);
    const fy = lift + H * 0.55, hw = Wd * 0.32;
    const lights = mergeC([
      [new T.BoxGeometry(0.0009, 0.0013, 0.0026).translate(L / 2 + 0.0004, fy, hw), [7, 6.2, 5]], [new T.BoxGeometry(0.0009, 0.0013, 0.0026).translate(L / 2 + 0.0004, fy, -hw), [7, 6.2, 5]],
      [new T.BoxGeometry(0.0009, 0.0012, 0.003).translate(-L / 2 - 0.0004, fy, hw), [4.5, 0.18, 0.08]], [new T.BoxGeometry(0.0009, 0.0012, 0.003).translate(-L / 2 - 0.0004, fy, -hw), [4.5, 0.18, 0.08]],
    ]);
    const brake = mergeC([
      [new T.BoxGeometry(0.0011, 0.0016, 0.0034).translate(-L / 2 - 0.0006, fy, hw), [11, 0.28, 0.10]],
      [new T.BoxGeometry(0.0011, 0.0016, 0.0034).translate(-L / 2 - 0.0006, fy, -hw), [11, 0.28, 0.10]],
      [new T.BoxGeometry(0.0009, 0.0008, Wd * 0.52).translate(-L / 2 - 0.0005, lift + H * 0.92, 0), [8, 0.2, 0.08]],
    ]);
    const bp = [], bc = [], tri = (a, b, c, ca, cb, cc) => { bp.push(...a, ...b, ...c); bc.push(...ca, ...cb, ...cc); };
    const y = 0.0006, x0 = L / 2, x1 = L / 2 + 0.06, w0 = Wd * 0.38, w1 = Wd * 1.5, k0 = [0.32, 0.29, 0.23], z0 = [0, 0, 0], r0 = [0.16, 0.006, 0.003];
    tri([x0, y, -w0], [x1, y, -w1], [x1, y, w1], k0, z0, z0); tri([x0, y, -w0], [x1, y, w1], [x0, y, w0], k0, z0, k0);
    tri([-x0, y, -w0], [-x0 - 0.014, y, -w0 * 1.7], [-x0 - 0.014, y, w0 * 1.7], r0, z0, z0); tri([-x0, y, -w0], [-x0 - 0.014, y, w0 * 1.7], [-x0, y, w0], r0, z0, r0);
    const beam = new T.BufferGeometry(); beam.setAttribute('position', new T.Float32BufferAttribute(bp, 3)); beam.setAttribute('color', new T.Float32BufferAttribute(bc, 3));
    return { body, lights, brake, beam, L, H: lift + H };
  }
  // 四种车型：小汽车、面包车（警车/救护车/运钞车）、公交、卡车
  const CAR = vehicle({}), VAN = vehicle({ L: 0.03, H: 0.0085, kind: 'van' }), BUS = vehicle({ L: 0.064, Wd: 0.0135, H: 0.0095, kind: 'bus' }), TRUCK = vehicle({ L: 0.054, Wd: 0.013, H: 0.0062, kind: 'truck' });
  // 车身颜色池：白、黑、银灰最多，少量红、蓝、香槟色（按中国街头常见比例）
  const CAR_COLS = [[0.80, 0.80, 0.78], [0.80, 0.80, 0.78], [0.80, 0.80, 0.78], [0.03, 0.03, 0.035], [0.03, 0.03, 0.035], [0.42, 0.43, 0.45], [0.42, 0.43, 0.45], [0.18, 0.19, 0.2], [0.45, 0.04, 0.03], [0.05, 0.12, 0.32], [0.55, 0.47, 0.34]];
  const pickCol = cols => cols[(rnd() * cols.length) | 0];

  // 红绿灯相位：14 秒一轮，phase = 0 为东西向先绿，phase = 1 为南北向先绿，中间留全红清空时间避免路口穿模
  const sigState = (t, phase = 0) => { const c = (((t + phase * 7) % 14) + 14) % 14; return c < 5.2 ? 2 : c < 6.3 ? 1 : 0; };
  const sigGreen = (t, phase = 0) => sigState(t, phase) === 2;

  // 由道路定义（§8 的 rd）生成车道：靠右行驶，每个方向 lanes 条；内侧车道略快。
  // 每条车道 = { path 路径, sp 速度（单位/秒）, n 车数 }
  function lanesOf(rd) {
    const { pts, closed = false, w, lanes = 1, median = 0 } = rd, lw = (w - median) / 2 / lanes, out = [];
    for (let i = 0; i < lanes; i++) {
      const off = median / 2 + lw * (i + 0.5), sp = (rd.speed ?? 0.07) * (1 - i * 0.12);
      out.push({ path: pathOf(offsetLine(pts, off, closed), closed), sp, n: rd.n ?? 4 });
      out.push({ path: pathOf(offsetLine([...pts].reverse(), off, closed), closed), sp: sp * (0.92 + rnd() * 0.16), n: rd.n ?? 4 });
    }
    return out;
  }
  // 车流：支持路口红灯停车排队（刹车灯高亮）、跟车防追尾、公交进港湾站台缓停靠站、救护车顶爆闪灯。
  function traffic(d, lanes, { kind = CAR, cols = CAR_COLS, delay = 0.8, crossings = [], busStops = [], amb = false } = {}) {
    const cars = [], laneGroups = [];
    for (const l of lanes) {
      const P = l.path, stops = [], grp = [];
      for (const [cx, cz, hw = 0.05] of crossings) {
        let bestS = -1, bestD = 1e9;
        for (let s = 0; s <= P.L; s += 0.007) { const [px, pz] = P.at(s), dd = Math.hypot(px - cx, pz - cz); if (dd < bestD) { bestD = dd; bestS = s; } }
        if (bestD < hw) {
          const [, , ang] = P.at(bestS), phase = Math.abs(Math.cos(ang)) > 0.7 ? 0 : 1, sStop = bestS - hw - 0.008;
          if (P.closed || (sStop > 0.05 && sStop < P.L - 0.05)) stops.push({ s: (sStop + P.L) % P.L, phase });
        }
      }
      for (const [bx, bz] of busStops) {
        let bestS = -1, bestD = 1e9;
        for (let s = 0.06; s <= P.L - 0.06; s += 0.007) { const [px, pz] = P.at(s), dd = Math.hypot(px - bx, pz - bz); if (dd < bestD) { bestD = dd; bestS = s; } }
        if (bestD < 0.045) stops.push({ s: bestS, bus: true });
      }
      for (let i = 0; i < l.n; i++) {
        const o = l.o0 !== undefined ? l.o0 + i / l.n : (i + 0.15 + rnd() * 0.5) / l.n;
        const c = { l, s: (((o % 1) + 1) % 1) * P.L, v: l.sp, stops, bt: 0, bc: rnd() * 6, pull: 0 };
        cars.push(c); grp.push(c);
      }
      if (grp.length) laneGroups.push({ l, grp });
    }
    if (!cars.length) return;
    const N = cars.length, body = inst(kind.body, lifeM, N, true), lights = inst(kind.lights, lightM, N), brake = inst(kind.brake, lightM, N), beam = inst(kind.beam, beamM, N);
    const ambBar = amb ? inst(mergeC([
      [new T.BoxGeometry(0.0022, 0.0014, 0.0035).translate(0.004, kind.H + 0.0008, 0.0022), [9, 0.2, 0.15]],
      [new T.BoxGeometry(0.0022, 0.0014, 0.0035).translate(0.004, kind.H + 0.0008, -0.0022), [0.15, 1.2, 9]],
    ]), lightM, N) : null;
    cars.forEach((c, i) => body.setColorAt(i, _c.setRGB(...(c.col = pickCol(cols)))));
    const node = new T.Group(); node.add(body, lights, brake, beam); if (ambBar) node.add(ambBar);
    addNode(d, node, 0, 0, delay, 0.02);
    const safe = kind.L * 1.48 + 0.009, hasStops = crossings.length > 0 || busStops.length > 0;
    const stepSim = (t, dt) => {
      for (const { l, grp } of laneGroups) {
        const L = l.path.L;
        for (let i = 0; i < grp.length; i++) {
          const c = grp[i];
          if (!hasStops) { c.s = (c.s + l.sp * dt) % L; c.v = l.sp; continue; }
          let gapCar = 1e9, gapStop = 1e9;
          for (let j = 0; j < grp.length; j++) if (j !== i) {
            const dF = grp[j].s >= c.s ? grp[j].s - c.s : (l.path.closed ? grp[j].s + L - c.s : 1e9);
            if (dF < gapCar) gapCar = dF;
          }
          if (c.bc > 0) c.bc -= dt;
          if (c.bt > 0) c.bt -= dt;
          for (const st of c.stops) {
            const dSt = st.s >= c.s ? st.s - c.s : (l.path.closed ? st.s + L - c.s : 1e9);
            if (st.bus) {
              if (c.bt <= 0 && c.bc <= 0 && dSt < 0.035) { if (dSt < 0.004) { c.bt = 3.2; c.bc = 13; } else gapStop = Math.min(gapStop, dSt); }
            } else if (!sigGreen(t, st.phase) && dSt > 0.002 && dSt < 0.11) {
              gapStop = Math.min(gapStop, dSt);
            }
          }
          const eff = Math.min(gapCar - safe, gapStop - 0.005);
          const wantV = c.bt > 0 ? 0 : l.sp * clamp(eff / 0.036, 0, 1);
          c.v += (wantV - c.v) * Math.min(1, dt * 6.5);
          c.pull += ((c.bt > 0 ? 0.0032 : 0) - c.pull) * Math.min(1, dt * 4);
          c.s = (c.s + Math.max(0, c.v) * dt) % L;
        }
      }
    };
    if (hasStops) for (let k = -110; k < 0; k++) stepSim(k * 0.05, 0.05);   // 预热车流，首帧即呈现自然的红灯排队与绿波错落
    const fade = 0.05; let lastT = null;
    animate(d, (t, v) => {
      if (v < 0.02) { lastT = null; return; }
      const dt = lastT === null ? 0.016 : clamp(t - lastT, 0, 0.05); lastT = t;
      stepSim(t, dt);
      for (let i = 0; i < N; i++) {
        const c = cars[i], P = c.l.path; let [x, z, a] = P.at(c.s);
        if (c.pull > 1e-4) { x += Math.cos(a + Math.PI / 2) * c.pull; z += Math.sin(a + Math.PI / 2) * c.pull; }
        const sc = P.closed ? 1 : smooth(0, fade, c.s) * smooth(P.L, P.L - fade, c.s);
        const brk = (c.v < c.l.sp * 0.62 || c.bt > 0) ? sc : 0;
        setI(body, i, x, 0, z, -a, sc); setI(lights, i, x, 0, z, -a, sc); setI(brake, i, x, 0, z, -a, brk); setI(beam, i, x, 0, z, -a, sc);
        if (ambBar) setI(ambBar, i, x, 0, z, -a + (((t * 7) | 0) % 2 ? Math.PI : 0), sc);
      }
      body.instanceMatrix.needsUpdate = lights.instanceMatrix.needsUpdate = brake.instanceMatrix.needsUpdate = beam.instanceMatrix.needsUpdate = true;
      if (ambBar) ambBar.instanceMatrix.needsUpdate = true;
    });
  }
  // 路口悬臂红绿灯：与 traffic 的 sigState 严格同步变色。list 每项 [cx, cz, 半宽, 模式 'cross'|'ew'|'ns']
  function signals(d, list, delay = 0.62) {
    const poles = [], bulbs = [];
    for (const [cx, cz, hw = 0.046, mode = 'cross'] of list) {
      const dirs = [];
      if (mode !== 'ns') dirs.push([cx - hw, cz + hw, 0, 0], [cx + hw, cz - hw, Math.PI, 0]);
      if (mode !== 'ew') dirs.push([cx - hw, cz - hw, -Math.PI / 2, 1], [cx + hw, cz + hw, Math.PI / 2, 1]);
      for (const [x, z, ry, ph] of dirs) {
        const ca = Math.cos(ry), sa = Math.sin(ry), rot = (lx, lz) => [x + lx * ca + lz * sa, z - lx * sa + lz * ca];
        poles.push([cylAt(0.0007, 0.0009, 0.031, x, 0, z, 6), 4, 0, 1, C.dark]);
        const [ax, az] = rot(0, -0.009), gArm = new T.BoxGeometry(0.001, 0.001, 0.018); gArm.rotateY(ry); gArm.translate(ax, 0.030, az);
        poles.push([gArm, 4, 0, 1, C.dark]);
        const [bx, bz] = rot(0, -0.015), gBox = new T.BoxGeometry(0.0022, 0.0024, 0.0055); gBox.rotateY(ry); gBox.translate(bx, 0.0295, bz);
        poles.push([gBox, 4, 0, 1, C.dark]);
        bulbs.push({ x: bx, y: 0.0292, z: bz, ry, ph });
      }
    }
    if (!bulbs.length) return;
    const node = new T.Group(); node.add(new T.Mesh(merge(poles), MAT[d]));
    const bGeo = mergeC([[new T.SphereGeometry(0.0013, 6, 5), [1, 1, 1]]]);
    const bMesh = inst(bGeo, lightM, bulbs.length);
    bulbs.forEach((b, i) => { setI(bMesh, i, b.x, b.y, b.z, b.ry); bMesh.setColorAt(i, _c.setRGB(4, 0.2, 0.1)); });
    node.add(bMesh); addNode(d, node, 0, 0, delay, 0.035);
    animate(d, (t, v) => {
      if (v < 0.02) return;
      for (let i = 0; i < bulbs.length; i++) {
        const st = sigState(t, bulbs[i].ph);
        bMesh.setColorAt(i, st === 2 ? _c.setRGB(0.18, 4.0, 0.65) : st === 1 ? _c.setRGB(4.5, 2.5, 0.15) : _c.setRGB(5.0, 0.22, 0.12));
      }
      bMesh.instanceColor.needsUpdate = true;
    });
  }
  // 公交候车亭：深灰顶棚 + 暖光灯箱 + 等车乘客。list 每项 [x, z, 朝向马路的 rotY]
  function busStops(d, list, delay = 0.64) {
    if (!list.length) return;
    const parts = [], lights = [], waiters = [];
    const boxM = new T.MeshBasicMaterial({ color: new T.Color(2.3, 1.85, 1.25), clippingPlanes: CLIP });
    for (const [x, z, ry] of list) {
      const ca = Math.cos(ry), sa = Math.sin(ry), tr = (g, lx, ly, lz) => { g.rotateY(ry); g.translate(x + lx * ca + lz * sa, ly, z - lx * sa + lz * ca); return g; };
      parts.push([tr(new T.BoxGeometry(0.034, 0.0014, 0.010), 0, 0.0155, 0), 4, 0, 1, C.dark]);
      for (const lx of [-0.014, 0.014]) parts.push([tr(new T.BoxGeometry(0.0012, 0.0155, 0.0012), lx, 0.0077, -0.0035), 4, 0, 1, C.dark]);
      parts.push([tr(new T.BoxGeometry(0.018, 0.0012, 0.003), -0.004, 0.0038, -0.002), 4, 0, 1, [0.42, 0.26, 0.13]]);
      lights.push([tr(new T.BoxGeometry(0.008, 0.011, 0.0018), 0.010, 0.0075, -0.0032), [1, 1, 1]]);
      for (let k = 0; k < 3; k++) {
        const ox = -0.011 + k * 0.008 + (rnd() - 0.5) * 0.003, oz = 0.0015 + rnd() * 0.0025;
        waiters.push({ x: x + ox * ca + oz * sa, z: z - ox * sa + oz * ca, a: -ry + Math.PI / 2 + (rnd() - 0.5) * 0.25 });
      }
    }
    const node = new T.Group(); node.add(new T.Mesh(merge(parts), MAT[d]));
    const lm = new T.Mesh(mergeC(lights), boxM); lm.userData.noShadow = true; node.add(lm);
    addNode(d, node, 0, 0, delay, 0.02);
    crowd(d, waiters, { delay: delay + 0.1 });
  }
  // 非机动车道小电驴（外卖黄/蓝骑手与通勤电动车）
  const SCOOTER = mergeC([
    [new T.BoxGeometry(0.0105, 0.0028, 0.0036).translate(0, 0.0022, 0), [0.12, 0.13, 0.15]],
    [new T.BoxGeometry(0.0020, 0.0048, 0.0038).translate(0.0036, 0.0045, 0), [0.15, 0.15, 0.16]],
    [new T.CylinderGeometry(0.0014, 0.0012, 0.0042, 6).translate(-0.0005, 0.0062, 0), [1, 1, 1]],
    [new T.SphereGeometry(0.0013, 6, 5).translate(-0.0002, 0.0095, 0), [1, 1, 1]],
    [new T.BoxGeometry(0.0034, 0.0032, 0.0036).translate(-0.0042, 0.0052, 0), [1, 1, 1]],
  ]);
  const SCOOT_L = mergeC([[new T.SphereGeometry(0.0008, 5, 4).translate(0.0052, 0.0052, 0), [5, 4.5, 3.5]]]);
  function scooters(d, lanes, { delay = 0.84 } = {}) {
    const list = [], cols = [[0.92, 0.68, 0.04], [0.06, 0.44, 0.88], [0.92, 0.68, 0.04], [0.78, 0.78, 0.76], [0.12, 0.22, 0.35]];
    for (const l of lanes) for (let i = 0; i < (l.n ?? 2); i++) list.push({ l, o: rnd(), sp: (l.sp ?? 0.042) * (0.85 + rnd() * 0.3) });
    if (!list.length) return;
    const N = list.length, body = inst(SCOOTER, matteM, N, true), hl = inst(SCOOT_L, lightM, N);
    list.forEach((_, i) => body.setColorAt(i, _c.setRGB(...pickCol(cols))));
    const node = new T.Group(); node.add(body, hl); addNode(d, node, 0, 0, delay, 0.015);
    animate(d, (t, v) => {
      if (v < 0.02) return;
      for (let i = 0; i < N; i++) {
        const s0 = list[i], P = s0.l.path, s = (((s0.o + t * s0.sp / P.L) % 1) + 1) % 1 * P.L, [x, z, a] = P.at(s);
        const sc = P.closed ? 1 : smooth(0, 0.04, s) * smooth(P.L, P.L - 0.04, s);
        setI(body, i, x, 0, z, -a, sc); setI(hl, i, x, 0, z, -a, sc);
      }
      body.instanceMatrix.needsUpdate = hl.instanceMatrix.needsUpdate = true;
    });
  }
  // 停着的车：spots 是车位列表（§8 parking() 的返回值或手写 [x, z, 朝向]），fill = 停满的比例；hazard = 双闪等待车辆数
  function parked(d, spots, { kind = CAR, cols = CAR_COLS, fill = 0.8, delay = 0.7, hazard = 0, amb = false } = {}) {
    const list = spots.filter(() => rnd() < fill);
    if (!list.length) return;
    const body = inst(kind.body, lifeM, list.length, true), node = new T.Group(); node.add(body);
    const hzList = [];
    list.forEach(([x, z, a, fixed], i) => {
      const ry = fixed ? a : a + (rnd() < 0.5 ? Math.PI : 0);
      setI(body, i, x, 0, z, ry); body.setColorAt(i, _c.setRGB(...pickCol(cols)));
      if (i < hazard || amb) hzList.push({ x, z, ry, ph: rnd() * 6 });
    });
    if (hzList.length) {
      const hGeo = amb ? mergeC([
        [new T.BoxGeometry(0.0022, 0.0014, 0.0035).translate(0.004, kind.H + 0.0008, 0.0022), [8, 0.2, 0.15]],
        [new T.BoxGeometry(0.0022, 0.0014, 0.0035).translate(0.004, kind.H + 0.0008, -0.0022), [0.15, 1.2, 8]],
      ]) : mergeC([
        [new T.SphereGeometry(0.0009, 5, 4).translate(kind.L / 2, 0.0038, 0.0045), [5, 2.4, 0.1]],
        [new T.SphereGeometry(0.0009, 5, 4).translate(kind.L / 2, 0.0038, -0.0045), [5, 2.4, 0.1]],
        [new T.SphereGeometry(0.0009, 5, 4).translate(-kind.L / 2, 0.0038, 0.0045), [5, 2.4, 0.1]],
        [new T.SphereGeometry(0.0009, 5, 4).translate(-kind.L / 2, 0.0038, -0.0045), [5, 2.4, 0.1]],
      ]);
      const hm = inst(hGeo, lightM, hzList.length); node.add(hm);
      animate(d, (t, v) => {
        if (v < 0.02) return;
        hzList.forEach((h, i) => {
          const on = amb ? 1 : (((t * 1.8 + h.ph) % 1) < 0.48 ? 1 : 0);
          setI(hm, i, h.x, 0, h.z, h.ry + (amb && ((t * 5) | 0) % 2 ? Math.PI : 0), on);
        });
        hm.instanceMatrix.needsUpdate = true;
      });
    }
    addNode(d, node, 0, 0, delay, 0.02);
  }

  // 行人模型：腿（深色）+ 上衣（颜色按实例随机）+ 头。人高约 0.011，约 1.8 米
  const PERSON = mergeC([
    [new T.CylinderGeometry(0.0010, 0.0011, 0.0052, 5).translate(0, 0.0026, 0), [0.10, 0.10, 0.12]],
    [new T.CylinderGeometry(0.0018, 0.0014, 0.0042, 6).translate(0, 0.0072, 0), [1, 1, 1]],
    [new T.SphereGeometry(0.0013, 6, 5).translate(0, 0.0103, 0), [0.62, 0.46, 0.36]],
  ]);
  const SEATED = mergeC([
    [new T.BoxGeometry(0.0024, 0.0014, 0.0022).translate(0.0008, 0.0042, 0), [0.10, 0.10, 0.12]],
    [new T.BoxGeometry(0.0012, 0.0036, 0.0022).translate(0.0018, 0.0018, 0), [0.10, 0.10, 0.12]],
    [new T.CylinderGeometry(0.0017, 0.0014, 0.0038, 6).translate(0, 0.0066, 0), [1, 1, 1]],
    [new T.SphereGeometry(0.0013, 6, 5).translate(0.0002, 0.0095, 0), [0.62, 0.46, 0.36]],
  ]);
  const SHIRTS = [   // 上衣颜色池
   [0.75, 0.75, 0.72], [0.05, 0.05, 0.06], [0.10, 0.16, 0.36], [0.55, 0.08, 0.06], [0.35, 0.36, 0.38], [0.62, 0.50, 0.30], [0.12, 0.30, 0.20], [0.70, 0.62, 0.55], [0.20, 0.40, 0.65]];
  // 一群人。支持结伴并肩走、亲子比例（w.sc）、驻足面朝看点、以及自定义动态位置函数 w.fn(t)
  function crowd(d, walkers, { cols = SHIRTS, delay = 0.85, scale = 1, avoid = [] } = {}) {
    if (!walkers.length) return;
    const N = walkers.length, mesh = inst(PERSON, matteM, N);
    walkers.forEach((w, i) => { mesh.setColorAt(i, _c.setRGB(...pickCol(w.cols ?? cols))); w.ph = w.ph ?? rnd() * 50; w.k = (0.9 + rnd() * 0.2) * scale * (w.sc ?? 1); });
    const node = new T.Group(); node.add(mesh); addNode(d, node, 0, 0, delay, 0.02);
    animate(d, (t, v) => {
      if (v < 0.02) return;
      for (let i = 0; i < N; i++) {
        const w = walkers[i]; let x, z, a, mv = 1, extraY = 0;
        if (w.fn) {
          [x, z, a, extraY = 0] = w.fn(t, w);
        } else if (w.path) {
          const P = w.path, L = P.L; let s = (w.o ?? 0) * L + t * w.sp, back = false;
          if (w.ping || !P.closed) { s = ((s % (2 * L)) + 2 * L) % (2 * L); if (s > L) { s = 2 * L - s; back = true; } }
          [x, z, a] = P.at(s); if (back) a += Math.PI;
          if (w.side) { x += Math.cos(a + Math.PI / 2) * w.side; z += Math.sin(a + Math.PI / 2) * w.side; }
        } else if (w.r !== undefined) {
          const u = t * (w.sp ?? 0.25) + w.ph;
          x = w.cx + Math.sin(u * 0.71) * w.r * (w.rx ?? 1); z = w.cz + Math.sin(u * 0.53 + 1.3) * w.r * (w.rz ?? 1);
          a = Math.atan2(Math.cos(u * 0.53 + 1.3) * 0.53 * (w.rz ?? 1), Math.cos(u * 0.71) * 0.71 * (w.rx ?? 1));
        } else { x = w.x; z = w.z; a = (w.a ?? w.ph) + Math.sin(t * 0.8 + w.ph) * 0.08; mv = 0; }
        for (const o of avoid) {
          if (o.length === 3) { const dx = x - o[0], dz = z - o[1], dd = Math.hypot(dx, dz); if (dd < o[2]) { const k = o[2] / Math.max(dd, 1e-4); x = o[0] + dx * k; z = o[1] + dz * k; } }
          else if (x > o[0] && x < o[2] && z > o[1] && z < o[3]) { const e = [x - o[0], o[2] - x, z - o[1], o[3] - z], m = Math.min(...e), j = e.indexOf(m); if (j === 0) x = o[0]; else if (j === 1) x = o[2]; else if (j === 2) z = o[1]; else z = o[3]; }
        }
        const bob = (mv ? Math.abs(Math.sin(t * 9 + w.ph)) * 0.0005 : 0) + extraY;      // 走路时身体轻轻上下颠
        setI(mesh, i, x, bob, z, -a, w.k);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
  // 快捷生成：walkPath 沿路独行；pairPath 两人结伴并肩同行（可选亲子一大一小）；standLook 面朝焦点驻足；chatGroup 两三人围站交谈
  const walkPath = (pts, n, sp = 0.014, closed = false, side = 0.004) => Array.from({ length: n }, () => ({ path: pathOf(pts, closed), sp: sp * (0.75 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1), o: rnd(), ping: !closed, side: (rnd() - 0.5) * 2 * side }));
  const pairPath = (pts, nPairs, sp = 0.0125, closed = false, kidRate = 0.18) => {
    const P = pathOf(pts, closed), out = [];
    for (let i = 0; i < nPairs; i++) {
      const o = rnd(), s = sp * (0.82 + rnd() * 0.32) * (rnd() < 0.5 ? -1 : 1), base = (rnd() - 0.5) * 0.003, kid = rnd() < kidRate;
      out.push({ path: P, sp: s, o, ping: !closed, side: base - 0.0018 }, { path: P, sp: s, o, ping: !closed, side: base + 0.0018, sc: kid ? 0.64 : 0.96 });
    }
    return out;
  };
  const wander = (cx, cz, r, n, rx = 1, rz = 1) => Array.from({ length: n }, () => ({ cx: cx + (rnd() - 0.5) * r, cz: cz + (rnd() - 0.5) * r, r: r * (0.3 + rnd() * 0.6), rx, rz, sp: 0.15 + rnd() * 0.25 }));
  const stand = (cx, cz, r, n) => Array.from({ length: n }, () => ({ x: cx + (rnd() - 0.5) * r, z: cz + (rnd() - 0.5) * r }));
  const standLook = (cx, cz, r, n, tx, tz, kidRate = 0.15) => Array.from({ length: n }, (_, i) => {
    const x = cx + (rnd() - 0.5) * r, z = cz + (rnd() - 0.5) * r;
    return { x, z, a: Math.atan2(tz - z, tx - x) + (rnd() - 0.5) * 0.28, sc: i % 3 === 1 && rnd() < kidRate * 3 ? 0.65 : 1 };
  });
  const chatGroup = (cx, cz, n = 3) => Array.from({ length: n }, (_, i) => {
    const ang = (i / n) * TAU + rnd() * 0.4, rr = 0.0032 + rnd() * 0.0012;
    return { x: cx + Math.cos(ang) * rr, z: cz + Math.sin(ang) * rr, a: ang + Math.PI + (rnd() - 0.5) * 0.2 };
  });
  // 公园/校园长椅 + 坐着休息的人：list 每项 [x, z, rotY, 坐几个人(0~2)]
  function benches(d, list, delay = 0.66) {
    if (!list.length) return;
    const parts = [], sitters = [];
    for (const [x, z, ry = 0, nSit = 1] of list) {
      const ca = Math.cos(ry), sa = Math.sin(ry), tr = (g, lx, ly, lz) => { g.rotateY(ry); g.translate(x + lx * ca + lz * sa, ly, z - lx * sa + lz * ca); return g; };
      parts.push([tr(new T.BoxGeometry(0.015, 0.0010, 0.0042), 0, 0.0034, 0), 4, 0, 1, [0.46, 0.28, 0.13]],
        [tr(new T.BoxGeometry(0.015, 0.0032, 0.0009), 0, 0.0052, -0.0018), 4, 0, 1, [0.46, 0.28, 0.13]]);
      for (const lx of [-0.0058, 0.0058]) parts.push([tr(new T.BoxGeometry(0.0010, 0.0034, 0.0038), lx, 0.0017, 0), 4, 0, 1, C.dark]);
      for (let k = 0; k < nSit; k++) {
        const lx = nSit === 1 ? (rnd() - 0.5) * 0.005 : (k ? 0.0036 : -0.0036);
        sitters.push({ x: x + lx * ca, z: z - lx * sa, ry: ry - Math.PI / 2 });
      }
    }
    const node = new T.Group(); node.add(new T.Mesh(merge(parts), MAT[d]));
    if (sitters.length) {
      const sm = inst(SEATED, matteM, sitters.length);
      sitters.forEach((s, i) => { setI(sm, i, s.x, 0, s.z, s.ry, 0.96); sm.setColorAt(i, _c.setRGB(...pickCol(SHIRTS))); });
      node.add(sm);
    }
    addNode(d, node, 0, 0, delay, 0.015);
  }
  // 建筑冠顶航空障碍灯 / 停机坪助航灯：list 每项 [x, y, z, 'red' | 'heli']
  function beacons(d, list, delay = 0.6) {
    if (!list.length) return;
    const geo = mergeC([[new T.SphereGeometry(0.0018, 6, 5), [1, 1, 1]]]), mesh = inst(geo, lightM, list.length);
    list.forEach(([x, y, z, kind = 'red'], i) => {
      setI(mesh, i, x, y, z, 0, kind === 'heli' ? 0.65 : 1);
      mesh.setColorAt(i, kind === 'heli' ? _c.setRGB(0.25, 3.6, 0.7) : _c.setRGB(5.5, 0.18, 0.08));
    });
    const node = new T.Group(); node.add(mesh); addNode(d, node, 0, 0, delay, 0.05);
    animate(d, (t, v) => {
      if (v < 0.02) return;
      list.forEach(([x, y, z, kind = 'red'], i) => {
        const sc = kind === 'heli' ? 0.55 + 0.18 * Math.sin(t * 3 + i) : (0.35 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(t * 2.2 + i * 1.7), 3));
        setI(mesh, i, x, y, z, 0, sc);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
  // 柔和烟雾 / 水汽粒子贴图（蒙古包炊烟、工厂冷却塔白雾共用）
  const SMOKE_TEX = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.65)'); g.addColorStop(0.45, 'rgba(255,255,255,0.25)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    const tx = new T.CanvasTexture(cv); return tx;
  })();
  function plumes(d, sources, { col = [0.78, 0.76, 0.72], size = 0.018, nPer = 18, h = 0.11, dx = 0.045, dz = 0.02, sp = 0.22, opacity = 0.34 } = {}) {
    const N = sources.length * nPer, pos = new Float32Array(N * 3);
    const seeds = sources.flatMap(([sx, sy, sz]) => Array.from({ length: nPer }, (_, k) => [sx, sy, sz, k / nPer + rnd() * 0.05, (rnd() - 0.5) * 0.008, (rnd() - 0.5) * 0.008]));
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3));
    const pm = new T.PointsMaterial({ map: SMOKE_TEX, color: new T.Color(...col), size, transparent: true, opacity, depthWrite: false, clippingPlanes: CLIP });
    const pts = new T.Points(g, pm); groups[d].add(pts);
    animate(d, (t, v) => {
      pm.opacity = opacity * smooth(0.78, 1, v); pts.visible = v > 0.78;
      if (!pts.visible) return;
      for (let i = 0; i < N; i++) {
        const [sx, sy, sz, o, jx, jz] = seeds[i], ph = (t * sp + o) % 1, w = Math.sin(t * 1.6 + o * 12) * 0.005 * ph;
        pos[i * 3] = sx + dx * ph * ph + jx * ph + w;
        pos[i * 3 + 1] = sy + h * ph;
        pos[i * 3 + 2] = sz + dz * ph * ph + jz * ph + w * 0.6;
      }
      g.attributes.position.needsUpdate = true;
    });
  }
  // 湖面/草原上空盘旋滑翔的小飞鸟（着色器双翅微扇，1 次绘制）
  const BIRD_GEO = (() => {
    const g = new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0.002), new T.Vector3(-0.0048, 0.0008, -0.001), new T.Vector3(0, 0, -0.0018),
      new T.Vector3(0, 0, 0.002), new T.Vector3(0, 0, -0.0018), new T.Vector3(0.0048, 0.0008, -0.001)]);
    g.computeVertexNormals();
    return mergeC([[g, [0.85, 0.84, 0.80]]]);
  })();
  const birdM = matteM.clone(); birdM.side = T.DoubleSide;
  birdM.onBeforeCompile = sh => {
    sh.uniforms.uTime = U.time;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nfloat bPh = instanceMatrix[3][0] * 37.0 + instanceMatrix[3][2] * 53.0;\ntransformed.y += abs(position.x) * sin(uTime * 6.8 + bPh) * 0.55;');
  };
  birdM.customProgramCacheKey = () => 'bird';
  function birds(d, cx, cz, y0 = 0.16, r = 0.14, n = 5) {
    const mesh = inst(BIRD_GEO, birdM, n), list = Array.from({ length: n }, (_, i) => ({ a0: i / n * TAU + rnd() * 0.5, rr: r * (0.7 + rnd() * 0.5), y: y0 + (rnd() - 0.5) * 0.035, sp: 0.22 + rnd() * 0.08 }));
    groups[d].add(mesh);
    animate(d, (t, v) => {
      mesh.visible = v > 0.8; if (!mesh.visible) return;
      const sc = smooth(0.8, 1, v);
      list.forEach((b, i) => {
        const u = b.a0 + t * b.sp, x = cx + Math.cos(u) * b.rr, z = cz + Math.sin(u) * b.rr * 0.78, dir = Math.atan2(Math.cos(u) * 0.78, -Math.sin(u));
        setI(mesh, i, x, b.y + Math.sin(t * 0.9 + b.a0) * 0.008, z, -dir + Math.PI / 2, sc);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  // 三种树：0 圆冠乔木（国槐、榆树这类）/ 1 钻天杨（内蒙古路边、防护林最常见）/ 2 松柏（机关大院常见）。树高约 0.03 ≈ 5 米
  const TREE_GEOS = (() => {
    const trunk = c => [cylAt(0.0009, 0.0013, 0.014, 0, 0, 0, 5), c];
    const round = mergeC([trunk([0.5, 0.42, 0.36]), ...[[0, 0.022, 0, 0.0105], [0.006, 0.018, 0.003, 0.0085], [-0.005, 0.019, -0.004, 0.0085], [0.001, 0.028, -0.002, 0.0075]].map(([x, y, z, r]) => [new T.IcosahedronGeometry(r, 0).translate(x, y, z), [1, 1, 1]])]);
    const poplar = mergeC([trunk([0.5, 0.42, 0.36]), [new T.IcosahedronGeometry(0.0065, 1).scale(1, 3.2, 1).translate(0, 0.032, 0), [1, 1, 1]]]);
    const pine = mergeC([trunk([0.5, 0.42, 0.36]), [new T.ConeGeometry(0.009, 0.022, 7).translate(0, 0.019, 0), [1, 1, 1]], [new T.ConeGeometry(0.0068, 0.018, 7).translate(0, 0.03, 0), [1, 1, 1]]]);
    return [round, poplar, pine];
  })();
  const LEAF = [   // 三种树各自的叶色池
   [[0.10, 0.20, 0.06], [0.13, 0.24, 0.07], [0.16, 0.26, 0.08], [0.09, 0.17, 0.06], [0.20, 0.27, 0.08]], [[0.14, 0.24, 0.07], [0.18, 0.28, 0.08], [0.24, 0.30, 0.09]], [[0.04, 0.10, 0.05], [0.05, 0.12, 0.06], [0.06, 0.13, 0.07]]];
  function forest(d, list, delay) {                                  // 种一批树：list 每项 [x, z, 树种 0/1/2, 大小倍数]
    const node = new T.Group();
    for (let k = 0; k < 3; k++) {
      const L = list.filter(p => (p[2] ?? 0) === k);
      if (!L.length) continue;
      const mesh = inst(TREE_GEOS[k], matteM, L.length, true);
      L.forEach(([x, z, , s = 1], i) => { const sc = s * (0.82 + rnd() * 0.36); setI(mesh, i, x, 0, z, rnd() * TAU, sc, sc * (0.9 + rnd() * 0.25)); mesh.setColorAt(i, _c.setRGB(...pickCol(LEAF[k]))); });
      node.add(mesh);
    }
    addNode(d, node, 0, 0, delay, 0.07);
  }
  // 路灯：细杆 + 发光灯头；地上的光斑在 §8 画进了地貌图。list 每项 [x, z]
  const lampM = new T.MeshBasicMaterial({ color: new T.Color(2.2, 1.7, 1.05), clippingPlanes: CLIP });
  function lamps(d, list, delay = 0.6) {
    if (!list.length) return;
    const posts = [], heads = [];
    for (const [x, z] of list) { posts.push([cylAt(0.0006, 0.0008, 0.024, x, 0, z, 5), 4, 0, 1, C.dark]); heads.push([new T.SphereGeometry(0.0019, 6, 5).translate(x, 0.025, z), 4]); }
    const node = new T.Group();
    node.add(new T.Mesh(merge(posts), MAT[d])); const hm = new T.Mesh(merge(heads), lampM); hm.userData.noShadow = true; hm.castShadow = false; node.add(hm);
    addNode(d, node, 0, 0, delay, 0.03);
  }
  // 喷泉：粒子水柱。中间一束高的，外圈一圈矮的往外喷；(fx, fz) 位置，R0~R1 外圈喷射半径，N 粒子数
  function fountain(d, fx, fz, R0 = 0.03, R1 = 0.085, N = 240) {
    const pos = new Float32Array(N * 3), seeds = Array.from({ length: N }, () => [rnd() * TAU, rnd(), rnd()]);
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3));
    const pm = new T.PointsMaterial({ color: new T.Color(1.6, 1.7, 1.8), size: 0.006, transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending, clippingPlanes: CLIP });
    const pts = new T.Points(g, pm); pts.position.set(fx, 0, fz); groups[d].add(pts);
    animate(d, (t, v) => {
      pm.opacity = 0.9 * smooth(0.85, 1, v); pts.visible = v > 0.85;
      if (!pts.visible) return;
      for (let i = 0; i < N; i++) {
        const [a, s, o] = seeds[i], ph = (t * 0.9 + o) % 1, inner = s < 0.3;
        const rr = inner ? 0.003 + ph * 0.016 : R0 + ph * (R1 - R0) * 0.5, hh = inner ? 0.05 + 0.04 * s : 0.03;
        pos[i * 3] = Math.cos(a) * rr; pos[i * 3 + 2] = Math.sin(a) * rr;
        pos[i * 3 + 1] = 0.006 + (inner ? 0.02 : 0.003) + hh * 4 * ph * (1 - ph);
      }
      g.attributes.position.needsUpdate = true;
    });
  }

  // 一小片树林：在 (cx, cz) 半径 r 内随机撒 n 棵，互相距离 > 0.02；kinds 可选树种；sq 竖向压扁（椭圆形林子）
  function grove(cx, cz, r, n, kinds = [0], size = 1, sq = 0.8) {
    const out = []; let k = 0;
    while (out.length < n && k++ < n * 40) { const a = rnd() * TAU, rr = Math.sqrt(rnd()) * r, x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr * sq;
      if (out.every(p => Math.hypot(p[0] - x, p[1] - z) > 0.02)) out.push([x, z, kinds[(rnd() * kinds.length) | 0], size * (0.85 + rnd() * 0.4)]); }
    return out;
  }
  const lakeM = waterMat(   // 自然水面（湖、海子、河面）：深色光滑反射环境，带微风波纹
   [0.02, 0.042, 0.05], 0.04, { envMapIntensity: 1.7 }, false);
  // 草坪庭院矮灯：用于公园步道、湖岸、医院花园（弥补高杆路灯照不到的暗角）
  function bollards(d, list, delay = 0.62) {
    if (!list.length) return;
    const posts = [], heads = [];
    for (const [x, z] of list) { posts.push([cylAt(0.0006, 0.0007, 0.0085, x, 0, z, 5), 4, 0, 1, C.dark]); heads.push([new T.SphereGeometry(0.0012, 5, 4).translate(x, 0.009, z), 4]); }
    const node = new T.Group(); node.add(new T.Mesh(merge(posts), MAT[d]));
    const hm = new T.Mesh(merge(heads), lampM); hm.userData.noShadow = true; hm.castShadow = false; node.add(hm);
    addNode(d, node, 0, 0, delay, 0.015);
  }
  // 街区轮廓：矩形，超出半径 rc 的部分沿圆弧切掉（城市环路以内的街区边缘贴着环路）
  function blockPoly(x0, z0, x1, z1, rc = 2) {
    const out = [], n = 16;
    const edge = (ax, az, bx, bz) => { for (let i = 0; i < n; i++) { let x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n; const r = Math.hypot(x, z); if (r > rc) { x *= rc / r; z *= rc / r; } out.push([x, z]); } };
    edge(x0, z0, x1, z0); edge(x1, z0, x1, z1); edge(x1, z1, x0, z1); edge(x0, z1, x0, z0);
    return out;
  }
  const inDisc = (x, z, r = 0.95) =>        // 点在不在台面半径 r 以内
    Math.hypot(x, z) < r;
  const scatter = (pts, n, minR = 0, filter = () => true) =>   // 在多边形 pts 里随机撒 n 个点
    { const bb = bbox(pts), out = []; let k = 0; while (out.length < n && k++ < n * 40) { const x = bb[0] + rnd() * (bb[2] - bb[0]), z = bb[1] + rnd() * (bb[3] - bb[1]); if (inPoly(x, z, pts) && filter(x, z)) out.push([x, z]); } return out; };
  // 点在不在多边形里（射线法）
  function inPoly(x, z, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; }
  const DISC = shapeCircle(R - 0.012, 160);    // 整个台面的轮廓，画底色用

  /* ══ §11 五个领域的具体布置 ═══════════════════════════════
     每个领域一个代码块，结构相同：
       ① 定义道路（中线、宽度、车道数、车速、车数）
       ② TER[D] = terrain(…)：画地面（草地、铺装、水面、道路、停车场、斑马线）
       ③ add(…)：放建筑（tower / slab / 手工拼的 merge）
       ④ forest / lamps：树和路灯
       ⑤ traffic / parked：车
       ⑥ crowd：人；以及这个领域特有的动画（国旗、风机、羊群…）
     想改某个东西的位置，找到它的 add(…, x, z) 改 x、z 即可（坐标说明见文件头）。 */

  /* ══ §11-1 智慧城市 ══════════════════════════════════════
     布局（x 右，z 下）：
       半径 0.73 的二环快速路（双向 6 车道 + 中央绿化带），环外是绿化带和一圈低层房子，东北外侧是东河（弧形）
       四条主干道 x = ±0.26、z = ±0.26 十字交叉，三条支路
       CBD 在中央：两座超高层（-0.095, -0.08）（0.1, -0.06）+ 一座板式塔（0, 0.12）
       南侧（0, 0.47）喷泉广场；东侧（0.48, -0.115）万达广场商业体 + 停车场
       西侧和西北、东南是住宅区（板楼 + 小区绿地） */
  {
    const D = 0, RC = 0.668;          // RC：环路内侧边缘的半径，街区切到这里
    const ring = { pts: arcPts(0, 0, 0.73, 0, TAU, 200).slice(0, -1), closed: true, w: 0.105, lanes: 3, median: 0.012, speed: 0.12, n: 12 };
    const aves = [-0.26, 0.26].flatMap(v => [{ pts: chordX(v), w: 0.07, lanes: 2, sw: 0.014, speed: 0.08, n: 6 }, { pts: chordZ(v), w: 0.07, lanes: 2, sw: 0.014, speed: 0.08, n: 6 }]);
    const streets = [[[0, -0.676], [0, -0.296]], [[-0.676, 0], [-0.296, 0]], [[0.296, 0], [0.676, 0]]].map(pts => ({ pts, w: 0.036, lanes: 1, sw: 0.01, speed: 0.05, n: 2, lampStep: 0.09 }));
    const B = {          // 各街区的矩形范围 [x0, z0, x1, z1]（n 北、s 南、e 东、w 西）
      cbd: [-0.205, -0.205, 0.205, 0.205], n1: [-0.205, -0.68, -0.028, -0.309], n2: [0.028, -0.68, 0.205, -0.309], s: [-0.205, 0.309, 0.205, 0.68],
      e1: [0.309, -0.205, 0.68, -0.028], e2: [0.309, 0.028, 0.68, 0.205], w1: [-0.68, -0.205, -0.309, -0.028], w2: [-0.68, 0.028, -0.309, 0.205],
      ne: [0.309, -0.68, 0.68, -0.309], nw: [-0.68, -0.68, -0.309, -0.309], se: [0.309, 0.309, 0.68, 0.68], sw: [-0.68, 0.309, -0.309, 0.68],
    };
    const bp = k => blockPoly(...B[k], RC);    // 街区轮廓
    let lot = [];
    const riv = arcPts(0, 0, 0.885, -2.02, -0.26, 84), outerA = [0.0, 0.5, 0.95, 2.15, 2.6, 3.14, -2.2, -2.6];
    TER[D] = terrain(t => {
      t.grass(DISC, '#3c5a29', 1400);                                                       // 环外：绿化带
      t.poly(shapeCircle(0.79, 160), '#4d4c49', MT(0.85));                                  // 环内：城市硬地
      t.line(riv, 0.078, '#6d685c', MT(0.9)); t.line(riv, 0.058, '#0a1519', MT(0.04));
      t.line(offsetLine(riv, 0.034), 0.002, 'rgba(150,150,140,0.6)'); t.line(offsetLine(riv, -0.034), 0.002, 'rgba(150,150,140,0.6)');
      t.line(arcPts(0, 0, 0.838, -1.82, -1.33, 32), 0.009, '#9e988c', MT(0.75));
      t.line(arcPts(0, 0, 0.838, -1.19, -0.36, 40), 0.009, '#9e988c', MT(0.75));
      for (const a of outerA) {
        const r = 0.87, x = Math.cos(a) * r, z = Math.sin(a) * r;
        t.line([[Math.cos(a) * 0.79, Math.sin(a) * 0.79], [x, z]], 0.008, '#8f8b82', MT(0.78));
        t.poly(shapeCircle(0.048, 24, x, z), '#7d7970', MT(0.8)); t.glow(x, z, 0.045, 0.5);
      }
      for (const k of ['w1', 'w2', 'nw', 'se']) { t.grass(bp(k), '#45652e', 160); t.line(bp(k), 0.006, '#8d8a84', MT(0.85), { closed: true }); }   // 住宅区：小区绿地
      for (const sz of [-1, 1]) {
        t.line([[-0.31, sz * 0.115], [-0.54, sz * 0.115]], 0.009, '#9c968a', MT(0.75));
        t.poly(shapeRound(0.046, 0.030, 0.009, -0.505, sz * 0.118), '#b2563c', MT(0.82));
        t.poly(shapeRound(0.028, 0.018, 0.006, -0.505, sz * 0.118), '#3b7396', MT(0.82));
        t.glow(-0.42, sz * 0.115, 0.06, 0.65); t.glow(-0.56, sz * 0.115, 0.045, 0.55);
      }
      t.glow(-0.41, -0.42, 0.055, 0.55); t.glow(0.41, 0.43, 0.055, 0.55);
      for (const k of ['n1', 'n2', 'ne', 'sw', 'e1']) t.paving(bp(k), '#7d7a73', 'rgba(50,48,45,0.45)', 0.024);
      t.paving(bp('cbd'), '#8c887f', 'rgba(55,52,48,0.5)', 0.02);
      t.paving(bp('s'), '#827e76', 'rgba(55,52,48,0.45)', 0.024);
      t.paving(shapeCircle(0.15, 80, 0, 0.47), '#97928a', 'rgba(60,56,50,0.5)', 0.016);
      t.circle(0, 0.47, 0.105, '#6e6a62', MT(0.8)); t.circle(0, 0.47, 0.09, '#0c181c', MT(0.05));   // 喷泉水池
      for (const g of [[-0.15, 0.6, 0.05, 0.03], [0.15, 0.6, 0.05, 0.03], [-0.15, 0.34, 0.04, 0.025], [0.15, 0.34, 0.04, 0.025]]) t.grass(shapeRound(g[2] * 2, g[3] * 2, 0.01, g[0], g[1]), '#4a6a30', 30);
      lot = t.parking(0.33, 0.045, 0.6, 0.19, { rows: 2 });
      for (const r of [...aves, ...streets]) t.road(r);
      t.road(ring);
      for (const [a0, a1] of [[-2.01, -1.93], [-1.81, -1.33], [-1.21, -0.35]]) t.line(arcPts(0, 0, 0.885, a0, a1, 28), 0.054, '#0a1519', MT(0.04));
      t.glow(-0.095, -0.015, 0.065, 0.8); t.glow(0.1, 0.005, 0.065, 0.8); t.glow(0, 0.16, 0.06, 0.7); t.glow(0.48, -0.025, 0.085, 0.9);
      for (const [x, z] of along(ring.pts, 0.085, [0], true)) if (![-0.26, 0.26].some(v => Math.abs(x - v) < 0.05 || Math.abs(z - v) < 0.05)) { t.lampPts.push([x, z]); t.glow(x, z, 0.05, 0.6); }
      for (const v of [-0.26, 0.26]) for (const u of [-0.26, 0.26]) { t.zebra(v, u - 0.05, 0, 0.07); t.zebra(v, u + 0.05, 0, 0.07); t.zebra(v - 0.05, u, Math.PI / 2, 0.07); t.zebra(v + 0.05, u, Math.PI / 2, 0.07); }
    });
    // 东河跨河石拱桥 × 3 + 冠顶航空障碍灯
    for (const [bx, bz, ry] of [[-0.26, -0.846, 0], [0.26, -0.846, 0], [0.846, -0.26, Math.PI / 2]]) {
      const br = [[boxAt(0.098, 0.0045, 0.082, 0, 0.002, 0), 4, 0, 1, C.concrete]];
      for (const sx of [-0.046, 0.046]) {
        br.push([boxAt(0.004, 0.0085, 0.084, sx, 0.004, 0), 4, 0, 1, C.white]);
        for (const sz of [-0.04, 0, 0.04]) br.push([boxAt(0.006, 0.012, 0.006, sx, 0.004, sz), 4, 0, 1, C.stone]);
      }
      add(D, merge(br), null, bx, bz, { rotY: ry, delay: 0.42 });
    }
    beacons(D, [[-0.095, 0.752, -0.08, 'red'], [0.1, 0.612, -0.06, 'red'], [0.42, 0.452, -0.42, 'red'], [0.12, 0.36, -0.42, 'red']]);
    // CBD：双塔 + 第三座塔 + 广场
    add(D, tower({ w: 0.1, d: 0.1, h: 0.66, style: 1, podium: 0.035, tiers: 3, crown: 1, oct: 0.2, col: C.glass, pcol: C.glassG }), null, -0.095, -0.08, { delay: 0.1 });
    add(D, tower({ w: 0.1, d: 0.09, h: 0.58, style: 1, podium: 0.035, tiers: 2, crown: 2, col: [0.30, 0.34, 0.38] }), null, 0.1, -0.06, { delay: 0.15 });
    add(D, tower({ w: 0.15, d: 0.06, h: 0.3, style: 1, tiers: 1, col: [0.36, 0.38, 0.40] }), null, 0.0, 0.12, { delay: 0.2 });
    // 写字楼 / 住宅
    const B1 = [         // [x, z, tower 参数]
      [-0.12, -0.4, { w: 0.11, d: 0.09, h: 0.26, style: 1, col: [0.32, 0.36, 0.40] }], [-0.11, -0.56, { w: 0.09, d: 0.07, h: 0.14, style: 0, col: C.concrete }],
      [0.12, -0.42, { w: 0.1, d: 0.1, h: 0.33, style: 1, tiers: 2, crown: 2, col: [0.28, 0.33, 0.36] }], [0.11, -0.57, { w: 0.09, d: 0.06, h: 0.12, style: 0, col: C.stone }],
      [0.42, -0.42, { w: 0.1, d: 0.1, h: 0.36, style: 1, tiers: 2, crown: 1, oct: 0.22, col: C.glass }], [0.5, -0.34, { w: 0.06, d: 0.08, h: 0.14, style: 0, col: C.concrete }],
      [-0.42, 0.42, { w: 0.1, d: 0.08, h: 0.22, style: 1, col: [0.34, 0.37, 0.40] }], [-0.52, 0.34, { w: 0.06, d: 0.06, h: 0.12, style: 0, col: C.stone }], [-0.36, 0.55, { w: 0.06, d: 0.06, h: 0.09, style: 0, col: C.cream }],
    ];
    for (const [x, z, o] of B1) add(D, tower(o), null, x, z);
    // 住宅板楼：[x, z, 长, 高]
    for (const [x, z, w, h] of [[-0.42, -0.16, 0.15, 0.27], [-0.42, -0.075, 0.15, 0.23], [-0.58, -0.12, 0.09, 0.18], [-0.42, 0.075, 0.15, 0.25], [-0.42, 0.16, 0.15, 0.21], [-0.58, 0.12, 0.09, 0.17],
      [-0.43, -0.38, 0.12, 0.2], [-0.39, -0.47, 0.1, 0.16], [0.42, 0.40, 0.13, 0.22], [0.39, 0.47, 0.1, 0.18]])
      add(D, slab({ w, d: 0.042, h, col: rnd() < 0.5 ? C.cream : [0.62, 0.56, 0.48], trim: rnd() < 0.3 ? C.terracotta : C.white }), null, x, z);
    // 万达广场：商业裙楼 + 玻璃中庭 + 外摆遮阳伞咖啡座 + 小区游乐滑梯与车棚 + 塔楼
    {
      const comm = [];
      for (const sz of [-1, 1]) {
        comm.push([boxAt(0.012, 0.014, 0.018, -0.314, 0, sz * 0.115 + 0.012), 0.25, 0, 1, C.cream],
          [boxAt(0.008, 0.009, 0.008, -0.508, 0, sz * 0.118), 4, 0, 1, [0.85, 0.58, 0.12]],
          [new T.ConeGeometry(0.0065, 0.005, 6).translate(-0.508, 0.0115, sz * 0.118), 4, 0, 1, [0.75, 0.16, 0.1]],
          [boxAt(0.010, 0.002, 0.004, -0.499, 0.003, sz * 0.118), 4, 0, 1, [0.15, 0.45, 0.72]],
          [boxAt(0.036, 0.009, 0.010, -0.54, 0, sz * 0.165), 4, 0, 1, [0.28, 0.34, 0.38]]);
      }
      add(D, merge(comm), null, 0, 0, { delay: 0.52 });
      const mall = [[prism(shapeRound(0.31, 0.15, 0.02), 0, 0.045), 3, 0, 1, C.white], [prism(shapeRound(0.32, 0.16, 0.02), 0.045, 0.005), 4, 0, 1, C.dark],
        [cylAt(0.036, 0.036, 0.062, -0.07, 0, 0, 32), 1, 0, 1, C.glass], [cylAt(0.04, 0.04, 0.004, -0.07, 0.062, 0, 32), 4, 0, 1, C.white],
        [boxAt(0.12, 0.004, 0.012, 0.0, 0.03, 0.081), 4, 0, 1, [0.9, 0.2, 0.1]],
        [boxAt(0.10, 0.0025, 0.022, -0.02, 0.018, 0.084), 4, 0, 1, C.white]];
      for (let i = 0; i < 4; i++) {
        const ux = -0.06 + i * 0.038, uz = 0.098 + (i % 2) * 0.008;
        mall.push([cylAt(0.0006, 0.0006, 0.011, ux, 0, uz, 5), 4, 0, 1, C.dark],
          [new T.ConeGeometry(0.0075, 0.0035, 8).translate(ux, 0.0115, uz), 4, 0, 1, i % 2 ? [0.78, 0.18, 0.12] : C.cream]);
      }
      add(D, merge(mall), null, 0.48, -0.115, { delay: 0.3 });
    }
    add(D, tower({ w: 0.07, d: 0.07, h: 0.32, style: 1, crown: 2, col: [0.30, 0.34, 0.37] }), null, 0.6, -0.13, { delay: 0.35 });
    parked(D, lot, { fill: 0.78, hazard: 2 });
    // 环外：低层房子沿外圈
    for (const a of outerA) { const r = 0.87, x = Math.cos(a) * r, z = Math.sin(a) * r;
      add(D, slab({ w: 0.08, d: 0.04, h: 0.05 + rnd() * 0.04, col: rnd() < 0.5 ? C.cream : C.brickL, trim: C.white }), null, x, z, { rotY: -a + Math.PI / 2 }); }
    // 喷泉广场：石材水池沿 + 中心喷泉台 + 水面 + 喷泉粒子 + 休息长椅
    add(D, merge([[prism(shapeCircle(0.105, 72), 0, 0.006, [shapeCircle(0.092, 72)]), 4, 0, 1, C.stone], [cylAt(0.022, 0.026, 0.01, 0, 0, 0, 24), 4, 0, 1, C.stone], [cylAt(0.009, 0.012, 0.024, 0, 0, 0, 16), 4, 0, 1, C.stone]]), null, 0, 0.47, { delay: 0.2 });
    add(D, new T.CircleGeometry(0.092, 48).rotateX(-Math.PI / 2).translate(0, 0.003, 0), M.water, 0, 0.47, { delay: 0.2, shadow: false });
    fountain(D, 0, 0.47, 0.03, 0.085);
    benches(D, [[0, 0.352, 0, 2], [0, 0.588, Math.PI, 2], [-0.118, 0.47, Math.PI / 2, 1], [0.118, 0.47, -Math.PI / 2, 2], [-0.49, -0.098, 0, 2], [-0.49, 0.098, Math.PI, 1]]);
    // 树：大道行道树、环路中分带、外圈钻天杨、广场环树、小区树
    const tl = [];
    for (const r of aves) for (const [x, z] of along(r.pts, 0.042, [r.w / 2 + r.sw * 0.75, -(r.w / 2 + r.sw * 0.75)])) if (Math.abs(Math.hypot(x, z) - 0.73) > 0.07 && inDisc(x, z, 0.95) && !(Math.abs(Math.abs(x) - 0.26) < 0.07 && Math.abs(Math.abs(z) - 0.26) < 0.07)) tl.push([x, z, 0, 0.75]);
    const nearAve = (x, z, m = 0.06) => [-0.26, 0.26].some(v => Math.abs(x - v) < m || Math.abs(z - v) < m);
    for (const [x, z] of along(ring.pts, 0.034, [0.0], true)) if (!nearAve(x, z)) tl.push([x, z, 0, 0.45]);
    for (const rr of [0.8, 0.95]) for (const [x, z] of along(arcPts(0, 0, rr, 0, TAU, 200), 0.03)) { const a = Math.atan2(z, x); if ((rr > 0.9 || a < -2.02 || a > -0.26) && ![-0.26, 0.26].some(v => Math.abs(x - v) < 0.06 || Math.abs(z - v) < 0.06)) tl.push([x, z, 1, 1]); }
    for (const [x, z] of shapeCircle(0.13, 22, 0, 0.47)) tl.push([x, z, 0, 0.9]);
    for (const k of ['w1', 'w2', 'nw', 'se']) for (const [x, z] of scatter(bp(k), 10, 0, (px, pz) => Math.hypot(px + 0.505, Math.abs(pz) - 0.118) > 0.035)) tl.push([x, z, 0, 0.8]);
    for (const [x, z] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17], [-0.17, 0.05], [0.17, 0.05]]) tl.push([x, z, 0, 0.9]);
    forest(D, tl, 0.55);
    lamps(D, TER[D].lampPts.filter(([x, z]) => inDisc(x, z, 0.95) && !(Math.abs(Math.hypot(x, z) - 0.73) < 0.01 && nearAve(x, z, 0.05))));
    // 路口红绿灯 + 公交候车亭 + 车流（红灯排队亮刹车灯、公交进站停靠）+ 外卖小电驴
    const cityCross = [[-0.26, -0.26, 0.052], [0.26, -0.26, 0.052], [-0.26, 0.26, 0.052], [0.26, 0.26, 0.052]];
    signals(D, cityCross);
    busStops(D, [[-0.304, 0.09, Math.PI / 2], [0.304, 0.41, -Math.PI / 2], [-0.09, 0.304, Math.PI]]);
    const aveLanes = aves.flatMap(lanesOf);
    traffic(D, lanesOf(ring));
    traffic(D, [...aveLanes, ...streets.flatMap(lanesOf)], { crossings: cityCross });
    traffic(D, aveLanes.filter((_, i) => i % 4 >= 2).map(l => ({ ...l, n: 1, o0: 0.92 / l.n })), { kind: BUS, cols: [[0.08, 0.32, 0.18], [0.75, 0.75, 0.72], [0.12, 0.25, 0.5]], crossings: cityCross, busStops: [[-0.285, 0.09], [0.285, 0.41], [-0.09, 0.285]] });
    scooters(D, aves.flatMap(r => [1, -1].map(sd => ({ path: pathOf(offsetLine(r.pts, sd * (r.w / 2 - 0.003))), sp: 0.044, n: 1 }))));
    // 行人：结伴步行、喷泉边驻足面向水池、商场外摆食客、小区亲子溜达、河岸夜跑
    const ppl = [];
    for (const r of aves) for (const sd of [1, -1]) {
      const swP = offsetLine(r.pts, sd * (r.w / 2 + r.sw / 2));
      ppl.push(...walkPath(swP, 3, 0.013, false, 0.003), ...pairPath(swP, 2, 0.012, false, 0.2));
    }
    ppl.push(...pairPath(shapeCircle(0.124, 48, 0, 0.47), 7, 0.011, true, 0.3), ...standLook(0, 0.47, 0.21, 12, 0, 0.47, 0.25),
      ...chatGroup(-0.06, 0.35, 3), ...chatGroup(0.07, 0.36, 2), ...wander(0, 0.06, 0.11, 10), ...chatGroup(-0.04, 0.02, 3));
    ppl.push(...wander(0.47, -0.02, 0.045, 10, 2.2, 0.3), ...chatGroup(0.44, -0.018, 3), ...chatGroup(0.51, -0.018, 2),
      ...pairPath([[-0.33, -0.115], [-0.53, -0.115]], 2, 0.01, false, 0.6), ...standLook(-0.505, -0.118, 0.028, 4, -0.508, -0.118, 0.5),
      ...pairPath([[-0.33, 0.115], [-0.53, 0.115]], 2, 0.01, false, 0.6), ...wander(0.44, 0.44, 0.05, 4),
      ...pairPath(arcPts(0, 0, 0.838, -1.78, -1.36, 24), 2, 0.015), ...walkPath(arcPts(0, 0, 0.838, -1.16, -0.40, 28), 4, 0.018));
    crowd(D, ppl.filter(p => p.path || inDisc(p.cx ?? p.x, p.cz ?? p.z, 0.94)), { avoid: [[0, 0.47, 0.113]] });
  }

  /* ══ §11-2 智慧政务 ══════════════════════════════════════
     布局：
       园区环路（圆角矩形 x -0.64~0.64、z -0.62~0.48），南边 z = 0.69 是双向 6 车道大道，大门在 (0, 0.48~0.64)
       行政中心主楼（石材 + 柱廊 + 山花）在 (0, -0.235)，两侧配楼在 x = ±0.47
       主楼前是国旗广场（x ±0.13，z -0.06~0.465），国旗在 (0, 0.16)；广场两侧草坪 + 绿篱
       东西两侧是停车场（东边前 8 个车位停警车），主楼后面 (0, -0.49) 是数据中心
       环路外：两侧椭圆健身步道、北边 (0, -0.77) 景观湖、门前一排红黄花坛、外圈松柏 */
  {
    const D = 1;
    const blvd = { pts: chordZ(0.69), w: 0.1, lanes: 3, median: 0.012, sw: 0.014, speed: 0.1, n: 6 };
    const loop = { pts: rrect(-0.64, -0.62, 0.64, 0.48, 0.12, 8), closed: true, w: 0.036, lanes: 1, speed: 0.045, n: 2 };
    const gate = { pts: [[0, 0.48], [0, 0.64]], w: 0.05, lanes: 1, n: 0 };
    let lotW = [], lotE = [], parkBollards = [];
    TER[D] = terrain(t => {
      t.grass(DISC, '#3d5c2a', 1500);
      t.poly(rrect(-0.62, -0.6, 0.62, 0.46, 0.1, 8), '#55534e', MT(0.85));                  // 院内硬地
      t.paving([[-0.13, -0.06], [0.13, -0.06], [0.13, 0.465], [-0.13, 0.465]], '#9a958b', 'rgba(60,56,50,0.5)', 0.02);   // 国旗广场
      t.poly([[-0.018, -0.06], [0.018, -0.06], [0.018, 0.465], [-0.018, 0.465]], '#b0aa9e', MT(0.65));                    // 中轴
      t.circle(0, 0.16, 0.04, '#b4aea2', MT(0.6)); t.circle(0, 0.16, 0.012, '#6d685f', MT(0.7));
      for (const sx of [-1, 1]) {
        t.grass([[sx * 0.145, 0.0], [sx * 0.36, 0.0], [sx * 0.36, 0.44], [sx * 0.145, 0.44]], '#47692f', 120);
        t.line([[sx * 0.145, 0.22], [sx * 0.36, 0.22]], 0.012, '#a8a296', MT(0.7));
        t.grass([[sx * 0.33, -0.56], [sx * 0.6, -0.56], [sx * 0.6, -0.4], [sx * 0.33, -0.4]], '#45662d', 60);
      }
      t.line([[0.36, 0.22], [0.382, 0.22], [0.382, -0.18]], 0.014, '#a8a296', MT(0.7));     // 通往东配楼市民服务大厅的便民步道
      t.paving([[-0.36, -0.42], [0.36, -0.42], [0.36, 0.0], [-0.36, 0.0]], '#7e7a72', 'rgba(50,48,44,0.4)', 0.024);
      lotW = t.parking(-0.6, 0.06, -0.39, 0.43, { rows: 2, along: 'z' }); lotE = t.parking(0.39, 0.06, 0.6, 0.43, { rows: 2, along: 'z' });
      t.road(loop); t.road(gate); t.road(blvd);
      t.zebra(0, 0.69, Math.PI / 2, 0.1);
      t.glow(0, -0.05, 0.08, 0.85); t.glow(0.385, -0.20, 0.065, 0.9); t.glow(0, 0.16, 0.05, 0.65);
      for (const [x, z] of [[-0.14, 0.02], [-0.14, 0.15], [-0.14, 0.28], [-0.14, 0.41], [0.14, 0.02], [0.14, 0.15], [0.14, 0.28], [0.14, 0.41]]) { t.lampPts.push([x, z]); t.glow(x, z, 0.04, 0.8); }
      // 园区外围：两侧健身步道、后面的景观湖、门前花坛 + 环湖与步道庭院暖灯
      for (const sx of [-1, 1]) {
        const ep = ellPts(sx * 0.775, -0.03, 0.06, 0.29, 64);
        t.line(ep, 0.011, '#9c968a', MT(0.75), { closed: true }); t.line([[sx * 0.715, -0.03], [sx * 0.656, -0.03]], 0.009, '#9c968a', MT(0.75));
        for (const [bx, bz] of along(ep, 0.13, [0.012], true)) { parkBollards.push([bx, bz]); t.glow(bx, bz, 0.032, 0.55); }
      }
      t.poly(ellPts(0, -0.77, 0.15, 0.065, 64), '#5f5a48', MT(0.9)); t.poly(ellPts(0, -0.77, 0.135, 0.054, 64), '#16252a', MT(0.05));
      const lp = ellPts(0, -0.77, 0.165, 0.08, 64);
      t.line(lp, 0.008, '#9c968a', MT(0.75), { closed: true });
      for (const [bx, bz] of along(lp, 0.11, [0.01], true)) { parkBollards.push([bx, bz]); t.glow(bx, bz, 0.03, 0.55); }
      t.glow(-0.155, -0.76, 0.04, 0.7);
      for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) { const x = sx * (0.13 + i * 0.12), red = (i + (sx > 0 ? 1 : 0)) % 2;
        t.poly(shapeRound(0.1, 0.07, 0.03, x, 0.56), '#3c5a29', MT(0.9, 0.7)); t.poly(shapeRound(0.085, 0.055, 0.025, x, 0.56), red ? '#9a2a1c' : '#c79a22', MT(0.9, 0.4));
        t.speckle(shapeRound(0.085, 0.055, 0.025, x, 0.56), red ? ['#c8402a', '#7a1e14'] : ['#e6b83a', '#a8781a'], 60, 0.002, 0.005, [0.4, 0.8]); }
    });
    // 行政中心（石材 + 柱廊 + 山花）
    const S = C.stone, Wt = C.white;
    const main = [
      [prism(shapeRect(0.62, 0.26), 0, 0.012), 4, 0, 1, Wt],
      [prism(shapeRect(0.6, 0.24), 0.012, 0.1, [shapeRect(0.14, 0.1, -0.17, -0.02), shapeRect(0.14, 0.1, 0.17, -0.02)]), 3, 0.012, 1, S],
      [prism(shapeRect(0.62, 0.26), 0.112, 0.008), 4, 0, 1, Wt],
      [prism(shapeRect(0.58, 0.22), 0.12, 0.014), 2, 0.12, 1, S],
    ];
    for (let s = 0; s < 4; s++) main.push([boxAt(0.26 - s * 0.012, 0.004, 0.05 - s * 0.01, 0, s * 0.004, 0.17 - s * 0.005), 4, 0, 1, Wt]);
    main.push([boxAt(0.24, 0.006, 0.07, 0, 0.012, 0.15), 4, 0, 1, Wt]);
    for (let i = 0; i < 8; i++) main.push([cylAt(0.0065, 0.0075, 0.084, -0.105 + i * 0.03, 0.018, 0.175, 14), 4, 0, 1, Wt]);
    main.push([boxAt(0.25, 0.012, 0.075, 0, 0.102, 0.152), 4, 0, 1, Wt]);
    { const sh = new T.Shape([new T.Vector2(-0.13, 0), new T.Vector2(0.13, 0), new T.Vector2(0, 0.035)]);
      const g = new T.ExtrudeGeometry(sh, { depth: 0.07, bevelEnabled: false }); g.translate(0, 0.114, 0.117); main.push([g, 4, 0, 1, Wt]); }
    for (let i = 0; i < 15; i++) { const x = -0.28 + i * 0.04; if (Math.abs(x) < 0.13) continue; main.push([boxAt(0.007, 0.1, 0.004, x, 0.012, 0.121), 4, 0, 1, Wt], [boxAt(0.007, 0.1, 0.004, x, 0.012, -0.121), 4, 0, 1, Wt]); }
    main.push([prism(shapeRect(0.2, 0.1), 0.134, 0.02), 3, 0.134, 1, S], [prism(shapeRect(0.21, 0.11), 0.154, 0.004), 4, 0, 1, Wt]);
    add(D, merge(main), null, 0, -0.235, { delay: 0.3 });
    for (const sx of [-1, 1]) add(D, tower({ w: 0.15, d: 0.3, h: 0.15, style: 0, crown: 0, col: [0.58, 0.52, 0.42] }), null, sx * 0.47, -0.2, { delay: 0.5 });
    const dc = [[prism(shapeRect(0.36, 0.11), 0, 0.055), 2, 0, 1, C.steel]];
    for (let i = 0; i < 6; i++) dc.push([cylAt(0.015, 0.015, 0.011, -0.15 + i * 0.06, 0.055, 0, 20), 4, 0, 1, C.white], [cylAt(0.01, 0.01, 0.003, -0.15 + i * 0.06, 0.066, 0, 20), 4, 0, 1, C.dark]);
    add(D, merge(dc), null, 0, -0.49, { delay: 0.6 });
    // 门卫室 + 自动抬杆道闸 + 东配楼「市民政务服务大厅」入口雨棚 + 湖畔亲水木栈台与四角凉亭
    {
      const civic = [[boxAt(0.03, 0.018, 0.02, 0.05, 0, 0.5), 0, 0, 1, Wt], [boxAt(0.006, 0.02, 0.006, -0.03, 0, 0.5), 4, 0, 1, S], [boxAt(0.006, 0.02, 0.006, 0.03, 0, 0.5), 4, 0, 1, S],
        // 东配楼西侧：便民服务大厅迎宾雨棚与政务蓝标识条
        [boxAt(0.026, 0.0035, 0.09, 0.382, 0.028, -0.20), 4, 0, 1, Wt], [boxAt(0.003, 0.0045, 0.086, 0.369, 0.030, -0.20), 4, 0, 1, [0.08, 0.28, 0.72]],
        [cylAt(0.0018, 0.0018, 0.028, 0.372, 0, -0.236, 8), 4, 0, 1, Wt], [cylAt(0.0018, 0.0018, 0.028, 0.372, 0, -0.164, 8), 4, 0, 1, Wt],
        // 北湖亲水木平台 + 四角攒尖景观亭
        [boxAt(0.044, 0.0025, 0.022, 0.065, 0.002, -0.718), 4, 0, 1, [0.44, 0.28, 0.14]],
        [boxAt(0.044, 0.004, 0.0012, 0.065, 0.004, -0.728), 4, 0, 1, [0.38, 0.24, 0.12]],
        [cylAt(0.016, 0.018, 0.003, -0.155, 0, -0.76, 4), 4, 0, 1, S],
        [new T.ConeGeometry(0.019, 0.012, 4).rotateY(Math.PI / 4).translate(-0.155, 0.024, -0.76), 4, 0, 1, [0.22, 0.18, 0.15]]];
      for (const [px, pz] of [[-0.164, -0.769], [-0.146, -0.769], [-0.164, -0.751], [-0.146, -0.751]]) civic.push([cylAt(0.001, 0.001, 0.018, px, 0.003, pz, 6), 4, 0, 1, [0.45, 0.16, 0.1]]);
      const gNode = new T.Group(); gNode.add(new T.Mesh(merge(civic), MAT[D]));
      const hallGlow = new T.Mesh(new T.PlaneGeometry(0.022, 0.082).rotateX(Math.PI / 2).translate(0.382, 0.026, -0.20), new T.MeshBasicMaterial({ color: new T.Color(2.4, 2.0, 1.4), clippingPlanes: CLIP }));
      hallGlow.userData.noShadow = true; gNode.add(hallGlow);
      // 大门智能起落道闸杆
      const arm = new T.Group(); arm.position.set(0.025, 0.008, 0.502);
      arm.add(new T.Mesh(boxAt(0.024, 0.0012, 0.0012, -0.012, 0, 0), new T.MeshBasicMaterial({ color: new T.Color(1.8, 0.35, 0.2), clippingPlanes: CLIP })));
      gNode.add(arm);
      animate(D, t => { const open = smooth(0.2, 0.45, (t * 0.12) % 1) * (1 - smooth(0.65, 0.85, (t * 0.12) % 1)); arm.rotation.z = -open * 1.32; });
      addNode(D, gNode, 0, 0, 0.42, 0.04);
    }
    // 国旗
    {
      const node = new T.Group();
      node.add(new T.Mesh(merge([[cylAt(0.0011, 0.0015, 0.13, 0, 0, 0, 8), 4, 0, 1, [0.8, 0.8, 0.82]], [cylAt(0.008, 0.01, 0.006, 0, 0, 0, 16), 4, 0, 1, C.white]]), MAT[D]));
      const cv = document.createElement('canvas'); cv.width = 192; cv.height = 128; const c = cv.getContext('2d');
      c.fillStyle = '#de2910'; c.fillRect(0, 0, 192, 128);
      const star = (x, y, r, rot = 0) => { c.beginPath(); for (let i = 0; i < 10; i++) { const a = rot - Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.38 : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); c.fill(); };
      c.fillStyle = '#ffde00'; star(32, 32, 19); star(64, 13, 6, 0.4); star(77, 26, 6, 0.9); star(77, 45, 6, 0); star(64, 58, 6, 0.6);
      const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
      const fm = new T.MeshStandardMaterial({ map: tex, roughness: 0.7, side: T.DoubleSide, clippingPlanes: CLIP });
      fm.onBeforeCompile = sh => { sh.uniforms.uTime = U.time; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float fk = position.x / 0.042;
          transformed.z += sin(position.x * 150.0 - uTime * 6.0) * 0.0032 * fk;
          transformed.y += sin(position.x * 95.0 - uTime * 4.0) * 0.0008 * fk - 0.002 * fk * fk;`); };
      const flag = new T.Mesh(new T.PlaneGeometry(0.042, 0.028, 16, 6).translate(0.021, -0.014, 0), fm);
      flag.position.set(0.0012, 0.128, 0); node.add(flag);
      addNode(D, node, 0, 0.16, 0.25, 0.14);
    }
    // 绿化：广场两侧松柏、草坪孤植、园区外围松树、大道行道树、绿篱
    const tl = [];
    for (let i = 0; i < 9; i++) for (const sx of [-1, 1]) tl.push([sx * 0.138, 0.0 + i * 0.054, 2, 0.8]);
    for (const sx of [-1, 1]) for (const [x, z] of [[0.2, 0.08], [0.3, 0.12], [0.24, 0.32], [0.31, 0.38], [0.2, 0.4]]) tl.push([sx * x, z, 0, 1.1]);
    for (const [x, z] of along(arcPts(0, 0, 0.9, 0, TAU, 200), 0.034)) if (z < 0.56) tl.push([x, z, rnd() < 0.6 ? 2 : 0, 1.1]);
    for (const [x, z] of along(blvd.pts, 0.045, [blvd.w / 2 + blvd.sw * 0.75, -(blvd.w / 2 + blvd.sw * 0.75)])) if (Math.abs(x) > 0.08 && inDisc(x, z, 0.95)) tl.push([x, z, 0, 0.8]);
    for (const sx of [-1, 1]) for (let i = 0; i < 6; i++) tl.push([sx * (0.36 + i * 0.045), -0.48, 0, 0.9]);
    for (const sx of [-1, 1]) tl.push(...grove(sx * 0.775, -0.2, 0.035, 5, [0, 2]), ...grove(sx * 0.775, 0.14, 0.035, 5, [0, 2]), ...grove(sx * 0.32, -0.76, 0.08, 9, [0, 0, 2], 1.1), ...grove(sx * 0.6, -0.62, 0.05, 5, [2]));
    forest(D, tl.filter(([x, z]) => !(Math.abs(x) < 0.185 && Math.abs(z + 0.77) < 0.09) && inDisc(x, z, 0.94)), 0.5);
    add(D, new T.CircleGeometry(1, 48).scale(0.135, 0.054, 1).rotateX(-Math.PI / 2).translate(0, 0.0012, 0), lakeM, 0, -0.77, { delay: 0.3, shadow: false });
    add(D, hedge([[-0.36, 0.0], [-0.145, 0.0], [-0.145, 0.44], [-0.36, 0.44]], true), null, 0, 0, { delay: 0.45 });
    add(D, hedge([[0.36, 0.0], [0.145, 0.0], [0.145, 0.44], [0.36, 0.44]], true), null, 0, 0, { delay: 0.45 });
    lamps(D, TER[D].lampPts.filter(([x, z]) => inDisc(x, z, 0.95)));
    bollards(D, parkBollards.filter(([x, z]) => inDisc(x, z, 0.95)));
    benches(D, [[-0.84, -0.03, -Math.PI / 2, 2], [0.84, -0.03, Math.PI / 2, 1], [0, -0.858, 0, 2], [-0.155, -0.76, Math.PI, 2]]);
    birds(D, 0, -0.76, 0.16, 0.13, 5);
    // 车：门前斑马线红绿灯、便民公交站台、大道车流、园区巡逻车、停车场（含警车）
    const govCross = [[0, 0.69, 0.056, 'ew']];
    signals(D, govCross);
    busStops(D, [[-0.22, 0.625, 0], [0.22, 0.755, Math.PI]]);
    const blvdLanes = lanesOf(blvd);
    traffic(D, blvdLanes, { crossings: govCross });
    traffic(D, blvdLanes.filter((_, i) => i >= 4).map(l => ({ ...l, n: 1, o0: 0.4 })), { kind: BUS, cols: [[0.10, 0.28, 0.55], [0.78, 0.78, 0.75]], crossings: govCross, busStops: [[-0.22, 0.655], [0.22, 0.725]] });
    traffic(D, lanesOf(loop), { cols: [[0.85, 0.85, 0.85], [0.03, 0.03, 0.035]] });
    { const jog = []; for (const sx of [-1, 1]) jog.push(...pairPath(ellPts(sx * 0.775, -0.03, 0.06, 0.29, 64), 3, 0.018, true, 0.25), ...walkPath(ellPts(sx * 0.775, -0.03, 0.06, 0.29, 64), 3, 0.022, true, 0.002));
      jog.push(...pairPath(ellPts(0, -0.77, 0.165, 0.08, 64), 3, 0.011, true, 0.3), ...standLook(0.065, -0.715, 0.025, 3, 0, -0.77));
      for (const sd of [1, -1]) jog.push(...walkPath(chordZ(0.69 + sd * (blvd.w / 2 + blvd.sw / 2), 0.95), 5));
      crowd(D, jog, { delay: 0.9 }); }
    parked(D, lotW, { fill: 0.85, cols: [[0.85, 0.85, 0.85], [0.03, 0.03, 0.035], [0.42, 0.43, 0.45]] });
    parked(D, lotE.slice(0, 8), { fill: 1, cols: [[0.85, 0.86, 0.9]], kind: VAN });
    parked(D, lotE.slice(8), { fill: 0.8, cols: [[0.85, 0.85, 0.85], [0.03, 0.03, 0.035], [0.05, 0.12, 0.32]], hazard: 1 });
    // 人：国旗下真正面朝红旗仰望驻足、结伴走进政务服务大厅办事、中轴漫步
    const ppl = [...wander(0, 0.28, 0.09, 14, 1, 1.5), ...pairPath([[0, 0.48], [0, -0.04]], 5, 0.011, false, 0.25),
      ...standLook(0, 0.225, 0.065, 9, 0, 0.16, 0.3), ...chatGroup(-0.06, 0.02, 3), ...wander(0, -0.03, 0.06, 6, 2, 0.3),
      ...pairPath([[0.04, 0.22], [0.382, 0.22], [0.382, -0.18]], 4, 0.012, false, 0.1), ...chatGroup(0.355, -0.20, 3)];
    for (const sd of [1, -1]) ppl.push(...pairPath(offsetLine(blvd.pts, sd * (blvd.w / 2 + blvd.sw / 2)), 3, 0.012));
    crowd(D, ppl);
  }

  /* ══ §11-3 教育医疗 ══════════════════════════════════════
     布局：x = 0.12 一条南北向城市道路，把台面分成左边校园、右边医院
       校园：环形校内车道（x -0.7~0.02，z -0.52~0.28），校门在 (0.055, -0.08)
             北边三栋宿舍 (z -0.43)，中间四栋红砖教学楼 (x -0.39 / -0.18，z -0.27 / 0.1)，西边图书馆 (-0.58, -0.08)
             步道把宿舍、教学楼、图书馆、操场连起来；西南体育馆 (-0.5, 0.21)；南边操场 (-0.42, 0.52) 和四块篮球场
             西侧小湖 (-0.82, -0.02)，北边停车场有车道接到环路
       医院：环形院内车道（x 0.22~0.76，z -0.55~0.3），十字形住院楼 + 停机坪 (0.5, -0.3)，门诊楼 + 急诊落客区 (0.47, 0.06)
             南边大停车场，车道从环路接下去；救护车在院内环路上跑 */
  {
    const D = 2;
    const city = { pts: chordX(0.12), w: 0.07, lanes: 2, sw: 0.014, speed: 0.075, n: 6 };
    const cLoop = { pts: rrect(-0.7, -0.52, 0.02, 0.28, 0.14, 8), closed: true, w: 0.032, lanes: 1, speed: 0.035, n: 2, sw: 0.008, lampStep: 0.11 };
    const cGate = { pts: [[0.02, -0.08], [0.086, -0.08]], w: 0.032, lanes: 1, n: 0 };
    const hLoop = { pts: rrect(0.22, -0.55, 0.76, 0.3, 0.12, 8), closed: true, w: 0.032, lanes: 1, speed: 0.04, n: 2, sw: 0.008, lampStep: 0.11 };
    const hGate = { pts: [[0.154, -0.08], [0.222, -0.08]], w: 0.032, lanes: 1, n: 0 };
    // 步道：两条南北向（宿舍 → 教学区 → 操场）、一条东西向主轴（校门 → 图书馆）、一条从图书馆往南到体育馆
    const walks = [
      [[-0.28, -0.4], [-0.28, -0.08], [-0.28, 0.26], [-0.28, 0.38]], [[0.06, -0.08], [-0.52, -0.08]], [[-0.1, -0.4], [-0.1, -0.08], [-0.1, 0.26], [-0.1, 0.38]], [[-0.5, -0.4], [-0.5, -0.08]],
      [[-0.66, -0.08], [-0.66, 0.3]],
    ];
    const track = { cx: -0.42, cz: 0.52, W: 0.46, H: 0.27 };
    const bCourts = [[-0.108, 0.424], [-0.002, 0.424], [-0.108, 0.536], [-0.002, 0.536]];
    const lotRdC = { pts: [[-0.11, -0.52], [-0.11, -0.6]], w: 0.026, lanes: 1, n: 0 }, lotRdH = { pts: [[0.445, 0.3], [0.445, 0.37]], w: 0.026, lanes: 1, n: 0 };
    let lotH = [], lotC = [];
    TER[D] = terrain(t => {
      t.grass(DISC, '#3e5d2a', 1500);
      t.grass(rrect(-0.69, -0.505, 0.005, 0.265, 0.13, 8), '#4a6c30', 400);                 // 校园草坪
      t.poly(rrect(0.235, -0.535, 0.745, 0.285, 0.11, 8), '#5a5852', MT(0.85));              // 医院院内硬地
      t.grass([[0.6, -0.12], [0.72, -0.12], [0.72, -0.02], [0.6, -0.02]], '#4a6c30', 40);     // 医院小花园
      t.line([[0.6, -0.07], [0.72, -0.07]], 0.009, '#9e988c', MT(0.75));
      for (const w of walks) { t.line(w, 0.026, '#a39d90', MT(0.7)); t.line(w, 0.022, '#b3ad9f', MT(0.65)); }
      t.line([[-0.18, 0.48], [-0.155, 0.48]], 0.020, '#a39d90', MT(0.7));                    // 操场连往篮球场区的步道
      t.paving([[-0.66, -0.16], [-0.46, -0.16], [-0.46, 0.0], [-0.66, 0.0]], '#a49e92', 'rgba(60,56,50,0.4)', 0.016);   // 图书馆前广场
      // 操场：塑胶跑道 + 足球场 + 夜间球场泛光
      { const { cx, cz, W, H } = track, rr = H / 2, c = t.c;
        const stad = (ins) => { c.beginPath(); c.moveTo(cx - W / 2 + rr, cz - H / 2 + ins); c.lineTo(cx + W / 2 - rr, cz - H / 2 + ins); c.arc(cx + W / 2 - rr, cz, rr - ins, -Math.PI / 2, Math.PI / 2); c.lineTo(cx - W / 2 + rr, cz + H / 2 - ins); c.arc(cx - W / 2 + rr, cz, rr - ins, Math.PI / 2, Math.PI * 1.5); c.closePath(); };
        t.poly(rrect(cx - W / 2 - 0.012, cz - H / 2 - 0.012, cx + W / 2 + 0.012, cz + H / 2 + 0.012, 0.03), '#6f6b62', MT(0.8));
        c.fillStyle = '#9a4a34'; stad(0); c.fill(); t.m.fillStyle = MT(0.9); t.m.beginPath(); t.m.rect(cx - W / 2, cz - H / 2, W, H); t.m.fill();
        c.strokeStyle = 'rgba(240,235,225,0.8)'; c.lineWidth = 0.0009; for (let i = 1; i <= 6; i++) { stad(i * 0.0055); c.stroke(); }
        c.fillStyle = '#3f6e37'; stad(0.038); c.fill();
        c.save(); stad(0.038); c.clip(); for (let i = 0; i < 14; i++) { c.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'; c.fillRect(cx - W / 2 + i * W / 14, cz - H / 2, W / 14, H); } c.restore();
        c.strokeStyle = 'rgba(240,240,235,0.85)'; c.lineWidth = 0.0012; const fw = W - 2 * rr + 0.02, fh = H - 0.09;
        c.strokeRect(cx - fw / 2, cz - fh / 2, fw, fh); c.beginPath(); c.moveTo(cx, cz - fh / 2); c.lineTo(cx, cz + fh / 2); c.stroke();
        c.beginPath(); c.arc(cx, cz, 0.02, 0, TAU); c.stroke(); c.strokeRect(cx - fw / 2, cz - 0.03, 0.03, 0.06); c.strokeRect(cx + fw / 2 - 0.03, cz - 0.03, 0.03, 0.06);
        t.glow(cx - 0.10, cz, 0.16, 0.72); t.glow(cx + 0.10, cz, 0.16, 0.72); }
      // 标准校园篮球场区（4 片南北向红绿拼色硅PU球场：三秒区、中圈、三分弧线齐全）
      t.poly(rrect(-0.160, 0.364, 0.050, 0.596, 0.014), '#6f6b62', MT(0.8));
      t.poly(rrect(-0.154, 0.370, 0.044, 0.590, 0.010), '#9e4733', MT(0.75));
      for (const [x, z] of bCourts) {
        const cw = 0.058, cl = 0.088, c = t.c;
        t.poly(shapeRect(cw, cl, x, z), '#2c6f47', MT(0.72));
        for (const sz of [-1, 1]) t.poly(shapeRect(0.016, 0.019, x, z + sz * (cl / 2 - 0.0095)), '#9e4733', MT(0.72));
        t.circle(x, z, 0.0075, '#9e4733', MT(0.72));
        c.strokeStyle = 'rgba(244,242,236,0.9)'; c.lineWidth = 0.0010;
        c.strokeRect(x - cw / 2, z - cl / 2, cw, cl);
        c.beginPath(); c.moveTo(x - cw / 2, z); c.lineTo(x + cw / 2, z); c.stroke();
        c.beginPath(); c.arc(x, z, 0.0075, 0, TAU); c.stroke();
        for (const sz of [-1, 1]) {
          const bz = z + sz * (cl / 2 - 0.005);
          c.strokeRect(x - 0.008, sz < 0 ? z - cl / 2 : z + cl / 2 - 0.019, 0.016, 0.019);
          c.beginPath(); c.arc(x, bz, 0.021, sz < 0 ? 0.12 : Math.PI + 0.12, sz < 0 ? Math.PI - 0.12 : TAU - 0.12); c.stroke();
        }
      }
      t.glow(-0.055, 0.48, 0.14, 0.85);
      lotH = t.parking(0.25, 0.36, 0.64, 0.6, { rows: 4 });
      lotC = t.parking(-0.22, -0.74, 0.0, -0.58, { rows: 2 });
      t.road(lotRdC); t.road(lotRdH);
      t.road(cLoop); t.road(hLoop); t.road(cGate); t.road(hGate); t.road(city);
      t.poly(ellPts(-0.82, -0.02, 0.07, 0.11, 48), '#5f5a48', MT(0.9)); t.poly(ellPts(-0.82, -0.02, 0.058, 0.098, 48), '#16252a', MT(0.05));   // 校园里的小湖
      t.line([[-0.7, -0.02], [-0.755, -0.02]], 0.012, '#a39d90', MT(0.7));
      t.zebra(0.12, -0.08, Math.PI / 2, 0.07); t.zebra(0.12, 0.2, Math.PI / 2, 0.07); t.zebra(-0.28, 0.28, 0, 0.032); t.zebra(-0.10, 0.28, 0, 0.032);
      t.poly(shapeRect(0.07, 0.04, 0.47, 0.19), '#7a3434', MT(0.7));                         // 急诊落客区
      t.glow(0.47, 0.175, 0.085, 0.92); t.glow(-0.58, -0.02, 0.06, 0.65); t.glow(0.66, -0.07, 0.05, 0.55);
    });
    // 校门（门楼）
    add(D, merge([[boxAt(0.012, 0.035, 0.012, 0.055, 0, -0.112), 4, 0, 1, C.white], [boxAt(0.012, 0.035, 0.012, 0.055, 0, -0.048), 4, 0, 1, C.white], [boxAt(0.016, 0.01, 0.078, 0.055, 0.035, -0.08), 4, 0, 1, C.brick]]), null, 0, 0, { delay: 0.3 });
    // 图书馆 (-0.58, -0.08)：石材基座 + 墙身 + 顶上玻璃阅览室；下面依次是四栋红砖教学楼 [x, z, 长]、三栋宿舍板楼、体育馆（拱顶）
    add(D, merge([[prism(shapeRect(0.13, 0.15), 0, 0.012), 4, 0, 1, C.stone], [prism(shapeRect(0.12, 0.14), 0.012, 0.09), 1, 0.012, 1, [0.5, 0.48, 0.44]], [prism(shapeRect(0.14, 0.16), 0.102, 0.008), 4, 0, 1, C.white], [prism(shapeRect(0.06, 0.06), 0.11, 0.03), 1, 0.11, 1, C.glass]]), null, -0.58, -0.08, { delay: 0.35 });
    for (const [x, z, w] of [[-0.39, -0.27, 0.18], [-0.18, -0.27, 0.12], [-0.39, 0.1, 0.18], [-0.18, 0.1, 0.12]]) {
      const p = [[prism(shapeRect(w, 0.06), 0, 0.075), 0, 0, 1, C.brick], [prism(shapeRect(w + 0.006, 0.066), 0.075, 0.006), 4, 0, 1, C.white]];
      for (let y = 0.021; y < 0.07; y += 0.021) p.push([boxAt(w + 0.002, 0.0018, 0.062, 0, y, 0), 4, 0, 1, C.white]);
      p.push([prism(shapeRect(0.03, 0.03, -w / 2 + 0.02, 0), 0.075, 0.018), 2, 0.075, 1, C.brickL]);
      add(D, merge(p), null, x, z);
    }
    for (const [x, z] of [[-0.5, -0.43], [-0.32, -0.43], [-0.14, -0.43]]) add(D, slab({ w: 0.13, d: 0.045, h: 0.11, col: [0.62, 0.56, 0.48], trim: C.terracotta }), null, x, z);
    add(D, merge([[prism(shapeRound(0.18, 0.11, 0.02), 0, 0.035), 3, 0, 1, C.white], [(() => { const v = new T.CylinderGeometry(0.055, 0.055, 0.18, 28, 1, false, -Math.PI / 2, Math.PI); v.rotateX(-Math.PI / 2); v.rotateY(Math.PI / 2); v.scale(1, 0.45, 1); v.translate(0, 0.035, 0); return v; })(), 4, 0, 1, C.steel]]), null, -0.5, 0.21, { delay: 0.45 });
    // 医院：十字形住院楼 + 发光红十字 + 停机坪助航灯、门诊楼 + 急诊暖白发光雨棚
    {
      const ward = merge([
        [prism([[-0.05, -0.14], [0.05, -0.14], [0.05, -0.05], [0.14, -0.05], [0.14, 0.05], [0.05, 0.05], [0.05, 0.14], [-0.05, 0.14], [-0.05, 0.05], [-0.14, 0.05], [-0.14, -0.05], [-0.05, -0.05]], 0, 0.34), 0, 0, 1, C.white],
        [prism(shapeRect(0.1, 0.1), 0.34, 0.03), 2, 0.34, 1, C.white], [cylAt(0.058, 0.058, 0.004, 0, 0.37, 0, 40), 4, 0, 1, C.dark],
      ]);
      const node = new T.Group(); node.add(new T.Mesh(ward, MAT[D]));
      const crossM = new T.MeshBasicMaterial({ color: new T.Color(5.2, 0.25, 0.18), clippingPlanes: CLIP });
      const crossG = mergeC([
        [boxAt(0.018, 0.0055, 0.002, 0, 0.355, 0.051), [1, 1, 1]], [boxAt(0.0055, 0.018, 0.002, 0, 0.349, 0.051), [1, 1, 1]],
        [boxAt(0.002, 0.0055, 0.018, -0.051, 0.355, 0), [1, 1, 1]], [boxAt(0.002, 0.018, 0.0055, -0.051, 0.349, 0), [1, 1, 1]],
      ]);
      const cm = new T.Mesh(crossG, crossM); cm.userData.noShadow = true; node.add(cm);
      const pad = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 256; const c = cv.getContext('2d');
        c.fillStyle = '#2b2d30'; c.beginPath(); c.arc(128, 128, 126, 0, 7); c.fill(); c.strokeStyle = '#e8e6df'; c.lineWidth = 9; c.beginPath(); c.arc(128, 128, 96, 0, 7); c.stroke();
        c.lineWidth = 4; c.beginPath(); c.arc(128, 128, 60, 0, 7); c.stroke();
        c.fillStyle = '#e8e6df'; c.fillRect(104, 96, 10, 64); c.fillRect(142, 96, 10, 64); c.fillRect(104, 123, 48, 10);
        const tx = new T.CanvasTexture(cv); tx.colorSpace = T.SRGBColorSpace; return tx; })();
      node.add(new T.Mesh(new T.CircleGeometry(0.056, 40).rotateX(-Math.PI / 2).translate(0, 0.3745, 0), std([1, 1, 1], 0.6, { map: pad })));
      addNode(D, node, 0.5, -0.3, 0.35);
      beacons(D, [...Array.from({ length: 8 }, (_, k) => [0.5 + Math.cos(k / 8 * TAU) * 0.055, 0.376, -0.3 + Math.sin(k / 8 * TAU) * 0.055, 'heli']), [0.5, 0.382, -0.355, 'red']]);
      const op = [[prism(shapeRect(0.3, 0.15), 0, 0.07), 1, 0, 1, [0.62, 0.64, 0.66]], [prism(shapeRect(0.31, 0.16), 0.07, 0.008), 4, 0, 1, C.white],
        [boxAt(0.12, 0.004, 0.06, 0, 0.035, 0.105), 4, 0, 1, C.white], [boxAt(0.122, 0.0025, 0.003, 0, 0.038, 0.135), 4, 0, 1, [0.75, 0.12, 0.08]]];
      for (const x of [-0.05, 0.05]) op.push([cylAt(0.0025, 0.0025, 0.035, x, 0, 0.13, 8), 4, 0, 1, C.white]);
      const opNode = new T.Group(); opNode.add(new T.Mesh(merge(op), MAT[D]));
      const erUnder = new T.Mesh(new T.PlaneGeometry(0.11, 0.052).rotateX(Math.PI / 2).translate(0, 0.0345, 0.105), new T.MeshBasicMaterial({ color: new T.Color(2.8, 2.5, 2.0), clippingPlanes: CLIP }));
      const erCross = new T.Mesh(mergeC([[boxAt(0.012, 0.0035, 0.002, 0, 0.055, 0.076), [1, 1, 1]], [boxAt(0.0035, 0.012, 0.002, 0, 0.051, 0.076), [1, 1, 1]]]), crossM);
      erUnder.userData.noShadow = erCross.userData.noShadow = true; opNode.add(erUnder, erCross);
      addNode(D, opNode, 0.47, 0.06, 0.45, 0.08);
    }
    // 运动设施与校园单车棚：8 座立体海燕篮球架 + 球场围网 + 足球门 × 2 + 主席台小看台 + 高杆球场灯 + 单车排
    {
      const sp = [], gl = [];
      for (const [x, z] of bCourts) for (const sz of [-1, 1]) {
        const pz = z + sz * 0.0465, bz = z + sz * 0.0415, rz = z + sz * 0.0392;
        sp.push([boxAt(0.0018, 0.0135, 0.0018, x, 0, pz), 4, 0, 1, [0.10, 0.28, 0.58]],
          [boxAt(0.0014, 0.0014, 0.0055, x, 0.0128, (pz + bz) / 2), 4, 0, 1, [0.10, 0.28, 0.58]],
          [boxAt(0.0115, 0.0072, 0.0009, x, 0.0098, bz), 4, 0, 1, C.white],
          [boxAt(0.0042, 0.0008, 0.0032, x, 0.0102, rz), 4, 0, 1, [0.92, 0.28, 0.06]]);
      }
      // 篮球场深绿包塑围网（北、西留出入口）
      const fc = [0.08, 0.20, 0.12], segs = [[-0.156, 0.368, -0.116, 0.368], [-0.084, 0.368, 0.046, 0.368], [0.046, 0.368, 0.046, 0.592],
        [0.046, 0.592, -0.156, 0.592], [-0.156, 0.592, -0.156, 0.494], [-0.156, 0.466, -0.156, 0.368]];
      for (const [x0, z0, x1, z1] of segs) {
        const L = Math.hypot(x1 - x0, z1 - z0), ay = -Math.atan2(z1 - z0, x1 - x0);
        for (const yy of [0.007, 0.014]) { const g = new T.BoxGeometry(L, 0.0007, 0.0007); g.rotateY(ay); g.translate((x0 + x1) / 2, yy, (z0 + z1) / 2); sp.push([g, 4, 0, 1, fc]); }
        const np = Math.max(2, Math.round(L / 0.032));
        for (let i = 0; i <= np; i++) sp.push([boxAt(0.0009, 0.015, 0.0009, x0 + (x1 - x0) * i / np, 0, z0 + (z1 - z0) * i / np), 4, 0, 1, fc]);
      }
      // 足球门 × 2（中空球门白框与后斜撑）+ 北侧白色遮阳小看台
      const fw = track.W - track.H + 0.02;
      for (const sx of [-1, 1]) {
        const gx = track.cx + sx * (fw / 2), bx = gx + sx * 0.0065;
        sp.push([boxAt(0.0011, 0.009, 0.0011, gx, 0, track.cz - 0.014), 4, 0, 1, C.white],
          [boxAt(0.0011, 0.009, 0.0011, gx, 0, track.cz + 0.014), 4, 0, 1, C.white],
          [boxAt(0.0011, 0.0011, 0.029, gx, 0.009, track.cz), 4, 0, 1, C.white],
          [boxAt(0.0009, 0.0009, 0.029, bx, 0.0005, track.cz), 4, 0, 1, C.white],
          [strut([gx, 0.009, track.cz - 0.014], [bx, 0.0005, track.cz - 0.014], 0.0008), 4, 0, 1, C.white],
          [strut([gx, 0.009, track.cz + 0.014], [bx, 0.0005, track.cz + 0.014], 0.0008), 4, 0, 1, C.white]);
      }
      sp.push([boxAt(0.11, 0.008, 0.018, track.cx, 0, track.cz - track.H / 2 - 0.010), 4, 0, 1, C.concrete],
        [boxAt(0.116, 0.002, 0.024, track.cx, 0.018, track.cz - track.H / 2 - 0.008), 4, 0, 1, C.white],
        [cylAt(0.0012, 0.0012, 0.018, track.cx - 0.048, 0, track.cz - track.H / 2 - 0.016, 6), 4, 0, 1, C.steel],
        [cylAt(0.0012, 0.0012, 0.018, track.cx + 0.048, 0, track.cz - track.H / 2 - 0.016, 6), 4, 0, 1, C.steel]);
      // 操场与篮球场高杆投光灯
      for (const [lx, lz, h] of [[-0.60, 0.39, 0.052], [-0.24, 0.39, 0.052], [-0.60, 0.65, 0.052], [-0.24, 0.65, 0.052], [-0.158, 0.37, 0.036], [0.046, 0.37, 0.036], [-0.158, 0.59, 0.036], [0.046, 0.59, 0.036]]) {
        sp.push([cylAt(0.0008, 0.0012, h, lx, 0, lz, 6), 4, 0, 1, C.steel]);
        gl.push([boxAt(0.005, 0.0022, 0.003, lx, h, lz), [3.2, 3.0, 2.6]]);
      }
      // 宿舍与图书馆旁的共享单车棚与五彩单车排
      const bikes = [], bikeCols = [[0.08, 0.62, 0.52], [0.90, 0.68, 0.06], [0.10, 0.42, 0.85], [0.65, 0.65, 0.65]];
      for (const [rx, rz, nB] of [[-0.41, -0.392, 10], [-0.23, -0.392, 10], [-0.50, -0.156, 8]]) {
        sp.push([boxAt(nB * 0.0036 + 0.006, 0.001, 0.009, rx, 0.0075, rz), 4, 0, 1, [0.32, 0.38, 0.42]]);
        for (let k = 0; k < nB; k++) {
          const bx = rx - (nB - 1) * 0.0018 + k * 0.0036;
          bikes.push([boxAt(0.0010, 0.0032, 0.0052, bx, 0.0008, rz), pickCol(bikeCols)]);
        }
      }
      const sNode = new T.Group(); sNode.add(new T.Mesh(merge(sp), MAT[D]));
      const gm = new T.Mesh(mergeC(gl), lightM); gm.userData.noShadow = true; sNode.add(gm);
      sNode.add(new T.Mesh(mergeC(bikes), matteM));
      addNode(D, sNode, 0, 0, 0.52, 0.06);
    }
    // 绿化
    const tl = [];
    for (const w of walks) for (const [x, z] of along(w, 0.04, [0.02, -0.02])) if (inDisc(x, z, 0.93)) tl.push([x, z, 0, 0.75]);
    for (const [x, z] of along(cLoop.pts, 0.045, [-0.026], true)) tl.push([x, z, 1, 0.9]);
    for (const [x, z] of along(hLoop.pts, 0.05, [0.026], true)) if (z < 0.33) tl.push([x, z, 0, 0.9]);
    for (const [x, z] of along(arcPts(0, 0, 0.93, 0, TAU, 200), 0.03)) tl.push([x, z, rnd() < 0.5 ? 1 : 0, 1]);
    for (const [x, z] of scatter([[0.61, -0.11], [0.71, -0.11], [0.71, -0.03], [0.61, -0.03]], 5)) tl.push([x, z, 0, 0.8]);
    for (const [x, z] of along(city.pts, 0.045, [city.w / 2 + city.sw * 0.75, -(city.w / 2 + city.sw * 0.75)])) if (Math.abs(z + 0.08) > 0.04 && inDisc(x, z, 0.95)) tl.push([x, z, 1, 0.9]);
    tl.push(...grove(-0.45, -0.68, 0.11, 13, [0, 0, 1]), ...grove(0.42, -0.72, 0.09, 10, [0, 1]), ...grove(-0.3, 0.79, 0.07, 7), ...grove(0.45, 0.72, 0.09, 10, [0, 0, 1]),
      ...grove(-0.82, 0.25, 0.06, 7, [0, 2]), ...grove(-0.82, -0.3, 0.06, 7, [0, 2]), ...grove(0.86, -0.1, 0.04, 4));
    for (const [x, z] of ellPts(-0.82, -0.02, 0.085, 0.125, 18)) if (x < -0.75) tl.push([x, z, 0, 0.8]);
    add(D, new T.CircleGeometry(1, 40).scale(0.058, 0.098, 1).rotateX(-Math.PI / 2).translate(0, 0.0012, 0), lakeM, -0.82, -0.02, { delay: 0.3, shadow: false });
    forest(D, tl.filter(([x, z]) => !(Math.abs(x - track.cx) < track.W / 2 + 0.014 && Math.abs(z - track.cz) < track.H / 2 + 0.022) && !(x > -0.17 && x < 0.06 && z > 0.355 && z < 0.605) && !(Math.abs(x + 0.82) < 0.075 && Math.abs(z + 0.02) < 0.11) && !(x > 0.24 && x < 0.65 && z > 0.35 && z < 0.61) && !(x > -0.23 && x < 0.01 && z > -0.75 && z < -0.57) && inDisc(x, z, 0.94)), 0.55);
    lamps(D, TER[D].lampPts.filter(([x, z]) => inDisc(x, z, 0.95)));
    bollards(D, [[0.62, -0.04], [0.70, -0.04], [0.62, -0.10], [0.70, -0.10], [-0.74, -0.05], [-0.74, 0.02]]);
    benches(D, [[-0.755, -0.05, -Math.PI / 2, 2], [-0.755, 0.02, -Math.PI / 2, 1], [-0.055, 0.48, Math.PI / 2, 2], [0.66, -0.05, 0, 2], [-0.42, 0.375, Math.PI, 2]]);
    birds(D, -0.80, -0.02, 0.15, 0.10, 4);
    // 车：校门斑马线红绿灯、公交站、城市道路车流、校内 / 院内环路、顶灯闪烁急救车、停车场
    const eduCross = [[0.12, -0.08, 0.048, 'ns']];
    signals(D, eduCross);
    busStops(D, [[0.062, 0.08, Math.PI / 2], [0.178, -0.22, -Math.PI / 2]]);
    traffic(D, lanesOf(city), { crossings: eduCross });
    traffic(D, [...lanesOf(cLoop), ...lanesOf(hLoop)]);
    traffic(D, lanesOf(hLoop).slice(0, 1).map(l => ({ ...l, n: 1, o0: 0.5 })), { kind: VAN, cols: [[0.92, 0.92, 0.92]], amb: true });
    parked(D, lotH, { fill: 0.85, hazard: 1 }); parked(D, lotC, { fill: 0.6 });
    parked(D, [[0.47, 0.19, 0, true]], { kind: VAN, fill: 1, cols: [[0.92, 0.92, 0.92]], amb: true });
    // 动态足球与 4 颗跳跃篮球 + 围绕球跑动跳跃的学生
    const ballPos = (t) => [track.cx + Math.sin(t * 0.95) * 0.075 + Math.cos(t * 2.1) * 0.022, track.cz + Math.sin(t * 1.43 + 0.8) * 0.052];
    {
      const balls = inst(mergeC([[new T.SphereGeometry(0.0014, 6, 5), [1, 1, 1]]]), matteM, 5);
      balls.setColorAt(0, _c.setRGB(0.95, 0.95, 0.92));
      for (let k = 1; k <= 4; k++) balls.setColorAt(k, _c.setRGB(0.92, 0.36, 0.06));
      const bNode = new T.Group(); bNode.add(balls); addNode(D, bNode, 0, 0, 0.85, 0.02);
      animate(D, (t, v) => {
        if (v < 0.02) return;
        const [sx, sz] = ballPos(t);
        setI(balls, 0, sx, 0.0015 + Math.abs(Math.sin(t * 6.5)) * 0.0035, sz, 0, 1);
        bCourts.forEach(([cx, cz], k) => {
          const ph = (t * 0.85 + k * 0.37) % 1, dir = ((t * 0.85 + k * 0.37) | 0) % 2 ? 1 : -1;
          const bz = cz + dir * (-0.01 + ph * 0.048), bx = cx + Math.sin(ph * Math.PI) * 0.008 * (k % 2 ? 1 : -1);
          const by = 0.004 + Math.sin(ph * Math.PI) * 0.012;
          setI(balls, k + 1, bx, by, bz, 0, 0.85);
        });
        balls.instanceMatrix.needsUpdate = true;
      });
    }
    const ppl = [];
    for (const w of walks) ppl.push(...walkPath(w, 4, 0.012, false, 0.006), ...pairPath(w, 3, 0.0115, false, 0));
    ppl.push(...wander(-0.56, -0.08, 0.055, 8, 1.5, 1), ...chatGroup(-0.55, -0.04, 3),
      ...pairPath(ellPts(-0.82, -0.02, 0.075, 0.115, 40), 3, 0.01, true, 0), ...walkPath([[-0.11, -0.52], [-0.11, -0.6]], 2), ...walkPath([[0.445, 0.3], [0.445, 0.37]], 2));
    { const { cx, cz, W, H } = track, rr = H / 2 - 0.016, fw = W - H + 0.02, P = pathOf([...arcPts(cx + W / 2 - H / 2, cz, rr, -Math.PI / 2, Math.PI / 2, 16), ...arcPts(cx - W / 2 + H / 2, cz, rr, Math.PI / 2, Math.PI * 1.5, 16)], true);
      for (let i = 0; i < 12; i++) ppl.push({ path: P, sp: 0.036 + rnd() * 0.018, o: rnd(), ping: false, side: (rnd() - 0.5) * 0.018, cols: [[0.65, 0.1, 0.06], [0.1, 0.24, 0.55], [0.82, 0.82, 0.8]] });
      ppl.push({ x: cx - fw / 2 + 0.008, z: cz, a: 0, cols: [[0.85, 0.72, 0.1]] }, { x: cx + fw / 2 - 0.008, z: cz, a: Math.PI, cols: [[0.15, 0.65, 0.25]] });
      for (let i = 0; i < 14; i++) {
        const hx = cx + (i < 7 ? -0.045 : 0.045) + (rnd() - 0.5) * 0.07, hz = cz + (rnd() - 0.5) * 0.075, pull = 0.35 + rnd() * 0.35, ph = rnd() * 20;
        ppl.push({ cols: i < 7 ? [[0.68, 0.08, 0.05]] : [[0.10, 0.26, 0.68]], fn: t => {
          const [bx, bz] = ballPos(t), tx = hx + (bx - hx) * pull + Math.sin(t * 1.8 + ph) * 0.014, tz = hz + (bz - hz) * pull + Math.cos(t * 1.5 + ph) * 0.012;
          return [tx, tz, Math.atan2(bz - tz, bx - tx), 0];
        } });
      } }
    bCourts.forEach(([cx, cz], k) => {
      const cA = k % 2 ? [[0.88, 0.68, 0.08]] : [[0.72, 0.10, 0.08]], cB = k % 2 ? [[0.12, 0.32, 0.72]] : [[0.82, 0.82, 0.80]];
      for (let i = 0; i < 6; i++) {
        const ox = (rnd() - 0.5) * 0.038, oz = (rnd() - 0.5) * 0.056, ph = rnd() * 20;
        ppl.push({ cols: i < 3 ? cA : cB, fn: t => {
          const dir = Math.sin(t * 0.85 * Math.PI + k) * 0.015, px = cx + ox + Math.sin(t * 2.1 + ph) * 0.008, pz = cz + oz * 0.6 + dir;
          const jmp = Math.max(0, Math.sin(t * 3.4 + ph) - 0.78) * 0.012;
          return [px, pz, Math.atan2((cz + (dir > 0 ? 0.038 : -0.038)) - pz, cx - px), jmp];
        } });
      }
    });
    ppl.push(...wander(0.47, 0.17, 0.045, 10, 2, 0.4), ...pairPath([[0.61, -0.07], [0.71, -0.07]], 2, 0.008, false, 0.2), ...pairPath([[0.3, 0.33], [0.6, 0.33]], 3, 0.011));
    for (const sd of [1, -1]) ppl.push(...pairPath(offsetLine(city.pts, sd * (city.w / 2 + city.sw / 2)), 3, 0.012));
    crowd(D, ppl, { cols: [[0.75, 0.75, 0.72], [0.1, 0.16, 0.36], [0.05, 0.05, 0.06], [0.55, 0.08, 0.06], [0.2, 0.4, 0.65], [0.62, 0.5, 0.3]] });
  }

  /* ══ §11-4 金融保险 ══════════════════════════════════════
     布局：z = 0.5 一条双向 6 车道主干道，x = 0.52 一条大道，x = -0.52、z = -0.52 两条小街，围出中间的金融街区
       银行总部（玻璃裙房 + 八角塔楼）在 (0, -0.1)，两侧塔楼 (-0.33, -0.3) (0.31, -0.3)，后面运营中心 (0, -0.41)
       总部前广场 + 长条水景和三个喷泉 (0, 0.27)；左前银行网点 (-0.37, 0.24)（门口停运钞车），右前保险楼 (0.37, 0.24)
       总部两侧各 5×5 的树阵；对街一圈写字楼和商铺；四个角是街角绿地 */
  {
    const D = 3;
    const ave = { pts: chordZ(0.5), w: 0.1, lanes: 3, median: 0.012, sw: 0.016, speed: 0.1, n: 6 };
    const aveN = { pts: chordX(0.52), w: 0.07, lanes: 2, sw: 0.014, speed: 0.08, n: 5 };
    const stW = { pts: chordX(-0.52), w: 0.036, lanes: 1, sw: 0.012, speed: 0.05, n: 3 };
    const stN = { pts: chordZ(-0.52), w: 0.036, lanes: 1, sw: 0.012, speed: 0.05, n: 3 };
    TER[D] = terrain(t => {
      t.grass(DISC, '#3d5b2a', 1200);
      t.paving(blockPoly(-0.5, -0.5, 0.47, 0.434, 2), '#8a867e', 'rgba(55,52,48,0.45)', 0.022);
      t.paving([[-0.32, 0.08], [0.32, 0.08], [0.32, 0.43], [-0.32, 0.43]], '#a09b91', 'rgba(60,56,50,0.5)', 0.016);
      t.poly([[-0.055, 0.04], [0.055, 0.04], [0.055, 0.43], [-0.055, 0.43]], '#aea89d', MT(0.62));    // 总行礼仪中轴石道
      t.poly(shapeRect(0.3, 0.07, 0, 0.27), '#6e6a62', MT(0.8)); t.poly(shapeRect(0.285, 0.056, 0, 0.27), '#0a1418', MT(0.04));   // 水景
      for (const sx of [-1, 1]) t.grass(shapeRect(0.08, 0.12, sx * 0.24, 0.3), '#4a6a30', 40);
      for (const [x0, z0, x1, z1] of [[-0.95, 0.566, 0.95, 0.95], [0.569, -0.95, 0.95, 0.434], [-0.95, -0.95, 0.5, -0.538], [-0.95, -0.502, -0.538, 0.434]])
        t.paving(blockPoly(x0, z0, x1, z1, 0.96), '#7c7870', 'rgba(50,48,44,0.4)', 0.024);
      // 打破外围大块空白灰硬地：外街区增加规整石材绿植花池与港湾落客铺装
      for (const [gx, gz, gw, gd] of [[0.72, -0.04, 0.09, 0.08], [0.72, 0.28, 0.09, 0.07], [-0.72, -0.24, 0.08, 0.08], [-0.72, 0.11, 0.08, 0.06], [0, -0.72, 0.10, 0.07], [-0.15, 0.76, 0.10, 0.05], [0.15, 0.76, 0.10, 0.05]]) {
        t.poly(shapeRect(gw + 0.012, gd + 0.012, gx, gz), '#9e998e', MT(0.72));
        t.grass(shapeRect(gw, gd, gx, gz), '#48682f', 25);
      }
      // 四角做成街角绿地；总部两侧树阵（每棵树一个石材树池）
      for (const [x0, z0, x1, z1] of [[-0.95, -0.95, -0.55, -0.55], [0.57, -0.95, 0.95, -0.55], [-0.95, 0.57, -0.55, 0.95], [0.57, 0.57, 0.95, 0.95]]) t.grass(blockPoly(x0, z0, x1, z1, 0.97), '#4a6a30', 60);
      for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) { const x = sx * (0.2 + i * 0.06), z = -0.17 + j * 0.065; t.poly(shapeRect(0.022, 0.022, x, z), '#b8b2a6', MT(0.7)); t.poly(shapeRect(0.016, 0.016, x, z), '#3a2e22', MT(0.95)); }
      t.paving([[-0.22, -0.48], [0.22, -0.48], [0.22, -0.27], [-0.22, -0.27]], '#9a958b', 'rgba(60,56,50,0.45)', 0.016);
      for (const r of [stW, stN, aveN, ave]) t.road(r);
      // 总行大堂、门前石狮、方孔圆钱雕塑、银行网点与南侧沿街商铺暖光外溢
      t.glow(0, 0.065, 0.085, 0.95); t.glow(0, 0.365, 0.05, 0.9); t.glow(-0.37, 0.31, 0.06, 0.8); t.glow(0.37, 0.31, 0.055, 0.75);
      for (const sx of [-0.3, 0, 0.3]) t.glow(sx, 0.62, 0.065, 0.7);
      for (const [x, z, a, l] of [[0.52, 0.42, Math.PI / 2, 0.07], [0.44, 0.5, 0, 0.1], [-0.52, 0.42, Math.PI / 2, 0.036], [-0.44, 0.5, 0, 0.1], [0.52, -0.45, Math.PI / 2, 0.07], [-0.45, -0.52, 0, 0.036]]) t.zebra(x, z, a, l);
    });
    // 镇宅汉白玉石狮生成器：(x, z) 须弥座中心，sc 缩放（蹲坐雄狮 + 卷鬃昂首 + 前爪抚球）
    const lionParts = (lx, lz, sc = 1) => {
      const mC = [0.84, 0.82, 0.77], pC = [0.72, 0.68, 0.60], k = sc;
      return [
        [boxAt(0.013 * k, 0.003 * k, 0.016 * k, lx, 0, lz), 4, 0, 1, pC],
        [boxAt(0.010 * k, 0.005 * k, 0.013 * k, lx, 0.003 * k, lz), 4, 0, 1, mC],
        [boxAt(0.012 * k, 0.0022 * k, 0.015 * k, lx, 0.008 * k, lz), 4, 0, 1, pC],
        [cylAt(0.0032 * k, 0.0042 * k, 0.0075 * k, lx, 0.0102 * k, lz - 0.0015 * k, 8), 4, 0, 1, mC],
        [new T.SphereGeometry(0.0038 * k, 8, 6).translate(lx, 0.0175 * k, lz + 0.0012 * k), 4, 0, 1, mC],
        [boxAt(0.0042 * k, 0.0032 * k, 0.0035 * k, lx, 0.0168 * k, lz + 0.0038 * k), 4, 0, 1, mC],
        [boxAt(0.0016 * k, 0.0055 * k, 0.0018 * k, lx - 0.0020 * k, 0.0102 * k, lz + 0.0032 * k), 4, 0, 1, mC],
        [boxAt(0.0016 * k, 0.0055 * k, 0.0018 * k, lx + 0.0020 * k, 0.0102 * k, lz + 0.0032 * k), 4, 0, 1, mC],
        [new T.SphereGeometry(0.0015 * k, 6, 5).translate(lx + (lx < 0 ? 0.002 : -0.002) * k, 0.0115 * k, lz + 0.0048 * k), 4, 0, 1, pC],
      ];
    };
    // 银行总部大厦（厚重古典石材巨柱裙房 + 挑高铜门门廊与行徽 + 对称玻璃藻井采光顶 + 竖肋石材退台主塔 + 鎏金阁冠 + 门前镇宅石狮）
    {
      const BS = [0.64, 0.57, 0.45], BG = [0.26, 0.24, 0.21], trimS = [0.78, 0.73, 0.64];
      const hq = [
        [prism(shapeRect(0.30, 0.28), 0, 0.009), 4, 0, 1, C.granite],                                           // 花岗岩台基
        [prism(shapeRect(0.276, 0.256), 0.009, 0.072), 3, 0.009, 1, [0.46, 0.40, 0.32]],                        // 深凹古铜竖窗裙房芯
        [prism(shapeRect(0.292, 0.272), 0.081, 0.007), 4, 0, 1, trimS],                                         // 古典挑檐大线脚
        [prism(shapeRect(0.284, 0.264), 0.088, 0.006, [shapeRect(0.256, 0.236)]), 4, 0, 1, BS],                 // 裙房厚重石材女儿墙（无休闲花园）
      ];
      // 门前御道宽石阶 + 正面与侧面贯通式古典石材方巨柱 + 挑高柱式门廊
      for (let s = 0; s < 4; s++) hq.push([boxAt(0.12 - s * 0.008, 0.0024, 0.036 - s * 0.007, 0, s * 0.0022, 0.152 - s * 0.004), 4, 0, 1, trimS]);
      for (let i = 0; i < 8; i++) { const px = -0.126 + i * 0.036; hq.push([boxAt(0.011, 0.072, 0.012, px, 0.009, 0.128), 4, 0, 1, BS], [boxAt(0.011, 0.072, 0.012, px, 0.009, -0.128), 4, 0, 1, BS]); }
      for (let i = 0; i < 6; i++) { const pz = -0.10 + i * 0.04; hq.push([boxAt(0.012, 0.072, 0.011, -0.138, 0.009, pz), 4, 0, 1, BS], [boxAt(0.012, 0.072, 0.011, 0.138, 0.009, pz), 4, 0, 1, BS]); }
      hq.push([boxAt(0.118, 0.010, 0.036, 0, 0.074, 0.144), 4, 0, 1, trimS], [boxAt(0.106, 0.008, 0.030, 0, 0.084, 0.142), 4, 0, 1, BS]);
      for (const cx of [-0.046, -0.016, 0.016, 0.046]) hq.push([cylAt(0.0048, 0.0056, 0.065, cx, 0.009, 0.152, 14), 4, 0, 1, trimS]);
      // 裙房顶面：四向对称营业大厅玻璃金字塔采光天窗（庄重严谨的银行建筑语言）
      for (const [sx, sz] of [[0, 0.098], [0, -0.098], [-0.098, 0], [0.098, 0]]) {
        hq.push([boxAt(0.052, 0.004, 0.034, sx, 0.088, sz), 4, 0, 1, trimS],
          [new T.ConeGeometry(0.024, 0.011, 4).rotateY(Math.PI / 4).translate(sx, 0.097, sz), 1, 0, 1, C.glass]);
      }
      // 主塔楼：竖向密肋石材 + 深古铜幕墙 + 三级古典退台 + 顶部发光阁冠
      hq.push([prism(shapeOct(0.146, 0.146, 0.028), 0.090, 0.39), 1, 0.090, 1, BG],
        [prism(shapeOct(0.118, 0.118, 0.024), 0.480, 0.076), 1, 0.480, 1, BG],
        [prism(shapeOct(0.090, 0.090, 0.018), 0.556, 0.054), 3, 0.556, 1, BS],
        [prism(shapeOct(0.096, 0.096, 0.018), 0.610, 0.006), 4, 0, 1, trimS],
        [prism(shapeOct(0.062, 0.062, 0.012), 0.616, 0.030), 3, 0.616, 1, trimS],
        [cylAt(0.0018, 0.004, 0.095, 0, 0.646, 0, 8), 4, 0, 1, C.steel]);
      for (let yy = 0.090 + 0.078; yy < 0.48; yy += 0.078) hq.push([prism(shapeOct(0.153, 0.153, 0.03), yy, 0.003, [], 0.0006), 4, 0, 1, trimS]);
      for (let i = 0; i < 16; i++) { const a = i / 16 * TAU, r = 0.074; hq.push([boxAt(0.0042, 0.39, 0.0042, Math.cos(a) * r, 0.090, Math.sin(a) * r), 4, 0, 1, BS]); }
      for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + Math.PI / 8, r = 0.060; hq.push([boxAt(0.0036, 0.076, 0.0036, Math.cos(a) * r, 0.480, Math.sin(a) * r), 4, 0, 1, BS]); }
      hq.push(...lionParts(-0.062, 0.168, 1.05), ...lionParts(0.062, 0.168, 1.05));                             // 总行大门两侧镇宅石狮
      const hqNode = new T.Group(); hqNode.add(new T.Mesh(merge(hq), MAT[D]));
      // 门楣中央鎏金「外圆内方」银行总行徽标 + 阁冠鎏金尖顶
      const crest = prism(shapeCircle(0.0075, 24), 0, 0.0025, [shapeRect(0.0052, 0.0052)], 0.0004);
      crest.rotateX(Math.PI / 2); crest.translate(0, 0.080, 0.163);
      const cap = new T.ConeGeometry(0.032, 0.018, 8).translate(0, 0.655, 0);
      hqNode.add(new T.Mesh(crest, M.bronze), new T.Mesh(cap, M.bronze));
      const crownGlow = new T.Mesh(cylAt(0.022, 0.022, 0.024, 0, 0.618, 0, 8), new T.MeshBasicMaterial({ color: new T.Color(2.4, 1.75, 0.85), clippingPlanes: CLIP }));
      crownGlow.userData.noShadow = true; hqNode.add(crownGlow);
      addNode(D, hqNode, 0, -0.1, 0.2, 0.76);
      beacons(D, [[0, 0.742, -0.1, 'red'], [-0.33, 0.368, -0.3, 'red'], [0.31, 0.382, -0.3, 'red']]);
    }
    // 金融广场中轴图腾：花岗岩基座 + 巨型古铜鎏金「外圆内方」古钱币雕塑 (0, 0.365) + 东侧拓荒铜牛 (0.24, 0.22)
    {
      const base = [[prism(shapeRect(0.052, 0.030, 0, 0.365), 0, 0.005), 4, 0, 1, C.granite], [prism(shapeRect(0.040, 0.022, 0, 0.365), 0.005, 0.006), 4, 0, 1, C.dark],
        [prism(shapeRect(0.030, 0.020, 0.24, 0.22), 0, 0.007), 4, 0, 1, C.granite],
        ...lionParts(-0.405, 0.312, 0.72), ...lionParts(-0.335, 0.312, 0.72)];                                  // 左前银行支行网点门口也配一对小石狮
      const fNode = new T.Group(); fNode.add(new T.Mesh(merge(base), MAT[D]));
      const coin = prism(shapeCircle(0.022, 40), 0, 0.0055, [shapeRect(0.012, 0.012)], 0.0008);
      coin.rotateX(Math.PI / 2); coin.translate(0, 0.032, 0.368);
      const bull = new T.BufferGeometry();
      {
        const bp = [boxAt(0.015, 0.0075, 0.0065, 0.24, 0.010, 0.22), boxAt(0.007, 0.0065, 0.006, 0.232, 0.012, 0.22),
          boxAt(0.002, 0.005, 0.0018, 0.234, 0.007, 0.222), boxAt(0.002, 0.005, 0.0018, 0.246, 0.007, 0.218)].map(g => g.toNonIndexed());
        const cnt = bp.reduce((s, q) => s + q.attributes.position.count, 0), P = new Float32Array(cnt * 3), N = new Float32Array(cnt * 3);
        let o = 0; for (const q of bp) { P.set(q.attributes.position.array, o * 3); N.set(q.attributes.normal.array, o * 3); o += q.attributes.position.count; }
        bull.setAttribute('position', new T.BufferAttribute(P, 3)); bull.setAttribute('normal', new T.BufferAttribute(N, 3));
      }
      fNode.add(new T.Mesh(coin, M.bronze), new T.Mesh(bull, M.bronze));
      addNode(D, fNode, 0, 0, 0.34, 0.06);
    }
    add(D, tower({ w: 0.1, d: 0.12, h: 0.34, style: 0, tiers: 2, crown: 2, col: C.stone }), null, -0.33, -0.3, { delay: 0.4 });
    add(D, tower({ w: 0.1, d: 0.1, h: 0.29, style: 1, tiers: 1, crown: 1, oct: 0.2, col: [0.28, 0.33, 0.37] }), null, 0.31, -0.3, { delay: 0.45 });
    // 左前银行网点（厚石材柱廊 + 鎏金门头灯带）
    add(D, merge([[prism(shapeRect(0.16, 0.12), 0, 0.052), 3, 0, 1, C.stone], [prism(shapeRect(0.17, 0.13), 0.052, 0.006), 4, 0, 1, C.white],
      [boxAt(0.072, 0.004, 0.03, 0, 0.032, 0.074), 4, 0, 1, C.white], [boxAt(0.14, 0.0035, 0.003, 0, 0.044, 0.062), 4, 0, 1, [0.78, 0.56, 0.18]],
      ...[-0.06, -0.02, 0.02, 0.06].map(px => [boxAt(0.006, 0.052, 0.006, px, 0, 0.061), 4, 0, 1, C.white])]), null, -0.37, 0.24, { delay: 0.5 });
    add(D, tower({ w: 0.12, d: 0.1, h: 0.16, style: 1, col: [0.30, 0.34, 0.36] }), null, 0.37, 0.24, { delay: 0.5 });
    add(D, merge([[prism(shapeRect(0.3, 0.075, 0, 0.27), 0, 0.006, [shapeRect(0.285, 0.056, 0, 0.27)]), 4, 0, 1, C.stone]]), null, 0, 0, { delay: 0.3 });
    add(D, new T.PlaneGeometry(0.285, 0.056).rotateX(-Math.PI / 2).translate(0, 0.003, 0.27), M.water, 0, 0, { delay: 0.3, shadow: false });
    for (const x of [-0.09, 0, 0.09]) fountain(D, x, 0.27, 0.004, 0.02, 60);
    // 银行网点、保险楼、运营中心；对街一圈商铺和写字楼 [x, z, tower 参数]
    for (const [x, z, o] of [[-0.3, 0.67, { w: 0.18, d: 0.07, h: 0.07, style: 0, col: C.cream }], [0.0, 0.68, { w: 0.16, d: 0.07, h: 0.09, style: 1, col: [0.34, 0.37, 0.4] }], [0.3, 0.67, { w: 0.18, d: 0.07, h: 0.06, style: 0, col: C.brickL }],
      [0.72, -0.2, { w: 0.1, d: 0.1, h: 0.3, style: 1, tiers: 2, crown: 2, col: C.glass }], [0.72, 0.12, { w: 0.1, d: 0.08, h: 0.18, style: 0, col: C.stone }],
      [-0.2, -0.72, { w: 0.14, d: 0.08, h: 0.2, style: 1, col: [0.3, 0.33, 0.36] }], [0.2, -0.72, { w: 0.12, d: 0.08, h: 0.14, style: 0, col: C.concrete }], [-0.72, -0.05, { w: 0.08, d: 0.14, h: 0.22, style: 1, crown: 1, col: [0.28, 0.32, 0.36] }], [-0.72, 0.25, { w: 0.08, d: 0.1, h: 0.1, style: 0, col: C.cream }]])
      add(D, tower(o), null, x, z);
    // 绿化
    const tl = [];
    for (const r of [ave, aveN, stW, stN]) for (const [x, z] of along(r.pts, 0.045, [r.w / 2 + r.sw * 0.75, -(r.w / 2 + r.sw * 0.75)])) if (inDisc(x, z, 0.94) && !(Math.abs(Math.abs(x) - 0.52) < 0.06 && Math.abs(Math.abs(z) - 0.5) < 0.06)) tl.push([x, z, 0, 0.85]);
    for (const sx of [-1, 1]) for (let i = 0; i < 6; i++) tl.push([sx * 0.2, 0.11 + i * 0.055, 0, 0.9]);
    for (const [x, z] of along(arcPts(0, 0, 0.93, 0, TAU, 200), 0.032)) if (Math.abs(Math.abs(x) - 0.52) > 0.06 && Math.abs(z - 0.5) > 0.08 && Math.abs(z + 0.52) > 0.05) tl.push([x, z, 0, 1]);
    for (const sx of [-1, 1]) for (const [x, z] of scatter(shapeRect(0.06, 0.1, sx * 0.24, 0.3), 3)) tl.push([x, z, 0, 0.8]);
    for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) tl.push([sx * (0.2 + i * 0.06), -0.17 + j * 0.065, 0, 0.95]);
    for (const [cx, cz] of [[-0.72, -0.72], [0.72, -0.72], [-0.72, 0.72], [0.72, 0.72]]) tl.push(...grove(cx, cz, 0.1, 9, [0, 0, 1], 1, 1));
    for (const [gx, gz] of [[0.72, -0.04], [0.72, 0.28], [-0.72, -0.24], [-0.72, 0.11], [0, -0.72], [-0.15, 0.76], [0.15, 0.76]]) tl.push([gx - 0.022, gz, 0, 0.85], [gx + 0.022, gz, 0, 0.85]);
    for (let i = 0; i < 7; i++) tl.push([-0.18 + i * 0.06, -0.3, 0, 0.85]);
    forest(D, tl.filter(([x, z]) => inDisc(x, z, 0.94)), 0.55);
    add(D, tower({ w: 0.22, d: 0.08, h: 0.065, style: 1, col: [0.30, 0.34, 0.37] }), null, 0, -0.41, { delay: 0.5 });
    benches(D, [[-0.09, 0.215, 0, 2], [0.09, 0.215, 0, 1], [-0.09, 0.325, Math.PI, 2], [0.09, 0.325, Math.PI, 2], [0.72, -0.088, 0, 2], [-0.72, -0.288, 0, 1]]);
    lamps(D, TER[D].lampPts.filter(([x, z]) => inDisc(x, z, 0.95)));
    // 车：金融街十字路口红绿灯、公交站、主干道车流、武装押运钞车、写字楼门口双闪迎宾商务黑车
    const finCross = [[0.52, 0.5, 0.056], [-0.52, 0.5, 0.046], [0.52, -0.52, 0.046], [-0.52, -0.52, 0.042]];
    signals(D, finCross.slice(0, 2));
    busStops(D, [[-0.22, 0.432, 0], [0.22, 0.568, Math.PI]]);
    const finAveL = lanesOf(ave);
    traffic(D, [...finAveL, ...lanesOf(aveN), ...lanesOf(stW), ...lanesOf(stN)], { crossings: finCross });
    traffic(D, finAveL.filter((_, i) => i >= 4).map(l => ({ ...l, n: 1, o0: 0.35 })), { kind: BUS, cols: [[0.12, 0.25, 0.5], [0.76, 0.76, 0.74]], crossings: finCross, busStops: [[-0.22, 0.462], [0.22, 0.538]] });
    traffic(D, lanesOf(stN).slice(0, 1).map(l => ({ ...l, n: 1, o0: 0.9 / 3 })), { kind: VAN, cols: [[0.14, 0.24, 0.18]], crossings: finCross });
    parked(D, [[-0.4, 0.33, 0, true], [-0.34, 0.33, 0, true]], { kind: VAN, fill: 1, cols: [[0.14, 0.24, 0.18]] });
    parked(D, [[0.65, -0.11, Math.PI / 2, true], [0.65, 0.03, Math.PI / 2, true], [-0.65, -0.05, Math.PI / 2, true], [0.37, 0.33, 0, true]], { fill: 1, cols: [[0.03, 0.03, 0.035]], hazard: 2 });
    // 人：西装白领结伴通行、古铜钱币雕塑与水景旁驻足仰望、支行门口办事人群
    const suitCols = [[0.06, 0.07, 0.10], [0.12, 0.15, 0.24], [0.78, 0.78, 0.76], [0.24, 0.24, 0.26], [0.55, 0.46, 0.34]];
    const ppl = [...wander(0, 0.16, 0.10, 16, 1.8, 0.5), ...standLook(0, 0.39, 0.09, 8, 0, 0.365, 0.1), ...standLook(0, 0.22, 0.18, 6, 0, 0.27, 0.1),
      ...chatGroup(-0.08, 0.12, 3), ...chatGroup(0.09, 0.14, 2), ...standLook(0.24, 0.255, 0.03, 3, 0.24, 0.22, 0),
      ...wander(-0.32, -0.04, 0.1, 8, 1.2, 1.2), ...wander(0.32, -0.04, 0.1, 8, 1.2, 1.2), ...wander(0, -0.3, 0.12, 6, 1.6, 0.3),
      ...wander(-0.37, 0.33, 0.04, 6, 2, 0.4), ...pairPath([[0, 0.42], [0, 0.06]], 4, 0.012, false, 0)];
    for (const r of [ave, aveN]) for (const sd of [1, -1]) {
      const swP = offsetLine(r.pts, sd * (r.w / 2 + r.sw / 2));
      ppl.push(...walkPath(swP, 3, 0.014), ...pairPath(swP, 3, 0.013, false, 0));
    }
    crowd(D, ppl, { cols: suitCols, avoid: [[-0.156, 0.236, 0.156, 0.304], [-0.155, -0.245, 0.155, 0.065], [-0.455, 0.175, -0.285, 0.305], [0.305, 0.185, 0.435, 0.295], [-0.035, 0.345, 0.035, 0.385]] });
  }

  /* ══ §11-5 能源智造 ══════════════════════════════════════
     布局：整片草原（台面草地上还撒了几千簇会随风摆的草）
       南边一条弯曲的公路（卡车、小车），两侧钻天杨防护林；路边 (0.15, 0.66) 加油站，(0.48, 0.68) 一个海子（小湖）
       中央圆形中控楼 (0, 0)，土路放射状连到各处
       西边光伏电站（x -0.8~-0.37），东边变电站 (0.42, -0.05) 和光伏硅片工厂 (0.46, 0.25)
       北边一圈土路（巡检皮卡在跑），五台风机，东北三座输电塔连到变电站；两台抽油机在中控楼南边
       西南三座蒙古包和羊群，风机下第二群羊，东边黑牛，中控楼北边马群，海子边几匹马在喝水 */
  {
    const D = 4;
    const hw = { pts: spline([[-0.99, 0.4], [-0.6, 0.46], [-0.2, 0.52], [0.2, 0.55], [0.55, 0.52], [0.86, 0.47]], 14), w: 0.046, lanes: 1, speed: 0.07, n: 4 };
    hw.pts = hw.pts.filter(([x, z]) => Math.hypot(x, z) < EDGE);
    const dirt = [
      [[0, 0.1], [0, 0.5]], [[-0.1, 0], [-0.36, 0]], [[0.1, 0], [0.3, -0.04]], [[0.07, 0.07], [0.33, 0.2]], [[0, -0.1], [0, -0.42]],
      [[-0.22, 0.52], [-0.22, 0.3]], [[-0.02, 0.53], [-0.02, 0.36]],
      [[-0.60, 0.46], [-0.60, 0.66], [-0.50, 0.77]], [[-0.60, 0.60], [-0.68, 0.56]], [[-0.60, 0.66], [-0.44, 0.68]],   // 串联蒙古包与羊圈的牧道
    ];
    const tLoop = { pts: ellPts(0.02, -0.56, 0.5, 0.15, 72), closed: true, w: 0.018, kind: 'dirt' };
    const solar = rrect(-0.8, -0.4, -0.37, 0.3, 0.03);
    let lotF = [], station = null;
    TER[D] = terrain(t => {
      // 草原：干草黄绿的底色，大片深浅起伏，再撒细碎草色
      t.poly(DISC, '#63703c', MT(0.95, 1, 0));
      t.speckle(DISC, ['#4f6230', '#6f7a42', '#56692f', '#7b8048', '#5b6b35'], 260, 0.05, 0.18, [0.18, 0.35]);
      t.speckle(DISC, ['#4a5d2b', '#6c7a3f', '#7f8549', '#566a31', '#8a8a52'], 5200, 0.003, 0.016, [0.25, 0.5]);
      t.poly(solar, '#77736a', MT(0.95, 0.05)); t.speckle(solar, ['#6b675f', '#85817a', '#5f5b55'], 900, 0.002, 0.006);
      for (const g of [rrect(0.29, -0.15, 0.55, 0.05, 0.02), rrect(0.3, 0.17, 0.62, 0.34, 0.02), rrect(-0.27, 0.25, -0.17, 0.35, 0.015), rrect(-0.07, 0.29, 0.03, 0.39, 0.015)]) {
        t.poly(g, '#7a766c', MT(0.95, 0.05)); t.speckle(g, ['#6b675f', '#8a867e'], 200, 0.002, 0.005); }
      t.poly(shapeCircle(0.13, 64), '#777369', MT(0.9, 0.05));
      t.circle(-0.43, 0.68, 0.034, '#6e6045', MT(0.95, 0.1));                                // 木栅栏羊圈内踩实的黄土地
      lotF = t.parking(0.34, 0.36, 0.62, 0.44, { rows: 1 });
      for (const p of dirt) t.road({ pts: p, w: 0.016, kind: 'dirt' });
      t.road(tLoop);
      t.road(hw);
      // 加油站：路边硬地 + 进出车道 + 蒙古包暖黄炉火微光
      station = { x: 0.15, z: 0.66 };
      t.poly(rrect(0.02, 0.585, 0.3, 0.76, 0.02), '#4a4a4c', MT(0.6)); t.glow(0.15, 0.67, 0.1, 0.9);
      t.glow(0, 0, 0.16, 0.5); t.glow(0.46, 0.25, 0.14, 0.5);
      for (const [yx, yz] of [[-0.6, 0.66], [-0.5, 0.77], [-0.68, 0.56]]) t.glow(yx, yz + 0.015, 0.04, 0.65);
      // 海子（草原上的小湖）：湿泥岸 + 水面
      t.poly(ellPts(0.48, 0.68, 0.115, 0.068, 64), '#4f5236', MT(0.85, 0.3)); t.speckle(ellPts(0.48, 0.68, 0.115, 0.068, 64), ['#3e4a2a', '#6b6a4a'], 120, 0.003, 0.01);
      t.poly(ellPts(0.48, 0.68, 0.1, 0.055, 64), '#18272b', MT(0.05));
    });
    add(D, new T.CircleGeometry(1, 48).scale(0.1, 0.055, 1).rotateX(-Math.PI / 2).translate(0, 0.0012, 0), lakeM, 0.48, 0.68, { delay: 0.3, shadow: false });
    // 中控楼（圆形）
    add(D, merge([[prism(shapeCircle(0.075, 48), 0, 0.05), 1, 0, 1, [0.6, 0.62, 0.64]], [prism(shapeCircle(0.08, 48), 0.05, 0.006), 4, 0, 1, C.white], [cylAt(0.03, 0.03, 0.01, 0, 0.056, 0, 32), 4, 0, 1, C.steel]]), null, 0, 0, { delay: 0.2 });
    // 光伏阵列
    const solarTex = (() => { const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; const c = cv.getContext('2d');
      c.fillStyle = '#1b3150'; c.fillRect(0, 0, 256, 128); c.strokeStyle = 'rgba(190,205,225,.6)'; c.lineWidth = 1.4;
      for (let x = 0; x <= 256; x += 21.3) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 128); c.stroke(); }
      for (let y = 0; y <= 128; y += 21.3) { c.beginPath(); c.moveTo(0, y); c.lineTo(256, y); c.stroke(); }
      c.strokeStyle = '#c9ccd2'; c.lineWidth = 6; c.strokeRect(0, 0, 256, 128);
      const tx = new T.CanvasTexture(cv); tx.colorSpace = T.SRGBColorSpace; tx.anisotropy = 8; return tx; })();
    const solarM = std([1, 1, 1], 0.2, { map: solarTex, metalness: 0.15, envMapIntensity: 1.8 });
    for (let row = 0; row < 9; row++) {
      const z = -0.36 + row * 0.077, geos = [];
      for (let col = 0; col < 7; col++) {
        const x = -0.765 + col * 0.06;
        if (!inPoly(x, z, solar) || !inPoly(x + 0.03, z, solar) || !inPoly(x - 0.03, z, solar)) continue;
        const p = new T.BoxGeometry(0.056, 0.0025, 0.05); p.rotateX(0.42); p.translate(x, 0.022, z);
        geos.push(p, boxAt(0.0025, 0.02, 0.0025, x - 0.02, 0, z - 0.006), boxAt(0.0025, 0.02, 0.0025, x + 0.02, 0, z - 0.006));
      }
      if (!geos.length) continue;
      const g = new T.BufferGeometry(), all = geos.map(q => q.index ? q.toNonIndexed() : q);
      const cnt = all.reduce((s, q) => s + q.attributes.position.count, 0), P = new Float32Array(cnt * 3), N = new Float32Array(cnt * 3), UV = new Float32Array(cnt * 2);
      let o = 0; for (const q of all) { P.set(q.attributes.position.array, o * 3); N.set(q.attributes.normal.array, o * 3); UV.set(q.attributes.uv.array, o * 2); o += q.attributes.position.count; }
      g.setAttribute('position', new T.BufferAttribute(P, 3)); g.setAttribute('normal', new T.BufferAttribute(N, 3)); g.setAttribute('uv', new T.BufferAttribute(UV, 2));
      add(D, g, solarM, 0, 0, { delay: 0.25 + row * 0.05 });
    }
    // 风机（草原上）
    for (const [x, z, s] of [[-0.48, -0.66, 0.95], [-0.2, -0.75, 1.0], [0.12, -0.79, 1.0], [0.45, -0.76, 0.92], [-0.62, -0.5, 0.85]]) {
      const node = new T.Group(), H = 0.42 * s;
      node.add(new T.Mesh(cylAt(0.004, 0.009, H, 0, 0, 0, 14), M.white));
      const hub = new T.Group(); hub.position.set(0, H, 0.012);
      node.add(new T.Mesh(boxAt(0.012, 0.012, 0.032, 0, H - 0.006, 0), M.white));
      hub.add(new T.Mesh(new T.SphereGeometry(0.0065, 12, 8), M.white));
      for (let b = 0; b < 3; b++) {
        const bl = new T.Shape([new T.Vector2(-0.004, 0), new T.Vector2(0.005, 0), new T.Vector2(0.0015, 0.15 * s), new T.Vector2(-0.001, 0.15 * s)]);
        const m = new T.Mesh(new T.ExtrudeGeometry(bl, { depth: 0.0012, bevelEnabled: false }), M.white); m.rotation.z = b * TAU / 3; hub.add(m);
      }
      node.add(hub);
      const blink = new T.Mesh(new T.SphereGeometry(0.0022, 6, 5).translate(0, H + 0.006, -0.012), new T.MeshBasicMaterial({ color: new T.Color(4, 0.2, 0.1), clippingPlanes: CLIP })); node.add(blink);
      const sp = 0.9 + rnd() * 0.3, ph = rnd() * 6;
      animate(D, t => { hub.rotation.z = -(t * sp + ph); blink.visible = (t + ph) % 2 < 0.25; });
      node.rotation.y = 0.35;
      addNode(D, node, x, z, 0.45);
    }
    // 变电站 + 输电塔
    {
      const p = [];
      for (let i = 0; i < 3; i++) p.push([boxAt(0.032, 0.028, 0.03, -0.07 + i * 0.07, 0, -0.03), 2, 0, 1, C.steel], [cylAt(0.004, 0.004, 0.02, -0.07 + i * 0.07, 0.028, -0.03, 8), 4, 0, 1, [0.55, 0.35, 0.25]]);
      for (let i = 0; i < 5; i++) p.push([strut([-0.1 + i * 0.05, 0, 0.05], [-0.1 + i * 0.05, 0.06, 0.05], 0.002), 4, 0, 1, C.steel]);
      p.push([strut([-0.105, 0.058, 0.05], [0.105, 0.058, 0.05], 0.002), 4, 0, 1, C.steel], [boxAt(0.05, 0.03, 0.035, 0.08, 0, -0.06), 0, 0, 1, C.white]);
      add(D, merge(p), null, 0.42, -0.05, { delay: 0.55 });
      const pyl = [[0.58, -0.27], [0.68, -0.47], [0.75, -0.6]];
      const pylon = () => {
        const parts = [], Hh = 0.26, b = 0.028, tp = 0.007, lv = [0, 0.09, 0.17, 0.26], at = y => b + (tp - b) * (y / Hh), cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (const [sx, sz] of cs) parts.push([strut([sx * b, 0, sz * b], [sx * tp, Hh, sz * tp], 0.0022), 4, 0, 1, C.steel]);
        for (let i = 0; i < lv.length - 1; i++) { const y0 = lv[i], y1 = lv[i + 1], a0 = at(y0), a1 = at(y1);
          for (let k = 0; k < 4; k++) { const [x0, z0] = cs[k], [x1, z1] = cs[(k + 1) % 4]; parts.push([strut([x0 * a0, y0, z0 * a0], [x1 * a1, y1, z1 * a1], 0.0012), 4, 0, 1, C.steel], [strut([x1 * a0, y0, z1 * a0], [x0 * a1, y1, z0 * a1], 0.0012), 4, 0, 1, C.steel]); } }
        for (const y of [0.17, 0.22]) parts.push([strut([-0.06, y, 0], [0.06, y, 0], 0.0025), 4, 0, 1, C.steel]);
        return merge(parts);
      };
      const wireM = new T.LineBasicMaterial({ color: new T.Color(0.22, 0.22, 0.23), clippingPlanes: CLIP });
      pyl.forEach(([x, z], i) => {
        const node = new T.Group(), m = new T.Mesh(pylon(), MAT[D]); node.add(m);
        const nx = pyl[i + 1] ?? [x * 1.2, z * 1.2], ang = Math.atan2(nx[1] - z, nx[0] - x);
        if (pyl[i + 1]) for (const [ox, y] of [[-0.055, 0.17], [0.055, 0.17], [-0.05, 0.22], [0.05, 0.22]]) {
          const pts = [], L = Math.hypot(nx[0] - x, nx[1] - z);
          for (let s = 0; s <= 24; s++) { const f = s / 24; pts.push(new T.Vector3(Math.cos(ang) * L * f - Math.sin(ang) * ox, y - 0.035 * 4 * f * (1 - f), Math.sin(ang) * L * f + Math.cos(ang) * ox)); }
          node.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), wireM));
        }
        m.rotation.y = -ang - Math.PI / 2;
        addNode(D, node, x, z, 0.5 + i * 0.08);
      });
    }
    // 光伏硅片工厂：锯齿屋面大厂房 + 办公楼 + 冷却塔白雾 + 装卸货卡车
    {
      const p = [[prism(shapeRect(0.3, 0.15), 0, 0.045), 2, 0, 1, C.white]];
      for (let i = 0; i < 5; i++) { const s = new T.Shape([new T.Vector2(0, 0), new T.Vector2(0.06, 0), new T.Vector2(0.06, 0.02)]); const g = new T.ExtrudeGeometry(s, { depth: 0.15, bevelEnabled: false }); g.translate(-0.15 + i * 0.06, 0.045, -0.075); p.push([g, 4, 0, 1, C.blueRoof]); }
      p.push([prism(shapeRect(0.08, 0.05, 0.11, 0.1), 0, 0.06), 1, 0, 1, C.glass],
        [boxAt(0.045, 0.005, 0.016, -0.09, 0, 0.082), 4, 0, 1, C.concrete]);                                  // 装卸货月台
      for (let i = 0; i < 3; i++) p.push([cylAt(0.012, 0.014, 0.02, -0.1 + i * 0.035, 0, -0.1, 16), 4, 0, 1, C.white]);
      add(D, merge(p), null, 0.46, 0.25, { delay: 0.5 });
      plumes(D, [0, 1, 2].map(i => [0.36 + i * 0.035, 0.022, 0.15]), { col: [1.28, 1.30, 1.35], size: 0.028, nPer: 16, h: 0.095, dx: 0.034, dz: 0.012, sp: 0.25, opacity: 0.44 });
      parked(D, lotF, { fill: 0.7 });
      parked(D, [[0.37, 0.355, -Math.PI / 2, true]], { kind: TRUCK, fill: 1, cols: [[0.12, 0.28, 0.55]] });
    }
    // 抽油机 × 2（游梁上下点头，曲柄转动）：[x, z, 朝向]
    for (const [x, z, r] of [[-0.22, 0.3, -0.3], [-0.02, 0.34, 0.4]]) {
      const node = new T.Group();
      node.add(new T.Mesh(merge([[boxAt(0.09, 0.006, 0.026, 0, 0, 0), 4, 0, 1, C.concrete], [strut([-0.006, 0.006, -0.01], [0, 0.055, 0], 0.003), 4, 0, 1, [0.6, 0.45, 0.1]], [strut([-0.006, 0.006, 0.01], [0, 0.055, 0], 0.003), 4, 0, 1, [0.6, 0.45, 0.1]], [strut([0.012, 0.006, 0], [0, 0.055, 0], 0.003), 4, 0, 1, [0.6, 0.45, 0.1]]]), MAT[D]));
      const beam = new T.Group(); beam.position.set(0, 0.057, 0);
      beam.add(new T.Mesh(merge([[boxAt(0.085, 0.006, 0.006, 0.005, -0.003, 0), 4, 0, 1, [0.6, 0.45, 0.1]], [boxAt(0.008, 0.02, 0.008, 0.048, -0.017, 0), 4, 0, 1, C.dark]]), MAT[D]));
      node.add(beam);
      const crank = new T.Group(); crank.position.set(-0.03, 0.02, 0); crank.add(new T.Mesh(boxAt(0.024, 0.008, 0.012, 0.006, -0.004, 0), M.dark)); node.add(crank);
      const ph = rnd() * 6;
      animate(D, t => { beam.rotation.z = Math.sin(t * 1.5 + ph) * 0.22; crank.rotation.z = t * 1.5 + ph; });
      node.rotation.y = r;
      addNode(D, node, x, z, 0.6);
    }
    // 加油站：罩棚（底面发光）+ 油泵 + 便利店；加油的车
    {
      const { x, z } = station;
      const gs = [[prism(shapeRect(0.14, 0.08), 0.042, 0.007), 4, 0, 1, C.white], [boxAt(0.142, 0.003, 0.082, 0, 0.04, 0), 4, 0, 1, [0.75, 0.1, 0.06]]];
      for (const [px, pz] of [[-0.05, -0.025], [0.05, -0.025], [-0.05, 0.025], [0.05, 0.025]]) gs.push([cylAt(0.0025, 0.0025, 0.042, px, 0, pz, 8), 4, 0, 1, C.white]);
      for (const px of [-0.03, 0.03]) gs.push([boxAt(0.008, 0.014, 0.014, px, 0, 0), 4, 0, 1, C.white]);
      gs.push([prism(shapeRect(0.07, 0.04, 0.04, 0.065), 0, 0.03), 1, 0, 1, C.white]);
      add(D, merge(gs), null, x, z, { delay: 0.6 });
      const under = new T.Mesh(new T.PlaneGeometry(0.13, 0.07).rotateX(Math.PI / 2).translate(x, 0.0395, z), new T.MeshBasicMaterial({ color: new T.Color(3, 2.9, 2.7), clippingPlanes: CLIP }));
      under.userData.noShadow = true; const n2 = new T.Group(); n2.add(under); addNode(D, n2, 0, 0, 0.62, 0.05);
      parked(D, [[x - 0.03, z - 0.022, 0], [x + 0.03, z + 0.022, 0], [x - 0.03, z + 0.022, 0]], { fill: 1 });
    }
    // 蒙古包 × 3（门缝透暖光 + 套瑙袅袅炊烟）+ 木栅栏羊圈 + 牧民皮卡与光伏巡检车
    {
      const doorM = new T.MeshBasicMaterial({ color: new T.Color(2.4, 1.45, 0.55), clippingPlanes: CLIP });
      const camp = [], doors = [];
      for (const [x, z, ry] of [[-0.6, 0.66, 0.25], [-0.5, 0.77, -0.2], [-0.68, 0.56, 0.45]]) {
        const gY = merge([[cylAt(0.017, 0.017, 0.011, 0, 0, 0, 20), 4, 0, 1, [0.82, 0.8, 0.74]], [new T.ConeGeometry(0.0185, 0.009, 20).translate(0, 0.0155, 0), 4, 0, 1, [0.78, 0.76, 0.7]],
          [cylAt(0.0172, 0.0172, 0.0018, 0, 0.008, 0, 20), 4, 0, 1, [0.12, 0.25, 0.55]], [boxAt(0.006, 0.008, 0.002, 0, 0, 0.017), 4, 0, 1, [0.7, 0.35, 0.1]], [cylAt(0.003, 0.003, 0.003, 0, 0.02, 0, 8), 4, 0, 1, C.dark]]);
        add(D, gY, null, x, z, { delay: 0.7, rotY: ry });
        const dg = boxAt(0.0042, 0.0065, 0.001, 0, 0.0006, 0.0182); dg.rotateY(ry); dg.translate(x, 0, z);
        doors.push([dg, [1, 1, 1]]);
      }
      // 圆形木栅栏羊圈 (-0.43, 0.68)
      const nP = 18, cr = 0.032;
      for (let i = 0; i < nP; i++) {
        const a0 = i / nP * TAU, a1 = (i + 1) / nP * TAU, x0 = -0.43 + Math.cos(a0) * cr, z0 = 0.68 + Math.sin(a0) * cr, x1 = -0.43 + Math.cos(a1) * cr, z1 = 0.68 + Math.sin(a1) * cr;
        camp.push([cylAt(0.0007, 0.0008, 0.0075, x0, 0, z0, 5), 4, 0, 1, [0.42, 0.28, 0.14]]);
        if (i !== 9) for (const yy of [0.0028, 0.0058]) camp.push([strut([x0, yy, z0], [x1, yy, z1], 0.0007), 4, 0, 1, [0.46, 0.32, 0.16]]);
      }
      const cNode = new T.Group(); cNode.add(new T.Mesh(merge(camp), MAT[D]));
      const dm = new T.Mesh(mergeC(doors), doorM); dm.userData.noShadow = true; cNode.add(dm);
      addNode(D, cNode, 0, 0, 0.72, 0.02);
      // 顺风倾斜的袅袅炊烟（风向与地上草丛摆动一致：朝 +x, +z 缓缓飘散）
      plumes(D, [[-0.6, 0.023, 0.66], [-0.5, 0.023, 0.77]], { col: [1.18, 1.12, 1.02], size: 0.022, nPer: 22, h: 0.125, dx: 0.058, dz: 0.025, sp: 0.17, opacity: 0.46 });
      parked(D, [[-0.555, 0.635, 0.5, true], [-0.355, 0.015, 0, true]], { fill: 1, cols: [[0.85, 0.85, 0.82]], hazard: 1 });
    }
    // 防护林：沿公路两侧一溜钻天杨（给牧道留口）；厂区、中控楼旁几棵
    const tl = [];
    for (const [x, z] of along(hw.pts, 0.032, [0.045, -0.045])) if (inDisc(x, z, 0.95) && !(Math.abs(x - 0.15) < 0.17 && z > 0.55) && Math.abs(x) > 0.03 && Math.abs(x + 0.22) > 0.02 && Math.abs(x + 0.60) > 0.028) tl.push([x, z, 1, 1]);
    for (const [x, z] of [[0.12, 0.08], [-0.1, 0.1], [0.1, -0.1], [-0.1, -0.1], [0.66, 0.2], [0.66, 0.3], [0.3, 0.12]]) tl.push([x, z, 0, 1]);
    forest(D, tl, 0.55);
    lamps(D, [[0.03, 0.6], [0.27, 0.6], [0.31, 0.16], [0.61, 0.16], [0.09, 0.09], [-0.09, -0.09]]);
    birds(D, 0.48, 0.68, 0.15, 0.12, 5);
    // 公路上的卡车、小车；巡检皮卡绕风机跑
    const hl = lanesOf(hw);
    traffic(D, hl.map(l => ({ ...l, n: 2, o0: 0 })), { kind: TRUCK, cols: [[0.65, 0.12, 0.08], [0.12, 0.25, 0.5], [0.85, 0.85, 0.82]] });
    traffic(D, hl.map(l => ({ ...l, n: 4, o0: 0.125 }) ), {});
    traffic(D, lanesOf({ ...tLoop, w: 0.018, lanes: 1, speed: 0.03, n: 1 }).slice(0, 1), { cols: [[0.85, 0.85, 0.82]] });
    // 牲畜：羊群（带低头吃草起伏与绕圈看护的牧羊犬）、马群、黑牛、真正面向海子低头饮水的马；光伏橙衣巡检员与牧民
    const SHEEP = mergeC([[new T.SphereGeometry(0.0042, 8, 6).scale(1.3, 0.75, 0.82).translate(0, 0.0048, 0), [1, 1, 1]], [new T.SphereGeometry(0.0018, 6, 5).translate(0.0058, 0.0044, 0), [0.1, 0.09, 0.08]],
      ...[[-0.003, -0.002], [-0.003, 0.002], [0.003, -0.002], [0.003, 0.002]].map(([lx, lz]) => [new T.BoxGeometry(0.0008, 0.0026, 0.0008).translate(lx, 0.0013, lz), [0.08, 0.07, 0.06]])]);
    const herd = (cx, cz, rx, rz, n, col, scale, speed, spread, hasDog = false) => {
      const tot = n + (hasDog ? 1 : 0), mesh = inst(SHEEP, matteM, tot, true), list = [];
      for (let i = 0; i < n; i++) { const a = rnd() * TAU, r = Math.sqrt(rnd()) * spread; list.push({ ox: Math.cos(a) * r, oz: Math.sin(a) * r * 0.7, ph: rnd() * 50 }); mesh.setColorAt(i, _c.setRGB(...col.map(v => v * (0.85 + rnd() * 0.25)))); }
      if (hasDog) mesh.setColorAt(n, _c.setRGB(0.10, 0.08, 0.06));
      const node = new T.Group(); node.add(mesh); addNode(D, node, 0, 0, 0.8, 0.02);
      animate(D, (t, v) => {
        if (v < 0.02) return;
        const u = t * speed, hx = cx + Math.cos(u) * rx, hz = cz + Math.sin(u) * rz, dirA = Math.atan2(Math.cos(u) * rz, -Math.sin(u) * rx);
        for (let i = 0; i < n; i++) { const s = list[i], w = Math.sin(t * 0.35 + s.ph), graze = 0.88 + 0.12 * smooth(-0.2, 0.5, Math.sin(t * 0.9 + s.ph));
          setI(mesh, i, hx + s.ox + Math.sin(t * 0.21 + s.ph) * 0.008, 0, hz + s.oz + Math.cos(t * 0.17 + s.ph) * 0.006, -(dirA + w * 1.15), scale, scale * graze); }
        if (hasDog) {
          const da = t * 0.55, dx = hx + Math.cos(da) * (spread + 0.018), dz = hz + Math.sin(da) * (spread * 0.75 + 0.014);
          setI(mesh, n, dx, Math.abs(Math.sin(t * 11)) * 0.0008, dz, -Math.atan2(Math.cos(da) * 0.75, -Math.sin(da)), 0.78);
        }
        mesh.instanceMatrix.needsUpdate = true;
      });
    };
    herd(-0.26, 0.73, 0.08, 0.04, 46, [0.78, 0.75, 0.68], 1, 0.026, 0.07, true);
    herd(-0.43, 0.68, 0.003, 0.003, 7, [0.80, 0.77, 0.70], 0.92, 0.02, 0.02);              // 羊圈里的几只小羊
    herd(0.15, -0.28, 0.07, 0.03, 9, [0.28, 0.16, 0.09], 1.8, 0.025, 0.05);
    herd(0.06, -0.56, 0.12, 0.03, 30, [0.8, 0.77, 0.7], 1, 0.02, 0.06);                    // 风机下的第二群羊
    herd(0.72, -0.04, 0.04, 0.05, 11, [0.06, 0.05, 0.045], 1.6, 0.02, 0.05);               // 黑牛
    // 海子水岸真正面向湖心低头饮水的 4 匹骏马（修长马身 + 俯首长颈）
    {
      const HORSE = mergeC([
        [new T.BoxGeometry(0.0115, 0.0044, 0.0038).translate(0, 0.0068, 0), [1, 1, 1]],
        [new T.BoxGeometry(0.0058, 0.0024, 0.0022).rotateZ(-0.55).translate(0.0068, 0.0060, 0), [1, 1, 1]],
        [new T.BoxGeometry(0.0036, 0.0020, 0.0020).rotateZ(-0.35).translate(0.0094, 0.0042, 0), [1, 1, 1]],
        ...[[-0.0042, -0.0013], [-0.0042, 0.0013], [0.0042, -0.0013], [0.0042, 0.0013]].map(([lx, lz]) => [new T.BoxGeometry(0.0010, 0.0052, 0.0010).translate(lx, 0.0026, lz), [0.12, 0.09, 0.07]]),
      ]);
      const horses = [[0.585, 0.665, [0.46, 0.28, 0.15]], [0.590, 0.684, [0.26, 0.15, 0.09]], [0.578, 0.703, [0.54, 0.36, 0.20]], [0.556, 0.719, [0.76, 0.74, 0.68]]];
      const hm = inst(HORSE, matteM, horses.length, true);
      horses.forEach(([, , c], i) => hm.setColorAt(i, _c.setRGB(...c)));
      const hNode = new T.Group(); hNode.add(hm); addNode(D, hNode, 0, 0, 0.8, 0.02);
      animate(D, (t, v) => {
        if (v < 0.02) return;
        horses.forEach(([hx, hz], i) => {
          const ang = Math.atan2(0.68 - hz, 0.48 - hx) + Math.sin(t * 0.5 + i * 2) * 0.06;
          setI(hm, i, hx, 0, hz, -ang, 1.05, 1.05 * (0.94 + 0.06 * Math.sin(t * 1.1 + i * 1.9)));
        });
        hm.instanceMatrix.needsUpdate = true;
      });
    }
    crowd(D, [{ x: -0.46, z: 0.66, a: 0.3, cols: [[0.58, 0.12, 0.08]] }, { x: -0.58, z: 0.685, a: -1.2, cols: [[0.12, 0.25, 0.58]] },
      { x: -0.375, z: 0.02, a: Math.PI, cols: [[0.92, 0.42, 0.06]] }, { x: -0.392, z: -0.01, a: -0.6, cols: [[0.92, 0.42, 0.06]] },   // 光伏区橙衣工程巡检员
      ...standLook(0.15, 0.70, 0.05, 3, 0.15, 0.66, 0), ...pairPath([[0.35, 0.34], [0.56, 0.34]], 2, 0.011, false, 0), ...wander(0, 0.1, 0.04, 3)],
      { cols: [[0.1, 0.22, 0.55], [0.75, 0.45, 0.1], [0.8, 0.8, 0.78]] });
    // 草丛（只撒在草地上，随风摆）
    {
      const blade = (a, tilt, h) => { const g = new T.ConeGeometry(0.0007, h, 3, 1, true); g.translate(0, h / 2, 0); g.rotateZ(tilt); g.rotateY(a); return g; };
      const TUFT = mergeC([0, 2.1, 4.2].map((a, k) => [blade(a, 0.25 + k * 0.08, 0.0065 + k * 0.0012), [1, 1, 1]]));
      const grassM = matteM.clone(); grassM.side = T.DoubleSide;
      grassM.onBeforeCompile = sh => { sh.uniforms.uTime = U.time; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float sw = sin(uTime * 1.7 + ip.x * 9.0 + ip.y * 6.0) + 0.5 * sin(uTime * 2.9 + ip.x * 21.0);
          transformed.x += sw * 0.0011 * position.y / 0.007; transformed.z += sw * 0.0005 * position.y / 0.007;`); };
      grassM.customProgramCacheKey = () => 'grass';
      const want = TPX > 1024 ? 4200 : 2200, pts = [];
      for (let k = 0; pts.length < want && k < want * 6; k++) { const a = rnd() * TAU, r = Math.sqrt(rnd()) * 0.965, x = Math.cos(a) * r, z = Math.sin(a) * r; if (TER[D].sample(x, z)[1] > 0.9) pts.push([x, z]); }
      const mesh = inst(TUFT, grassM, pts.length);
      const GC = [[0.28, 0.32, 0.12], [0.34, 0.36, 0.14], [0.22, 0.28, 0.1], [0.4, 0.38, 0.16]];
      pts.forEach(([x, z], i) => { const s = 0.8 + rnd() * 0.6; setI(mesh, i, x, 0, z, 0, s, s * (0.8 + rnd() * 0.5)); mesh.setColorAt(i, _c.setRGB(...pickCol(GC))); });
      const node = new T.Group(); node.add(mesh); addNode(D, node, 0, 0, 0.5, 0.012);
    }
  }

  /* ── §12 光柱与浮尘 ─────────────────────────────────────
     主光（聚光灯）穿过薄雾的那道光柱：一个半透明圆锥，正对镜头的地方亮、边缘淡；在画布边缘淡出。浮尘默认关闭 */
  const beamRes = new T.Vector2(1, 1);
  {
    const tgt = new T.Vector3(0.05, -PH, 0), L = key.position.distanceTo(tgt), rad = Math.tan(key.angle) * L * 0.95;
    const g = new T.ConeGeometry(rad, L, 64, 1, true); g.translate(0, -L / 2, 0);
    const m = new T.ShaderMaterial({
      uniforms: { uTime: U.time, uRes: { value: beamRes } },
      vertexShader: `varying vec3 vN; varying vec3 vV; varying float vT; void main(){ vT = -position.y / ${L.toFixed(3)}; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uTime; uniform vec2 uRes; varying vec3 vN; varying vec3 vV; varying float vT;
        void main(){ float f = abs(dot(normalize(vN), normalize(vV))); float a = pow(f, 2.2) * smoothstep(0.3, 0.62, vT) * (1.0 - smoothstep(0.7, 1.0, vT));
          a *= 0.85 + 0.15 * sin(vT * 9.0 - uTime * 0.4);
          vec2 su = gl_FragCoord.xy / uRes; a *= smoothstep(0.0, 0.22, su.x) * smoothstep(0.0, 0.22, 1.0 - su.x) * smoothstep(0.0, 0.15, 1.0 - su.y);   // 光柱在画布边缘淡出
          gl_FragColor = vec4(vec3(1.0, 0.78, 0.55) * a * 0.035, 1.0); }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
    });
    const cone = new T.Mesh(g, m); cone.position.copy(key.position);
    cone.quaternion.setFromUnitVectors(new T.Vector3(0, -1, 0), tgt.clone().sub(key.position).normalize());
    scene.add(cone);
    const N = 260, pos = new Float32Array(N * 3), sd = Array.from({ length: N }, () => [rnd(), rnd(), rnd()]);
    const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pos, 3));
    const pm = new T.PointsMaterial({ color: new T.Color(1.2, 0.95, 0.7), size: 0.0036, transparent: true, opacity: 0.16, depthWrite: false, blending: T.AdditiveBlending });
    const dust = new T.Points(pg, pm); dust.visible = opts.dust !== false; scene.add(dust);
    const dir = tgt.clone().sub(key.position).normalize(), up = new T.Vector3(0, 1, 0), s1 = new T.Vector3().crossVectors(dir, up).normalize(), s2 = new T.Vector3().crossVectors(dir, s1);
    animate(-1, t => {
      for (let i = 0; i < N; i++) {
        const [a, b, c] = sd[i], f = 0.55 + 0.4 * ((a + t * 0.004) % 1), r = Math.tan(key.angle) * L * f * Math.sqrt(b) * 0.8, ang = c * 6.283 + t * 0.03;
        const p = key.position.clone().addScaledVector(dir, L * f).addScaledVector(s1, Math.cos(ang) * r).addScaledVector(s2, Math.sin(ang) * r);
        pos.set([p.x, p.y + Math.sin(t * 0.3 + a * 20) * 0.01, p.z], i * 3);
      }
      pg.attributes.position.needsUpdate = true;
    });
  }

  /* ══ §13 后期处理 ═══════════════════════════════════════
     场景先渲染到一张 HDR（半精度浮点、4 倍多重采样抗锯齿）缓冲，再依次：
       ao    环境光遮蔽：楼脚、墙角、树下压暗，物体“落地”（半分辨率 + 横竖两次模糊）
       down/up 泛光：逐级缩小 5 次再逐级放大叠加，车灯、窗灯、路灯周围出现柔和光晕
       dof   移轴景深：焦点在台面中心，前后边缘渐虚，像用微距镜头拍实物沙盘
       final 合成：色差 → 景深混合 → AO → 泛光 → 曝光 → ACES 色调映射 → 暗部偏冷亮部偏暖 → S 曲线 → sRGB → 四边羽化 → 胶片颗粒
     所有采样都过滤掉 NaN / 无穷大：个别显卡上一个坏像素会经泛光把整屏染黑 */
  // 全屏三角形：后期每一步都是“把一个着色器铺满整个画面画一遍”
  const quad = new T.Mesh(new T.BufferGeometry().setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)));
  quad.frustumCulled = false;
  const qScene = new T.Scene(); qScene.add(quad); const qCam = new T.Camera();
  const VS = 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const pass = (fs, uniforms) => new T.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
  let rtScene, rtAO, rtAO2, rtDof, mips = [], ups = [], W = 0, H = 0, msaa = 4;   // 各级渲染缓冲；W, H 当前像素尺寸
  const LOOK = new T.Vector3(0, 0.1, 0);     // 镜头看向的点（台面中心略高）
  // 系统开了“减少动态效果”：转台不摆动，切换时间减半
  const RM = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const P = {
    // 环境光遮蔽：用深度图还原每个像素的位置和法线，在周围 14 个点里找挡住它的东西
    ao: pass(/* glsl */`
      uniform sampler2D tDepth; uniform mat4 uPInv; uniform vec2 uRes; uniform float uRad; varying vec2 vUv;
      vec3 vp(vec2 uv){ float d = texture2D(tDepth, uv).x; vec4 p = uPInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
      void main(){
        float d0 = texture2D(tDepth, vUv).x; if (d0 >= 1.0) { gl_FragColor = vec4(1.0); return; }
        vec2 px = 1.0 / uRes; vec3 p = vp(vUv);
        vec3 a = vp(vUv + vec2(px.x, 0.0)), b = vp(vUv - vec2(px.x, 0.0)), c = vp(vUv + vec2(0.0, px.y)), e = vp(vUv - vec2(0.0, px.y));
        vec3 dx = abs(a.z - p.z) < abs(p.z - b.z) ? a - p : p - b, dy = abs(c.z - p.z) < abs(p.z - e.z) ? c - p : p - e;
        vec3 n = normalize(cross(dx, dy));
        float rs = 0.5 * uRad / (-p.z * uPInv[1][1]);
        float rot = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853, occ = 0.0;
        for (int i = 0; i < 14; i++) {
          float fi = (float(i) + 0.5) / 14.0, ang = rot + fi * 6.2831853 * 4.1, r = rs * sqrt(fi);
          vec2 o = vec2(cos(ang), sin(ang)) * r * vec2(uRes.y / uRes.x, 1.0);
          vec3 v = vp(vUv + o) - p; float l2 = dot(v, v);
          occ += max(dot(v, n) - 0.0008 * -p.z, 0.0) / (l2 + 0.00004) * smoothstep(uRad * uRad * 3.0, uRad * uRad * 0.5, l2);
        }
        float ao = clamp(1.0 - occ * uRad * 0.16, 0.0, 1.0);
        gl_FragColor = vec4(ao, 0.0, 0.0, 1.0); }`, { tDepth: { value: null }, uPInv: { value: new T.Matrix4() }, uRes: { value: new T.Vector2() }, uRad: { value: 0.05 } }),
    // 9 点高斯模糊（AO 用）
    blur: pass(/* glsl */`uniform sampler2D tA; uniform vec2 uD; varying vec2 vUv;
      void main(){ float s = texture2D(tA, vUv).r * 0.28, w = 0.28;
        for (int i = 1; i <= 4; i++) { float k = float(i), ww = exp(-k * k / 6.0); s += (texture2D(tA, vUv + uD * k).r + texture2D(tA, vUv - uD * k).r) * ww; w += 2.0 * ww; }
        gl_FragColor = vec4(s / w, 0.0, 0.0, 1.0); }`, { tA: { value: null }, uD: { value: new T.Vector2() } }),
    // 泛光缩小：4 点平均；第一级按亮度加权（Karis 平均），避免单个极亮像素闪烁
    down: pass(/* glsl */`uniform sampler2D tC; uniform vec2 uT; uniform float uKaris; varying vec2 vUv;
      vec3 S(vec2 o){ vec3 c = texture2D(tC, vUv + o * uT).rgb; return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : min(c, vec3(256.0)); }
      float kw(vec3 c){ return mix(1.0, 1.0 / (1.0 + max(c.r, max(c.g, c.b))), uKaris); }
      void main(){ vec3 a = S(vec2(-1, -1)), b = S(vec2(1, -1)), c = S(vec2(-1, 1)), d = S(vec2(1, 1));
        float wa = kw(a), wb = kw(b), wc = kw(c), wd = kw(d);
        gl_FragColor = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0); }`, { tC: { value: null }, uT: { value: new T.Vector2() }, uKaris: { value: 0 } }),
    // 泛光放大：3×3 帐篷滤波，叠加到上一级
    up: pass(/* glsl */`uniform sampler2D tC, tB; uniform vec2 uT; varying vec2 vUv;
      void main(){ vec3 s = 4.0 * texture2D(tC, vUv).rgb;
        s += 2.0 * (texture2D(tC, vUv + vec2(uT.x, 0)).rgb + texture2D(tC, vUv - vec2(uT.x, 0)).rgb + texture2D(tC, vUv + vec2(0, uT.y)).rgb + texture2D(tC, vUv - vec2(0, uT.y)).rgb);
        s += texture2D(tC, vUv + uT).rgb + texture2D(tC, vUv - uT).rgb + texture2D(tC, vUv + vec2(uT.x, -uT.y)).rgb + texture2D(tC, vUv + vec2(-uT.x, uT.y)).rgb;
        gl_FragColor = vec4(s / 16.0 + texture2D(tB, vUv).rgb, 1.0); }`, { tC: { value: null }, tB: { value: null }, uT: { value: new T.Vector2() } }),
    // 移轴景深：圆台中心对焦，前后沿和远处渐虚，像拍实物沙盘的微距镜头（半分辨率散景采样）
    dof: pass(/* glsl */`uniform sampler2D tC, tDepth; uniform float uNear, uFar, uFocus, uAp, uMax; uniform vec2 uPx; varying vec2 vUv;
      float lz(vec2 uv){ float d = texture2D(tDepth, uv).r * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - d * (uFar - uNear)); }
      vec3 S(vec2 uv){ vec3 c = texture2D(tC, uv).rgb; return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : min(c, vec3(64.0)); }
      void main(){
        float z0 = lz(vUv), c0 = min(abs(1.0 - uFocus / z0) * uAp, uMax);
        vec3 col = S(vUv); float tot = 1.0;
        for (int i = 0; i < 36; i++) {
          float fi = (float(i) + 0.5) / 36.0, r = sqrt(fi) * uMax, a = float(i) * 2.39996323;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uPx;
          float z = lz(uv), cs = min(abs(1.0 - uFocus / z) * uAp, uMax);
          if (z > z0) cs = min(cs, c0 * 2.0);                       // 背景不往清晰的前景上糊
          float m = smoothstep(r - 0.5, r + 0.5, cs);
          col += mix(col / tot, S(uv), m); tot += 1.0;
        }
        gl_FragColor = vec4(col / tot, 1.0); }`, { tC: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 40 }, uFocus: { value: 4 }, uAp: { value: 16 }, uMax: { value: 10 }, uPx: { value: new T.Vector2() } }),
    // 最终合成（见本节开头的步骤）。uExp 曝光、uBloom 泛光强度
    final: pass(/* glsl */`uniform sampler2D tC, tA, tB, tD, tDepth; uniform float uNear, uFar, uFocus, uAp, uDof; uniform float uBloom, uExp, uTime, uLevels; uniform vec2 uRes; varying vec2 vUv;
      vec3 rrt(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
      vec3 aces(vec3 c){                                    // ACES 拟合（Stephen Hill）
        mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
        mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
        return clamp(o * rrt(i * c), 0.0, 1.0); }
      vec3 srgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main(){
        vec2 q = vUv - 0.5; float r2 = dot(q * vec2(uRes.x / uRes.y, 1.0), q * vec2(uRes.x / uRes.y, 1.0)) / max(1.0, uRes.x / uRes.y);
        vec2 ca = q * dot(q, q) * 0.006;
        vec3 c = vec3(texture2D(tC, vUv - ca).r, texture2D(tC, vUv).g, texture2D(tC, vUv + ca).b);
        if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);                                        // 个别 GPU 的高光溢出，别让一个坏像素经泛光染黑全屏
        float zd = texture2D(tDepth, vUv).r * 2.0 - 1.0; zd = 2.0 * uNear * uFar / (uFar + uNear - zd * (uFar - uNear));
        c = mix(c, texture2D(tD, vUv).rgb, uDof * smoothstep(0.7, 2.2, abs(1.0 - uFocus / zd) * uAp));
        c *= mix(1.0, texture2D(tA, vUv).r, 0.95);
        vec3 b = texture2D(tB, vUv).rgb / uLevels;
        c = mix(c, b, uBloom) + b * uBloom * 0.6;
        c *= uExp;
        c = aces(c);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, 1.05);
        c *= mix(vec3(0.94, 0.98, 1.08), vec3(1.04, 1.0, 0.93), smoothstep(0.02, 0.5, l));          // 暗部偏冷、亮部偏暖（乘法，纯黑仍是纯黑）
        c = mix(c, c * c * (3.0 - 2.0 * c), 0.35);
        c = srgb(max(c, 0.0));
        float fx = smoothstep(0.0, 0.10, vUv.x) * smoothstep(0.0, 0.10, 1.0 - vUv.x), fy = smoothstep(0.0, 0.10, vUv.y) * smoothstep(0.0, 0.12, 1.0 - vUv.y);
        c *= fx * fy;                                                                              // 四边羽化进纯黑页面
        float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime * 7.13) * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
        c += (n - 0.5) * 0.016 * (0.12 + l) * fx * fy;
        gl_FragColor = vec4(c, 1.0); }`, { tC: { value: null }, tA: { value: null }, tB: { value: null }, uBloom: { value: 0.06 }, uExp: { value: 1.2 }, uTime: U.time, uRes: { value: new T.Vector2() }, uLevels: { value: 5 },
      tD: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 40 }, uFocus: { value: 4 }, uAp: { value: 16 }, uDof: { value: opts.dof === false ? 0 : 1 } }),
  };
  const run = (m, target) =>          // 用材质 m 画一遍全屏，输出到 target（null = 画布）
    { quad.material = m; renderer.setRenderTarget(target); renderer.render(qScene, qCam); };
  function targets(w, h) {              // 画布尺寸变了，重建所有缓冲
    if (w === W && h === H) return; W = w; H = h;
    [rtScene, rtAO, rtAO2, rtDof, ...mips, ...ups].forEach(t => t && t.dispose());
    const hf = { type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: false };
    const dt = new T.DepthTexture(w, h); dt.type = T.FloatType;
    rtScene = new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, samples: msaa, depthTexture: dt });
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    rtAO = new T.WebGLRenderTarget(hw, hh, hf); rtAO2 = new T.WebGLRenderTarget(hw, hh, hf); rtDof = new T.WebGLRenderTarget(hw, hh, hf);
    mips = []; ups = []; let bw = hw, bh = hh;
    for (let i = 0; i < 5; i++) { mips.push(new T.WebGLRenderTarget(bw, bh, hf)); ups.push(new T.WebGLRenderTarget(bw, bh, hf)); bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1); }
    P.final.uniforms.uRes.value.set(w, h); P.final.uniforms.uLevels.value = mips.length;
  }
  function renderFrame() {             // 渲染一帧：场景 → AO → 泛光 → 景深 → 合成
    renderer.setRenderTarget(rtScene); renderer.render(scene, camera);
    // AO（半分辨率 + 双向模糊）
    P.ao.uniforms.tDepth.value = rtScene.depthTexture; P.ao.uniforms.uPInv.value.copy(camera.projectionMatrixInverse); P.ao.uniforms.uRes.value.set(rtAO.width, rtAO.height);
    run(P.ao, rtAO);
    P.blur.uniforms.tA.value = rtAO.texture; P.blur.uniforms.uD.value.set(1 / rtAO.width, 0); run(P.blur, rtAO2);
    P.blur.uniforms.tA.value = rtAO2.texture; P.blur.uniforms.uD.value.set(0, 1 / rtAO.height); run(P.blur, rtAO);
    // 泛光：逐级缩小（第一级压掉高光噪点）→ 逐级放大叠加
    let src = rtScene.texture, sw = W, sh = H;
    mips.forEach((m, i) => { P.down.uniforms.tC.value = src; P.down.uniforms.uT.value.set(1 / sw, 1 / sh); P.down.uniforms.uKaris.value = i === 0 ? 1 : 0; run(P.down, m); src = m.texture; sw = m.width; sh = m.height; });
    let prev = mips[mips.length - 1];
    for (let i = mips.length - 2; i >= 0; i--) { P.up.uniforms.tC.value = prev.texture; P.up.uniforms.tB.value = mips[i].texture; P.up.uniforms.uT.value.set(1 / prev.width, 1 / prev.height); run(P.up, ups[i]); prev = ups[i]; }
    // 景深：焦平面放在圆台中心略靠前；光圈随画面高度缩放，手机和桌面虚化程度一致
    const F = P.final.uniforms, Dd = P.dof.uniforms, focus = camera.position.distanceTo(LOOK) - 0.08, ap = 16 * H / 900;
    if (F.uDof.value > 0) {
      Dd.tC.value = rtScene.texture; Dd.tDepth.value = rtScene.depthTexture; Dd.uFocus.value = focus; Dd.uAp.value = ap; Dd.uMax.value = Math.max(4, 10 * H / 900);
      Dd.uNear.value = camera.near; Dd.uFar.value = camera.far; Dd.uPx.value.set(1 / W, 1 / H);
      run(P.dof, rtDof);
    }
    F.tD.value = rtDof.texture; F.tDepth.value = rtScene.depthTexture; F.uFocus.value = focus; F.uAp.value = ap; F.uNear.value = camera.near; F.uFar.value = camera.far;
    P.final.uniforms.tC.value = rtScene.texture; P.final.uniforms.tA.value = rtAO.texture; P.final.uniforms.tB.value = prev.texture;
    run(P.final, null);
  }

  /* ── §14 画布尺寸、镜头距离、自适应画质 ─────────────────────
     - 渲染像素数封顶 220 万（约 2K），高分屏不会把显卡拖垮
     - 镜头距离按画面宽高比算：保证整个台座横向放得下（竖屏手机上镜头会拉远）
     - 竖屏时地面光斑收紧，画布边缘不露出亮边
     - quality：§16 里如果连续 40 帧平均超过 24ms，就把分辨率降 18%；很流畅时再慢慢升回去 */
  let cssW = 0, cssH = 0, quality = 1;
  const camBase = { dist: 4, el: 0.56 };   // 镜头距离、俯角（弧度，0.56 ≈ 32°）
  function resize() {
    cssW = canvas.clientWidth; cssH = canvas.clientHeight; if (!cssW || !cssH) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
    const maxPx = 2.2e6, k = Math.min(1, Math.sqrt(maxPx / (cssW * cssH * dpr * dpr)));
    const pw = Math.round(cssW * dpr * k), ph = Math.round(cssH * dpr * k);
    renderer.setPixelRatio(1); renderer.setSize(pw, ph, false); beamRes.set(pw, ph);
    camera.aspect = cssW / cssH;
    const hf = 2 * Math.atan(Math.tan(T.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
    camBase.dist = Math.max(3.8, 1.38 / Math.tan(hf / 2));
    floorFO.value = camera.aspect < 1 ? 1.42 : camera.aspect < 1.4 ? 1.9 : 2.3;
    camera.updateProjectionMatrix();
    targets(pw, ph);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();
  let px = 0, py = 0, sx = 0, sy = 0;
  // 鼠标位置（-1 ~ 1），镜头会跟着轻微偏转
  addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); px = clamp((e.clientX - r.left) / r.width * 2 - 1, -1.5, 1.5); py = clamp((e.clientY - r.top) / r.height * 2 - 1, -1.5, 1.5); }, { passive: true });

  /* ── §15 切换状态机 ──────────────────────────────────────
     s 是一个连续的数：0 = 完全是城市，1 = 完全是政务，1.5 = 正切到一半……goTo(i) 让 s 用时间动画走到 i。
     vis(d) = 领域 d 的可见度：s 离 d 越近越接近 1，差 0.58 以上就是 0。
     每个物体的升起高度 h = 按它自己的 delay 错开的 vis：delay 小的先升起、后沉下。
     地面：s 在 a 和 a+1 之间时，台面上同时有 a、b 两张地貌，扫开进度 wipe 在 s 的小数部分 0.3~0.72 之间走完，
     土层在扫开的最后 14% 从上往下换。
     时间线（以城市 → 政务为例）：城市的楼依次沉下 → 蓝色扫光从圆心扫到边缘、地面换成政务 → 政务的楼依次升起 → 窗户亮灯 */
  let s = -0.6, from = s, to = s, t0 = 0, dur = 1;    // 初始 -0.6：什么都没升起，第一次可见时自动 goTo(start)
  const vis = d => 1 - smooth(0.04, 0.58, Math.abs(s - d));
  function goTo(i, duration) {
    i = clamp(Math.round(i), 0, DOMAINS.length - 1);
    if (i === to) return;
    from = s; to = i; t0 = performance.now(); dur = duration ?? (opts.duration ?? 1.6) * Math.sqrt(Math.max(1, Math.abs(to - from))) * (RM ? 0.5 : 1);
  }
  function update(now) {
    if (s !== to) { const f = clamp((now - t0) / (dur * 1000), 0, 1); s = from + (to - from) * easeIO(f); if (f >= 1) s = to; }
    const v = DOMAINS.map((_, d) => vis(d));
    for (const o of objs) {
      const h = easeIO(clamp((v[o.d] - o.delay * 0.45) / 0.55, 0, 1));
      if (h === o.h) continue; o.h = h;
      o.mesh.visible = h > 0.001;
      o.mesh.position.y = -(1 - h) * o.hgt;
    }
    groups.forEach((g, d) => { g.visible = v[d] > 0.001; litU[d].value = smooth(0.52, 0.98, v[d]); });   // 升起后半段窗户逐扇错落点亮
    // 地貌：相邻两个领域的地面图，中途从圆心扫开；扫光用要去的那个领域的颜色
    const a = clamp(Math.floor(s), 0, 4), b = clamp(a + 1, 0, 4), f = clamp(s - a, 0, 1), wipe = a === b ? 0 : smooth(0.3, 0.72, f);
    terrU.tCA.value = TER[a].tc; terrU.tMA.value = TER[a].tm; terrU.tCB.value = TER[b].tc; terrU.tMB.value = TER[b].tm;
    terrU.uWipe.value = wipe * 1.06; terrU.uSeamOn.value = Math.sin(Math.PI * wipe);
    terrU.uSeam.value.setRGB(...DOMAINS[to >= s ? b : a].accent);
    terrU.uLA.value = litU[a].value; terrU.uLB.value = litU[b].value;
    sideU.uDA.value = a; sideU.uDB.value = b; sideU.uK.value = clamp((wipe - 0.86) / 0.14, 0, 1) * 1.08;
    return v;
  }

  /* ── §16 每帧循环与对外接口 ─────────────────────────────────
     只在画布出现在屏幕上时才渲染（IntersectionObserver），滚出屏幕就停，省电。
     dbg 只给自动截图测试用（固定镜头、放大、关掉自适应画质），正常使用不需要管它。 */
  let visible = false, raf = 0, last = 0, acc = 0, n = 0, started = false;
  const dbg = { zoom: 1, look: [0, 0, 0], spin: null, el: null, fixQ: false };
  const clock0 = performance.now();
  function frame(now) {
    raf = visible ? requestAnimationFrame(frame) : 0;
    const t = (now - clock0) / 1000; U.time.value = t;
    const v = update(now);
    anim.forEach(f => f(t, f.d < 0 ? 1 : v[f.d]));
    // 转台轻轻来回摆（约 ±18°，一个来回 90 秒），镜头随鼠标微动
    turntable.rotation.y = dbg.spin != null ? dbg.spin : RM ? -0.12 : Math.sin(t * 0.07) * 0.32 - 0.12;
    sx += (px - sx) * 0.04; sy += (py - sy) * 0.04;
    const yaw = sx * 0.1, el = camBase.el - sy * 0.04;
    const cd = camBase.dist / dbg.zoom, ee = dbg.el ?? el;
    camera.position.set(Math.sin(yaw) * Math.cos(ee) * cd + dbg.look[0], Math.sin(ee) * cd + 0.02 + dbg.look[1], Math.cos(yaw) * Math.cos(ee) * cd + dbg.look[2]);
    LOOK.set(dbg.look[0], 0.1 + dbg.look[1], dbg.look[2]);
    camera.lookAt(LOOK);
    renderFrame();
    if (last && !dbg.fixQ) { acc += now - last; if (++n === 40) { const avg = acc / n; acc = 0; n = 0;
      if (avg > 24 && quality > 0.55) { quality *= 0.82; resize(); } else if (avg < 13 && quality < 1) { quality = Math.min(1, quality * 1.1); resize(); } } }
    last = now;
  }
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) { last = 0; raf = requestAnimationFrame(frame); }
    if (visible && !started) { started = true; if (to < 0 || s < 0) { to = -1; goTo(opts.start ?? 0); } }
  }, { rootMargin: '10% 0px' }).observe(canvas);

  // 对外接口：goTo(i) 切换领域；state 当前连续状态；renderer 给外部做截图等用；
  //          _hold(v) 把状态定格在 v（测试用，比如 1.5 = 切换到一半）；_dbg 测试用镜头参数
  return { goTo, get state() { return s; }, renderer, domains: DOMAINS.map(d => d.name), _hold(v) { s = from = to = v; }, _dbg: dbg };
}
