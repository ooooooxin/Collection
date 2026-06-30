/**
 * 跨境智采 - Background Service Worker
 * 处理跨域图片代理、多线程并发抓取、任务调度、断点续传及桌面通知
 */

// 缓存规则
let parserRules = null;

// 从本地或云端获取解析规则
async function loadRules() {
  try {
    const response = await fetch(chrome.runtime.getURL('rules.json'));
    parserRules = await response.json();
    console.log('Loaded parser rules:', parserRules);
  } catch (error) {
    console.error('Failed to load rules:', error);
  }
}

// 初始化加载规则
chrome.runtime.onInstalled.addListener(() => {
  loadRules();
  // 初始化存储
  chrome.storage.local.set({
    dailyQuota: { date: new Date().toLocaleDateString(), count: 0 },
    currentTask: null // 存储批量任务状态
  });
});

chrome.runtime.onStartup.addListener(() => {
  loadRules();
});

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'proxyFetchImage') {
    // 代理下载图片以避免 Canvas 跨域污染
    fetchImageAsBase64(request.url)
      .then(base64 => sendResponse({ success: true, base64 }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 异步响应
  }

  if (request.action === 'startBatchScrape') {
    // 启动批量采集任务
    handleBatchScrape(request.urls, request.userLevel)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'getRules') {
    if (parserRules) {
      sendResponse({ success: true, rules: parserRules });
    } else {
      loadRules().then(() => sendResponse({ success: true, rules: parserRules }));
    }
    return true;
  }

  if (request.action === 'showNotification') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: request.title || '跨境智采',
      message: request.message || '任务已完成！',
      priority: 1
    });
    sendResponse({ success: true });
  }
});

/**
 * 代理获取图片并转为 Base64
 */
async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

/**
 * 处理批量抓取任务（控制并发及会员额度）
 */
async function handleBatchScrape(urls, userLevel = 'free') {
  // 1. 额度检查
  const todayStr = new Date().toLocaleDateString();
  const storage = await chrome.storage.local.get(['dailyQuota']);
  let quota = storage.dailyQuota || { date: todayStr, count: 0 };
  
  if (quota.date !== todayStr) {
    quota = { date: todayStr, count: 0 };
  }

  if (userLevel === 'free') {
    if (urls.length > 1) {
      throw new Error('免费用户单次最多提交 1 个链接！请升级高级会员解锁批量采集。');
    }
    if (quota.count >= 5) {
      throw new Error('已达到每日 5 次的免费采集限额！请明天再试或升级高级会员。');
    }
  }

  // 2. 初始化任务状态以支持断点续传
  const taskState = {
    id: Date.now().toString(),
    urls: urls,
    currentIndex: 0,
    results: [],
    failedUrls: [],
    status: 'running',
    userLevel: userLevel
  };
  await chrome.storage.local.set({ currentTask: taskState });

  // 3. 执行采集调度 (如果是高级会员使用并发抓取，普通会员单线程)
  const concurrency = userLevel === 'vip' ? 3 : 1;
  runScrapeQueue(taskState, concurrency);

  return { taskId: taskState.id, message: '任务已在后台启动' };
}

/**
 * 并发控制队列执行
 */
async function runScrapeQueue(taskState, concurrency) {
  let index = 0;
  const activePromises = [];
  const results = [];
  const failedUrls = [];

  const runNext = async () => {
    if (index >= taskState.urls.length) return;
    
    // 检查任务是否被暂停或取消
    const current = await chrome.storage.local.get(['currentTask']);
    if (!current.currentTask || current.currentTask.status !== 'running') {
      console.log('Task paused or deleted');
      return;
    }

    const itemIndex = index++;
    const url = taskState.urls[itemIndex];
    
    // 更新进度状态
    taskState.currentIndex = itemIndex;
    await chrome.storage.local.set({ currentTask: taskState });

    try {
      const data = await scrapeSingleUrl(url);
      results.push(data);
      taskState.results = results;
    } catch (err) {
      console.error(`Scrape failed for ${url}:`, err);
      failedUrls.push({ url, error: err.message });
      taskState.failedUrls = failedUrls;
    }

    // 更新每日免费额度
    if (taskState.userLevel === 'free') {
      const quotaStorage = await chrome.storage.local.get(['dailyQuota']);
      const todayStr = new Date().toLocaleDateString();
      let quota = quotaStorage.dailyQuota || { date: todayStr, count: 0 };
      if (quota.date !== todayStr) quota = { date: todayStr, count: 0 };
      quota.count++;
      await chrome.storage.local.set({ dailyQuota: quota });
    }

    await chrome.storage.local.set({ currentTask: taskState });
    
    // 递归执行下一个
    await runNext();
  };

  // 启动初始并发
  for (let i = 0; i < Math.min(concurrency, taskState.urls.length); i++) {
    activePromises.push(runNext());
  }

  await Promise.all(activePromises);

  // 标记任务完成
  taskState.status = 'completed';
  await chrome.storage.local.set({ currentTask: taskState });

  // 弹出桌面通知
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '跨境智采 - 批量任务完成',
    message: `成功采集 ${results.length} 个商品` + (failedUrls.length > 0 ? `，失败 ${failedUrls.length} 个。` : '！'),
    priority: 1
  });

  // 向所有活动的 popup 页面发送更新通知
  chrome.runtime.sendMessage({ action: 'taskFinished', taskState });
}

/**
 * 抓取单条 URL 的核心函数
 */
async function scrapeSingleUrl(url) {
  // 识别平台类型
  const platform = detectPlatform(url);
  
  if (platform === 'shopify' || platform === 'shopline') {
    // 降维获取 JSON 数据
    const jsonUrl = cleanUrlForJson(url);
    const response = await fetch(jsonUrl);
    if (!response.ok) throw new Error(`无法获取独立站数据: ${response.status}`);
    const data = await response.json();
    return formatShopifyJson(data, url, platform);
  }

  // 其他平台（如 Amazon, 1688, AliExpress），请求其 HTML 并发送给解析引擎
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
  });
  if (!response.ok) throw new Error(`请求目标页面失败: ${response.status}`);
  const html = await response.text();

  // 根据平台进行 HTML DOM 解析或数据提取
  return await parseHtmlData(html, url, platform);
}

/**
 * 识别 URL 对应平台
 */
function detectPlatform(url) {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes('1688.com')) return '1688';
  if (lowercaseUrl.includes('amazon.')) return 'amazon';
  if (lowercaseUrl.includes('aliexpress.com')) return 'aliexpress';
  
  // 默认为 shopify (大多数跨境独立站使用 Shopify 或店匠)
  // 如果链接包含 /products/ 极大可能是 Shopify/Shopline 独立站
  if (lowercaseUrl.includes('/products/')) {
    if (lowercaseUrl.includes('shopline')) return 'shopline';
    return 'shopify';
  }
  
  return 'shopify';
}

/**
 * 独立站链接加上 .js / .json 降维请求
 */
function cleanUrlForJson(url) {
  let clean = url.split('?')[0];
  if (clean.endsWith('/')) {
    clean = clean.slice(0, -1);
  }
  if (!clean.endsWith('.json') && !clean.endsWith('.js')) {
    clean = clean + '.json';
  }
  return clean;
}

/**
 * 格式化 Shopify/Shopline JSON 数据
 */
function formatShopifyJson(data, originalUrl, platform) {
  // Shopify JSON 接口返回结构通常是 { product: { ... } }，或者是直接返回商品信息
  const p = data.product || data;
  
  if (!p || !p.title) {
    throw new Error('未能在返回的 JSON 中解析到有效的商品数据。');
  }

  const images = (p.images || []).map(img => typeof img === 'string' ? img : (img.src || ''));
  
  // SKU 变体信息
  const variants = (p.variants || []).map(v => ({
    sku: v.sku || `${p.id}-${v.id}`,
    title: v.title,
    price: v.price,
    compare_at_price: v.compare_at_price || '',
    inventory_quantity: v.inventory_quantity || 99,
    option1: v.option1 || '',
    option2: v.option2 || '',
    option3: v.option3 || '',
    image_url: v.image_id ? (p.images.find(img => img.id === v.image_id)?.src || '') : ''
  }));

  return {
    id: p.id || Date.now(),
    title: p.title,
    url: originalUrl,
    platform: platform,
    price: p.variants?.[0]?.price || '0.00',
    description: p.body_html || p.description || '',
    images: images,
    variants: variants,
    options: p.options || []
  };
}

/**
 * 解析亚马逊、1688、速卖通等平台的 HTML
 * 注意：由于我们在 background.js 中没有 DOM，我们使用正则表达式或轻量解析器来匹配
 */
async function parseHtmlData(html, url, platform) {
  const rules = parserRules?.[platform] || {};
  const data = {
    id: extractIdFromUrl(url, platform),
    title: '',
    url: url,
    platform: platform,
    price: '0.00',
    description: '',
    images: [],
    variants: []
  };

  if (platform === 'amazon') {
    // 匹配 Amazon 标题
    const titleMatch = html.match(/<span id="productTitle"[^>]*>\s*([^<]+)\s*<\/span>/i);
    data.title = titleMatch ? titleMatch[1].trim() : 'Amazon Product';

    // 匹配价格
    const priceMatch = html.match(/<span class="a-offscreen">([^<]+)<\/span>/i) || 
                       html.match(/<span id="priceblock_ourprice"[^>]*>([^<]+)<\/span>/i);
    data.price = priceMatch ? priceMatch[1].trim().replace(/[^0-9.]/g, '') : '0.00';

    // 匹配大图
    // 亚马逊常在大图中使用 data-a-dynamic-image 包含多分辨率图片
    const dynamicImgMatch = html.match(/data-a-dynamic-image="([^"]+)"/i);
    if (dynamicImgMatch) {
      try {
        const imgObj = JSON.parse(dynamicImgMatch[1].replace(/&quot;/g, '"'));
        data.images = [Object.keys(imgObj)[0]]; // 取最高清的一张
      } catch (e) {
        console.error('Failed to parse dynamic image JSON');
      }
    }
    
    // 备用图片获取
    if (data.images.length === 0) {
      const imgMatch = html.match(/<img[^>]+id="landingImage"[^>]+src="([^"]+)"/i);
      if (imgMatch) data.images.push(imgMatch[1]);
    }
    
    data.description = 'Amazon Product Description';
  } else if (platform === 'aliexpress') {
    // AliExpress 详情页一般包含 window._detailData 或 window.runParams
    const runParamsMatch = html.match(/window\.runParams\s*=\s*({.+?});/);
    if (runParamsMatch) {
      try {
        const runParams = JSON.parse(runParamsMatch[1]);
        const widgetData = runParams?.data?.productInfoComponent || runParams?.data?.actionComponent;
        data.title = widgetData?.subject || '';
        data.price = runParams?.data?.priceComponent?.priceText || '0.00';
        data.images = runParams?.data?.imageComponent?.imagePathList || [];
      } catch (e) {
        console.error('Failed to parse AliExpress runParams');
      }
    }
    
    // 备用匹配
    if (!data.title) {
      const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
      data.title = titleMatch ? titleMatch[1].trim() : 'AliExpress Product';
    }
  } else if (platform === '1688') {
    // 1688 数据匹配
    const titleMatch = html.match(/<h1 class="title-text"[^>]*>\s*([^<]+)\s*<\/span>/i) || 
                       html.match(/<div class="od-pc-offer-title"[^>]*>\s*([^<]+)\s*<\/div>/i) ||
                       html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/i);
    data.title = titleMatch ? titleMatch[1].trim() : '1688 Product';

    const priceMatch = html.match(/<span class="price-num">([^<]+)<\/span>/i) ||
                       html.match(/<div class="price-text">([^<]+)<\/div>/i) ||
                       html.match(/class="offer-price">([^<]+)<\/i>/i);
    data.price = priceMatch ? priceMatch[1].trim().replace(/[^0-9.]/g, '') : '0.00';

    // 匹配相册大图并转换为超高清
    const imgMatches = [...html.matchAll(/class="detail-gallery-img"[^>]+src="([^"]+)"/gi)] || 
                       [...html.matchAll(/<img[^>]+class="[^"]*prop-img[^"]*"[^>]+src="([^"]+)"/gi)];
    let rawImgs = imgMatches.map(m => m[1]);

    if (rawImgs.length === 0) {
      const altImgs = [...html.matchAll(/(https?:)?\/\/cbu01\.alicdn\.com\/img\/ibank\/[^\s"']+\.jpg/gi)];
      rawImgs = [...new Set(altImgs.map(m => m[0]))];
    }
    data.images = rawImgs.map(get1688HighResUrl);

    // 异步提取详情图
    try {
      const descUrlMatch = html.match(/["'](https?:)?\/\/desc\.1688\.com\/fdesc\/[^"'\s]+["']/i) || 
                           html.match(/["'](https?:)?\/\/cbu01\.alicdn\.com\/desc\/[^"'\s]+["']/i);
      if (descUrlMatch) {
        let descUrl = descUrlMatch[0].replace(/["']/g, '');
        if (descUrl.startsWith('//')) descUrl = 'https:' + descUrl;
        
        const descRes = await fetch(descUrl);
        if (descRes.ok) {
          const descText = await descRes.text();
          const ibankMatches = [...descText.matchAll(/(https?:)?\/\/cbu01\.alicdn\.com\/img\/ibank\/[^\s"'\\]+/gi)];
          const detailImgs = ibankMatches.map(m => get1688HighResUrl(m[0].replace(/\\/g, '')));
          if (detailImgs.length > 0) {
            data.description = detailImgs.map(img => `<img src="${img}" />`).join('\n');
            if (data.images.length === 0) {
              data.images = detailImgs.slice(0, 5);
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to parse 1688 detail images in background:', e);
    }
  }

  // 兜底补齐变体
  data.variants = [{
    sku: `${data.id}-default`,
    title: 'Default Title',
    price: data.price,
    compare_at_price: '',
    inventory_quantity: 99,
    option1: 'Default Title',
    option2: '',
    option3: '',
    image_url: data.images[0] || ''
  }];

  return data;
}

/**
 * 从 URL 中提取商品 ID
 */
function extractIdFromUrl(url, platform) {
  try {
    if (platform === 'amazon') {
      const match = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/product\/([A-Z0-9]{10})/i);
      return match ? match[1] : Date.now().toString();
    }
    if (platform === 'aliexpress') {
      const match = url.match(/\/item\/(\d+)\.html/);
      return match ? match[1] : Date.now().toString();
    }
    if (platform === '1688') {
      const match = url.match(/\/offer\/(\d+)\.html/);
      return match ? match[1] : Date.now().toString();
    }
  } catch (e) {}
  return Date.now().toString();
}

/**
 * 获取 1688 高清无尺寸限制原图
 */
function get1688HighResUrl(url) {
  if (!url) return '';
  let clean = url;
  const match = url.match(/(.+?\.(jpg|jpeg|png|webp|gif))_(\d+x\d+)/i);
  if (match) {
    clean = match[1];
  }
  if (clean.startsWith('//')) {
    clean = 'https:' + clean;
  }
  return clean;
}
