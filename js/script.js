function highlightCode() {
    const codeElement = document.getElementById('code');
    const codeText = codeElement.textContent;

    // 使用正则表达式匹配符号和数字
    const highlightedText = codeText
        .replace(/[+\-*/%=(),{}[\];]/g, '<span class="symbol">$&</span>')
        .replace(/\d+/g, '<span class="number">$&</span>');

    codeElement.innerHTML = highlightedText;
}
window.onload = highlightCode;// 在页面加载完成后高亮代码

// 折叠按钮
function toggleFold(button) {
    const content = button.nextElementSibling;
    if (content.style.display === 'none' || content.style.display === '') {
        content.style.display = 'block';
    } else {
        content.style.display = 'none';
    }
}
// 在页面加载完成后默认折叠折叠内容
window.onload = function() {
    const foldableContents = document.querySelectorAll('.foldable-content');
    foldableContents.forEach(content => {
        content.style.display = 'none';
    });
};
