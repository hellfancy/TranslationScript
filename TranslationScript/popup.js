let floatingButton = null;

// 监听来自 background 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggleTranslator') {
    toggleTranslator();
  }
});

function toggleTranslator() {
  if (floatingButton) {
    floatingButton.remove();
    floatingButton = null;
  } else {
    injectFloatingButton();
  }
}

class TranslationHelper {
  constructor() {
    this.id = Math.floor(Math.random() * 10000000) + 1;
  }

  protected_tokens = new Map();
  protect_count = 0;

  protectSpecialFormat(text) {
    // 保护代码块
    text = text.replace(/```[\s\S]*?```/g, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护行内代码
    text = text.replace(/`[^`]+`/g, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护数学公式
    text = text.replace(/\$\$[\s\S]*?\$\$/g, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护行内数学公式
    text = text.replace(/\$[^$]+\$/g, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护标题
    text = text.replace(/^(#{1,6})\s+.+$/gm, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护链接
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护图片
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护列表
    text = text.replace(/^([\s]*)([-*+]|\d+\.)\s+/gm, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护强调语法
    text = text.replace(/(\*\*|__)[^*_]+?\1/g, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护斜体语法
    text = text.replace(/(\*|_)[^*_]+?\1/g, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    // 保护表格语法
    text = text.replace(/^\|.+\|$/gm, (match) => {
      const token = `__PROTECTED_${this.protect_count}__`;
      this.protected_tokens.set(token, match);
      this.protect_count++;
      return token;
    });

    return text;
  }

  restoreSpecialFormat(text) {
    this.protected_tokens.forEach((value, key) => {
      text = text.replace(key, value);
    });
    return text;
  }

  generateRandomICount() {
    return Math.floor(Math.random() * 10000) + 1;
  }

  async translate(text) {
    if (!text.trim()) return '';
    
    const protectedText = this.protectSpecialFormat(text);
    
    try {
      const iCount = this.generateRandomICount();

      const response = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('Translation request timeout'));
        }, 30000);

        chrome.runtime.sendMessage({
          action: 'translate',
          data: {
            "jsonrpc": "2.0",
            "method": "LMT_handle_texts",
            "params": {
              "texts": [
                {
                  "text": protectedText,
                  "requestAlternatives": 1
                }
              ],
              "splitting": "newlines",
              "lang": {
                "source_lang_user_selected": "auto",
                "target_lang": "ZH"
              }
            },
            "id": this.id + iCount
          }
        }, response => {
          clearTimeout(timeoutId);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error('Empty response'));
            return;
          }
          if (!response.success) {
            reject(new Error(response.error || 'Translation failed'));
            return;
          }
          resolve(response.data);
        });
      });

      if (response && response.result && response.result.texts && response.result.texts[0]) {
        const translatedText = response.result.texts[0].text;
        return this.restoreSpecialFormat(translatedText);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (error) {
      console.error('Translation error:', error);
      throw error;
    }
  }

  createTranslationElement(translatedText) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const originalElement = range.startContainer.parentElement;
    const computedStyle = window.getComputedStyle(originalElement);
    const originalFontSize = computedStyle.fontSize;

    const translationDiv = document.createElement('div');
    translationDiv.className = 'deepl-translation';

    const toolbarDiv = document.createElement('div');
    toolbarDiv.className = 'deepl-toolbar';

    const toolTypeSpan = document.createElement('span');
    toolTypeSpan.textContent = 'DeepL API Free';
    toolTypeSpan.className = 'deepl-tool-type';

    const toolsDiv = document.createElement('div');
    toolsDiv.className = 'deepl-tools';

    const copyButton = document.createElement('button');
    copyButton.className = 'deepl-button';
    const copyIcon = document.createElement('span');
    copyIcon.className = 'material-symbols-rounded';
    copyIcon.innerHTML = 'content_copy';
    copyButton.appendChild(copyIcon);
    copyButton.title = '复制翻译内容';

    const toggleButton = document.createElement('button');
    toggleButton.className = 'deepl-button';
    const toggleIcon = document.createElement('span');
    toggleIcon.className = 'material-symbols-rounded';
    toggleIcon.innerHTML = 'expand_less';
    toggleButton.appendChild(toggleIcon);
    toggleButton.title = '折叠/展开';

    const closeButton = document.createElement('button');
    closeButton.className = 'deepl-button';
    const closeIcon = document.createElement('span');
    closeIcon.className = 'material-symbols-rounded';
    closeIcon.innerHTML = 'close';
    closeButton.appendChild(closeIcon);
    closeButton.title = '关闭';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'deepl-content';
    contentDiv.style.fontSize = originalFontSize;
    contentDiv.style.lineHeight = computedStyle.lineHeight;
    contentDiv.textContent = translatedText;

    let isCollapsed = false;

    copyButton.onclick = () => {
      navigator.clipboard.writeText(translatedText).then(() => {
        const icon = copyButton.querySelector('.material-symbols-rounded');
        icon.style.color = '#059669';
        setTimeout(() => {
          icon.style.color = '';
        }, 1000);
      });
    };

    toggleButton.onclick = () => {
      isCollapsed = !isCollapsed;
      if (isCollapsed) {
        contentDiv.style.height = '0';
        contentDiv.style.margin = '0';
        contentDiv.style.opacity = '0';
        toggleButton.classList.add('collapsed');
      } else {
        contentDiv.style.height = 'auto';
        contentDiv.style.margin = '';
        contentDiv.style.opacity = '1';
        toggleButton.classList.remove('collapsed');
      }
    };

    closeButton.onclick = () => translationDiv.remove();

    toolsDiv.appendChild(copyButton);
    toolsDiv.appendChild(toggleButton);
    toolsDiv.appendChild(closeButton);

    toolbarDiv.appendChild(toolTypeSpan);
    toolbarDiv.appendChild(toolsDiv);

    translationDiv.appendChild(toolbarDiv);
    translationDiv.appendChild(contentDiv);

    return translationDiv;
  }
}

function injectFloatingButton() {
  if (floatingButton) return;

  floatingButton = document.createElement('div');
  floatingButton.className = 'deepl-floating-button';
  const translateIcon = document.createElement('span');
  translateIcon.className = 'material-symbols-rounded';
  translateIcon.innerHTML = 'translate';
  floatingButton.appendChild(translateIcon);

  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  function dragStart(e) {
    if (e.target === floatingButton || floatingButton.contains(e.target)) {
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;
      isDragging = true;
      floatingButton.classList.add('dragging');
    }
  }

  function drag(e) {
    if (isDragging) {
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;

      xOffset = currentX;
      yOffset = currentY;

      setTranslate(currentX, currentY, floatingButton);
    }
  }

  function dragEnd(e) {
    if (!isDragging) return;

    const wasDragging = Math.abs(e.clientX - (initialX + xOffset)) > 5 || 
                       Math.abs(e.clientY - (initialY + yOffset)) > 5;

    initialX = currentX;
    initialY = currentY;
    isDragging = false;

    floatingButton.classList.remove('dragging');

    if (!wasDragging) {
      startTranslation();
    }

    savePosition();
  }

  function setTranslate(xPos, yPos, el) {
    const buttonWidth = el.offsetWidth;
    const buttonHeight = el.offsetHeight;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    xPos = Math.min(Math.max(xPos, -buttonWidth/2), windowWidth - buttonWidth/2);
    yPos = Math.min(Math.max(yPos, 0), windowHeight - buttonHeight);

    el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
  }

  function savePosition() {
    const position = { x: xOffset, y: yOffset };
    localStorage.setItem('deeplFloatingButtonPosition', JSON.stringify(position));
  }

  async function startTranslation() {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    if (selectedText) {
      const translator = new TranslationHelper();
      try {
        const translatedText = await translator.translate(selectedText);
        const range = selection.getRangeAt(0);
        const translationElement = translator.createTranslationElement(translatedText);
        range.collapse(false);
        range.insertNode(translationElement);
        selection.removeAllRanges();
      } catch (error) {
        console.error('Translation error:', error);
        showTooltip('翻译失败，请重试');
      }
    } else {
      showTooltip('请先选择要翻译的文本');
    }
  }

  function showTooltip(message) {
    const tooltip = document.createElement('div');
    tooltip.className = 'deepl-tooltip';
    tooltip.textContent = message;
    document.body.appendChild(tooltip);

    const buttonRect = floatingButton.getBoundingClientRect();
    tooltip.style.top = `${buttonRect.top - tooltip.offsetHeight - 10}px`;
    tooltip.style.left = `${buttonRect.left + buttonRect.width / 2}px`;

    // 使用 requestAnimationFrame 确保过渡动画正常工作
    requestAnimationFrame(() => {
      tooltip.classList.add('show');
    });

    setTimeout(() => {
      tooltip.classList.remove('show');
      // 等待过渡动画完成后再移除元素
      setTimeout(() => tooltip.remove(), 200);
    }, 2000);
  }

  floatingButton.addEventListener('mousedown', dragStart);
  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', dragEnd);

  document.body.appendChild(floatingButton);

  const savedPosition = localStorage.getItem('deeplFloatingButtonPosition');
  if (savedPosition) {
    const position = JSON.parse(savedPosition);
    xOffset = position.x;
    yOffset = position.y;
    setTranslate(position.x, position.y, floatingButton);
  }

  window.addEventListener('resize', () => {
    setTranslate(xOffset, yOffset, floatingButton);
  });
} 