// js/minecraft.js
// 完全基于 Three.js CDN 的 Minecraft 方块渲染自定义元素 <block>
// 支持模型继承、纹理着色 (颜色图) 与等轴测正交渲染
// 版本: 适配 Minecraft 1.20+ 资源包结构 (26.2 规范)

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

// ---------- 路径配置 ----------
const ASSETS_ROOT = '/mc_textures/26.2-Fabric 0.19.3/assets/minecraft';
const MODELS_BASE = `${ASSETS_ROOT}/models/`;
const TEXTURES_BASE = `${ASSETS_ROOT}/textures/`;
const COLOR_MAP_PATH = `${TEXTURES_BASE}colormap/`;

// ---------- 工具函数 ----------
/** 将命名空间路径转为模型 JSON 的绝对 URL */
function modelUrl(modelPath) {
    let path = modelPath;
    if (path.startsWith('minecraft:')) path = path.slice(10);
    return `${MODELS_BASE}${encodeURI(path)}.json`;
}

/** 将纹理引用转为纹理图片的绝对 URL */
function textureUrl(textureRef) {
    let path = textureRef;
    if (path.startsWith('minecraft:')) path = path.slice(10);
    return `${TEXTURES_BASE}${encodeURI(path)}.png`;
}

/** 角度转弧度 */
const deg = Math.PI / 180;

// ---------- 缓存 ----------
const modelCache = new Map();      // url -> Promise<object>
const textureCache = new Map();    // url -> Promise<THREE.Texture>
const colormapCache = {};         // 'grass' | 'foliage' -> Promise<{r,g,b}>

// 错误纹理（粉紫）
function createErrorTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FF00FF';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 8);
    return new THREE.CanvasTexture(canvas);
}
const ERROR_TEXTURE = createErrorTexture();

// ---------- 颜色图处理 ----------
async function loadColormap(type) {
    if (!colormapCache[type]) {
        const url = `${COLOR_MAP_PATH}${encodeURI(type)}.png`;
        colormapCache[type] = new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                // 采样中心像素 (0.5, 0.5)
                const cx = Math.floor(img.width / 2);
                const cy = Math.floor(img.height / 2);
                const pixel = ctx.getImageData(cx, cy, 1, 1).data;
                resolve({ r: pixel[0] / 255, g: pixel[1] / 255, b: pixel[2] / 255 });
            };
            img.onerror = reject;
            img.src = url;
        }).catch(err => {
            console.warn(`无法加载颜色图 ${type}，使用默认颜色`, err);
            // 回退默认颜色
            if (type === 'grass') return { r: 0.569, g: 0.741, b: 0.349 }; // #91BD59
            if (type === 'foliage') return { r: 0.467, g: 0.671, b: 0.184 }; // #77AB2F
            return { r: 1, g: 1, b: 1 };
        });
    }
    return colormapCache[type];
}

/** 判断纹理是否需要颜色图着色，返回类型或null */
function getTintType(texturePath) {
    const lower = texturePath.toLowerCase();
    // 草方块顶部/侧面/本体 (排除雪覆盖变种)
    if ((lower.includes('grass_block') && !lower.includes('snow')) || lower.includes('grass_block_top') || lower.includes('grass_block_side')) {
        return 'grass';
    }
    // 树叶
    if (lower.includes('leaves') || lower.includes('leaf')) {
        return 'foliage';
    }
    // 高草丛等
    if (lower.includes('tall_grass') || lower.includes('fern') || lower.includes('vine')) {
        return 'grass';
    }
    return null;
}

/** 加载纹理并应用颜色着色 */
async function loadTexture(url, tintType = null) {
    const key = `${url}||tint:${tintType || 'none'}`;
    if (textureCache.has(key)) return textureCache.get(key).then(tex => tex.clone()); // 返回克隆，避免共享问题

    const promise = new Promise(async (resolve, reject) => {
        try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = async () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                if (tintType) {
                    const tint = await loadColormap(tintType);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const data = imageData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        data[i] = Math.min(255, data[i] * tint.r);
                        data[i + 1] = Math.min(255, data[i + 1] * tint.g);
                        data[i + 2] = Math.min(255, data[i + 2] * tint.b);
                        // alpha 保持不变
                    }
                    ctx.putImageData(imageData, 0, 0);
                }

                const texture = new THREE.CanvasTexture(canvas);
                texture.magFilter = THREE.NearestFilter;
                texture.minFilter = THREE.NearestFilter;
                texture.colorSpace = THREE.SRGBColorSpace;
                resolve(texture);
            };
            img.onerror = () => {
                console.warn(`纹理加载失败: ${url}`);
                resolve(ERROR_TEXTURE.clone());
            };
            img.src = url;
        } catch (e) {
            console.warn(`纹理处理异常: ${url}`, e);
            resolve(ERROR_TEXTURE.clone());
        }
    });

    textureCache.set(key, promise);
    return promise;
}

// ---------- 模型加载与继承解析 ----------
async function loadModel(blockId) {
    // 补全命名空间
    if (!blockId.includes(':')) blockId = 'minecraft:' + blockId;
    const item = blockId.replace('minecraft:', '');
    const url = modelUrl(item.startsWith('block/') ? item : `block/${item}`);

    if (modelCache.has(url)) return modelCache.get(url);

    const promise = (async () => {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`模型 404: ${url}`);
            const json = await response.json();
            let textures = {};
            let elements = null;
            let display = null;

            // 递归解析父模型
            if (json.parent) {
                const parentData = await loadModel(json.parent);
                textures = { ...parentData.textures };
                elements = parentData.elements;
                display = parentData.display;
            }

            // 子模型纹理覆盖
            if (json.textures) {
                Object.assign(textures, json.textures);
            }
            // 子模型 elements 覆盖
            if (json.elements) {
                elements = json.elements;
            }
            // 子模型 display 覆盖
            if (json.display) {
                display = { ...display, ...json.display };
            }

            const result = { textures, elements, display };
            modelCache.set(url, result);
            return result;
        } catch (e) {
            console.warn(`模型加载失败: ${blockId}`, e);
            const fallback = { textures: {}, elements: null, display: null };
            modelCache.set(url, fallback);
            return fallback;
        }
    })();

    modelCache.set(url, promise);
    return promise;
}

// ---------- 几何体生成 ----------
function createFaceGeometry(faceDir, from, to, uv) {
    const min = new THREE.Vector3().fromArray(from).multiplyScalar(1 / 16);
    const max = new THREE.Vector3().fromArray(to).multiplyScalar(1 / 16);
    let vertices;

    switch (faceDir) {
        case 'up': // Y+
            vertices = [
                [min.x, max.y, max.z], [max.x, max.y, max.z],
                [max.x, max.y, min.z], [min.x, max.y, min.z]
            ]; break;
        case 'down': // Y-
            vertices = [
                [min.x, min.y, min.z], [max.x, min.y, min.z],
                [max.x, min.y, max.z], [min.x, min.y, max.z]
            ]; break;
        case 'north': // Z-
            vertices = [
                [min.x, min.y, min.z], [max.x, min.y, min.z],
                [max.x, max.y, min.z], [min.x, max.y, min.z]
            ]; break;
        case 'south': // Z+
            vertices = [
                [min.x, min.y, max.z], [max.x, min.y, max.z],
                [max.x, max.y, max.z], [min.x, max.y, max.z]
            ]; break;
        case 'west': // X-
            vertices = [
                [min.x, min.y, min.z], [min.x, min.y, max.z],
                [min.x, max.y, max.z], [min.x, max.y, min.z]
            ]; break;
       case 'east': // X+
            vertices = [
                [max.x, min.y, min.z], // 左下
                [max.x, min.y, max.z], // 右下
                [max.x, max.y, max.z], // 右上
                [max.x, max.y, min.z]  // 左上
            ]; break;
        default: return null;
    }

    const geom = new THREE.BufferGeometry();
    const pos = [];
    vertices.forEach(v => pos.push(...v));
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);

    // UV 处理
    if (!uv) uv = [0, 0, 16, 16];
    const [u1, v1, u2, v2] = uv;
    const uvs = [
        u1 / 16, v1 / 16,
        u2 / 16, v1 / 16,
        u2 / 16, v2 / 16,
        u1 / 16, v2 / 16
    ];
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.computeVertexNormals();
    return geom;
}

// ---------- 完整场景构建 ----------
async function buildBlockScene(blockId) {
    const modelData = await loadModel(blockId);
    if (!modelData.elements) {
        console.warn(`方块 ${blockId} 没有 elements，无法渲染`);
        return null;
    }

    const { textures, elements, display } = modelData;
    const resolvedTextures = {};
    for (const [key, value] of Object.entries(textures)) {
        let resolved = value;
        let depth = 0;
        while (resolved.startsWith('#') && depth < 10) {
            const refKey = resolved.slice(1);
            if (textures[refKey]) {
                resolved = textures[refKey];
            } else {
                console.warn(`无法解析纹理变量 ${resolved}，使用错误纹理`);
                resolved = 'minecraft:block/missing';
                break;
            }
            depth++;
        }
        if (resolved.startsWith('#')) {
            resolved = 'minecraft:block/missing'; // 最终仍未解析则回退
        }
        resolvedTextures[key] = resolved;
    }
    const group = new THREE.Group();

    // 解析所有纹理引用 (并行加载)
    const texturePromises = {}; // 变量名 -> Promise<THREE.Texture>
    for (const [key, ref] of Object.entries(resolvedTextures)) {
        const texUrl = textureUrl(ref);
        const tint = getTintType(ref);
        texturePromises[key] = loadTexture(texUrl, tint);
    }

    // 生成所有面
    for (const elem of elements) {
        const from = elem.from;
        const to = elem.to;
        const faces = elem.faces || {};

        for (const [faceDir, faceData] of Object.entries(faces)) {
            const texVar = faceData.texture; // 如 "#all"
            if (!texVar) continue;
            const texKey = texVar.startsWith('#') ? texVar.slice(1) : texVar;
            const texturePromise = texturePromises[texKey];
            if (!texturePromise) {
                console.warn(`纹理变量 ${texVar} 未定义`);
                continue;
            }

            const geom = createFaceGeometry(faceDir, from, to, faceData.uv);
            if (!geom) continue;

            const material = new THREE.MeshLambertMaterial({
                map: await texturePromise,
                transparent: true,
                alphaTest: 0.1,
                side: THREE.DoubleSide,
            });

            const mesh = new THREE.Mesh(geom, material);
            group.add(mesh);
        }
    }

    // 模型居中 (原点位于方块几何中心)
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -center.y, -center.z);

    // 应用 display 变换 (GUI / fixed)
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

    // 最终居中，防止部分模型偏移导致只显示半边
    const finalBox = new THREE.Box3().setFromObject(group);
    const finalCenter = finalBox.getCenter(new THREE.Vector3());
    group.position.sub(finalCenter);

    return group;
}

// ---------- 自定义元素 <block> ----------
class BlockElement extends HTMLElement {
    static observedAttributes = ['size'];

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._blockId = '';
        this._size = '36px';
        this._renderRequested = false;
    }

    connectedCallback() {
        this._blockId = (this.textContent || '').trim();
        this._size = this.getAttribute('size') || '36px';
        this.setupShadowDOM();
        this.requestRender();
    }

    attributeChangedCallback(name, oldVal, newVal) {
        if (name === 'size' && oldVal !== newVal) {
            this._size = newVal;
            this.updateSize();
            this.requestRender();
        }
    }

    // 简单监听文本变化
    adoptedCallback() {}
    disconnectedCallback() {
        if (this._observer) this._observer.disconnect();
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

        // 监听 innerText 变化 (轻量)
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

        // 等待尺寸生效
        const width = this.clientWidth || 36;
        const height = this.clientHeight || 36;
        if (width === 0 || height === 0) {
            // 如果尺寸为0，稍后重试
            this._renderRequested = true;
            requestAnimationFrame(() => this.render());
            return;
        }

        // 清理旧渲染器
        if (this._renderer) {
            this._renderer.dispose();
            this._renderer = null;
        }
        if (this._scene) {
            // 简单清理几何体和材质
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
            const group = await buildBlockScene(this._blockId);
            if (!group) {
                // 显示错误占位
                this.showErrorBlock(width, height);
                return;
            }

            // 创建场景
            const scene = new THREE.Scene();
            scene.add(group);

            // 光照：上方偏左前方，产生顶面最亮、左侧面中等、右侧面暗的效果
            const light = new THREE.DirectionalLight(0xffffff, 2);
            light.position.set(0.8, 1, 0.6);
            scene.add(light);

            // 正交相机 (等轴测无透视)
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

            // 渲染器
            const renderer = new THREE.WebGLRenderer({
                antialias: true,
                alpha: true,
                canvas: this._canvas
            });
            renderer.setSize(width, height, false);
            renderer.setClearColor(0x000000, 0);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

            // 渲染一帧
            renderer.render(scene, camera);

            // 保存引用以便清理
            this._scene = scene;
            this._renderer = renderer;
            this._camera = camera;
        } catch (e) {
            console.error(`渲染方块 ${this._blockId} 失败:`, e);
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
        ctx.fillRect(0, 0, w/2, h/2);
        ctx.fillRect(w/2, h/2, w/2, h/2);
    }
}

// 注册元素 (防重复)
if (!customElements.get('block')) {
    customElements.define('mc-block', BlockElement);
}