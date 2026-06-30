/**
 * 跨境智采 - Content Script
 * 负责当前页面商品数据嗅探、DOM解析、类目链接抓取及辅助模拟翻页
 */

// 监听来自 Popup 或 Background 的指令
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeCurrentPage') {
    scrapeCurrentPage()
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 异步响应
  }

  if (request.action === 'extractCategoryUrls') {
    const urls = extractCategoryUrls();
    sendResponse({ success: true, urls });
    return true;
  }

  if (request.action === 'performNextPageClick') {
    const success = clickNextPageButton();
    sendResponse({ success });
    return true;
  }
});

// 自动检测当前页面是否为支持的商品页
function initDetection() {
  const isProduct = detectIsProductPage();
  if (isProduct) {
    chrome.runtime.sendMessage({
      action: 'productPageDetected',
      url: window.location.href,
      platform: isProduct.platform
    });
  }
}

// 延迟执行检测，确保页面加载完毕
setTimeout(initDetection, 1500);

/**
 * 判断是否是商品详情页
 */
function detectIsProductPage() {
  const url = window.location.href;
  
  // 1. 检查 Shopify 特征
  if (window.Shopify || document.querySelector('link[href*="cdn.shopify.com"]') || url.includes('/products/')) {
    if (url.includes('/products/')) {
      return { platform: 'shopify' };
    }
  }

  // 2. 亚马逊
  if (url.includes('amazon.') && (url.includes('/dp/') || url.includes('/gp/product/'))) {
    return { platform: 'amazon' };
  }

  // 3. AliExpress
  if (url.includes('aliexpress.com/item/')) {
    return { platform: 'aliexpress' };
  }

  // 4. 1688
  if (url.includes('1688.com/offer/')) {
    return { platform: '1688' };
  }

  return null;
}

/**
 * 解析当前页面的 DOM 数据（作为 Shopify JSON 抓取失败或非独立站时的本地兜底/解析）
 */
async function scrapeCurrentPage() {
  const platformInfo = detectIsProductPage();
  if (!platformInfo) {
    throw new Error('当前页面不是支持的商品详情页！');
  }

  const platform = platformInfo.platform;
  const url = window.location.href;

  if (platform === 'shopify') {
    // 独立站优先通过 .json 接口获取 100% 完整的高清数据
    try {
      const cleanUrl = url.split('?')[0].replace(/\/$/, '') + '.json';
      const res = await fetch(cleanUrl);
      if (res.ok) {
        const data = await res.json();
        const p = data.product;
        return {
          id: p.id,
          title: p.title,
          url: url,
          platform: 'shopify',
          price: p.variants?.[0]?.price || '0.00',
          description: p.body_html || '',
          images: (p.images || []).map(img => img.src),
          variants: (p.variants || []).map(v => ({
            sku: v.sku || `${p.id}-${v.id}`,
            title: v.title,
            price: v.price,
            compare_at_price: v.compare_at_price || '',
            inventory_quantity: v.inventory_quantity || 99,
            option1: v.option1 || '',
            option2: v.option2 || '',
            option3: v.option3 || '',
            image_url: v.image_id ? (p.images.find(img => img.id === v.image_id)?.src || '') : ''
          })),
          options: p.options || []
        };
      }
    } catch (e) {
      console.warn('Shopify JSON API failed, falling back to DOM parsing', e);
    }
  }

  // 走 DOM 解析兜底
  return await parseDomData(platform);
}

/**
 * 针对不同平台的 DOM 数据提取
 */
async function parseDomData(platform) {
  const data = {
    id: Date.now().toString(),
    title: document.title,
    url: window.location.href,
    platform: platform,
    price: '0.00',
    description: '',
    images: [],
    variants: [],
    options: []
  };

  if (platform === 'amazon') {
    const titleEl = document.querySelector('#productTitle');
    if (titleEl) data.title = titleEl.textContent.trim();

    const priceEl = document.querySelector('.a-price .a-offscreen') || document.querySelector('#priceblock_ourprice');
    if (priceEl) data.price = priceEl.textContent.trim().replace(/[^0-9.]/g, '');

    const imgEl = document.querySelector('#landingImage') || document.querySelector('#imgBlkFront');
    if (imgEl) {
      // 提取 dynamic image 最清晰的一张
      const dynAttr = imgEl.getAttribute('data-a-dynamic-image');
      if (dynAttr) {
        try {
          const imgObj = JSON.parse(dynAttr);
          data.images = [Object.keys(imgObj).reduce((a, b) => imgObj[a] > imgObj[b] ? a : b)]; // 取大图
        } catch (e) {
          data.images = [imgEl.src];
        }
      } else {
        data.images = [imgEl.src];
      }
    }

    // 抓取详情图
    const descEl = document.querySelector('#feature-bullets') || document.querySelector('#productDescription_feature_div');
    if (descEl) data.description = descEl.innerHTML;
  } 
  else if (platform === 'aliexpress') {
    // 优先读取页面全局变量
    if (window.runParams && window.runParams.data) {
      const runData = window.runParams.data;
      data.title = runData.productInfoComponent?.subject || document.title;
      data.price = runData.priceComponent?.priceText || '0.00';
      data.images = runData.imageComponent?.imagePathList || [];
    } else {
      const titleEl = document.querySelector('.product-title') || document.querySelector('h1');
      if (titleEl) data.title = titleEl.textContent.trim();
      const priceEl = document.querySelector('.product-price-value') || document.querySelector('.price');
      if (priceEl) data.price = priceEl.textContent.trim().replace(/[^0-9.]/g, '');
      const imgs = Array.from(document.querySelectorAll('.images-view-item img, .image-view-magnifier-wrap img'));
      data.images = imgs.map(img => img.src.replace(/_Q90\.jpg$/, ''));
    }
  } 
  else if (platform === '1688') {
    // 标题
    const titleEl = document.querySelector('.title-text') || document.querySelector('.od-pc-offer-title') || document.querySelector('h1');
    if (titleEl) data.title = titleEl.textContent.trim();

    // 价格
    const priceEl = document.querySelector('.price-num') || document.querySelector('.price-text') || document.querySelector('.offer-price');
    if (priceEl) data.price = priceEl.textContent.trim().replace(/[^0-9.]/g, '');

    // 获取轮播主图
    const imgElements = Array.from(document.querySelectorAll('.detail-gallery img, .detail-gallery-img img, .prop-img img, .nav-slider-img img, img.detail-gallery-img'));
    const rawImgs = imgElements.map(img => {
      return img.getAttribute('src') || img.getAttribute('lazy-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-src');
    }).filter(Boolean);
    
    data.images = [...new Set(rawImgs.map(get1688HighResUrl))];

    // 获取详情图
    try {
      const htmlText = document.documentElement.outerHTML;
      const descUrlMatch = htmlText.match(/["'](https?:)?\/\/desc\.1688\.com\/fdesc\/[^"'\s]+["']/i) || 
                           htmlText.match(/["'](https?:)?\/\/cbu01\.alicdn\.com\/desc\/[^"'\s]+["']/i);
      
      let descUrl = '';
      if (descUrlMatch) {
        descUrl = descUrlMatch[0].replace(/["']/g, '');
        if (descUrl.startsWith('//')) descUrl = 'https:' + descUrl;
      } else {
        const container = document.querySelector('#desc-lazyload-container');
        if (container) {
          descUrl = container.getAttribute('data-tianyan-url') || container.getAttribute('data-tianyan-param');
        }
      }

      if (descUrl) {
        const descRes = await fetch(descUrl);
        if (descRes.ok) {
          const descText = await descRes.text();
          // 提取 ibank 类型的图片 URL 并高清化
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

      // 兜底 DOM 结构解析
      if (!data.description) {
        const descContainer = document.querySelector('#desc-lazyload-container');
        if (descContainer) {
          const lazyImgs = Array.from(descContainer.querySelectorAll('img')).map(img => {
            return img.getAttribute('src') || img.getAttribute('lazy-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-src');
          }).filter(Boolean);
          if (lazyImgs.length > 0) {
            const cleanLazy = [...new Set(lazyImgs.map(get1688HighResUrl))];
            data.description = cleanLazy.map(img => `<img src="${img}" />`).join('\n');
          }
        }
      }
    } catch (e) {
      console.error('Failed to parse 1688 detail images:', e);
    }
  }

  // 填充默认变体
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
 * 提取当前页面所有的商品链接（用于目录/类目一键抓取）
 */
function extractCategoryUrls() {
  const urls = [];
  const currentDomain = window.location.origin;
  
  // 匹配常见的商品详情页链接模式
  let selectors = [
    'a[href*="/products/"]',      // Shopify / Shopline
    'a[href*="/item/"]',          // AliExpress
    'a[href*="/offer/"]',         // 1688
    'a[href*="/dp/"]',            // Amazon
    'a[href*="/gp/product/"]'     // Amazon
  ];

  const links = document.querySelectorAll(selectors.join(', '));
  
  links.forEach(link => {
    let href = link.getAttribute('href');
    if (!href) return;
    
    // 补全相对路径
    if (href.startsWith('/')) {
      href = currentDomain + href;
    } else if (!href.startsWith('http')) {
      return; // 过滤无效链接
    }

    // 过滤掉 collections 自身、cart、search 等无关 URL
    if (
      href.includes('/collections/') && !href.includes('/products/') || 
      href.includes('/cart') || 
      href.includes('/search')
    ) {
      return;
    }

    // 规范化链接
    const cleanUrl = href.split('?')[0];
    if (!urls.includes(cleanUrl)) {
      urls.push(cleanUrl);
    }
  });

  return urls;
}

/**
 * 模拟点击“下一页”按钮
 */
function clickNextPageButton() {
  // 各种平台常见的下一页按钮选择器
  const selectors = [
    '.pagination a.next',
    'a[aria-label="Next"]',
    '.s-pagination-next',
    'li.ant-pagination-next:not(.ant-pagination-disabled) a',
    '.next-page',
    'a.next-page',
    'a[title*="Next"]',
    'a[class*="pagination__next"]'
  ];

  for (const selector of selectors) {
    const btn = document.querySelector(selector);
    if (btn && btn.offsetHeight > 0) {
      btn.click();
      return true;
    }
  }

  // 降维处理：如果找不到按钮，可尝试识别页面底部的“下一页”文字
  const allLinks = Array.from(document.querySelectorAll('a'));
  const nextTextLink = allLinks.find(a => {
    const text = a.textContent.trim().toLowerCase();
    return (text === 'next' || text === '下一页' || text === 'next >' || text === '>') && a.offsetHeight > 0;
  });

  if (nextTextLink) {
    nextTextLink.click();
    return true;
  }

  return false;
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
