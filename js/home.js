/**
 * js/home.js —— 首页：进入动画 + 滚动分页
 *
 * 进入动画时序（点击 logo 后，单位 ms）：
 *   0    轻微放大
 *   170  开始 FLIP 飞向左上角导航栏 logo
 *   730  交接：黑幕淡出 + 导航栏从屏幕外下降
 *   880  蓝环扩散（渐变为红）铺满整页
 *   1630 首页内容淡入
 *   1880 红环淡出消失
 *   2480 清理并解锁滚动
 */
(function () {
    'use strict';

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const body = document.body;
    const html = document.documentElement;
    const intro = document.getElementById('intro');
    const introLogo = document.getElementById('introLogo');
    const ring = document.getElementById('introRing');
    const wave = document.getElementById('introWave');
    const nav = document.querySelector('.global-nav');
    const navLogoImg = document.querySelector('.nav-brand img');

    /* ============================================================
       滚动分页 + 右侧指示点
       ============================================================ */
    const pages = Array.from(document.querySelectorAll('.page'));
    const dotsBox = document.getElementById('pageDots');
    const dots = [];

    function activate(index) {
        pages.forEach((p, i) => p.classList.toggle('is-active', i === index));
        dots.forEach((d, i) => d.classList.toggle('is-active', i === index));
    }

    if (pages.length && dotsBox) {
        pages.forEach((page, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'page-dots__btn';
            btn.setAttribute('aria-label', `第 ${i + 1} 页`);
            btn.addEventListener('click', () => {
                activate(i);
                page.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
            });
            dotsBox.appendChild(btn);
            dots.push(btn);
        });

        if ('IntersectionObserver' in window) {
            const io = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
                        activate(pages.indexOf(entry.target));
                    }
                });
            }, { threshold: [0.5, 0.75] });
            pages.forEach((p) => io.observe(p));
        }
        activate(0);
    }

    /* ============================================================
       进入动画
       ============================================================ */
    if (!intro || !introLogo) return;

    const T = {
        press: 170,
        fly: 560,
        burstDelay: 150,
        // 红环铺满后开始淡出；内容同时开始浮现，两者交叠才显得平滑
        // （淡出时长在 css/home/intro.css 的 .intro__wave.is-fading 里，1.1s）
        fadeWave: 980,
        content: 1000,
        // 等红环淡出 + 内容入场都走完再收尾
        cleanup: 2500,
    };

    let started = false;

    // 导航栏此刻停在屏幕外，量之前先把 transform 摘掉；
    // 注意必须同时把 transition 也停掉：导航栏上有 transform 过渡，
    // 只改 transform 的话 getBoundingClientRect 拿到的还是过渡中的旧位置，
    // logo 会飞到屏幕外去（实测偏 57px）。
    // 这些操作在同一帧内完成并还原，不会产生闪烁或额外过渡。
    function navLogoRect() {
        if (!nav) return navLogoImg.getBoundingClientRect();
        const savedTransform = nav.style.transform;
        const savedTransition = nav.style.transition;
        nav.style.transition = 'none';
        nav.style.transform = 'none';
        const rect = navLogoImg.getBoundingClientRect();
        nav.style.transform = savedTransform;
        nav.style.transition = savedTransition;
        return rect;
    }

    // 光环从 logo 中心开始，直径要能盖住最远的那个屏幕角
    function setBurstOrigin(rect) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const w = window.innerWidth;
        const h = window.innerHeight;
        const maxDist = Math.max(
            Math.hypot(cx, cy),
            Math.hypot(w - cx, cy),
            Math.hypot(cx, h - cy),
            Math.hypot(w - cx, h - cy)
        );
        const size = Math.max(24, Math.round(rect.width));
        const max = Math.ceil(maxDist * 2 + 60);
        [ring, wave].forEach((el) => {
            if (!el) return;
            el.style.setProperty('--burst-x', cx + 'px');
            el.style.setProperty('--burst-y', cy + 'px');
            el.style.setProperty('--burst-size', size + 'px');
            el.style.setProperty('--burst-max', max + 'px');
        });
    }

    function finish() {
        body.classList.remove('intro-running');
        html.classList.remove('intro-lock');
        body.classList.remove('intro-lock');
        intro.classList.add('is-done');
        if (window.siteNav) window.siteNav.setPinned(false);
    }

    function play() {
        if (started) return;
        started = true;

        const target = navLogoRect();
        const from = introLogo.getBoundingClientRect();
        setBurstOrigin(target);

        if (reduceMotion) {
            if (nav) nav.classList.remove('nav-offstage');
            intro.classList.remove('is-cleared');
            finish();
            return;
        }

        // 1) 轻微放大
        introLogo.classList.add('is-pressing');

        setTimeout(() => {
            // 2) FLIP：飞向导航栏 logo 并缩放到同等大小
            //    缩放要用【未被变换】的布局宽度做除数：
            //    getBoundingClientRect 会把呼吸动画的 scale 也算进去，
            //    拿它当分母会让落位尺寸差 1~2px，和导航栏 logo 对不齐。
            const baseSize = introLogo.offsetWidth || from.width;
            const dx = target.left - from.left;
            const dy = target.top - from.top;
            const scale = target.width / baseSize;
            introLogo.classList.add('is-flying');
            introLogo.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;

            setTimeout(() => {
                // 3) 交接：黑幕淡出，露出的正是同一位置的导航栏 logo
                intro.classList.add('is-cleared');
                if (nav) nav.classList.remove('nav-offstage');

                setTimeout(() => {
                    if (ring) ring.classList.add('is-burst');
                    if (wave) wave.classList.add('is-burst');
                }, T.burstDelay);

                setTimeout(() => body.classList.remove('intro-running'), T.content);
                setTimeout(() => { if (wave) wave.classList.add('is-fading'); }, T.fadeWave);
                setTimeout(finish, T.cleanup);
            }, T.fly);
        }, T.press);
    }

    introLogo.addEventListener('click', play);

    // 键盘：直接回车/空格也能进（button 默认就支持，这里是兜底）
    introLogo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            play();
        }
    });

    // 窗口尺寸变化时，如果动画还没开始，光环参数会在点击时重新计算
    window.addEventListener('resize', () => {
        if (!started) return;
        // 动画进行中不做处理，避免中途跳变
    });
})();
