/**
 * js/nav.js —— 全局导航栏行为（所有带导航栏的页面共用）
 *
 * 1) 下拉菜单：鼠标悬浮由 CSS 负责，这里补上键盘、触摸点击与点击外部关闭
 * 2) 滚动收缩：往下滚 → 收成左上角单个按钮；悬浮/聚焦该按钮 → 重新展开
 * 3) 站内链接淡出过渡（原来只写在 index.html 里，现在全站统一）
 */
(function () {
    'use strict';

    const nav = document.querySelector('.global-nav');
    if (!nav) return;

    /* ============================================================
       1. 下拉菜单
       ============================================================ */
    const items = Array.from(nav.querySelectorAll('.nav-item'));

    function closeAll(except) {
        items.forEach(it => { if (it !== except) it.classList.remove('is-open'); });
    }

    items.forEach(item => {
        const btn = item.querySelector('.nav-btn');
        if (!btn) return;

        // 触摸/点击：切换展开（鼠标悬浮仍由 CSS 处理，互不冲突）
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const willOpen = !item.classList.contains('is-open');
            closeAll(item);
            item.classList.toggle('is-open', willOpen);
        });
    });

    document.addEventListener('click', (e) => {
        if (!nav.contains(e.target)) closeAll(null);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAll(null);
            nav.classList.remove('is-peeking');
        }
    });

    /* ============================================================
       2. 滚动收缩 / 悬浮展开
       ============================================================ */
    const COLLAPSE_AT = 80;   // 滚动超过该像素就收起
    let pinned = false;       // true = 暂时不接受收起（首页进入动画期间用）

    function syncCollapsed() {
        if (pinned) {
            nav.classList.remove('is-collapsed', 'is-peeking');
            return;
        }
        const shouldCollapse = window.scrollY > COLLAPSE_AT;
        nav.classList.toggle('is-collapsed', shouldCollapse);
        if (!shouldCollapse) nav.classList.remove('is-peeking');
    }

    window.addEventListener('scroll', syncCollapsed, { passive: true });
    window.addEventListener('resize', syncCollapsed, { passive: true });

    // 悬浮 / 拿到焦点 → 展开（收起状态下导航条本体不拦截指针，只有按钮可点）
    nav.addEventListener('mouseenter', () => {
        if (nav.classList.contains('is-collapsed')) nav.classList.add('is-peeking');
    });
    nav.addEventListener('mouseleave', () => nav.classList.remove('is-peeking'));
    nav.addEventListener('focusin', () => {
        if (nav.classList.contains('is-collapsed')) nav.classList.add('is-peeking');
    });
    nav.addEventListener('focusout', () => {
        if (!nav.contains(document.activeElement)) nav.classList.remove('is-peeking');
    });

    // 触摸设备没有 hover：点一下左上角按钮即可展开
    const fab = nav.querySelector('.nav-fab');
    if (fab) {
        fab.addEventListener('click', (e) => {
            e.preventDefault();
            nav.classList.toggle('is-peeking');
        });
    }

    syncCollapsed();

    /* ============================================================
       3. 站内链接淡出过渡
       ============================================================ */
    const EXIT_DELAY = 320;

    function isInternal(href) {
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
        const a = document.createElement('a');
        a.href = href;
        return !a.host || a.host === window.location.host;
    }

    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        if (!link) return;
        if (link.target === '_blank') return;
        if ((link.getAttribute('rel') || '').includes('external')) return;
        if (link.hasAttribute('data-no-transition')) return;
        const href = link.getAttribute('href');
        if (!isInternal(href)) return;

        e.preventDefault();
        if (document.body.classList.contains('page-exit')) return;
        document.body.classList.add('page-exit');
        setTimeout(() => { window.location.href = href; }, EXIT_DELAY);
    });

    // 浏览器前进/后退回来时清掉退出状态并重播入场
    window.addEventListener('pageshow', () => {
        document.body.classList.remove('page-exit');
        document.body.style.animation = 'none';
        void document.body.offsetHeight;
        document.body.style.animation = '';
    });

    // 供其它脚本（如首页进入动画）调用
    window.siteNav = {
        el: nav,
        setPinned(value) {
            pinned = !!value;
            syncCollapsed();
        },
        offstage(isOffstage) {
            nav.classList.toggle('nav-offstage', !!isOffstage);
        },
        collapseNow() {
            pinned = false;
            nav.classList.add('is-collapsed');
        },
    };
})();
