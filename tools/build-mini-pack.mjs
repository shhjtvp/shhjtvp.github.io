/**
 * tools/build-mini-pack.mjs
 *
 * 从完整材质包中抽取「本站实际用到的资源」，生成精简材质包 mc_textures/mini-26.2.zip。
 *
 * 为什么需要它：
 *   完整包有 4.9 MB，首页每次访问都要下载并解压。弱网 / 代理 / CDN 抖动下只要下载被
 *   中断，JSZip 就会拿到空 blob 并抛 "Corrupted zip ?"，于是所有方块退化成
 *   「材质缺失」的紫黑棋盘格。精简包只有几十 KB，下载几乎不可能失败，站点加载也快得多。
 *
 *   js/minecraft.js 里 DEFAULT_PACK 指向精简包，并且当精简包里找不到某个模型时，
 *   会自动回退到完整包 FALLBACK_PACK —— 所以新增方块不需要改这个脚本也不会崩，
 *   只是会退回复用完整包。想让它也进入精简包，把方块 id 加进下面 BLOCKS 再跑一次即可。
 *
 * 用法：node tools/build-mini-pack.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const JSZip = require(path.join(REPO, 'js/vendor/jszip.min.js'));

const SOURCE_PACK = '26.2-Fabric 0.19.3';
const TARGET_PACK = 'mini-26.2';

// 站点里实际用到的方块（首页 6 个 + 文档里的红蘑菇）
const BLOCKS = [
    'grass_block',
    'diamond_block',
    'soul_campfire',
    'oak_leaves',
    'dandelion',
    'damaged_anvil',
    'red_mushroom',
];

const srcPath = path.join(REPO, 'mc_textures', `${SOURCE_PACK}.zip`);
const srcZip = await JSZip.loadAsync(fs.readFileSync(srcPath));

const wanted = new Set();      // 需要复制进精简包的 zip 路径
const textureRefs = new Set(); // 记录用到的纹理，便于打印
const modelCache = new Map();

function modelPath(tryPath) {
    return `assets/minecraft/models/${tryPath}.json`;
}

async function loadModel(blockId, depth = 0) {
    if (depth > 25) throw new Error('parent 递归过深: ' + blockId);
    if (!blockId.includes(':')) blockId = 'minecraft:' + blockId;
    const item = blockId.replace('minecraft:', '');
    const basePath = item.startsWith('block/') ? item : `block/${item}`;
    if (modelCache.has(blockId)) return modelCache.get(blockId);

    let json = null;
    let jsonPath = null;
    for (const tryPath of [basePath, `item/${item}`]) {
        const p = modelPath(tryPath);
        const f = srcZip.file(p);
        if (f) {
            json = JSON.parse(await f.async('string'));
            jsonPath = p;
            break;
        }
    }
    if (!json) {
        modelCache.set(blockId, { textures: {}, elements: null, missing: true });
        return modelCache.get(blockId);
    }
    wanted.add(jsonPath);

    let textures = {};
    let elements = null;
    if (json.parent) {
        const p = await loadModel(json.parent, depth + 1);
        textures = { ...p.textures };
        elements = p.elements;
    }
    Object.assign(textures, json.textures || {});
    if (json.elements) elements = json.elements;

    const result = { textures, elements, missing: false };
    modelCache.set(blockId, result);
    return result;
}

function resolveRefs(textures) {
    const out = {};
    for (const [k, v] of Object.entries(textures)) {
        let resolved = v;
        let d = 0;
        while (typeof resolved === 'string' && resolved.startsWith('#') && d < 10) {
            const key = resolved.slice(1);
            if (textures[key]) resolved = textures[key];
            else { resolved = 'minecraft:block/missing'; break; }
            d++;
        }
        if (typeof resolved === 'string' && resolved.startsWith('#')) resolved = 'minecraft:block/missing';
        out[k] = resolved;
    }
    return out;
}

const missing = [];
for (const id of BLOCKS) {
    const m = await loadModel(id);
    if (m.missing || !m.elements) {
        missing.push(`${id}: 模型缺失`);
        continue;
    }
    const refs = resolveRefs(m.textures);
    for (const elem of m.elements) {
        for (const face of Object.values(elem.faces || {})) {
            if (!face.texture) continue;
            const key = face.texture.startsWith('#') ? face.texture.slice(1) : face.texture;
            let ref = refs[key];
            if (!ref) { missing.push(`${id}: 纹理变量 ${face.texture} 未定义`); continue; }
            if (ref.startsWith('minecraft:')) ref = ref.slice(10);
            const p = `assets/minecraft/textures/${ref}.png`;
            if (!srcZip.file(p)) { missing.push(`${id}: 纹理文件不存在 ${p}`); continue; }
            wanted.add(p);
            textureRefs.add(p);
        }
    }
}

// 颜色图（草/树叶染色用）
for (const cm of ['grass', 'foliage']) {
    const p = `assets/minecraft/textures/colormap/${cm}.png`;
    if (srcZip.file(p)) wanted.add(p);
    else missing.push(`颜色图缺失: ${p}`);
}

// 动画纹理的 <纹理>.png.mcmeta（帧间隔与帧序）必须一起带上，
// 否则渲染器只能用默认 1 tick 猜，动起来的节奏会和游戏里不一致。
const animated = [];
for (const p of [...wanted].filter((f) => f.endsWith('.png'))) {
    const metaPath = `${p}.mcmeta`;
    if (srcZip.file(metaPath)) {
        wanted.add(metaPath);
        animated.push(p.split('/').pop());
    }
}
if (animated.length) {
    console.log(`   动画纹理 ${animated.length} 张：${animated.join('、')}`);
}

if (missing.length) {
    console.error('❌ 解析完整包时发现问题，未生成精简包：');
    for (const m of missing) console.error('   - ' + m);
    process.exit(1);
}

// 打包
const outZip = new JSZip();
for (const p of [...wanted].sort()) {
    outZip.file(p, await srcZip.file(p).async('nodebuffer'));
}
const buf = await outZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
});

const outPath = path.join(REPO, 'mc_textures', `${TARGET_PACK}.zip`);
fs.writeFileSync(outPath, buf);

// 同时输出一份【未压缩】的目录树。
// 这样 js/minecraft.js 的 HTTP 回退才有真实可用的目标：ZIP 下载被拦截 / 截断 /
// JSZip 不可用时，加载器会改成一个一个拉这些小文件，方块照样能渲染出来。
const outDir = path.join(REPO, 'mc_textures', TARGET_PACK);
fs.rmSync(outDir, { recursive: true, force: true });
let unpackedBytes = 0;
for (const p of [...wanted].sort()) {
    const data = await srcZip.file(p).async('nodebuffer');
    unpackedBytes += data.length;
    const dest = path.join(outDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
}

const srcSize = fs.statSync(srcPath).size;
console.log(`✅ 已生成 ${path.relative(REPO, outPath)}`);
console.log(`   方块 ${BLOCKS.length} 个 · 模型/纹理 ${wanted.size} 个文件 · 纹理 ${textureRefs.size} 张`);
console.log(`   压缩包 ${(buf.length / 1024).toFixed(1)} KB（完整包 ${(srcSize / 1024 / 1024).toFixed(1)} MB，缩小 ${(srcSize / buf.length).toFixed(0)} 倍）`);
console.log(`✅ 已生成解包回退目录 ${path.relative(REPO, outDir)}（${wanted.size} 个文件 / ${(unpackedBytes / 1024).toFixed(1)} KB）`);
