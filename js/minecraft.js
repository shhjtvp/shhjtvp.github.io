// js/minecraft.js
// 支持多材质包：<mc-block src="packname"> 加载 mc_textures/packname.zip
// 默认材质包：mini-26.2（精简包，仅含站点用到的资源，约 31 KB）
// 兜底材质包：26.2-Fabric 0.19.3（完整包，精简包里没收录的方块会自动到这里取）
// 保留 HTTP 回退，模型加载失败时自动尝试 item/ 路径
//
// ============ 2026-08 修复说明：为什么线上所有方块都变成“材质缺失” ============
// 原因链：
//   1) JSZip 只从 cdnjs 这一个 CDN 引入。该 CDN 一旦不可达，window.JSZip 为 undefined；
//   2) ZIP 分支整体抛错 → packCache.loaded = false；
//   3) 代码于是走 HTTP 回退，去请求 /mc_textures/<包名>/assets/minecraft/... ——
//      但仓库里只有 .zip，没有解包目录，该路径必然 404；
//   4) 模型拿不到 elements → buildBlockScene 返回 null → 画紫黑棋盘格（“材质缺失”）。
// 现在改为：three.js / JSZip 一律【本地优先】(js/vendor/)，本地缺失才回退 CDN 链，
// 并且路径基准改用 import.meta.url 推导，不再写死根路径。

// ---------- 路径基准（不写死 '/mc_textures/'，兼容子路径部署） ----------
const SITE_JS_DIR = new URL('./', import.meta.url);
const ZIP_BASE_PATH = new URL('../mc_textures/', SITE_JS_DIR).href;

// ---------- three.js：本地优先 + CDN 兜底 ----------
const THREE_SOURCES = [
    new URL('./vendor/three.module.js', SITE_JS_DIR).href,
    'https://unpkg.com/three@0.160.0/build/three.module.js',
    'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
];

async function importThree() {
    const failures = [];
    for (const url of THREE_SOURCES) {
        try {
            const mod = await import(url);
            if (url.includes('/vendor/')) {
                console.log('✅ three.js 使用本地副本 (js/vendor/three.module.js)');
            } else {
                console.warn(`⚠️ three.js 本地副本不可用，已回退到 CDN：${url}`);
            }
            return mod;
        } catch (err) {
            failures.push(`  - ${url} → ${err.message}`);
        }
    }
    throw new Error('three.js 所有来源均加载失败：\n' + failures.join('\n'));
}

// ---------- JSZip：本地优先 + CDN 兜底 ----------
const JSZIP_SOURCES = [
    new URL('./vendor/jszip.min.js', SITE_JS_DIR).href,
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
];

function injectScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`脚本加载失败 ${url}`));
        document.head.appendChild(s);
    });
}

let jsZipPromise = null;
function getJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);   // 页面里已有 <script> 版本
    if (jsZipPromise) return jsZipPromise;
    jsZipPromise = (async () => {
        const failures = [];
        for (const url of JSZIP_SOURCES) {
            try {
                await injectScript(url);
                if (window.JSZip) return window.JSZip;
                failures.push(`  - ${url} → 加载成功但未定义 window.JSZip`);
            } catch (err) {
                failures.push(`  - ${url} → ${err.message}`);
            }
        }
        console.error('[mc-block] JSZip 所有来源均加载失败：\n' + failures.join('\n'));
        return null;
    })();
    return jsZipPromise;
}

// ---------- 全局依赖（three 失败时不阻断元素注册，改为页面内可见报错） ----------
let THREE = null;
let threeLoadError = null;
try {
    THREE = await importThree();
} catch (err) {
    threeLoadError = err;
    console.error('[mc-block] three.js 加载失败，方块将显示为错误占位：', err);
}

// ---------- 常量 ----------
// 默认用精简包（tools/build-mini-pack.mjs 生成，仅含站点实际用到的资源，约 31 KB），
// 完整材质包留作兜底：精简包里找不到的方块会自动去完整包里取。
const DEFAULT_PACK = 'mini-26.2';
const FALLBACK_PACK = '26.2-Fabric 0.19.3';
const PACK_MAX_ATTEMPTS = 3;   // zip 下载/解析失败时的重试次数

// 剪影贴图的二值裁剪阈值（MC 本身就是二值 alpha）
const ALPHA_TEST = 0.5;

// ---------- 光照 ----------
// three r155 之后是物理光照单位，Lambert 出射亮度 ≈ 入射辐照度/π，
// 所以「想要的亮度」要乘 π 才是 intensity。
// 老代码只有一个平行光、没有环境光：背光面直接是纯黑，
// 实测整块方块有 35%~42% 的像素亮度接近 0（中位亮度只有 0.11）。
// 现在：环境光托底 + 主光给方向感 + 补光抬一点背光面，
// 六个面的亮度大致落在 0.55 ~ 0.94，既不发黑也保留体积感。
const LIGHT_AMBIENT = 0.55 * Math.PI;
const LIGHT_KEY = 0.36 * Math.PI;
const LIGHT_FILL = 0.18 * Math.PI;

// ---------- 材质包缓存 ----------
const packCache = new Map(); // 键: packName, 值: { zipFile, loaded, promise }

function getPackCache(packName) {
    if (!packCache.has(packName)) {
        packCache.set(packName, {
            zipFile: null,
            loaded: false,
            promise: null,
            lastError: null,
            bytes: 0,
        });
    }
    return packCache.get(packName);
}

// 下载 + 解压一个材质包。下载被中断时 blob 会是 0 字节或短一截，
// JSZip 只会抛出难懂的 "Corrupted zip ?"，这里提前给出明确原因。
async function fetchPack(JSZip, packName) {
    const zipUrl = `${ZIP_BASE_PATH}${encodeURIComponent(packName)}.zip`;
    const response = await fetch(zipUrl, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`材质包请求失败 HTTP ${response.status}：${zipUrl}`);
    }
    const declared = Number(response.headers.get('content-length') || 0);
    const blob = await response.blob();
    if (blob.size === 0) {
        throw new Error(`材质包下载为空（0 字节），连接可能被中断：${zipUrl}`);
    }
    if (declared && blob.size !== declared) {
        throw new Error(`材质包下载不完整：${blob.size}/${declared} 字节`);
    }
    const zip = await JSZip.loadAsync(blob);
    return { zip, bytes: blob.size };
}

async function loadPack(packName) {
    const cache = getPackCache(packName);
    if (cache.loaded) return;
    if (cache.promise) return cache.promise;

    cache.promise = (async () => {
        try {
            const JSZip = await getJSZip();
            if (!JSZip) {
                throw new Error('JSZip 不可用：本地 js/vendor/jszip.min.js 与备用 CDN 均加载失败');
            }

            let lastErr = null;
            for (let attempt = 1; attempt <= PACK_MAX_ATTEMPTS; attempt++) {
                try {
                    const { zip, bytes } = await fetchPack(JSZip, packName);
                    cache.zipFile = zip;
                    cache.loaded = true;
                    cache.lastError = null;
                    cache.bytes = bytes;
                    console.log(`✅ 材质包 "${packName}" 加载成功：${Object.keys(zip.files).length} 个文件 / ${(bytes / 1024).toFixed(1)} KB`);
                    return;
                } catch (err) {
                    lastErr = err;
                    if (attempt < PACK_MAX_ATTEMPTS) {
                        console.warn(`⚠️ 材质包 "${packName}" 第 ${attempt} 次加载失败，准备重试：${err.message}`);
                        await new Promise(r => setTimeout(r, 400 * attempt));
                    }
                }
            }
            throw lastErr;
        } catch (err) {
            console.error(`❌ 材质包 "${packName}" 加载失败，将回退到 HTTP 加载`, err);
            cache.loaded = false;
            cache.zipFile = null;
            cache.lastError = err.message;
        } finally {
            cache.promise = null;
        }
    })();

    return cache.promise;
}

async function readFromPack(packName, path, type = 'string') {
    const cache = getPackCache(packName);
    if (!cache.loaded || !cache.zipFile) {
        throw new Error(`材质包 "${packName}" 未加载或加载失败`);
    }
    // 1. 直接尝试原路径
    let file = cache.zipFile.file(path);
    if (file) return file.async(type);

    // 2. 尝试常见顶层目录（去掉可能的 packName 前缀）
    const possiblePrefixes = [
        '', // 已经尝试过
        `${packName}/`,
        `${packName.replace(/ /g, '_')}/`, // 有时空格被替换
    ];
    for (const prefix of possiblePrefixes) {
        if (prefix && path.startsWith(prefix)) continue; // 避免重复
        const altPath = prefix + path;
        file = cache.zipFile.file(altPath);
        if (file) return file.async(type);
    }
    // 3. 如果还找不到，遍历所有文件路径，查找以 'assets/minecraft/models/' 结尾的匹配
    //    这是一种 fallback，性能稍差，但可靠
    const allFiles = Object.keys(cache.zipFile.files);
    const matchingPath = allFiles.find(f => f.endsWith(path));
    if (matchingPath) {
        file = cache.zipFile.file(matchingPath);
        if (file) return file.async(type);
    }

    throw new Error(`材质包 "${packName}" 中找不到文件: ${path}`);
}

// ---------- 工具函数 ----------
// 仅在真的把材质包解包到 mc_textures/<包名>/ 时才可用；
// 仓库里默认只放 zip，所以这条回退路径基本只作为“理论上存在”的兜底。
function getAssetsRoot(packName) {
    return `${ZIP_BASE_PATH}${encodeURIComponent(packName)}/assets/minecraft`;
}

function getModelUrl(packName, modelPath) {
    let path = modelPath;
    if (path.startsWith('minecraft:')) path = path.slice(10);
    return `${getAssetsRoot(packName)}/models/${encodeURI(path)}.json`;
}

function getTextureUrl(packName, textureRef) {
    let path = textureRef;
    if (path.startsWith('minecraft:')) path = path.slice(10);
    return `${getAssetsRoot(packName)}/textures/${encodeURI(path)}.png`;
}

const deg = Math.PI / 180;

// ---------- 缓存 ----------
const modelCache = new Map();   // key: "packName|blockId" -> Promise<object>
const textureCache = new Map(); // key: "packName|path|tint" -> Promise<THREE.Texture>
const colormapCache = new Map(); // key: "packName|type" -> Promise<{r,g,b}>

function createErrorTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FF00FF';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 8);
    return new THREE.CanvasTexture(canvas);
}
const ERROR_TEXTURE = THREE ? createErrorTexture() : null;

// ---------- 颜色图 ----------
async function loadColormap(packName, type) {
    const cacheKey = `${packName}|${type}`;
    if (colormapCache.has(cacheKey)) return colormapCache.get(cacheKey);

    const promise = (async () => {
        try {
            let img;
            const zipPath = `assets/minecraft/textures/colormap/${encodeURI(type)}.png`;
            const cache = getPackCache(packName);
            if (cache.loaded && cache.zipFile) {
                const blob = await readFromPack(packName, zipPath, 'blob');
                const url = URL.createObjectURL(blob);
                img = await loadImage(url);
                URL.revokeObjectURL(url);
            } else {
                const url = `${getAssetsRoot(packName)}/textures/colormap/${encodeURI(type)}.png`;
                img = await loadImage(url);
            }
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const cx = Math.floor(img.width / 2);
            const cy = Math.floor(img.height / 2);
            const pixel = ctx.getImageData(cx, cy, 1, 1).data;
            return { r: pixel[0] / 255, g: pixel[1] / 255, b: pixel[2] / 255 };
        } catch (err) {
            console.warn(`无法加载颜色图 ${type} (材质包 ${packName})，使用默认颜色`, err);
            if (type === 'grass') return { r: 0.569, g: 0.741, b: 0.349 };
            if (type === 'foliage') return { r: 0.467, g: 0.671, b: 0.184 };
            return { r: 1, g: 1, b: 1 };
        }
    })();

    colormapCache.set(cacheKey, promise);
    return promise;
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

// 染色只看模型里的 tintindex（MC 就是这么定的），不再按纹理路径猜。
// 老代码用路径猜，grass_block_side 因为路径里含 "grass_block" 被整张染绿，
// 结果连属性是泥土的那半张也被染绿了。
function pickTintType(blockId, textureRef) {
    const s = `${blockId} ${textureRef}`.toLowerCase();
    if (s.includes('leaves') || s.includes('leaf')) return 'foliage';
    return 'grass';
}

// ---------- 动画纹理 ----------
// MC 的动画纹理是「竖着摞起来的长条」（例：16x128 = 8 帧），
// 同目录配一个 <纹理名>.png.mcmeta 描述帧间隔。
// 这里用 texture.repeat/offset 每次只采样其中一帧，靠 rAF 推进 offset ——
// 不需要重新上传纹理，开销可以忽略。
const ANIMATION_EPOCH = (typeof performance !== 'undefined' ? performance.now() : Date.now());
// texture -> 动画描述。用 Map 而不是 Set，方便元素重建/卸载时精确移除自己那几张贴图，
// 否则每次重新渲染都会克隆出新纹理、注册表只增不减（尺寸变化时会慢慢涨）。
const animatedTextures = new Map();

function registerAnimatedTexture(texture, anim) {
    if (!texture || !anim) return;
    animatedTextures.set(texture, {
        frameCount: anim.frameCount,
        frames: anim.frames,
        frameTimeMs: anim.frameTimeMs,
    });
}

function unregisterAnimatedTexture(texture) {
    if (texture) animatedTextures.delete(texture);
}

// 按『绝对时间』算当前帧并写入 offset，所以重复调用是幂等的，
// 多个方块共用同一条纹理时也自动保持同步。
function tickAnimatedTextures(now) {
    const t = (typeof now === 'number' ? now : performance.now()) - ANIMATION_EPOCH;
    animatedTextures.forEach((entry, texture) => {
        const step = Math.floor(t / entry.frameTimeMs) % entry.frames.length;
        const offset = entry.frames[step] / entry.frameCount;
        if (texture.offset.y !== offset) texture.offset.y = offset;
    });
}

// 读 <纹理>.png.mcmeta。没有就返回 null，不抛错、不影响主流程。
async function loadAnimationMeta(packName, textureRef) {
    let path = textureRef;
    if (path.startsWith('minecraft:')) path = path.slice(10);
    const zipPath = `assets/minecraft/textures/${path}.png.mcmeta`;
    try {
        const cache = getPackCache(packName);
        let text = null;
        if (cache.loaded && cache.zipFile) {
            try {
                text = await readFromPack(packName, zipPath, 'string');
            } catch (e) {
                text = null;
            }
        }
        if (text === null) {
            // 只有材质包没走 ZIP 时才回退 HTTP。
            // ZIP 已加载却找不到文件 = 这张纹理本来就没有 mcmeta，
            // 再发一次 HTTP 只会白刷 404。
            if (cache.loaded && cache.zipFile) return null;
            const resp = await fetch(`${getAssetsRoot(packName)}/textures/${encodeURI(path)}.png.mcmeta`);
            if (!resp.ok) return null;
            text = await resp.text();
        }
        const anim = JSON.parse(text).animation;
        if (!anim) return null;
        const frames = Array.isArray(anim.frames)
            ? anim.frames.map((f) => (typeof f === 'number' ? f : f && f.index)).filter((n) => Number.isInteger(n))
            : null;
        return {
            frameTimeTicks: Number.isFinite(anim.frametime) ? Math.max(1, anim.frametime) : 1,
            frames: frames && frames.length ? frames : null,
            interpolate: !!anim.interpolate,
        };
    } catch (e) {
        return null;
    }
}

// ---------- 纹理加载 ----------
// 返回 { texture, anim }：anim 非空表示这是动画纹理，需要开渲染循环推进。
async function loadTexture(packName, textureRef, tintType = null) {
    let path = textureRef;
    if (path.startsWith('minecraft:')) path = path.slice(10);
    const zipPath = `assets/minecraft/textures/${path}.png`;
    const cacheKey = `${packName}|${zipPath}|tint:${tintType || 'none'}`;

    if (textureCache.has(cacheKey)) {
        const cached = await textureCache.get(cacheKey);
        if (!cached || !cached.texture) {
            return { texture: ERROR_TEXTURE ? ERROR_TEXTURE.clone() : null, anim: null };
        }
        const clone = cached.texture.clone();
        // clone 有独立的 offset，注册交给调用方（这样元素重建时能精确反注册）
        return { texture: clone, anim: cached.anim };
    }

    const promise = (async () => {
        let img;
        let blobUrl = null;
        try {
            const cache = getPackCache(packName);
            if (cache.loaded && cache.zipFile) {
                try {
                    const blob = await readFromPack(packName, zipPath, 'blob');
                    blobUrl = URL.createObjectURL(blob);
                    img = await loadImage(blobUrl);
                } catch (zipErr) {
                    console.warn(`ZIP 读取纹理失败 ${zipPath}，回退 HTTP`, zipErr);
                    img = await loadImage(getTextureUrl(packName, textureRef));
                }
            } else {
                img = await loadImage(getTextureUrl(packName, textureRef));
            }

            // 动画判定：长条高度是宽度的整数倍即为多帧（mcmeta 只负责帧间隔与帧序）
            const meta = await loadAnimationMeta(packName, textureRef);
            const frameCount = (img.height > img.width && img.height % img.width === 0)
                ? img.height / img.width
                : 1;
            let anim = null;
            if (frameCount > 1) {
                const all = Array.from({ length: frameCount }, (_, i) => i);
                const frames = ((meta && meta.frames) ? meta.frames : all).filter((i) => i >= 0 && i < frameCount);
                anim = {
                    frameCount,
                    frames: frames.length ? frames : all,
                    frameTimeMs: Math.max(20, ((meta && meta.frameTimeTicks) || 1) * 50),
                };
                if (meta && meta.interpolate) {
                    console.info(`[mc-block] ${textureRef}: mcmeta 要求帧间插值，已展开成 8 倍帧率播放`);
                }
            }

            // 这里【不再】把纹理裁成 16x16。
            // 老代码无条件取左上角 16x16：动画长条只剩第一帧（永远不动），
            // 非 16x16 的纹理还会被裁错区域导致贴图错位。
            let baseImage = img;

            // mcmeta 里 interpolate:true 表示相邻帧之间要平滑过渡。
            // 单张纹理没法同时采样两帧，所以加载时就把 N 帧插值放大成 N*STEPS 帧，
            // 再按帧播放，视觉上接近 MC 的效果。（篝火的 soul_campfire_log_lit 就是这种）
            if (anim && meta && meta.interpolate) {
                const steps = 8;
                const fh = img.width;                    // MC 约定：长条每帧高度 = 宽度
                const frameCanvas = document.createElement('canvas');
                frameCanvas.width = img.width;
                frameCanvas.height = fh;
                const fctx = frameCanvas.getContext('2d');
                const strip = document.createElement('canvas');
                strip.width = img.width;
                strip.height = fh * anim.frames.length * steps;
                const sctx = strip.getContext('2d');
                let outIndex = 0;
                for (let i = 0; i < anim.frames.length; i++) {
                    const cur = anim.frames[i];
                    const next = anim.frames[(i + 1) % anim.frames.length];
                    for (let s = 0; s < steps; s++) {
                        const t = s / steps;
                        fctx.clearRect(0, 0, img.width, fh);
                        fctx.globalAlpha = 1;
                        fctx.drawImage(img, 0, cur * fh, img.width, fh, 0, 0, img.width, fh);
                        fctx.globalAlpha = t;
                        fctx.drawImage(img, 0, next * fh, img.width, fh, 0, 0, img.width, fh);
                        fctx.globalAlpha = 1;
                        sctx.putImageData(fctx.getImageData(0, 0, img.width, fh), 0, outIndex * fh);
                        outIndex++;
                    }
                }
                baseImage = strip;
                anim = {
                    frameCount: outIndex,
                    frames: Array.from({ length: outIndex }, (_, i) => i),
                    frameTimeMs: Math.max(16, anim.frameTimeMs / steps),
                };
            }

            let source = baseImage;
            if (tintType) {
                const tint = await loadColormap(packName, tintType);
                const canvas = document.createElement('canvas');
                canvas.width = baseImage.width;
                canvas.height = baseImage.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(baseImage, 0, 0);
                const imageData = ctx.getImageData(0, 0, baseImage.width, baseImage.height);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = Math.min(255, data[i] * tint.r);
                    data[i + 1] = Math.min(255, data[i + 1] * tint.g);
                    data[i + 2] = Math.min(255, data[i + 2] * tint.b);
                }
                ctx.putImageData(imageData, 0, 0);
                source = canvas;
            }

            const texture = new THREE.CanvasTexture(source);
            // MC 的纹理 v 轴从上往下，而 three 默认 flipY=true 会在上传时把图上下翻转。
            // 两边各翻一次才对得上，很容易写成翻两次或都不翻 —— 那正是「贴图上下镜像」
            // 这类错位的来源。这里直接对齐 MC：flipY=false，UV 用 MC 原值。
            texture.flipY = false;
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.NearestFilter;
            texture.generateMipmaps = false;
            texture.colorSpace = THREE.SRGBColorSpace;
            if (anim) {
                texture.wrapS = THREE.ClampToEdgeWrapping;
                texture.wrapT = THREE.ClampToEdgeWrapping;
                texture.repeat.set(1, 1 / anim.frameCount);   // 只采样长条里的一帧
                texture.offset.set(0, 0);
            }
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            return { texture, anim };
        } catch (err) {
            console.warn(`纹理加载失败: ${textureRef} (材质包 ${packName})，使用错误纹理`, err);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            return { texture: ERROR_TEXTURE ? ERROR_TEXTURE.clone() : null, anim: null };
        }
    })();

    textureCache.set(cacheKey, promise);
    return promise;
}

// ---------- 模型加载（支持 block/ 和 item/ 回退） ----------
async function loadModel(packName, blockId) {
    if (!blockId.includes(':')) blockId = 'minecraft:' + blockId;
    const item = blockId.replace('minecraft:', '');
    const basePath = item.startsWith('block/') ? item : `block/${item}`;
    const cacheKey = `${packName}|${blockId}`;

    if (modelCache.has(cacheKey)) return modelCache.get(cacheKey);

    const promise = (async () => {
        // 尝试加载模型，若 block/ 失败则尝试 item/
        let jsonData = null;
        let usedPath = null;
        const attempts = [basePath, `item/${item}`]; // 注意 item/ 不带 "block/" 前缀
        for (const tryPath of attempts) {
            try {
                const zipPath = `assets/minecraft/models/${tryPath}.json`;
                const cache = getPackCache(packName);
                if (cache.loaded && cache.zipFile) {
                    const text = await readFromPack(packName, zipPath, 'string');
                    jsonData = JSON.parse(text);
                    usedPath = tryPath;
                    break;
                } else {
                    // HTTP 回退
                    const url = getModelUrl(packName, tryPath);
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    jsonData = await resp.json();
                    usedPath = tryPath;
                    break;
                }
            } catch (e) {
                // 继续尝试下一个路径
                continue;
            }
        }

        if (!jsonData) {
            console.warn(`模型加载失败: ${blockId} (材质包 ${packName})，所有路径尝试均失败，使用空模型`);
            return { textures: {}, elements: null, display: null };
        }

        // 递归解析父模型
        let textures = {};
        let elements = null;
        let display = null;

        if (jsonData.parent) {
            const parentData = await loadModel(packName, jsonData.parent);
            textures = { ...parentData.textures };
            elements = parentData.elements;
            display = parentData.display;
        }

        if (jsonData.textures) {
            Object.assign(textures, jsonData.textures);
        }
        if (jsonData.elements) {
            elements = jsonData.elements;
        }
        if (jsonData.display) {
            display = { ...display, ...jsonData.display };
        }

        return { textures, elements, display };
    })();

    modelCache.set(cacheKey, promise);
    return promise;
}

// ---------- 几何体生成 ----------
// 每个面：从方块外侧看过去，按「左上 → 右上 → 右下 → 左下」给出四个角。
//
// 推导方式（MC 的约定就是「从外侧看纹理不正像」）：
//   站在该面正前方看向方块，屏幕向右 = u 增大方向，屏幕向下 = v 增大方向。
// 例：north 面是站在北侧往南看，此时观察者的右手方向是世界 -x，所以 u 对应 -x；
//     south 面是站在南侧往北看，右手方向是 +x，所以 u 对应 +x。
// 六个面这样推下来满足同一条不变量：u × v = -外法线（自洽性检查）。
// 之前 north/south/west/east 的 u 方向写反了，表现就是这几个面的纹理左右镜像，
// 也就是「贴图错位」。
const FACE_CORNERS = {
    // u→+x, v→+z
    up:    (x1, y1, z1, x2, y2, z2) => [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]],
    // u→+x, v→-z
    down:  (x1, y1, z1, x2, y2, z2) => [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]],
    // u→-x, v→-y
    north: (x1, y1, z1, x2, y2, z2) => [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]],
    // u→+x, v→-y
    south: (x1, y1, z1, x2, y2, z2) => [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]],
    // u→+z, v→-y
    west:  (x1, y1, z1, x2, y2, z2) => [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]],
    // u→-z, v→-y
    east:  (x1, y1, z1, x2, y2, z2) => [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]],
};

// 模型没写 uv 时，MC 用「元素在该面两个方向上的尺寸」当 UV 矩形
function autoUV(faceDir, from, to) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    if (faceDir === 'up' || faceDir === 'down') return [0, 0, dx, dz];
    const u = (faceDir === 'east' || faceDir === 'west') ? dz : dx;
    return [0, 0, u, dy];
}

// elements[].rotation —— 老代码完全没实现。
// 灵魂篝火的火焰和蒲公英（cross 模型）都靠它把平面绕 Y 转 45°，
// 缺了它「X 形」会变成「十字形」，看着就是模型错位。
function elementMatrix(elem) {
    const r = elem && elem.rotation;
    if (!r) return null;
    const angleDeg = Number(r.angle || 0);
    if (!angleDeg) return null;
    const axis = String(r.axis || 'y').toLowerCase();
    const origin = Array.isArray(r.origin) ? r.origin : [8, 8, 8];
    const ox = origin[0] / 16;
    const oy = origin[1] / 16;
    const oz = origin[2] / 16;
    const rad = angleDeg * deg;

    const axisVec = axis === 'x' ? new THREE.Vector3(1, 0, 0)
        : axis === 'z' ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0);

    // 顺序：移到原点 → 缩放(rescale) → 旋转 → 移回
    const m = new THREE.Matrix4()
        .makeTranslation(ox, oy, oz)
        .multiply(new THREE.Matrix4().makeRotationAxis(axisVec, rad));

    if (r.rescale) {
        // MC 的 rescale：把垂直于旋转轴的两个方向按 1/max(|cos|,|sin|) 拉长，
        // 45° 时正好 √2，于是平面从一个角对角跨到另一个角（十字变 X 就是靠这个）
        const c = Math.abs(Math.cos(rad));
        const s = Math.abs(Math.sin(rad));
        const k = 1 / Math.max(c, s, 1e-6);
        m.multiply(new THREE.Matrix4().makeScale(
            axis === 'x' ? 1 : k,
            axis === 'y' ? 1 : k,
            axis === 'z' ? 1 : k
        ));
    }

    m.multiply(new THREE.Matrix4().makeTranslation(-ox, -oy, -oz));
    return m;
}

function createFaceGeometry(faceDir, from, to, uv, rotation) {
    const cornersOf = FACE_CORNERS[faceDir];
    if (!cornersOf) return null;
    if (!Array.isArray(from) || !Array.isArray(to) || from.length < 3 || to.length < 3) return null;

    const pos = cornersOf(
        from[0] / 16, from[1] / 16, from[2] / 16,
        to[0] / 16, to[1] / 16, to[2] / 16
    ).flat();

    // UV 矩形：MC 记法是 [左上u, 左上v, 右下u, 右下v]，
    // u1>u2 / v1>v2 表示该面纹理是镜像的，这里直接用原值即可。
    const rect = (Array.isArray(uv) && uv.length >= 4) ? uv : autoUV(faceDir, from, to);
    const cornerUV = [
        [rect[0] / 16, rect[1] / 16],   // 纹理左上
        [rect[2] / 16, rect[1] / 16],   // 纹理右上
        [rect[2] / 16, rect[3] / 16],   // 纹理右下
        [rect[0] / 16, rect[3] / 16],   // 纹理左下
    ];

    // faces[].rotation：把纹理在该面的 UV 矩形【内】顺时针转 0/90/180/270。
    // 老代码是绕整张纹理中心 (0.5,0.5) 旋转，那个做法和 MC 完全不是一回事，
    // 也是篝火/铁砧这类大量用 rotation 的模型贴图错位的主因。
    // 顺时针 90° 等价于「面的左上角取纹理左下角」，即角点整体错一位。
    const rot = (((Number(rotation) || 0) % 360) + 360) % 360;
    const shift = rot === 90 ? 1 : rot === 180 ? 2 : rot === 270 ? 3 : 0;
    const uvs = [];
    for (let i = 0; i < 4; i++) {
        const c = cornerUV[(i - shift + 4) % 4];
        uvs.push(c[0], c[1]);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    // 反向缠绕，使法线朝方块外侧（材质是 DoubleSide，可见性不受影响，
    // 但法线朝外时光照才是对的）
    geom.setIndex([0, 2, 1, 0, 3, 2]);
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.computeVertexNormals();
    return geom;
}

// ---------- 场景构建 ----------
async function buildBlockScene(packName, blockId) {
    await loadPack(packName);
    let modelData = await loadModel(packName, blockId);

    // 精简默认包里没有这个方块时，自动回退到完整材质包，
    // 这样往页面里加新方块不会因为精简包没收录而直接变成错误占位。
    if (!modelData.elements && packName !== FALLBACK_PACK) {
        console.info(`ℹ️ 精简包 "${packName}" 中没有 "${blockId}"，改用完整材质包 "${FALLBACK_PACK}"`);
        await loadPack(FALLBACK_PACK);
        const fallbackData = await loadModel(FALLBACK_PACK, blockId);
        if (fallbackData.elements) {
            modelData = fallbackData;
            packName = FALLBACK_PACK;   // 纹理也一并从完整包取
        }
    }

    if (!modelData.elements) {
        console.warn(`方块 ${blockId} (材质包 ${packName}) 没有 elements，显示错误占位`);
        return null;
    }

    const { textures, elements, display } = modelData;

    // 解析纹理变量
    const resolvedTextures = {};
    for (const [key, value] of Object.entries(textures)) {
        let resolved = value;
        let depth = 0;
        while (resolved.startsWith('#') && depth < 10) {
            const refKey = resolved.slice(1);
            if (textures[refKey]) {
                resolved = textures[refKey];
            } else {
                resolved = 'minecraft:block/missing';
                break;
            }
            depth++;
        }
        if (resolved.startsWith('#')) resolved = 'minecraft:block/missing';
        resolvedTextures[key] = resolved;
    }

    // 纹理按 (纹理引用 + 染色) 维度懒加载并复用；
    // 染色不再预先按变量算，而是逐面看 tintindex 决定。
    const texByRef = new Map();
    function getFaceTexture(ref, tintType) {
        const key = `${ref}|${tintType || 'none'}`;
        if (!texByRef.has(key)) texByRef.set(key, loadTexture(packName, ref, tintType));
        return texByRef.get(key);
    }

    let animated = false;
    const animatedUsed = new Set();   // 本次构建用到的动画纹理，交给元素负责反注册
    const group = new THREE.Group();

    for (const elem of elements) {
        const from = elem && elem.from;
        const to = elem && elem.to;
        if (!Array.isArray(from) || !Array.isArray(to)) continue;
        const faces = (elem && elem.faces) || {};
        // 元素级旋转（篝火火焰、蒲公英的 45° 平面都靠它）
        const elemMatrix = elementMatrix(elem);
        // shade:false —— 该元素不受方向光照影响（火焰、植物），MC 里就是全亮
        const unlit = elem.shade === false;

        for (const [faceDir, faceData] of Object.entries(faces)) {
            const texVar = faceData && faceData.texture;
            if (!texVar) continue;
            const texKey = texVar.startsWith('#') ? texVar.slice(1) : texVar;
            const ref = resolvedTextures[texKey];
            if (!ref) {
                console.warn(`纹理变量 ${texVar} 未定义，跳过该面`);
                continue;
            }

            const geom = createFaceGeometry(faceDir, from, to, faceData.uv, faceData.rotation);
            if (!geom) continue;
            if (elemMatrix) geom.applyMatrix4(elemMatrix);

            // tintindex 才是 MC 决定「这一面要不要染色」的依据
            const tintType = (faceData.tintindex === undefined) ? null : pickTintType(blockId, ref);
            const loaded = await getFaceTexture(ref, tintType);
            if (loaded.anim && loaded.texture) {
                animated = true;
                registerAnimatedTexture(loaded.texture, loaded.anim);
                animatedUsed.add(loaded.texture);
            }

            const params = {
                map: loaded.texture,
                // 剪影类贴图（树叶、植物、草方块覆盖层）用 alphaTest 做二值裁剪，
                // 比 transparent:true 正确得多：transparent 会走混合排序，
                // 容易出现半透明边和深度写入问题，画面发暗也是它引起的。
                transparent: false,
                alphaTest: ALPHA_TEST,
                side: THREE.DoubleSide,
            };
            const material = unlit
                ? new THREE.MeshBasicMaterial(params)      // 全亮，不参与光照
                : new THREE.MeshLambertMaterial(params);
            group.add(new THREE.Mesh(geom, material));
        }
    }

    // 居中
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -center.y, -center.z);

    const disp = (display && (display.gui || display.fixed)) || {
        rotation: [-30, -45, 0],
        translation: [0, 0, 0],
        scale: [0.625, 0.625, 0.625]
    };
    const [rx, ry, rz] = (disp.rotation || [0, 0, 0]);
    const [tx, ty, tz] = (disp.translation || [0, 0, 0]).map(v => v / 16);
    const [sx, sy, sz] = (disp.scale || [1, 1, 1]);
    group.rotation.set(rx * deg, ry * deg, rz * deg, 'XYZ');
    group.scale.set(sx, sy, sz);
    group.position.x += tx;
    group.position.y += ty;
    group.position.z += tz;

    const finalBox = new THREE.Box3().setFromObject(group);
    const finalCenter = finalBox.getCenter(new THREE.Vector3());
    group.position.sub(finalCenter);

    // animated=true 表示这个方块用了动画纹理，调用方需要开渲染循环推进帧；
    // animatedTextures 是本次构建注册的那些纹理实例，元素卸载/重建时要反注册。
    return { group, animated, animatedTextures: [...animatedUsed] };
}

// ---------- 自定义元素 <mc-block> ----------
class BlockElement extends HTMLElement {
    static observedAttributes = ['size', 'src'];

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._blockId = '';
        this._packName = DEFAULT_PACK;
        this._size = '36px';
        this._renderRequested = false;
        this._renderer = null;
        this._scene = null;
        this._camera = null;
        this._observer = null;
        this._rafId = null;       // 动画纹理的渲染循环
        this._io = null;          // 离屏暂停用的 IntersectionObserver
        this._paused = false;
        this._animationPending = false;
        this._animTextures = [];  // 本元素注册过的动画纹理实例
    }

    connectedCallback() {
        this._blockId = (this.textContent || '').trim();
        this._size = this.getAttribute('size') || '36px';
        this._packName = this.getAttribute('src') || DEFAULT_PACK;
        this.setupShadowDOM();
        loadPack(this._packName).then(() => this.requestRender());
    }

    attributeChangedCallback(name, oldVal, newVal) {
        if (name === 'size' && oldVal !== newVal) {
            this._size = newVal;
            this.updateSize();
            this.requestRender();
        } else if (name === 'src' && oldVal !== newVal) {
            this._packName = newVal || DEFAULT_PACK;
            // 清除该材质包的模型缓存，强制重新加载（因为可能换了资源）
            // 注意：我们不清除纹理缓存，但模型缓存会根据 packName+blockId 重新生成
            loadPack(this._packName).then(() => this.requestRender());
        }
    }

    disconnectedCallback() {
        this._stopAnimation();
        this._releaseAnimatedTextures();
        if (this._io) {
            this._io.disconnect();
            this._io = null;
        }
        if (this._observer) this._observer.disconnect();
        if (this._renderer) {
            this._renderer.dispose();
            this._renderer = null;
        }
        if (this._scene) {
            this._scene.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                    else obj.material.dispose();
                }
            });
            this._scene = null;
        }
    }

    // ---------- 动画纹理的渲染循环 ----------
    // 只有真的用到动画纹理的方块才会开；离屏 / 标签页隐藏时自动暂停。
    _startAnimation() {
        if (this._rafId !== null) return;
        const step = () => {
            this._rafId = requestAnimationFrame(step);
            if (this._paused || document.hidden) return;
            tickAnimatedTextures(performance.now());
            if (this._renderer && this._scene && this._camera) {
                this._renderer.render(this._scene, this._camera);
            }
        };
        this._rafId = requestAnimationFrame(step);

        if (!this._io && typeof IntersectionObserver !== 'undefined') {
            this._io = new IntersectionObserver((entries) => {
                this._paused = !(entries[0] && entries[0].isIntersecting);
            }, { threshold: 0 });
            this._io.observe(this);
        }
    }

    _stopAnimation() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    _releaseAnimatedTextures() {
        (this._animTextures || []).forEach(unregisterAnimatedTexture);
        this._animTextures = [];
    }

    setupShadowDOM() {
        this.shadowRoot.innerHTML = `
            <style>
                :host { display: inline-block; overflow: hidden; }
                canvas { display: block; width: 100%; height: 100%; }
            </style>
            <canvas></canvas>
        `;
        this._canvas = this.shadowRoot.querySelector('canvas');
        this.updateSize();

        if (this._observer) this._observer.disconnect();
        this._observer = new MutationObserver(() => {
            const newId = (this.textContent || '').trim();
            if (newId !== this._blockId) {
                this._blockId = newId;
                this.requestRender();
            }
        });
        this._observer.observe(this, { characterData: true, childList: true, subtree: true });
    }

    updateSize() {
        this.style.width = this._size;
        this.style.height = this._size;
        if (this._canvas) {
            this._canvas.style.width = this._size;
            this._canvas.style.height = this._size;
        }
    }

    requestRender() {
        if (this._renderRequested) return;
        this._renderRequested = true;
        requestAnimationFrame(() => this.render());
    }

    async render() {
        this._renderRequested = false;
        if (!this._blockId) return;

        // three.js 整体不可用时，给出可见的错误占位而不是静默空白
        if (!THREE) {
            const w = this.clientWidth || 36;
            const h = this.clientHeight || 36;
            this.showErrorBlock(w, h, 'three.js 加载失败：'
                + (threeLoadError ? threeLoadError.message : '未知原因'));
            return;
        }

        const width = this.clientWidth || 36;
        const height = this.clientHeight || 36;
        if (width === 0 || height === 0) {
            this._renderRequested = true;
            requestAnimationFrame(() => this.render());
            return;
        }

        // 清理旧资源
        this._stopAnimation();
        this._releaseAnimatedTextures();
        if (this._renderer) {
            this._renderer.dispose();
            this._renderer = null;
        }
        if (this._scene) {
            this._scene.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                    else obj.material.dispose();
                }
            });
            this._scene = null;
        }

        try {
            const built = await buildBlockScene(this._packName, this._blockId);
            if (!built || !built.group) {
                const packErr = getPackCache(this._packName).lastError;
                this.showErrorBlock(width, height, packErr
                    ? `材质包 "${this._packName}" 加载失败：${packErr}`
                    : `模型 "${this._blockId}" 缺少 elements（材质包 "${this._packName}"）`);
                return;
            }
            const { group, animated } = built;
            this._animTextures = built.animatedTextures || [];

            const scene = new THREE.Scene();
            scene.add(group);

            // 环境光托底，避免背光面纯黑；主光给体积感，补光抬一点背光面
            scene.add(new THREE.AmbientLight(0xffffff, LIGHT_AMBIENT));

            const keyLight = new THREE.DirectionalLight(0xffffff, LIGHT_KEY);
            keyLight.position.set(0.52, 1, 0.42);
            scene.add(keyLight);

            const fillLight = new THREE.DirectionalLight(0xffffff, LIGHT_FILL);
            fillLight.position.set(-0.6, 0.5, -0.7);
            scene.add(fillLight);

            const frustumSize = 1.8;
            const aspect = 1;
            const camera = new THREE.OrthographicCamera(
                -frustumSize / 2 * aspect,
                frustumSize / 2 * aspect,
                frustumSize / 2,
                -frustumSize / 2,
                0.1,
                10
            );
            camera.position.set(0, 0, 2);
            camera.lookAt(0, 0, 0);

            const renderer = new THREE.WebGLRenderer({
                antialias: true,
                alpha: true,
                canvas: this._canvas
            });
            renderer.setSize(width, height, false);
            renderer.setClearColor(0x000000, 0);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

            renderer.render(scene, camera);

            this._scene = scene;
            this._renderer = renderer;
            this._camera = camera;

            // 用了动画纹理就开渲染循环推进帧；否则保持一次性快照（省电）
            if (animated) {
                tickAnimatedTextures(performance.now());
                this._startAnimation();
            }

            // 成功标记：便于页面/自动化检查，也方便线上排障
            this.dataset.rendered = 'true';
            if (animated) this.dataset.animated = 'true';
            else delete this.dataset.animated;
            delete this.dataset.error;
            this.title = '';
        } catch (e) {
            console.error(`渲染方块 ${this._blockId} (材质包 ${this._packName}) 失败:`, e);
            this.showErrorBlock(width, height, '渲染异常：' + e.message);
        }
    }

    showErrorBlock(w, h, reason) {
        // 把失败原因挂到元素上：鼠标悬停即可看到，右键检查也能直接读到
        this.title = reason || '方块渲染失败';
        this.dataset.error = reason || 'unknown';
        delete this.dataset.rendered;
        const canvas = this._canvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = '#FF00FF';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w / 2, h / 2);
        ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
    }
}

if (!customElements.get('mc-block')) {
    customElements.define('mc-block', BlockElement);
}

// ---------- 线上排障入口 ----------
// 部署后在浏览器控制台执行 __mcBlockDiag()，可立刻看到依赖来源与材质包状态。
window.__mcBlockDiag = () => ({
    three: THREE ? `three r${THREE.REVISION || '?'}（已加载）`
                 : `加载失败：${threeLoadError ? threeLoadError.message : '未知'}`,
    jszip: window.JSZip ? '已加载' : '未加载（会走 CDN 兜底）',
    zipBasePath: ZIP_BASE_PATH,
    animatedTextures: [...animatedTextures.entries()].map(([texture, info]) => ({
        frames: info.frameCount,
        frameTimeMs: info.frameTimeMs,
        currentOffsetY: +texture.offset.y.toFixed(4),
    })),
    packs: [...packCache.entries()].map(([name, c]) => ({
        name,
        loaded: c.loaded,
        bytes: c.bytes,
        error: c.lastError,
    })),
});

// 内部函数也导出，方便自动化测试直接断言几何 / UV / 旋转是否正确
export { loadPack, loadModel, loadTexture, createFaceGeometry, elementMatrix, tickAnimatedTextures, DEFAULT_PACK };