/**
 * main.js — 公共功能脚本
 * 移除了 mcfunction 的 highlight.js 注册，因为改用 mcfunction-highlight 库。
 * 保留通用工具函数。
 */

// ============================================================
// 通用工具函数（可被其他页面使用）
// ============================================================

/**
 * 安全转义 HTML 字符串
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * 获取 URL 查询参数
 */
function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
}