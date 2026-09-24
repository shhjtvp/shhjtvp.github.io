/**
 * js/maps.js —— 地图页
 *
 * 1) 逐帧算出每个链接块与「列表中心」的归一化距离，写进 --t，
 *    由 CSS 用 calc() 换算成透明度 / 缩放 / 饱和度 —— 越靠中间越清晰。
 *    这样滚动过程中是连续变化，而不是跨过某条线才「啪」地切换。
 * 2) 把正中间那一块标记为 is-active，并按其 data-bg 切换背景图（淡入由 CSS 负责）。
 * 3) 按链接块数量生成右侧指示点，点击可平滑跳过去。
 */
(function () {
    'use strict';

    const list = document.getElementById('mapsList');
    if (!list) return;

    const items = Array.from(list.querySelectorAll('.maps-item'));
    const layers = Array.from(document.querySelectorAll('.maps-bg__layer'));
    const dotsBox = document.getElementById('mapsDots') || document.querySelector('.maps-dots');
    if (!items.length) return;

    let dots = [];
    let queued = false;
    let activeIndex = -1;
    let activeLayer = -1;

    // 把第 i 块滚到正中（自己算位置，不依赖 offsetParent 是哪一级）
    function centerItem(i) {
        const item = items[i];
        if (!item) return;
        const top = list.scrollTop + (item.getBoundingClientRect().top - list.getBoundingClientRect().top);
        list.scrollTo({
            top: top + item.offsetHeight / 2 - list.clientHeight / 2,
            behavior: 'smooth',
        });
    }

    function setActive(index) {
        if (index === activeIndex) return;
        activeIndex = index;
        items.forEach((item, i) => item.classList.toggle('is-active', i === index));
        dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));

        // 该块指定的背景图；没写 data-bg 或越界就沿用上一张，不做切换
        const bg = parseInt(items[index].dataset.bg, 10);
        if (Number.isNaN(bg) || bg === activeLayer || !layers[bg]) return;
        activeLayer = bg;
        layers.forEach((layer, i) => layer.classList.toggle('is-active', i === bg));
    }

    function update() {
        queued = false;
        const box = list.getBoundingClientRect();
        if (!box.height) return;
        const center = box.top + box.height / 2;
        const half = box.height / 2;

        let nearest = 0;
        let nearestDist = Infinity;
        items.forEach((item, i) => {
            const rect = item.getBoundingClientRect();
            const dist = Math.abs(rect.top + rect.height / 2 - center);
            // 归一化：0 在正中，1 差整整一屏
            item.style.setProperty('--t', Math.min(1, dist / half).toFixed(4));
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = i;
            }
        });
        setActive(nearest);
    }

    function schedule() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(update);
    }

    // 右侧指示点：数量跟着链接块走，加地图不用改脚本
    if (dotsBox) {
        dots = items.map((item, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'maps-dots__btn';
            btn.setAttribute('aria-label', `切换到第 ${i + 1} 张地图`);
            btn.addEventListener('click', () => {
                centerItem(i);
                setActive(i);
            });
            dotsBox.appendChild(btn);
            return btn;
        });
    }

    list.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // 背景图是异步加载的，加载完再算一次更稳
    window.addEventListener('load', schedule);

    update();
})();
