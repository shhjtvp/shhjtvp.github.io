// js/minecraft.js
// 支持多材质包：<mc-block src="packname"> 加载 mc_textures/packname.zip
// 默认材质包：26.2-Fabric 0.19.3
// 保留 HTTP 回退，模型加载失败时自动尝试 item/ 路径

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

// ---------- 全局依赖 ----------
const JSZip = window.JSZip;

// ---------- 常量 ----------
const DEFAULT_PACK = '26.2-Fabric 0.19.3';
const ZIP_BASE_PATH = '/mc_textures/';          // ZIP 存放目录

// ---------- 材质包缓存 ----------
const packCache = new Map(); // 键: packName, 值: { zipFile, loaded, promise }

function getPackCache(packName) {
    if (!packCache.has(packName)) {
        packCache.set(packName, {
            zipFile: null,
            loaded: false,
            promise: null,
        });
    }
    return packCache.get(packName);
}

async function loadPack(packName) {
    const cache = getPackCache(packName);
    if (cache.loaded) return;
    if (cache.promise) return cache.promise;

    cache.promise = (async () => {
        try {
            const zipUrl = `${ZIP_BASE_PATH}${encodeURIComponent(packName)}.zip`;
            const response = await fetch(zipUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const zip = await JSZip.loadAsync(blob);
            cache.zipFile = zip;
            cache.loaded = true;
            console.log(`✅ 材质包 "${packName}" 加载成功，共 ${Object.keys(zip.files).length} 个文件`);
        } catch (err) {
            console.error(`❌ 材质包 "${packName}" 加载失败，将回退到 HTTP 加载`, err);
            cache.loaded = false;
            cache.zipFile = null;
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
    const file = cache.zipFile.file(path);
    if (!file) {
        throw new Error(`材质包 "${packName}" 中找不到文件: ${path}`);
    }
    return file.async(type);
}

// ---------- 工具函数 ----------
function getAssetsRoot(packName) {
    return `/mc_textures/${packName}/assets/minecraft`;
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
const ERROR_TEXTURE = createErrorTexture();

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
            // 如果材质包加载成功，优先从ZIP读取
            if (cache.loaded && cache.zipFile) {
                try {
                    const blob = await readFromPack(packName, zipPath, 'blob');
                    blobUrl = URL.createObjectURL(blob);
                    img = await loadImage(blobUrl);
                } catch (zipErr) {
                    // ZIP读取失败，回退HTTP
                    console.warn(`ZIP读取纹理失败 ${zipPath}，回退HTTP`, zipErr);
                    const url = getTextureUrl(packName, textureRef);
                    img = await loadImage(url);
                }
            } else {
                // 材质包未加载，直接HTTP
                const url = getTextureUrl(packName, textureRef);
                img = await loadImage(url);
            }

            if (!tintType) {
                const texture = new THREE.CanvasTexture(img);
                texture.magFilter = THREE.NearestFilter;
                texture.minFilter = THREE.NearestFilter;
                texture.colorSpace = THREE.SRGBColorSpace;
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                return texture;
            }

            const tint = await loadColormap(packName, tintType);
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
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
            return ERROR_TEXTURE.clone();
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
function createFaceGeometry(faceDir, from, to, uv) {
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
    const geom = new THREE.BufferGeometry();
    const pos = [];
    vertices.forEach(v => pos.push(...v));
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    if (!uv) uv = [0, 0, 16, 16];
    const [u1, v1, u2, v2] = uv;
    const uvs = [u1/16, v1/16, u2/16, v1/16, u2/16, v2/16, u1/16, v2/16];
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.computeVertexNormals();
    return geom;
}

// ---------- 场景构建 ----------
async function buildBlockScene(packName, blockId) {
    const modelData = await loadModel(packName, blockId);
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
            const geom = createFaceGeometry(faceDir, from, to, faceData.uv);
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
                this.showErrorBlock(width, height);
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
        } catch (e) {
            console.error(`渲染方块 ${this._blockId} (材质包 ${this._packName}) 失败:`, e);
            this.showErrorBlock(width, height);
        }
    }

    showErrorBlock(w, h) {
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

export { loadPack, loadModel, loadTexture, DEFAULT_PACK };