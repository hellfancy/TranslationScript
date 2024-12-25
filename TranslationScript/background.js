// 监听扩展图标点击事件
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { action: 'toggleTranslator' });
});

// 监听来自内容脚本的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translate') {
    handleTranslation(request.data)
      .then(response => {
        sendResponse({ success: true, data: response });
      })
      .catch(error => {
        console.error('Translation error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

async function handleTranslation(data) {
  const API_KEY = 'e7f1bf82-507d-47e3-94be-cc5d85706dca:fx'; // 用户需要在此处填入自己的 DeepL API Free 密钥
  
  if (!API_KEY) {
    throw new Error('请先设置 DeepL API Free 密钥');
  }

  try {
    const response = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [data.params.texts[0].text],
        source_lang: data.params.lang.source_lang_user_selected === 'auto' ? null : data.params.lang.source_lang_user_selected,
        target_lang: data.params.lang.target_lang,
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${errorText}`);
    }

    const result = await response.json();
    return {
      jsonrpc: "2.0",
      id: data.id,
      result: {
        texts: [
          {
            text: result.translations[0].text,
            detected_source_language: result.translations[0].detected_source_language
          }
        ],
        lang: data.params.lang
      }
    };
  } catch (error) {
    console.error('Translation request failed:', error);
    throw error;
  }
} 