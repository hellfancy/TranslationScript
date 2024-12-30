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
    this.blockCounter = 0;
  }

  replace(text, pattern) {
    if (!text) return text;
    
    return text.replace(pattern, (match) => {
      const blockId = this.blockCounter++;
      const placeholder = `{{BLOCK_${blockId}}}`;
      this.blocks.set(placeholder, match);
      return placeholder;
    });
  }

  restore(text) {
    if (!text) return text;
    
    let result = text;
    for (const [placeholder, original] of this.blocks.entries()) {
      result = result.replace(placeholder, original);
    }
    return result;
  }

  clear() {
    this.blocks.clear();
    this.blockCounter = 0;
  }
}

class TranslationHelper {
  constructor() {
    this.id = Math.floor(Math.random() * 10000000) + 1;
    this.textBlockReplacer = new TextBlockReplacer();
    this.lastSelectedText = null;
  }

  isMarkdown(text) {
    // 检查是否包含常见的Markdown语法
    const markdownPatterns = [
      /^#+\s+/m,                    // 标题
      /\[.+?\]\(.+?\)/,            // 链接
      /`{1,3}[^`]+`{1,3}/,         // 代码块
      /\*\*.+?\*\*/,               // 粗体
      /\*.+?\*/,                   // 斜体
      /_{1,2}.+?_{1,2}/,           // 下划线
      /^\s*[-*+]\s+/m,             // 无序列表
      /^\s*\d+\.\s+/m,             // 有序列表
      /\${1,2}[^$]+\${1,2}/,       // LaTeX公式
      /\\\(.+?\\\)/,               // 行内LaTeX公式
      /\\\[.+?\\\]/                // 行间LaTeX公式
    ];
    return markdownPatterns.some(pattern => pattern.test(text));
  }

  getSelectedContent() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return { text: '', range: null };

    const range = selection.getRangeAt(0);
    const container = range.cloneContents();
    
    // 处理数学公式
    this.processMathNodes(container);
    
    const text = container.textContent;
    this.lastSelectedText = text;
    
    return { text, range };
  }

  processMarkdownContent(text) {
    // 保护所有LaTeX公式
    const latexPatterns = [
      /\${2}[^$]+\${2}/g,          // 行间公式 $$...$$
      /\$[^$\n]+\$/g,              // 行内公式 $...$
      /\\\([^)]+\\\)/g,            // 行内公式 \(...\)
      /\\\[[^\]]+\\\]/g,           // 行间公式 \[...\]
      /\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/g  // 环境公式
    ];

    let processedText = text;
    for (const pattern of latexPatterns) {
      processedText = this.textBlockReplacer.replace(processedText, pattern);
    }

    return processedText;
  }

  processMathNodes(container) {
    // 处理 MathML 节点
    const mathNodes = container.querySelectorAll('math');
    mathNodes.forEach(node => {
      // 优先获取原始的 LaTeX 内容
      const originalLatex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (originalLatex) {
        node.replaceWith(document.createTextNode(this.protectLatex(originalLatex)));
        return;
      }
      
      // 如果没有原始 LaTeX，尝试获取 alttext
      const altText = node.getAttribute('alttext');
      if (altText && !altText.includes('subscript') && !altText.includes('POSTSUBSCRIPT')) {
        node.replaceWith(document.createTextNode(this.protectLatex(altText)));
        return;
      }

      // 最后尝试从数学内容中提取
      const mathContent = node.textContent;
      if (mathContent && !mathContent.includes('subscript') && !mathContent.includes('POSTSUBSCRIPT')) {
        node.replaceWith(document.createTextNode(this.protectLatex(mathContent)));
      }
    });

    // 处理 MathJax 节点
    const mathJaxNodes = container.querySelectorAll('.MathJax, .MathJax_Preview');
    mathJaxNodes.forEach(node => {
      // 检查是否已经处理过这个公式
      const mathId = node.getAttribute('id');
      if (mathId && container.querySelector(`script[id="${mathId}-Frame"]`)) {
        // 如果存在对应的script标签，则移除当前节点
        node.remove();
        return;
      }

      // 优先获取原始的 TeX 内容
      const mathSource = node.querySelector('script[type="math/tex"]');
      if (mathSource) {
        // 替换整个 MathJax 相关的节点组
        const parent = node.parentElement;
        if (parent) {
          // 移除相关的预览节点
          const preview = parent.querySelector('.MathJax_Preview');
          if (preview) preview.remove();
          // 移除相关的 script 节点
          const script = parent.querySelector(`script[type="math/tex"]`);
          if (script) script.remove();
        }
        node.replaceWith(document.createTextNode(this.protectLatex(mathSource.textContent)));
        return;
      }

      // 尝试从 annotation 中获取
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) {
        node.replaceWith(document.createTextNode(this.protectLatex(annotation.textContent)));
      }
    });

    // 处理 KaTeX 节点
    const katexNodes = container.querySelectorAll('.katex');
    katexNodes.forEach(node => {
      // 优先获取原始的 TeX 内容
      const texSource = node.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
      if (texSource) {
        // 找到包含 KaTeX 的最外层容器（通常是 var 或 span）
        let katexContainer = node;
        while (katexContainer.parentElement && 
              (katexContainer.parentElement.tagName.toLowerCase() === 'var' ||
               katexContainer.parentElement.tagName.toLowerCase() === 'span')) {
          katexContainer = katexContainer.parentElement;
        }

        // 获取原始的 TeX 内容
        let texContent = texSource.textContent;

        // 检查是否有相邻的 KaTeX 节点
        const nextSibling = katexContainer.nextSibling;
        const prevSibling = katexContainer.previousSibling;
        
        // 如果前一个节点也是 KaTeX，不处理（让它作为一个整体处理）
        if (prevSibling && prevSibling.querySelector && prevSibling.querySelector('.katex')) {
          return;
        }

        // 如果后面还有 KaTeX 节点，收集它们的内容
        if (nextSibling && nextSibling.querySelector && nextSibling.querySelector('.katex')) {
          let currentNode = katexContainer;
          const fragments = [texContent];
          
          while (currentNode.nextSibling && 
                 currentNode.nextSibling.querySelector && 
                 currentNode.nextSibling.querySelector('.katex')) {
            currentNode = currentNode.nextSibling;
            const nextTexSource = currentNode.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
            if (nextTexSource) {
              fragments.push(nextTexSource.textContent);
            }
            // 标记这个节点待删除
            currentNode.setAttribute('data-to-remove', 'true');
          }
          
          // 合并所有片段
          texContent = fragments.join('');
        }

        // 替换为处理后的内容
        katexContainer.replaceWith(document.createTextNode(this.protectLatex(texContent)));

        // 删除已处理的相邻节点
        container.querySelectorAll('[data-to-remove="true"]').forEach(node => node.remove());
        return;
      }

      // 尝试从 tex-math 属性获取
      const texMath = node.getAttribute('data-tex-math');
      if (texMath) {
        let katexContainer = node;
        while (katexContainer.parentElement && 
              (katexContainer.parentElement.tagName.toLowerCase() === 'var' ||
               katexContainer.parentElement.tagName.toLowerCase() === 'span')) {
          katexContainer = katexContainer.parentElement;
        }
        katexContainer.replaceWith(document.createTextNode(this.protectLatex(texMath)));
      }
    });

    // 移除所有剩余的 script[type="math/tex"] 节点
    const mathScripts = container.querySelectorAll('script[type="math/tex"]');
    mathScripts.forEach(script => script.remove());

    // 获取所有文本节点
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    // 清理文本节点中的无用内容
    textNodes.forEach(node => {
      if (node.textContent.includes('subscript') || 
          node.textContent.includes('POSTSUBSCRIPT') ||
          node.textContent.includes('POSTSUPERSCRIPT') ||
          node.textContent.includes('start_') ||
          node.textContent.includes('end_') ||
          node.textContent.includes('bold_') ||
          node.textContent.includes('italic_') ||
          node.textContent.includes('blackboard_')) {
        // 检查是否包含 LaTeX 代码
        const latexMatch = node.textContent.match(/\\[a-zA-Z]+\{.*?\}/);
        if (latexMatch) {
          node.textContent = latexMatch[0];
        } else {
          node.textContent = '';
        }
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
    if (!text || !text.trim()) {
      throw new Error('翻译文本不能为空');
    }

    try {
      // 格式化文本
      const formattedText = this.formatText(text);
      
      // 发送翻译请求
      const response = await chrome.runtime.sendMessage({
        action: 'translate',
        data: {
          jsonrpc: '2.0',
          method: 'LMT_handle_texts',
          id: this.id,
          params: {
            texts: [
              {
                text: formattedText
              }
            ],
            lang: {
              source_lang_user_selected: 'auto',
              target_lang: 'ZH'
            }
          }
        }
      });

      if (!response.success) {
        throw new Error(response.error || '翻译请求失败');
      }

      // 恢复占位符
      const translatedText = this.textBlockReplacer.restore(response.data.result.texts[0].text);
      this.textBlockReplacer.clear();  // 清理占位符
      
      return translatedText;

    } catch (error) {
      console.error('Translation failed:', error);
      throw error;
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

  createTranslationElement(translatedText, isLoading = false, error = null) {
    const translationDiv = document.createElement('div');
    translationDiv.className = 'deepl-translation';

    const toolbarDiv = document.createElement('div');
    toolbarDiv.className = 'deepl-toolbar';

    const toolTypeSpan = document.createElement('span');
    toolTypeSpan.textContent = 'DeepL API Free';
    toolTypeSpan.className = 'deepl-tool-type';

    const toolsDiv = document.createElement('div');
    toolsDiv.className = 'deepl-tools';

    // 创建工具栏按钮
    const createButton = (icon, title) => {
      const button = document.createElement('button');
      button.className = 'deepl-button';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'material-symbols-rounded';
      iconSpan.innerHTML = icon;
      button.appendChild(iconSpan);
      button.title = title;
      return button;
    };

    const contentDiv = document.createElement('div');
    contentDiv.className = 'deepl-content';

    if (isLoading) {
      // 显示加载状态
      contentDiv.innerHTML = '<div class="deepl-loading">DeepL API Free 正在翻译...</div>';
      toolsDiv.appendChild(createButton('close', '关闭'));
    } else if (error) {
      // 显示错误信息和重试按钮
      contentDiv.innerHTML = `<div class="deepl-error">${error}</div>`;
      const retryButton = createButton('refresh', '重新翻译');
      const closeButton = createButton('close', '关闭');
      
      retryButton.onclick = async () => {
        try {
          // 使用保存的文本重新翻译
          if (this.lastSelectedText) {
            // 创建新的翻译元素
            const translationElement = this.createTranslationElement(null, true);
            
            // 检查原翻译框是否还存在于文档中
            if (translationDiv.parentNode) {
              // 如果存在，在原位置插入新元素并移除旧元素
              translationDiv.parentNode.insertBefore(translationElement, translationDiv);
              translationDiv.remove();
            } else {
              // 如果不存在，创建新的范围并插入
              const selection = window.getSelection();
              const range = document.createRange();
              const lastNode = selection.focusNode || document.body;
              range.setStartAfter(lastNode);
              range.collapse(true);
              range.insertNode(translationElement);
            }

            try {
              // 执行翻译
              const translatedText = await this.translate(this.lastSelectedText);
              if (!translatedText) {
                throw new Error('翻译结果为空');
              }

              const finalElement = this.createTranslationElement(translatedText);
              translationElement.replaceWith(finalElement);
            } catch (error) {
              // 如果翻译失败，替换加载状态为错误状态
              const errorElement = this.createTranslationElement(null, false, error.message || '翻译失败，请重试');
              translationElement.replaceWith(errorElement);
            }
          } else {
            showTooltip('无法获取之前选中的文本');
          }
        } catch (error) {
          console.error('Retry translation failed:', error);
          showTooltip(error.message || '重试失败，请稍后再试');
        }
      };
      
      closeButton.onclick = () => translationDiv.remove();
      
      toolsDiv.appendChild(retryButton);
      toolsDiv.appendChild(closeButton);
    } else {
      // 显示翻译结果
      const copyButton = createButton('content_copy', '复制翻译内容');
      const viewMarkdownButton = createButton('code', '查看 Markdown 格式');
      const toggleButton = createButton('expand_less', '折叠/展开');
      const closeButton = createButton('close', '关闭');

      // 创建显示容器
      const displayContainer = document.createElement('div');
      displayContainer.className = 'deepl-display-container';

      // 创建 Markdown 渲染视图
      const markdownView = document.createElement('div');
      markdownView.className = 'deepl-markdown-view';

      // 创建代码视图
      const codeView = document.createElement('div');
      codeView.className = 'deepl-code-view';
      codeView.style.display = 'none';

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
        code.textContent = translatedText;
        pre.appendChild(code);
        codeView.appendChild(pre);

        // 渲染数学公式
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
          }
        });

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
          viewMarkdownButton.querySelector('.material-symbols-rounded').innerHTML = 'visibility';
          viewMarkdownButton.title = '查看渲染结果';
        } else {
          markdownView.style.display = 'block';
          codeView.style.display = 'none';
          viewMarkdownButton.querySelector('.material-symbols-rounded').innerHTML = 'code';
          viewMarkdownButton.title = '查看 Markdown 代码';
        }
      };

      toggleButton.onclick = () => {
        isCollapsed = !isCollapsed;
        if (isCollapsed) {
          const height = contentDiv.scrollHeight;
          contentDiv.style.height = height + 'px';
          contentDiv.offsetHeight;
          contentDiv.style.height = '0';
          contentDiv.style.margin = '0';
          contentDiv.style.opacity = '0';
          toggleButton.classList.add('collapsed');
        } else {
          contentDiv.style.height = 'auto';
          contentDiv.style.opacity = '0';
          const height = contentDiv.scrollHeight;
          contentDiv.style.height = '0';
          contentDiv.offsetHeight;
          contentDiv.style.height = height + 'px';
          contentDiv.style.margin = '';
          contentDiv.style.opacity = '1';
          toggleButton.classList.remove('collapsed');
          setTimeout(() => {
            contentDiv.style.height = 'auto';
          }, 300);
        }
      };

      closeButton.onclick = () => translationDiv.remove();

      toolsDiv.appendChild(copyButton);
      toolsDiv.appendChild(viewMarkdownButton);
      toolsDiv.appendChild(toggleButton);
      toolsDiv.appendChild(closeButton);
    }

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
    let translationElement = null;
    let range = null;

    try {
      // 获取选中内容
      const selectedContent = translator.getSelectedContent();
      range = selectedContent.range;
      
      if (!selectedContent.text || !selectedContent.text.trim()) {
        showTooltip('请先选择要翻译的文本');
        return;
      }

      // 显示加载状态
      translationElement = translator.createTranslationElement(null, true);
      range.collapse(false);
      range.insertNode(translationElement);

      // 执行翻译
      const translatedText = await translator.translate(selectedContent.text);
      
      if (!translatedText) {
        throw new Error('翻译结果为空');
      }

      // 创建最终的翻译结果元素
      const finalElement = translator.createTranslationElement(translatedText);
      translationElement.replaceWith(finalElement);

    } catch (error) {
      console.error('Translation error:', error);
      
      if (translationElement) {
        // 显示错误信息和重试按钮
        const errorElement = translator.createTranslationElement(null, false, error.message || '翻译失败，请重试');
        translationElement.replaceWith(errorElement);
      } else if (range) {
        // 如果在显示加载状态之前就失败了，直接显示错误信息
        const errorElement = translator.createTranslationElement(null, false, error.message || '翻译失败，请重试');
        range.collapse(false);
        range.insertNode(errorElement);
      } else {
        // 如果连范围都没有，只能显示提示
        showTooltip(error.message || '翻译失败，请重试');
      }
    }

    // 清除选区
    window.getSelection().removeAllRanges();
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