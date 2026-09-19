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

function getTintType(texturePath) {
    const lower = texturePath.toLowerCase();
    if ((lower.includes('grass_block') && !lower.includes('snow')) ||
        lower.includes('grass_block_top') || lower.includes('grass_block_side')) {
        return 'grass';
    }
    if (lower.includes('leaves') || lower.includes('leaf')) {
        return 'foliage';
    }
    if (lower.includes('tall_grass') || lower.includes('fern') || lower.includes('vine')) {
        return 'grass';
    }
    return null;
}

// ---------- 纹理加载 ----------
async function loadTexture(packName, textureRef, tintType = null) {
    let path = textureRef;
    if (path.startsWith('minecraft:')) path = path.slice(10);
    const zipPath = `assets/minecraft/textures/${path}.png`;
    const cacheKey = `${packName}|${zipPath}|tint:${tintType || 'none'}`;

    if (textureCache.has(cacheKey)) {
        const tex = await textureCache.get(cacheKey);
        return tex.clone();
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
                    console.warn(`ZIP读取纹理失败 ${zipPath}，回退HTTP`, zipErr);
                    const url = getTextureUrl(packName, textureRef);
                    img = await loadImage(url);
                }
            } else {
                const url = getTextureUrl(packName, textureRef);
                img = await loadImage(url);
            }

            // ===== 新增：裁剪为 16x16 =====
            let imgSource = img;
            if (img.width !== 16 || img.height !== 16) {
                const canvas = document.createElement('canvas');
                canvas.width = 16;
                canvas.height = 16;
                const ctx = canvas.getContext('2d');
                // 取左上角 16x16 区域
                ctx.drawImage(img, 0, 0, 16, 16, 0, 0, 16, 16);
                imgSource = canvas;
                // 注意：如果后续有颜色图处理，使用 imgSource 作为图像源
            }

            // 如果不需要染色，直接使用 imgSource
            if (!tintType) {
                const texture = new THREE.CanvasTexture(imgSource);
                texture.magFilter = THREE.NearestFilter;
                texture.minFilter = THREE.NearestFilter;
                texture.colorSpace = THREE.SRGBColorSpace;
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                return texture;
            }

            // 染色逻辑：使用 imgSource（已裁剪）
            const tint = await loadColormap(packName, tintType);
            const canvas = document.createElement('canvas');
            canvas.width = 16;
            canvas.height = 16;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgSource, 0, 0, 16, 16);  // 直接绘制 16x16 图像
            const imageData = ctx.getImageData(0, 0, 16, 16);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                data[i] = Math.min(255, data[i] * tint.r);
                data[i + 1] = Math.min(255, data[i + 1] * tint.g);
                data[i + 2] = Math.min(255, data[i + 2] * tint.b);
            }
            ctx.putImageData(imageData, 0, 0);
            const texture = new THREE.CanvasTexture(canvas);
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.NearestFilter;
            texture.colorSpace = THREE.SRGBColorSpace;
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            return texture;
        } catch (err) {
            console.warn(`纹理加载失败: ${textureRef} (材质包 ${packName})，使用错误纹理`, err);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            return ERROR_TEXTURE ? ERROR_TEXTURE.clone() : null;
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
function createFaceGeometry(faceDir, from, to, uv, rotation) {
    const min = new THREE.Vector3().fromArray(from).multiplyScalar(1 / 16);
    const max = new THREE.Vector3().fromArray(to).multiplyScalar(1 / 16);
    let vertices;
    switch (faceDir) {
        case 'up':
            vertices = [
                [min.x, max.y, max.z], [max.x, max.y, max.z],
                [max.x, max.y, min.z], [min.x, max.y, min.z]
            ]; break;
        case 'down':
            vertices = [
                [min.x, min.y, min.z], [max.x, min.y, min.z],
                [max.x, min.y, max.z], [min.x, min.y, max.z]
            ]; break;
        case 'north':
            vertices = [
                [min.x, min.y, min.z], [max.x, min.y, min.z],
                [max.x, max.y, min.z], [min.x, max.y, min.z]
            ]; break;
        case 'south':
            vertices = [
                [min.x, min.y, max.z], [max.x, min.y, max.z],
                [max.x, max.y, max.z], [min.x, max.y, max.z]
            ]; break;
        case 'west':
            vertices = [
                [min.x, min.y, min.z], [min.x, min.y, max.z],
                [min.x, max.y, max.z], [min.x, max.y, min.z]
            ]; break;
        case 'east':
            vertices = [
                [max.x, min.y, min.z], [max.x, min.y, max.z],
                [max.x, max.y, max.z], [max.x, max.y, min.z]
            ]; break;
        default: return null;
    }

    // ---- 处理 UV 旋转 ----
    if (!uv) uv = [0, 0, 16, 16];
    let [u1, v1, u2, v2] = uv;
    // 归一化到 0-1
    u1 /= 16; v1 /= 16; u2 /= 16; v2 /= 16;
    // 四个角点：顺序与 vertices 对应
    let uvPoints = [
        [u1, v1], // 顶点0
        [u2, v1], // 顶点1
        [u2, v2], // 顶点2
        [u1, v2]  // 顶点3
    ];

    // 如果有旋转，应用旋转（围绕中心 0.5,0.5）
    if (rotation && rotation !== 0) {
        const angle = rotation * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        uvPoints = uvPoints.map(([u, v]) => {
            const du = u - 0.5;
            const dv = v - 0.5;
            return [
                0.5 + du * cos - dv * sin,
                0.5 + du * sin + dv * cos
            ];
        });
    }

    // 展平为数组
    const uvs = uvPoints.flat();

    // 构建几何体
    const geom = new THREE.BufferGeometry();
    const pos = [];
    vertices.forEach(v => pos.push(...v));
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
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

    // 并行加载纹理
    const texturePromises = {};
    for (const [key, ref] of Object.entries(resolvedTextures)) {
        const tint = getTintType(ref);
        texturePromises[key] = loadTexture(packName, ref, tint);
    }

    const group = new THREE.Group();
    for (const elem of elements) {
        const from = elem.from;
        const to = elem.to;
        const faces = elem.faces || {};
        for (const [faceDir, faceData] of Object.entries(faces)) {
            const texVar = faceData.texture;
            if (!texVar) continue;
            const texKey = texVar.startsWith('#') ? texVar.slice(1) : texVar;
            const texturePromise = texturePromises[texKey];
            if (!texturePromise) {
                console.warn(`纹理变量 ${texVar} 未定义，跳过该面`);
                continue;
            }
            const rotation = faceData.rotation || 0;
            const geom = createFaceGeometry(faceDir, from, to, faceData.uv, rotation);
            if (!geom) continue;
            const texture = await texturePromise;
            const material = new THREE.MeshLambertMaterial({
                map: texture,
                transparent: true,
                alphaTest: 0.1,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geom, material);
            group.add(mesh);
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

    return group;
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
            const group = await buildBlockScene(this._packName, this._blockId);
            if (!group) {
                const packErr = getPackCache(this._packName).lastError;
                this.showErrorBlock(width, height, packErr
                    ? `材质包 "${this._packName}" 加载失败：${packErr}`
                    : `模型 "${this._blockId}" 缺少 elements（材质包 "${this._packName}"）`);
                return;
            }

            const scene = new THREE.Scene();
            scene.add(group);

            const light = new THREE.DirectionalLight(0xffffff, 2);
            light.position.set(0.8, 1, 0.6);
            scene.add(light);

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

            // 成功标记：便于页面/自动化检查，也方便线上排障
            this.dataset.rendered = 'true';
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
    packs: [...packCache.entries()].map(([name, c]) => ({
        name,
        loaded: c.loaded,
        bytes: c.bytes,
        error: c.lastError,
    })),
});

export { loadPack, loadModel, loadTexture, DEFAULT_PACK };