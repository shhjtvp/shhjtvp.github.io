/**
 * js/cursor.js —— 光标光晕
 *
 * 平时光标下始终有一层淡淡的蓝光，按住鼠标时交叉淡入红色。
 * 实现要点：
 *   - 用 pointermove + requestAnimationFrame 合并更新，避免每次移动都写样式
 *   - 只用 transform 定位，不触发布局
 *   - pointer-events: none，不挡任何点击
 *   - 触摸设备（pointer: coarse）直接不启用
 */
(function () {
    'use strict';

    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
        return;   // 触摸设备没有光标，跳过
    }

    const glow = document.createElement('div');
    glow.className = 'cursor-glow';
    glow.setAttribute('aria-hidden', 'true');
    // 蓝、红两层叠在一起做交叉淡入淡出（CSS 渐变本身没法过渡，只能这么干）
    glow.innerHTML = '<span class="cursor-glow__blue"></span><span class="cursor-glow__red"></span>';
    document.body.appendChild(glow);

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let frameQueued = false;

    function place() {
        frameQueued = false;
        glow.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    }

    function schedule() {
        if (frameQueued) return;
        frameQueued = true;
        requestAnimationFrame(place);
    }

    // 先摆好位置再显示，避免第一次出现时从屏幕中心滑过去
    place();

    window.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        x = e.clientX;
        y = e.clientY;
        if (!glow.classList.contains('is-visible')) glow.classList.add('is-visible');
        schedule();
    }, { passive: true });

    // 按住 → 红；松开 → 蓝
    const press = () => glow.classList.add('is-pressed');
    const release = () => glow.classList.remove('is-pressed');
    window.addEventListener('pointerdown', press, { passive: true });
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    window.addEventListener('blur', release);
    // 拖拽时指针可能跑到窗口外，补一次兜底
    document.addEventListener('dragend', release);

    // 指针离开窗口就隐去，回来再显示
    document.addEventListener('mouseleave', () => glow.classList.remove('is-visible'));
    document.addEventListener('mouseenter', () => glow.classList.add('is-visible'));
})();
