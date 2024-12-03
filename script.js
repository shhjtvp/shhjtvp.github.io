document.addEventListener('DOMContentLoaded', function() {
    function replaceEmojis(textNode) {
      const regex = /\[(\w+)\]/g;// 使用正则表达式查找所有方括号内的内容
      const text = textNode.nodeValue;
      let match;
      let replacedText = text;
  
      while ((match = regex.exec(text)) !== null) {
        const emojiName = match[1];
        const imgSrc = `http://shhjtvp.github.io/emoji/${emojiName}.png`;
        const img = document.createElement('img');
        img.src = imgSrc;
        img.alt = emojiName;
        img.className = 'emoji';
        img.onerror = function() {
          // 处理图片失败
          this.src = 'http://shhjtvp.github.io/emoji/error.png';
        };

        replacedText = replacedText.replace(match[0], img.outerHTML);
      }
  
      textNode.nodeValue = replacedText;
    }
  
    document.body.childNodes.forEach(node => {// 遍历所有文本节点
      if (node.nodeType === Node.TEXT_NODE) {
        replaceEmojis(node);
      }
    });
  });