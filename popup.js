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
    
    // 使用更完整的公式匹配规则
    const latexPatterns = [
      // 行间公式
      '(?<display_1>\\$\\$(\\\\\\$|[^\\$])*?\\$\\$)',
      '(?<display_2>\\\\\\[(\\\\\\]|[^\\]])*?\\\\\\])',
      '(?<display_3>\\\\begin\\{[^}]+\\}[\\s\\S]*?\\\\end\\{[^}]+\\})',
      // 行内公式
      '(?<inline_1>\\$(\\\\\\$|[^\\$])*?\\$)',
      '(?<inline_2>\\\\\\((\\\\\\)|[^)])*?\\\\\\))'
    ].join('|');
    
    const regex = new RegExp(latexPatterns + '|' + pattern, 'g');
    
    return text.replace(regex, (match, ...args) => {
      // 检查是否是 LaTeX 公式
      const groups = args[args.length - 1];
      if (groups.display_1 || groups.display_2 || groups.display_3 || 
          groups.inline_1 || groups.inline_2) {
        return match;
      }
      
      // 处理公式前后的空格
      const offset = args[args.length - 3];
      let leftSpace = "", rightSpace = "";
      
      // 更智能的空格处理
      const prevChar = text[offset - 1];
      const nextChar = text[offset + match.length];
      
      // 如果前后不是空格，且不是特殊字符，添加空格
      if (prevChar && !/[\s\(\[\{（【「『]/.test(prevChar)) {
        leftSpace = " ";
      }
      if (nextChar && !/[\s\)\]\}）】」』\,\.\!\?\;\:\,\.\。\，\、\；\：\？\！]/.test(nextChar)) {
        rightSpace = " ";
      }
      
      const blockId = this.blockCounter++;
      const placeholder = `{{BLOCK_${blockId}}}`;
      this.blocks.set(placeholder, leftSpace + match + rightSpace);
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

  // 处理各种类型的数学公式节点
  processMathNodes(container) {
    // 处理 MathML 节点
    this.processMathMLNodes(container);
    // 处理 MathJax 节点
    this.processMathJaxNodes(container);
    // 处理 KaTeX 节点
    this.processKaTeXNodes(container);
    // 处理行内和行间公式
    this.processInlineFormulas(container);
    // 清理无用节点
    this.cleanupNodes(container);
  }

    // 处理 MathML 节点
  processMathMLNodes(container) {
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
      if (altText && this.isValidFormula(altText)) {
        node.replaceWith(document.createTextNode(this.protectLatex(altText)));
        return;
      }

      // 最后尝试从数学内容中提取
      const mathContent = node.textContent;
      if (mathContent && this.isValidFormula(mathContent)) {
        node.replaceWith(document.createTextNode(this.protectLatex(mathContent)));
      }
    });
  }

    // 处理 MathJax 节点
  processMathJaxNodes(container) {
    const mathJaxNodes = container.querySelectorAll('.MathJax, .MathJax_Preview');
    mathJaxNodes.forEach(node => {
      // 检查是否已经处理过这个公式
      const mathId = node.getAttribute('id');
      if (mathId && container.querySelector(`script[id="${mathId}-Frame"]`)) {
        node.remove();
        return;
      }

      // 优先获取原始的 TeX 内容
      const mathSource = node.querySelector('script[type="math/tex"]');
      if (mathSource) {
        this.cleanupMathJaxNodes(node);
        node.replaceWith(document.createTextNode(this.protectLatex(mathSource.textContent)));
        return;
      }

      // 尝试从 annotation 中获取
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) {
        node.replaceWith(document.createTextNode(this.protectLatex(annotation.textContent)));
      }
    });
  }

    // 处理 KaTeX 节点
  processKaTeXNodes(container) {
    const katexNodes = container.querySelectorAll('.katex');
    katexNodes.forEach(node => {
      const texSource = node.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
      if (texSource) {
        const katexContainer = this.findKaTeXContainer(node);
        const texContent = this.collectAdjacentFormulas(katexContainer);
        katexContainer.replaceWith(document.createTextNode(this.protectLatex(texContent)));
      }
    });
  }

  // 处理行内公式
  processInlineFormulas(container) {
    const html = container.innerHTML;
    container.innerHTML = this.protectInlineLatex(html);
  }

  // 清理节点
  cleanupNodes(container) {
    // 移除所有剩余的 script[type="math/tex"] 节点
    container.querySelectorAll('script[type="math/tex"]').forEach(script => script.remove());
    
    // 清理文本节点
    this.cleanupTextNodes(container);
  }

  // 清理 MathJax 相关节点
  cleanupMathJaxNodes(node) {
    const parent = node.parentElement;
    if (parent) {
      // 移除预览节点
      const preview = parent.querySelector('.MathJax_Preview');
      if (preview) preview.remove();
      // 移除 script 节点
      const script = parent.querySelector('script[type="math/tex"]');
      if (script) script.remove();
    }
  }

  // 查找 KaTeX 容器
  findKaTeXContainer(node) {
    let container = node;
    while (container.parentElement && 
           (container.parentElement.tagName.toLowerCase() === 'var' ||
            container.parentElement.tagName.toLowerCase() === 'span')) {
      container = container.parentElement;
    }
    return container;
  }

  // 收集相邻的公式
  collectAdjacentFormulas(startNode) {
    const formulas = [];
    let currentNode = startNode;
    
    // 如果前一个节点是 KaTeX，不处理
    if (this.hasPreviousKaTeX(currentNode)) {
      return null;
    }

    // 收集当前和后续的 KaTeX 节点
    while (currentNode && this.isKaTeXNode(currentNode)) {
      const formula = this.extractFormula(currentNode);
      if (formula) formulas.push(formula);
      currentNode.setAttribute('data-to-remove', 'true');
      currentNode = currentNode.nextSibling;
    }
    
    return formulas.join(' ');
  }

  // 检查是否有前置的 KaTeX 节点
  hasPreviousKaTeX(node) {
    const prevSibling = node.previousSibling;
    return prevSibling && prevSibling.querySelector && 
           prevSibling.querySelector('.katex');
  }

  // 检查节点是否是 KaTeX 节点
  isKaTeXNode(node) {
    return node && node.querySelector && node.querySelector('.katex');
  }

  // 从节点中提取公式
  extractFormula(node) {
    const texSource = node.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
    return texSource ? texSource.textContent : null;
  }

  // 检查是否是有效的公式
  isValidFormula(text) {
    return !text.includes('subscript') && 
           !text.includes('POSTSUBSCRIPT') &&
           !text.includes('POSTSUPERSCRIPT');
  }

  // 清理文本节点
  cleanupTextNodes(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    textNodes.forEach(node => {
      if (this.shouldCleanNode(node.textContent)) {
        const latexMatch = node.textContent.match(/\\[a-zA-Z]+\{.*?\}/);
        node.textContent = latexMatch ? latexMatch[0] : '';
      }
    });
  }

  // 检查节点是否需要清理
  shouldCleanNode(text) {
    return text.includes('subscript') || 
           text.includes('POSTSUBSCRIPT') ||
           text.includes('POSTSUPERSCRIPT') ||
           text.includes('start_') ||
           text.includes('end_') ||
           text.includes('bold_') ||
           text.includes('italic_') ||
           text.includes('blackboard_');
  }

  protectLatex(formula) {
    // 判断是否为行间公式
    const isBlock = formula.includes('\\begin{') || formula.includes('\\[');
    return isBlock ? `$$${formula.trim()}$$` : `$${formula.trim()}$`;
  }

  protectInlineLatex(text) {
    // 保护行间公式
    text = this.textBlockReplacer.replace(text, /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g);
    // 保护行内公式
    text = this.textBlockReplacer.replace(text, /\$[^$]+\$|\\\([\s\S]*?\\\)/g);
    return text;
  }

  async translate(text) {
    if (!text || !text.trim()) {
      throw new Error('翻译文本不能为空');
    }

    try {
      // 预处理文本
      const processedText = this.preprocessText(text);
      
      // 发送翻译请求
      const response = await chrome.runtime.sendMessage({
        action: 'translate',
        data: {
          jsonrpc: '2.0',
          method: 'LMT_handle_texts',
          id: this.id,
          params: {
            texts: [{ text: processedText }],
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

      // 后处理文本
      const translatedText = this.postprocessText(response.data.result.texts[0].text);
      this.textBlockReplacer.clear();
      
      return translatedText;

    } catch (error) {
      console.error('Translation failed:', error);
      throw error;
    }
  }

  // 预处理文本
  preprocessText(text) {
    if (!text) return text;
    
    // 1. 保护所有公式
    const patterns = [
      // 行间公式
      /\$\$([\s\S]*?)\$\$/g,
      /\\\[([\s\S]*?)\\\]/g,
      // 行内公式
      /\$((?:\\.|[^$])*?)\$/g,
      /\\\(((?:\\.|[^)])*?)\\\)/g
    ];
    
    for (const pattern of patterns) {
      text = this.textBlockReplacer.replace(text, pattern);
    }
    
    // 2. 保护代码块
    text = this.textBlockReplacer.replace(text, /```[\s\S]*?```/g);
    
    // 3. 处理特殊字符转义
    const escapeRules = [
      { pattern: /(?<!\\)>(?!\s)/g, replacement: " &gt; " },
      { pattern: /(?<!\\)</g, replacement: " &lt; " },
      { pattern: /(?<!\\)\*/g, replacement: " &#42; " },
      { pattern: /(?<!\\)_/g, replacement: " &#95; " },
      { pattern: /(?<!\\)\\\\(?=\s)/g, replacement: "\\\\\\\\" },
      { pattern: /(?<!\\)\\(?![\\a-zA-Z0-9])/g, replacement: "\\\\" }
    ];
    
    for (const rule of escapeRules) {
      text = text.replace(rule.pattern, rule.replacement);
    }
    
    // 4. 处理 Markdown 格式
    if (this.isMarkdown(text)) {
      text = this.processMarkdownFormatting(text);
    }
    
    return text;
  }

  // 后处理文本
  postprocessText(text) {
    if (!text) return text;
    
    // 1. 修正格式
    text = this.fixFormatting(text);
    
    // 2. 恢复所有占位符
    text = this.textBlockReplacer.restore(text);
    
    // 3. 处理公式之间的空格
    text = text
      .replace(/】【/g, '】 【')
      .replace(/\]\[/g, '] [')
      .replace(/\}\{/g, '} {');
    
    return text;
  }

  // 修正格式
  fixFormatting(text) {
    // 修正公式与标点符号之间的空格
    text = this.fixPunctuation(text);
    // 修正中英文之间的空格
    text = this.fixChineseEnglishSpacing(text);
    // 清理多余的空格
    text = this.cleanupSpaces(text);
    return text;
  }

  // 修正标点符号
  fixPunctuation(text) {
    const rules = [
      // 处理中文标点
      { pattern: /(\$[^$]+\$)\s*([，。、；：？！）】」』}])/g, replacement: '$1$2' },
      { pattern: /([（【「『{])\s*(\$[^$]+\$)/g, replacement: '$1$2' },
      // 处理英文标点
      { pattern: /(\$[^$]+\$)\s*([,.;:?!)\]}])/g, replacement: '$1$2' },
      { pattern: /([([{])\s*(\$[^$]+\$)/g, replacement: '$1$2' }
    ];

    return rules.reduce((text, rule) => 
      text.replace(rule.pattern, rule.replacement), text);
  }

  // 修正中英文之间的空格
  fixChineseEnglishSpacing(text) {
    return text
      // 在中英文之间添加空格
      .replace(/([\u4e00-\u9fa5])([\w])/g, '$1 $2')
      .replace(/([\w])([\u4e00-\u9fa5])/g, '$1 $2')
      // 修复误加的空格
      .replace(/([，。、；：？！）】」』}])(\s+)/g, '$1')
      .replace(/(\s+)([（【「『{])/g, '$2');
  }

  // 清理空格
  cleanupSpaces(text) {
    return text
      .replace(/\s+/g, ' ')  // 合并多个空格
      .replace(/^\s+|\s+$/g, '')  // 去除首尾空格
      .replace(/\s+([，。、；：？！）】」』}])/g, '$1')  // 去除标点前的空格
      .replace(/([（【「『{])\s+/g, '$1');  // 去除标点后的空格
  }

  formatText(text) {
    // 处理 LaTeX 公式
    const protectedFormulas = new Map();
    let counter = 0;

    // 处理所有 LaTeX 公式
    text = text.replace(/\$([^$]+)\$/g, (match, formula) => {
      // 处理上下标
      let processedFormula = this.processSubscriptsAndSuperscripts(formula);
      // 修复括号
      processedFormula = this.fixBrackets(processedFormula);

      const placeholder = `__FORMULA_${counter}__`;
      // 转义下划线
      const escapedFormula = `$${processedFormula}$`.replace(/_/g, '\\_');
      protectedFormulas.set(placeholder, escapedFormula);
      counter++;
      return placeholder;
    });

    // 处理 Markdown 格式
    text = this.processMarkdownFormatting(text);

    // 恢复公式
    for (const [placeholder, formula] of protectedFormulas) {
      text = text.replace(placeholder, ` ${formula} `);
    }

    return text;
  }

  // 处理上下标
  processSubscriptsAndSuperscripts(formula) {
    // 处理同时包含上下标的情况
    let processed = formula.replace(
      /([A-Za-z\d]+)([_^])([^{]|{[^}]*})\s*([_^])([^{]|{[^}]*})/g,
      (match, base, op1, sub1, op2, sub2) => {
        const fixedSub1 = sub1.startsWith('{') ? sub1 : `{${sub1}}`;
        const fixedSub2 = sub2.startsWith('{') ? sub2 : `{${sub2}}`;
        return `${base}${op1}${fixedSub1}${op2}${fixedSub2}`;
      }
    );

    // 处理单独的上标或下标
    processed = processed.replace(/([_^])([^{]|$)/g, '$1{$2}');
    
    return processed;
  }

  // 修复括号
  fixBrackets(text) {
      let depth = 0;
    let fixed = '';
    for (const char of text) {
        if (char === '{') depth++;
        else if (char === '}') depth--;
      fixed += char;
      }
    // 补充缺失的右括号
      while (depth > 0) {
      fixed += '}';
        depth--;
    }
    return fixed;
  }

  // 处理 Markdown 格式
  processMarkdownFormatting(text) {
    const mdRules = [
      // 处理中文下划线
      { pattern: /(\s_[\u4e00-\u9fa5]+_)([\u4e00-\u9fa5]+)/g, replacement: "$1 $2" },
      { pattern: /(_[\u4e00-\u9fa5]+_\s)([\u4e00-\u9fa5]+)/g, replacement: " $1$2" },
      { pattern: /(_[\u4e00-\u9fa5]+_)([\u4e00-\u9fa5]+)/g, replacement: " $1 $2" },
      // 处理中文括号
      { pattern: /（([\s\S]*?)）/g, replacement: "($1)" },
      // 处理粗体
      { pattern: /\*\* (.*?) \*\*/g, replacement: "**$1**" },
      // 处理斜体
      { pattern: /\* (.*?) \*/g, replacement: "*$1*" },
      // 处理行内代码
      { pattern: /` (.*?) `/g, replacement: "`$1`" }
    ];
    
    return mdRules.reduce((text, rule) => 
      text.replace(rule.pattern, rule.replacement), text);
  }

  createTranslationElement(translatedText, isLoading = false, error = null) {
    const element = TranslationUI.createTranslationElement(translatedText, isLoading, error);
    
    if (!isLoading && !error) {
      TranslationUI.setupEventHandlers(element, translatedText);
    }
    
    return element;
  }
}

class TranslationUI {
  static initMarkdownIt() {
    if (!this.md) {
      // 使用更完整的 markdown-it 配置
      this.md = markdownit({
        html: true,
        breaks: true,
        typographer: true,
        linkify: true,
        quotes: ['""', '\'\''],
        langPrefix: 'language-'
      });

      // 配置数学公式规则
      const mathInline = (tokens, idx) => {
        const content = tokens[idx].content;
        return `<span class="math inline">$${content}$</span>`;
      };

      const mathBlock = (tokens, idx) => {
        const content = tokens[idx].content;
        return `<div class="math display">$$${content}$$</div>`;
      };

      // 配置表格渲染
      this.md.renderer.rules.table_open = () => '<div class="table-wrapper"><table class="table">';
      this.md.renderer.rules.table_close = () => '</table></div>';

      // 配置数学公式渲染规则
      this.md.use((md) => {
        // 行内公式规则
        md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
          const pos = state.pos;
          const str = state.src;
          
          if (str.charCodeAt(pos) !== 0x24 /* $ */) return false;
          
          let end = pos + 1;
          let found = false;
          
          while (end < str.length && str.charCodeAt(end) !== 0x24 /* $ */) {
            if (str.charCodeAt(end) === 0x5C /* \ */) {
              end += 2;
              continue;
            }
            end++;
          }
          
          if (end >= str.length) return false;
          if (pos + 1 === end) return false;
          
          if (!silent) {
            const token = state.push('math_inline', 'math', 0);
            token.content = str.slice(pos + 1, end);
            token.markup = '$';
          }
          
          state.pos = end + 1;
          return true;
        });

        // 行间公式规则
        md.block.ruler.before('fence', 'math_block', (state, start, end, silent) => {
          let pos = state.bMarks[start] + state.tShift[start];
          let str = state.src;
          
          if (pos + 2 > str.length) return false;
          if (str.slice(pos, pos + 2) !== '$$') return false;
          
          pos += 2;
          let lineMax = str.length;
          
          // 查找结束标记
          while (pos < lineMax) {
            if (str.slice(pos, pos + 2) === '$$') {
              if (!silent) {
                let content = str.slice(state.bMarks[start] + 2, pos);
                let token = state.push('math_block', 'math', 0);
                token.block = true;
                token.content = content;
                token.markup = '$$';
                token.map = [start, state.line];
              }
              state.line = start + 1;
              return true;
            }
            pos++;
          }
          
          return false;
        });

        md.renderer.rules.math_inline = mathInline;
        md.renderer.rules.math_block = mathBlock;
      });
    }
  }

  static createMarkdownView(text) {
    const view = document.createElement('div');
    view.className = 'deepl-markdown-view';
    
    try {
      // 初始化 markdown-it
      this.initMarkdownIt();
      
      // 创建临时的 TextBlockReplacer 用于保护公式
      const replacer = new TextBlockReplacer();
      
      // 1. 保护所有公式
      const patterns = [
        // 行间公式
        /\$\$([\s\S]*?)\$\$/g,
        /\\\[([\s\S]*?)\\\]/g,
        // 行内公式
        /\$((?:\\.|[^$])*?)\$/g,
        /\\\(((?:\\.|[^)])*?)\\\)/g
      ];
      
      let processedText = text;
      for (const pattern of patterns) {
        processedText = replacer.replace(processedText, pattern);
      }
      
      // 2. 保护代码块
      processedText = replacer.replace(processedText, /```[\s\S]*?```/g);
      
      // 3. 渲染 Markdown
      let renderedText = this.md.render(processedText);
      
      // 4. 恢复公式和代码块
      renderedText = replacer.restore(renderedText);
      
      view.innerHTML = renderedText;
      
      // 5. 渲染数学公式
      if (typeof katex !== 'undefined' && typeof renderMathInElement !== 'undefined') {
        renderMathInElement(view, {
          delimiters: [
            {left: "$$", right: "$$", display: true},
            {left: "\\[", right: "\\]", display: true},
            {left: "$", right: "$", display: false},
            {left: "\\(", right: "\\)", display: false}
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
        
        // 6. 渲染代码块中的公式
        view.querySelectorAll('pre code').forEach((element) => {
          const codeText = element.textContent;
          const hasLatex = patterns.some(pattern => pattern.test(codeText));
          if (hasLatex) {
            renderMathInElement(element, {
              delimiters: [
                {left: "$$", right: "$$", display: true},
                {left: "\\[", right: "\\]", display: true},
                {left: "$", right: "$", display: false},
                {left: "\\(", right: "\\)", display: false}
              ],
              throwOnError: false,
              errorColor: '#cc0000',
              strict: false,
              trust: true
            });
          }
        });
      }
      
    } catch (error) {
      console.error('Rendering error:', error);
      view.textContent = text;
    }
    
    return view;
  }

  static createTranslationElement(translatedText, isLoading = false, error = null) {
    const element = document.createElement('div');
    element.className = 'deepl-translation';

    if (isLoading) {
      element.appendChild(this.createLoadingView());
    } else if (error) {
      element.appendChild(this.createErrorView(error));
    } else {
      element.appendChild(this.createResultView(translatedText));
    }

    return element;
  }

  static createLoadingView() {
    const container = document.createElement('div');
    
    // 添加工具栏
    container.appendChild(this.createToolbar('DeepL API Free', ['close']));
    
    // 添加加载提示
    const content = document.createElement('div');
    content.className = 'deepl-content';
    content.innerHTML = '<div class="deepl-loading">DeepL API Free 正在翻译...</div>';
    container.appendChild(content);
    
    return container;
  }

  static createErrorView(error) {
    const container = document.createElement('div');
    
    // 添加工具栏
    container.appendChild(this.createToolbar('DeepL API Free', ['refresh', 'close']));
    
    // 添加错误信息
    const content = document.createElement('div');
    content.className = 'deepl-content';
    content.innerHTML = `<div class="deepl-error">${error}</div>`;
    container.appendChild(content);
    
    return container;
  }

  static createResultView(text) {
    const container = document.createElement('div');
    
    // 添加工具栏
    container.appendChild(this.createToolbar('DeepL API Free', [
      'content_copy',
      'code',
      'expand_less',
      'close',
    ]));
    
    // 添加内容区
    const content = document.createElement('div');
    content.className = 'deepl-content';

    // 创建显示容器
    const displayContainer = document.createElement('div');
    displayContainer.className = 'deepl-display-container';

    // 创建Markdown渲染视图
    const markdownView = this.createMarkdownView(text);
    displayContainer.appendChild(markdownView);
    
    // 创建源码视图
    const sourceView = this.createSourceView(text);
    displayContainer.appendChild(sourceView);
    
    content.appendChild(displayContainer);
    container.appendChild(content);
    
    return container;
  }

  static createToolbar(title, buttons) {
    const toolbar = document.createElement('div');
    toolbar.className = 'deepl-toolbar';
    
    // 添加标题
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    titleSpan.className = 'deepl-tool-type';
    toolbar.appendChild(titleSpan);
    
    // 添加按钮
    const toolsDiv = document.createElement('div');
    toolsDiv.className = 'deepl-tools';

    buttons.forEach(icon => {
      toolsDiv.appendChild(this.createButton(icon));
    });
    
    toolbar.appendChild(toolsDiv);
    return toolbar;
  }

  static createButton(icon) {
      const button = document.createElement('button');
      button.className = 'deepl-button';
    
      const iconSpan = document.createElement('span');
      iconSpan.className = 'material-symbols-rounded';
      iconSpan.innerHTML = icon;
    
      button.appendChild(iconSpan);
    button.title = this.getButtonTitle(icon);
    
      return button;
  }

  static getButtonTitle(icon) {
    const titles = {
      'content_copy': '复制翻译内容',
      'code': '查看 Markdown 格式',
      'expand_less': '折叠/展开',
      'close': '关闭',
      'refresh': '重新翻译',
      'visibility': '查看渲染结果'
    };
    return titles[icon] || '';
  }

  static initTurndownService() {
    if (!this.turndownService) {
      this.turndownService = new TurndownService({ bulletListMarker: '-' });
      
      // 保留原始标签
      this.turndownService.keep(['del']);
      
      // 移除不需要的元素
      this.turndownService.addRule('removeByClass', {
        filter: function (node) {
          return node.classList.contains('html2md-panel') ||
            node.classList.contains('div-btn-copy') ||
            node.classList.contains('btn-copy') ||
            node.classList.contains('overlay') ||
            node.classList.contains('monaco-editor') ||
            node.nodeName === 'SCRIPT';
        },
        replacement: function () {
          return '';
        }
      });
      
      // 处理行内公式
      this.turndownService.addRule('inline-math', {
        filter: function (node) {
          return node.tagName.toLowerCase() === "span" && node.className === "katex";
        },
        replacement: function (content, node) {
          const latex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
          if (latex) {
            return "$" + latex.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "$";
          }
          return content;
        }
      });
      
      // 处理行间公式
      this.turndownService.addRule('block-math', {
        filter: function (node) {
          return node.tagName.toLowerCase() === "span" && node.className === "katex-display";
        },
        replacement: function (content, node) {
          const latex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
          if (latex) {
            return "\n$$\n" + latex.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "\n$$\n";
          }
          return content;
        }
      });
      
      // 处理代码块
      this.turndownService.addRule('pre', {
        filter: function (node) {
          return node.tagName.toLowerCase() === "pre";
        },
        replacement: function (content, node) {
          if (!node.classList.contains('source-code-for-copy') && !node.classList.contains('prettyprint')) {
            return "```\n" + content + "```\n";
          }
          return "";
        }
      });
      
      // 处理表格
      this.turndownService.addRule('bordertable', {
        filter: 'table',
        replacement: function (content, node) {
          if (node.classList.contains('table')) {
            const output = [];
            let thead = '';
            const trs = node.querySelectorAll('tr');
            
            if (trs.length > 0) {
              const ths = trs[0].querySelectorAll('th, td');
              if (ths.length > 0) {
                thead = '| ' + Array.from(ths).map(th => 
                  TranslationUI.turndownService.turndown(th.innerHTML.trim())
                ).join(' | ') + ' |\n';
                thead += '| ' + Array.from(ths).map(() => ' --- ').join('|') + ' |\n';
              }
            }
            
            Array.from(trs).forEach((row, i) => {
              if (i > 0) {
                const cells = row.querySelectorAll('td,th');
                const trow = '| ' + Array.from(cells).map(cell => 
                  TranslationUI.turndownService.turndown(cell.innerHTML.trim())
                ).join(' | ') + ' |';
                output.push(trow);
              }
            });
            
            return thead + output.join('\n');
          }
          return content;
        }
      });
    }
  }

  static createSourceView(text) {
    const view = document.createElement('div');
    view.className = 'deepl-code-view';
    view.style.display = 'none';
    
        const pre = document.createElement('pre');
        const code = document.createElement('code');
    code.textContent = text;
        pre.appendChild(code);
    view.appendChild(pre);
    
    return view;
  }

  static renderMathInElement(element) {
    renderMathInElement(element, {
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
  }

  static setupEventHandlers(element, translatedText) {
    const copyButton = element.querySelector('button[title="复制翻译内容"]');
    const viewButton = element.querySelector('button[title="查看 Markdown 格式"]');
    const toggleButton = element.querySelector('button[title="折叠/展开"]');
    const closeButton = element.querySelector('button[title="关闭"]');
    
    if (copyButton) {
      copyButton.onclick = () => this.handleCopy(copyButton, translatedText);
    }
    
    if (viewButton) {
      viewButton.onclick = () => this.handleViewToggle(element, viewButton);
    }
    
    if (toggleButton) {
      toggleButton.onclick = () => this.handleCollapse(element, toggleButton);
    }
    
    if (closeButton) {
      closeButton.onclick = () => element.remove();
    }
  }

  static handleCopy(button, text) {
    navigator.clipboard.writeText(text).then(() => {
      const icon = button.querySelector('.material-symbols-rounded');
          icon.style.color = '#059669';
          setTimeout(() => {
            icon.style.color = '';
          }, 1000);
        });
  }

  static handleViewToggle(element, button) {
    const markdownView = element.querySelector('.deepl-markdown-view');
    const codeView = element.querySelector('.deepl-code-view');
    const icon = button.querySelector('.material-symbols-rounded');
    
    const isShowingCode = markdownView.style.display === 'none';
    
    if (isShowingCode) {
          markdownView.style.display = 'block';
          codeView.style.display = 'none';
      icon.innerHTML = 'code';
      button.title = '查看 Markdown 格式';
    } else {
      markdownView.style.display = 'none';
      codeView.style.display = 'block';
      icon.innerHTML = 'visibility';
      button.title = '查看渲染结果';
    }
  }

  static handleCollapse(element, button) {
    const content = element.querySelector('.deepl-content');
    const isCollapsed = button.classList.contains('collapsed');
    
    if (!isCollapsed) {
      const height = content.scrollHeight;
      content.style.height = height + 'px';
      content.offsetHeight; // 触发重排
      content.style.height = '0';
      content.style.margin = '0';
      content.style.opacity = '0';
      button.classList.add('collapsed');
        } else {
      content.style.height = 'auto';
      content.style.opacity = '0';
      const height = content.scrollHeight;
      content.style.height = '0';
      content.offsetHeight; // 触发重排
      content.style.height = height + 'px';
      content.style.margin = '';
      content.style.opacity = '1';
      button.classList.remove('collapsed');
          setTimeout(() => {
        content.style.height = 'auto';
          }, 300);
        }
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
      const text = selectedContent.text.trim();
      
      if (!text) {
        showTooltip('请先选择要翻译的文本');
        return;
      }

      // 检查是否是 LaTeX 公式
      const isLatexFormula = (text) => {
        // 匹配行间公式
        const blockFormulaPattern = /^\s*\$\$([\s\S]*?)\$\$\s*$/;
        // 匹配行内公式
        const inlineFormulaPattern = /^\s*\$((?:\\.|[^$])*?)\$\s*$/;
        // 匹配其他格式的公式
        const otherFormulaPattern = /^\s*(?:\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\))\s*$/;
        
        return blockFormulaPattern.test(text) || 
               inlineFormulaPattern.test(text) || 
               otherFormulaPattern.test(text);
      };

      // 如果是 LaTeX 公式，直接显示
      if (isLatexFormula(text)) {
        // 清除选中的文本
        window.getSelection().removeAllRanges();
        
        // 创建显示元素
        translationElement = translator.createTranslationElement(text);
        range.collapse(false);
        range.insertNode(translationElement);
        
        // 渲染公式
        const markdownView = translationElement.querySelector('.deepl-markdown-view');
        if (markdownView && typeof katex !== 'undefined' && typeof renderMathInElement !== 'undefined') {
          renderMathInElement(markdownView, {
            delimiters: [
              {left: "$$", right: "$$", display: true},
              {left: "\\[", right: "\\]", display: true},
              {left: "$", right: "$", display: false},
              {left: "\\(", right: "\\)", display: false}
            ],
            throwOnError: false,
            errorColor: '#cc0000',
            strict: false,
            trust: true
          });
        }
        return;
      }

      // 显示加载状态
      translationElement = translator.createTranslationElement(null, true);
      range.collapse(false);
      range.insertNode(translationElement);

      // 执行翻译
      const translatedText = await translator.translate(text);
      
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