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

class TextBlockReplacer {
  constructor() {
    this.blocks = new Map();
    this.counter = 0;
  }

  replace(text, regex) {
    return text.replace(regex, (match) => {
      const placeholder = `__BLOCK_${this.counter}__`;
      this.blocks.set(placeholder, match);
      this.counter++;
      return placeholder;
    });
  }

  recover(text) {
    let result = text;
    for (const [placeholder, block] of this.blocks) {
      result = result.replace(placeholder, block);
    }
    return result;
  }
}

class TranslationHelper {
  constructor() {
    this.id = Math.floor(Math.random() * 10000000) + 1;
    this.textBlockReplacer = new TextBlockReplacer();
  }

  getSelectedContent() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      throw new Error('请先选择要翻译的文本');
    }

    const range = selection.getRangeAt(0);
    if (!range || range.collapsed) {
      throw new Error('请先选择要翻译的文本');
    }

    // 克隆选中内容到临时容器
    const fragment = range.cloneContents();
    const container = document.createElement('div');
    container.appendChild(fragment);
    
    console.log('Original HTML:', container.innerHTML);

    // 处理数学公式节点
    this.processMathNodes(container);

    // 获取处理后的文本
    const processedText = container.textContent;
    console.log('Processed text:', processedText);
    
    return {
      text: processedText,
      range: range
    };
  }

  processMathNodes(container) {
    // 处理 MathML 节点
    const mathNodes = container.querySelectorAll('math');
    mathNodes.forEach(node => {
      const altText = node.getAttribute('alttext');
      if (altText) {
        node.replaceWith(document.createTextNode(this.protectLatex(altText)));
      } else {
        const mathContent = node.textContent;
        if (mathContent) {
          node.replaceWith(document.createTextNode(this.protectLatex(mathContent)));
        }
      }
    });

    // 处理 MathJax 节点
    const mathJaxNodes = container.querySelectorAll('.MathJax, .MathJax_Preview');
    mathJaxNodes.forEach(node => {
      const mathSource = node.querySelector('script[type="math/tex"]');
      if (mathSource) {
        node.replaceWith(document.createTextNode(this.protectLatex(mathSource.textContent)));
      }
    });

    // 处理 KaTeX 节点
    const katexNodes = container.querySelectorAll('.katex');
    katexNodes.forEach(node => {
      const texSource = node.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
      if (texSource) {
        node.replaceWith(document.createTextNode(this.protectLatex(texSource.textContent)));
      }
    });

    // 处理行内和行间公式
    const html = container.innerHTML;
    container.innerHTML = this.protectInlineLatex(html);
  }

  protectLatex(formula) {
    // 判断是否为行间公式
    const isBlock = formula.includes('\\begin{') || formula.includes('\\[');
    return isBlock ? `$$${formula.trim()}$$` : `$${formula.trim()}$`;
  }

  protectInlineLatex(text) {
    // 保护行间公式，确保公式两边有空格
    text = this.textBlockReplacer.replace(text, /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g);
    // 保护行内公式，确保公式两边有空格
    text = this.textBlockReplacer.replace(text, /\$[^$]+\$|\\\([\s\S]*?\\\)/g);
    return text;
  }

  async translate(text) {
    if (!text.trim()) return '';
    
    try {
      // 保护 LaTeX 公式
      const protectedText = this.protectInlineLatex(text);
      console.log('Protected text:', protectedText);

      // 保护占位符中的下划线，避免被翻译服务处理
      const escapedText = protectedText.replace(/__BLOCK_(\d+)__/g, '{{BLOCK_$1}}');

      const iCount = Math.floor(Math.random() * 10000) + 1;
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
                  "text": escapedText,
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
          resolve(response);
        });
      });

      if (!response || !response.success) {
        throw new Error(response?.error?.message || 'Translation failed');
      }

      let translatedText = response.data.result.texts[0].text;

      // 恢复占位符中的下划线
      translatedText = translatedText.replace(/{{BLOCK_(\d+)}}/g, '__BLOCK_$1__');

      // 恢复 LaTeX 公式
      translatedText = this.textBlockReplacer.recover(translatedText);

      // 清理 LaTeX 公式后的多余下划线
      translatedText = translatedText.replace(/(\$\$[\s\S]*?\$\$|\$[^$]+\$)_+(?!\w)/g, '$1');

      // 格式化翻译结果
      translatedText = this.formatText(translatedText);

      console.log('Restored text:', translatedText);
      return translatedText;

    } catch (error) {
      console.error('Translation error details:', error);
      if (error.message.includes('timeout')) {
        throw new Error('翻译请求超时，请检查网络连接后重试');
      } else if (error.message.includes('API Error')) {
        throw new Error('翻译服务出错，请稍后重试');
      } else {
        throw new Error('翻译失败：' + (error.message || '未知错误'));
      }
    }
  }

  formatText(text) {
    // 处理 LaTeX 公式
    const protectedFormulas = new Map();
    let counter = 0;

    // 处理所有 LaTeX 公式，使用更精确的正则表达式来匹配下标和上标
    text = text.replace(/\$([^$]+)\$/g, (match, formula) => {
      // 先处理同时包含上下标的情况
      let processedFormula = formula.replace(/([A-Za-z\d]+)([_^])([^{]|{[^}]*})\s*([_^])([^{]|{[^}]*})/g, (match, base, op1, sub1, op2, sub2) => {
        // 确保子表达式都用大括号包裹
        const fixedSub1 = sub1.startsWith('{') ? sub1 : `{${sub1}}`;
        const fixedSub2 = sub2.startsWith('{') ? sub2 : `{${sub2}}`;
        return `${base}${op1}${fixedSub1}${op2}${fixedSub2}`;
      });

      // 然后处理单独的上标或下标
      processedFormula = processedFormula.replace(/([_^])([^{]|$)/g, '$1{$2}');
      
      // 检查并修复嵌套的大括号
      let depth = 0;
      let fixedFormula = '';
      for (let char of processedFormula) {
        if (char === '{') depth++;
        else if (char === '}') depth--;
        fixedFormula += char;
      }
      // 补充缺失的右大括号
      while (depth > 0) {
        fixedFormula += '}';
        depth--;
      }

      const placeholder = `__FORMULA_${counter}__`;
      // 在公式中的下划线前添加反斜杠，防止被解析为 Markdown
      const escapedFormula = `$${fixedFormula}$`.replace(/_/g, '\\_');
      protectedFormulas.set(placeholder, escapedFormula);
      counter++;
      return placeholder;
    });

    // markdown修正
    const mdRuleMap = [
      { pattern: /(\s_[\u4e00-\u9fa5]+_)([\u4e00-\u9fa5]+)/g, replacement: "$1 $2" }, // 斜体
      { pattern: /(_[\u4e00-\u9fa5]+_\s)([\u4e00-\u9fa5]+)/g, replacement: " $1$2" },
      { pattern: /(_[\u4e00-\u9fa5]+_)([\u4e00-\u9fa5]+)/g, replacement: " $1 $2" },
      { pattern: /（([\s\S]*?)）/g, replacement: "($1)" }, // 中文（）
      { pattern: /\*\* (.*?) \*\*/g, replacement: "**$1**" } // 加粗
    ];
    mdRuleMap.forEach(({ pattern, replacement }) => {
      text = text.replace(pattern, replacement);
    });

    // 清理多余的空格，但保留公式占位符
    text = text.replace(/\s+/g, ' ').trim();

    // 恢复所有的 LaTeX 公式，并确保公式与标点符号之间有空格
    for (const [placeholder, formula] of protectedFormulas) {
      // 在恢复公式时添加空格，同时处理标点符号
      text = text.replace(placeholder, ` ${formula} `);
    }

    // 处理公式与标点符号之间的空格
    // 处理中文标点
    text = text.replace(/(\$[^$]+\$)\s*([，。、；：？！）】」』}])/g, '$1 $2');
    text = text.replace(/([（【「『{])\s*(\$[^$]+\$)/g, '$1 $2');
    // 处理英文标点
    text = text.replace(/(\$[^$]+\$)\s*([,.;:?!)\]}])/g, '$1 $2');
    text = text.replace(/([([{])\s*(\$[^$]+\$)/g, '$1 $2');

    // 清理可能产生的多余空格
    text = text.replace(/\s+/g, ' ').trim();

    console.log('Formatted text:', text);
    return text;
  }

  createTranslationElement(translatedText) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      throw new Error('无法创建翻译结果：未找到选中的文本位置');
    }

    const range = selection.getRangeAt(0);
    if (!range) {
      throw new Error('无法创建翻译结果：未找到有效的选中范围');
    }

    const originalElement = range.startContainer.parentElement;
    if (!originalElement) {
      throw new Error('无法创建翻译结果：未找到原始元素');
    }

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

    const viewMarkdownButton = document.createElement('button');
    viewMarkdownButton.className = 'deepl-button';
    const codeIcon = document.createElement('span');
    codeIcon.className = 'material-symbols-rounded';
    codeIcon.innerHTML = 'code';
    viewMarkdownButton.appendChild(codeIcon);
    viewMarkdownButton.title = '查看 Markdown 格式';

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

    // 创建一个容器来切换显示模式
    const displayContainer = document.createElement('div');
    displayContainer.className = 'deepl-display-container';

    // 创建 Markdown 渲染视图
    const markdownView = document.createElement('div');
    markdownView.className = 'deepl-markdown-view';

    // 创建代码视图
    const codeView = document.createElement('div');
    codeView.className = 'deepl-code-view';
    codeView.style.display = 'none';  // 初始状态隐藏代码视图

    try {
      // 配置 marked 选项
      marked.setOptions({
        gfm: true,
        breaks: true,
        mangle: false,
        headerIds: false,
        sanitize: false
      });

      // 渲染 Markdown 内容
      markdownView.innerHTML = marked.parse(translatedText);

      // 创建代码预览
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.style.cssText = `
        display: block;
        padding: 16px;
        overflow-x: auto;
        background: #f8f9fa;
        color: #24292e;
        font-family: 'Consolas', 'Monaco', 'Andale Mono', 'Ubuntu Mono', monospace;
        font-size: 14px;
        line-height: 1.5;
        tab-size: 4;
        white-space: pre-wrap;
        word-break: break-all;
        word-wrap: break-word;
        border-radius: 4px;
      `;
      code.textContent = translatedText;
      pre.appendChild(code);
      codeView.appendChild(pre);

      // 使用 renderMathInElement 渲染数学公式
      try {
        renderMathInElement(markdownView, {
          delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false}
          ],
          throwOnError: false,
          errorColor: '#cc0000',
          strict: false,
          trust: true,
          macros: {
            "\\eqref": "\\href{#1}{}",
            "\\label": "\\href{#1}{}",
            "\\require": "\\href{#1}{}"
          },
          fleqn: false,
          leqno: false,
          maxSize: 500,
          maxExpand: 1000,
          minRuleThickness: 0.05,
          output: 'html',
          strict: false,
          trust: (context) => ['\\mathbb', '\\in'].includes(context.command),
          globalGroup: true
        });
        console.log('KaTeX rendering completed');
      } catch (error) {
        console.error('KaTeX rendering error:', error);
      }

    } catch (e) {
      console.error('Rendering error:', e);
      markdownView.textContent = translatedText;
    }

    displayContainer.appendChild(markdownView);
    displayContainer.appendChild(codeView);
    contentDiv.appendChild(displayContainer);

    let isCollapsed = false;
    let showingCode = false;

    copyButton.onclick = () => {
      navigator.clipboard.writeText(translatedText).then(() => {
        const icon = copyButton.querySelector('.material-symbols-rounded');
        icon.style.color = '#059669';
        setTimeout(() => {
          icon.style.color = '';
        }, 1000);
      });
    };

    viewMarkdownButton.onclick = () => {
      showingCode = !showingCode;
      if (showingCode) {
        markdownView.style.display = 'none';
        codeView.style.display = 'block';
        codeIcon.innerHTML = 'visibility';
        viewMarkdownButton.title = '查看渲染结果';
      } else {
        markdownView.style.display = 'block';
        codeView.style.display = 'none';
        codeIcon.innerHTML = 'code';
        viewMarkdownButton.title = '查看 Markdown 代码';
      }
    };

    toggleButton.onclick = () => {
      isCollapsed = !isCollapsed;
      if (isCollapsed) {
        // 先获取实际高度
        const height = contentDiv.scrollHeight;
        // 设置实际高度，触发动画起点
        contentDiv.style.height = height + 'px';
        // 强制回流
        contentDiv.offsetHeight;
        // 设置目标高度为0，开始动画
        contentDiv.style.height = '0';
        contentDiv.style.margin = '0';
        contentDiv.style.opacity = '0';  // 使用透明度来实现平滑过渡
        toggleButton.classList.add('collapsed');
      } else {
        // 移除高度限制，获取实际高度
        contentDiv.style.height = 'auto';
        contentDiv.style.opacity = '0';  // 先设置为透明
        const height = contentDiv.scrollHeight;
        // 设置起始高度
        contentDiv.style.height = '0';
        // 强制回流
        contentDiv.offsetHeight;
        // 设置目标高度，开始动画
        contentDiv.style.height = height + 'px';
        contentDiv.style.margin = '';
        contentDiv.style.opacity = '1';  // 逐渐显示内容
        toggleButton.classList.remove('collapsed');
        // 动画结束后移除固定高度
        setTimeout(() => {
          contentDiv.style.height = 'auto';
        }, 300); // 与 CSS 过渡时间相匹配
      }
    };

    closeButton.onclick = () => translationDiv.remove();

    toolsDiv.appendChild(copyButton);
    toolsDiv.appendChild(viewMarkdownButton);
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
    const translator = new TranslationHelper();
    try {
      const { text, range } = translator.getSelectedContent();
      
      if (!text || !text.trim()) {
        showTooltip('请先选择要翻译的文本');
        return;
      }

      const translatedText = await translator.translate(text);
      if (!translatedText) {
        showTooltip('翻译结果为空');
        return;
      }

      try {
        const translationElement = translator.createTranslationElement(translatedText);
        range.collapse(false);
        range.insertNode(translationElement);
        window.getSelection().removeAllRanges();
      } catch (insertError) {
        console.error('Failed to insert translation:', insertError);
        showTooltip('无法插入翻译结果：' + insertError.message);
      }
    } catch (error) {
      console.error('Translation error:', error);
      showTooltip(error.message || '翻译失败，请重试');
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