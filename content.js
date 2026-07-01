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

  // 5. Ozon
  if ((url.includes('ozon.ru') || url.includes('ozonru.me')) && url.includes('/product/')) {
    return { platform: 'ozon' };
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
          vendor: p.vendor || '',
          video_url: (p.media || []).find(m => m.media_type === 'video')?.sources?.[0]?.url || (document.querySelector('video') ? document.querySelector('video').src : ''),
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
    vendor: '',
    video_url: '',
    description: '',
    images: [],
    variants: [],
    options: []
  };

  if (platform === 'ozon') {
    // 标题
    const titleEl = document.querySelector('h1') || document.querySelector('[data-widget="webTitle"]');
    if (titleEl) data.title = titleEl.textContent.trim();

    // 价格
    const priceEl = document.querySelector('[data-testid="price-value"], [class*="price-value"], [class*="price"]');
    if (priceEl) data.price = priceEl.textContent.trim().replace(/[^0-9.]/g, '');

    // 店铺名
    const shopEl = document.querySelector('[class*="seller-name"], [class*="seller"] a, a[href*="/seller/"]');
    if (shopEl) data.vendor = shopEl.textContent.trim();

    // 1. 主图提取 (优先定位 webGallery 容器并兼容全域 ozon CDN)
    const galleryContainer = document.querySelector('[data-widget="webGallery"], [class*="gallery"], [class*="carousel"]');
    let mainGalleryImgs = [];
    if (galleryContainer) {
      mainGalleryImgs = Array.from(galleryContainer.querySelectorAll('img'));
    } else {
      mainGalleryImgs = Array.from(document.querySelectorAll('img')).filter(img => {
        const src = img.src || img.getAttribute('data-src') || '';
        return src.includes('/s3/multimedia-') || src.includes('ozon');
      });
    }

    let rawImgs = mainGalleryImgs.map(img => {
      return img.getAttribute('data-lazyload') || 
             img.getAttribute('data-original') || 
             img.getAttribute('data-src') || 
             img.getAttribute('lazy-src') || 
             img.getAttribute('data-lazy-src') || 
             img.src;
    }).filter(Boolean);

    data.images = [...new Set(rawImgs.map(getOzonHighResUrl))].filter(url => !url.toLowerCase().endsWith('.svg') && url.includes('ozon'));

    // 2. 详情图提取
    try {
      const descContainer = document.querySelector('[data-widget="webDescription"], #section-description, [class*="pdp_q1a"], [class*="description"]');
      let detailImgs = [];

      if (descContainer) {
        console.log('Ozon description container found, scanning images...');
        const imgs = Array.from(descContainer.querySelectorAll('img'));
        const rawDetail = imgs.map(img => {
          return img.getAttribute('data-lazyload') || 
                 img.getAttribute('data-original') || 
                 img.getAttribute('data-src') || 
                 img.getAttribute('lazy-src') || 
                 img.getAttribute('data-lazy-src') || 
                 img.src;
        }).filter(Boolean);

        detailImgs = [...new Set(rawDetail.map(getOzonHighResUrl))].filter(url => !url.toLowerCase().endsWith('.svg'));
      }

      if (detailImgs.length === 0) {
        const allImgs = Array.from(document.querySelectorAll('img')).map(img => {
          return img.getAttribute('data-lazyload') || 
                 img.getAttribute('data-original') || 
                 img.getAttribute('data-src') || 
                 img.getAttribute('lazy-src') || 
                 img.getAttribute('data-lazy-src') || 
                 img.src;
        }).filter(Boolean);

        const ozonImgs = allImgs.filter(src => (src.includes('ozonru.me') || src.includes('ozon.ru')) && !src.toLowerCase().endsWith('.svg'));
        detailImgs = ozonImgs.filter(url => !data.images.includes(url));
      }

      if (detailImgs.length > 0) {
        data.description = detailImgs.map(url => `<img src="${url}" />`).join('\n');
      }
    } catch (e) {
      console.warn('Failed to parse Ozon detail images:', e);
    }
  }
  else if (platform === 'amazon') {
    const titleEl = document.querySelector('#productTitle');
    if (titleEl) data.title = titleEl.textContent.trim();

    const priceEl = document.querySelector('.a-price .a-offscreen') || document.querySelector('#priceblock_ourprice');
    if (priceEl) data.price = priceEl.textContent.trim().replace(/[^0-9.]/g, '');

    const brandEl = document.querySelector('#bylineInfo, #sellerProfileTriggerId, #brand');
    if (brandEl) data.vendor = brandEl.textContent.trim().replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '');

    const amzVideo = document.querySelector('video.vjs-tech, #inline-video-main video, video');
    if (amzVideo && amzVideo.src) {
      data.video_url = amzVideo.src;
    } else {
      const htmlText = document.documentElement.outerHTML;
      const mp4Match = htmlText.match(/https?:\/\/[^\s"'\\]+?\.mp4/i);
      if (mp4Match) data.video_url = mp4Match[0];
    }

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
      data.images = (runData.imageComponent?.imagePathList || []).map(url => {
        let clean = url.replace(/_\d+x\d+.*$/, '').replace(/_Q\d+.*$/, '').replace(/_\.webp$/, '');
        if (clean.startsWith('//')) clean = 'https:' + clean;
        return clean;
      }).filter(url => !url.toLowerCase().endsWith('.svg'));
      
      if (runData.sellerComponent) {
        data.vendor = runData.sellerComponent.shopName || '';
      }
    } else {
      const titleEl = document.querySelector('.product-title') || document.querySelector('h1') || document.querySelector('[class*="title"]');
      if (titleEl) data.title = titleEl.textContent.trim();
      const priceEl = document.querySelector('.product-price-value') || document.querySelector('.price') || document.querySelector('[class*="price"]');
      if (priceEl) data.price = priceEl.textContent.trim().replace(/[^0-9.]/g, '');

      // 提取主图，支持多种新版类名，增加对更多 lazyload 属性的抓取
      const imgs = Array.from(document.querySelectorAll('.images-view-item img, .image-view-magnifier-wrap img, .slider--img img, [class*="slider"] img, [class*="gallery"] img, img.magnifier-image'));
      let rawImgs = imgs.map(img => {
        return img.getAttribute('data-lazyload') || 
               img.getAttribute('data-original') || 
               img.getAttribute('data-src') || 
               img.getAttribute('lazy-src') || 
               img.getAttribute('data-lazy-src') || 
               img.src;
      }).filter(Boolean);
      
      // 高容错：如果未定位到足够的主图，扫描全页面托管在 ae01.alicdn.com/kf/ 的资源
      if (rawImgs.length < 2) {
        console.log('AliExpress CSS selectors matched fewer than 2 images, running full-page kf scanner...');
        const allPageImgs = Array.from(document.querySelectorAll('img')).map(img => {
          return img.getAttribute('data-lazyload') || 
                 img.getAttribute('data-original') || 
                 img.getAttribute('data-src') || 
                 img.getAttribute('lazy-src') || 
                 img.getAttribute('data-lazy-src') || 
                 img.src;
        }).filter(Boolean);

        const kfImgs = allPageImgs.filter(src => src.includes('ae01.alicdn.com/kf/') && !src.toLowerCase().endsWith('.svg'));
        if (kfImgs.length > 0) {
          rawImgs = kfImgs;
        }
      }

      data.images = [...new Set(rawImgs.map(url => {
        let clean = url.replace(/_\d+x\d+.*$/, '').replace(/_Q\d+.*$/, '').replace(/_\.webp$/, '');
        if (clean.startsWith('//')) clean = 'https:' + clean;
        return clean;
      }))].filter(url => !url.toLowerCase().endsWith('.svg'));
      
      const shopEl = document.querySelector('.shop-name, .store-name a, [class*="shop-name"]');
      if (shopEl) data.vendor = shopEl.textContent.trim();
    }

    // 详情图抓取：优先定位详情容器（支持穿透 Shadow DOM），物理隔开主图与详情图，适配懒加载
    try {
      const hostEl = document.querySelector('div[id="product-description"][class*="description"], div[class*="description--product-description"], div[data-pl="product-description"], #product-description, #nav-description, .description--wrap');
      let detailImgs = [];
      let imgElements = [];

      let shadowRoot = null;
      if (hostEl) {
        if (hostEl.shadowRoot) {
          shadowRoot = hostEl.shadowRoot;
        } else {
          // 深度遍历所有子孙节点寻找隐藏的 shadowRoot 挂载点
          const allChildren = hostEl.getElementsByTagName('*');
          for (let el of allChildren) {
            if (el.shadowRoot) {
              shadowRoot = el.shadowRoot;
              break;
            }
          }
        }
      }

      if (shadowRoot) {
        console.log('AliExpress Shadow Root detected in description, penetrating shadow DOM...');
        imgElements = Array.from(shadowRoot.querySelectorAll('img'));
      } else {
        const descContainer = document.querySelector('.product-description, .detail-desc, .origin-part, .description-content, #product-description, #detail-desc, .desc-lazyload-container');
        if (descContainer) {
          console.log('AliExpress description container found, scanning images...');
          imgElements = Array.from(descContainer.querySelectorAll('img'));
        }
      }

      if (imgElements.length > 0) {
        const rawDetail = imgElements.map(img => {
          return img.getAttribute('data-lazyload') || 
                 img.getAttribute('data-original') || 
                 img.getAttribute('data-src') || 
                 img.getAttribute('lazy-src') || 
                 img.getAttribute('data-lazy-src') || 
                 img.src;
        }).filter(Boolean);
        
        detailImgs = [...new Set(rawDetail.map(url => {
          let clean = url.replace(/_\d+x\d+.*$/, '').replace(/_Q\d+.*$/, '').replace(/_\.webp$/, '');
          if (clean.startsWith('//')) clean = 'https:' + clean;
          return clean;
        }))].filter(url => !url.toLowerCase().endsWith('.svg') && !url.includes('/svg/'));
      }
      
      // 兜底方案：如果没找到容器，或者容器内无图，使用全页面 KF 排除法
      if (detailImgs.length === 0) {
        console.log('AliExpress description container empty or not found, falling back to full-page KF scanner...');
        const allImgs = Array.from(document.querySelectorAll('img')).map(img => {
          return img.getAttribute('data-lazyload') || 
                 img.getAttribute('data-original') || 
                 img.getAttribute('data-src') || 
                 img.getAttribute('lazy-src') || 
                 img.getAttribute('data-lazy-src') || 
                 img.src;
        }).filter(Boolean);
        
        const kfImgs = allImgs.filter(src => src.includes('ae01.alicdn.com/kf/') && !src.toLowerCase().endsWith('.svg'));
        const cleanKfs = [...new Set(kfImgs.map(url => {
          let clean = url.replace(/_\d+x\d+.*$/, '').replace(/_Q\d+.*$/, '').replace(/_\.webp$/, '');
          if (clean.startsWith('//')) clean = 'https:' + clean;
          return clean;
        }))];
        
        detailImgs = cleanKfs.filter(url => !data.images.includes(url));
      }

      if (detailImgs.length > 0) {
        data.description = detailImgs.map(url => `<img src="${url}" />`).join('\n');
      }
    } catch (e) {
      console.warn('Failed to parse AliExpress detail images:', e);
    }

    const aliVideo = document.querySelector('.video-uploader video, .video-wrap video, video');
    if (aliVideo && aliVideo.src) {
      data.video_url = aliVideo.src;
    } else {
      const htmlText = document.documentElement.outerHTML;
      const mp4Match = htmlText.match(/https?:\/\/video\.aliexpress-media\.com\/[^\s"'\\]+?\.mp4/i) || 
                       htmlText.match(/https?:\/\/[^\s"'\\]+?\.mp4/i);
      if (mp4Match) {
        let cleanVideo = mp4Match[0].replace(/\\/g, '');
        data.video_url = cleanVideo;
      }
    }
  } 
  else if (platform === '1688') {
    // 标题
    const titleEl = document.querySelector('.title-text') || document.querySelector('.od-pc-offer-title') || document.querySelector('h1');
    if (titleEl) data.title = titleEl.textContent.trim();

    // 价格
    const priceEl = document.querySelector('.price-num') || document.querySelector('.price-text') || document.querySelector('.offer-price');
    if (priceEl) data.price = priceEl.textContent.trim().replace(/[^0-9.]/g, '');

    // 店铺名
    const shopEl = document.querySelector('.company-name, .company-name-text, a.company-name, .member-info-name, .company-info .company-name');
    if (shopEl) data.vendor = shopEl.textContent.trim();

    // 视频源
    const videoEl = document.querySelector('.video-container video, .video-player video, video');
    if (videoEl && videoEl.src && videoEl.src.includes('video.taobao.com')) {
      data.video_url = videoEl.src;
    } else {
      const htmlText = document.documentElement.outerHTML;
      const videoMatch = htmlText.match(/cloud\.video\.taobao\.com\/play\/u\/\d+\/p\/\d+\/e\/\d+\/t\/\d+\/[^\s"'\\]+\.mp4/i) || 
                         htmlText.match(/cloud\.video\.taobao\.com\/play\/[^\s"'\\]+/i);
      if (videoMatch) {
        let cleanVideo = videoMatch[0].replace(/\\/g, '');
        if (!cleanVideo.startsWith('http')) {
          cleanVideo = 'https://' + cleanVideo;
        }
        data.video_url = cleanVideo;
      }
    }

    // 1. 提取轮播主图 (高容错设计 + 过滤 SVG)
    const imgElements = Array.from(document.querySelectorAll('.detail-gallery img, .detail-gallery-img img, .prop-img img, .nav-slider-img img, img.detail-gallery-img'));
    let rawImgs = imgElements.map(img => {
      return img.getAttribute('src') || img.getAttribute('lazy-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-src');
    }).filter(Boolean);
    
    let cleanImgs = [...new Set(rawImgs.map(get1688HighResUrl))].filter(url => url && !url.toLowerCase().endsWith('.svg') && !url.includes('/svg/'));

    // 降维兜底：如果常规 CSS 选择器抓取到的主图过少，直接扫描全页面 ibank 大图资源
    if (cleanImgs.length < 2) {
      console.log('1688 CSS selectors matched fewer than 2 images, running full-page ibank scanner...');
      const allPageImgs = Array.from(document.querySelectorAll('img')).map(img => {
        return img.getAttribute('src') || img.getAttribute('lazy-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-src');
      }).filter(Boolean);

      const ibankImgs = allPageImgs.filter(src => {
        const lowercaseSrc = src.toLowerCase();
        return (lowercaseSrc.includes('cbu01.alicdn.com/img/ibank/') || lowercaseSrc.includes('img.alicdn.com/')) &&
               !lowercaseSrc.includes('logo') && !lowercaseSrc.includes('icon') && !lowercaseSrc.includes('loading') && !lowercaseSrc.includes('avatar') &&
               !lowercaseSrc.endsWith('.svg') && !lowercaseSrc.includes('/svg/');
      });

      const highResIbanks = [...new Set(ibankImgs.map(get1688HighResUrl))].filter(Boolean);
      if (highResIbanks.length > 0) {
        cleanImgs = highResIbanks.slice(0, 5);
      }
    }
    
    data.images = cleanImgs;

    // 2. 提取详情图 (优先使用已渲染的本地 DOM / Shadow DOM，其次通过后台接口兜底)
    try {
      let detailImgs = [];

      // 流程 A: 本地 DOM 结构解析 (包含动态自定义标签锁定、v-detail-x 深层 Shadow DOM 穿透与推荐图过滤)
      // 首先通配匹配所有以 v-detail- 开头的自定义详情标签，防止混淆
      let descContainer = document.querySelector('#desc-lazyload-container, .collapse-body, .html-description, [class*="html-description"], #detail');
      if (!descContainer) {
        const allElements = document.getElementsByTagName('*');
        for (let el of allElements) {
          if (el.tagName.toLowerCase().startsWith('v-detail-')) {
            descContainer = el;
            break;
          }
        }
      }

      // 智能唤醒懒加载：如果容器内暂无任何图片，自动瞬间滚动页面唤醒懒加载
      let isFirstTryEmpty = true;
      if (descContainer) {
        const tempImgs = descContainer.shadowRoot ? descContainer.shadowRoot.querySelectorAll('img') : descContainer.querySelectorAll('img');
        if (tempImgs.length > 0) {
          isFirstTryEmpty = false;
        }
      }

      if (isFirstTryEmpty) {
        console.log('1688 detail container is empty initially, waking up lazy load...');
        const originalScrollY = window.scrollY;
        window.scrollTo(0, originalScrollY + 1200);
        await new Promise(r => setTimeout(r, 400));
        window.scrollTo(0, originalScrollY + 2400);
        await new Promise(r => setTimeout(r, 400));
        window.scrollTo(0, originalScrollY); // 瞬间复位
        
        // 滚动后重新捕获容器
        descContainer = document.querySelector('#desc-lazyload-container, .collapse-body, .html-description, [class*="html-description"], #detail');
        if (!descContainer) {
          const allElements = document.getElementsByTagName('*');
          for (let el of allElements) {
            if (el.tagName.toLowerCase().startsWith('v-detail-')) {
              descContainer = el;
              break;
            }
          }
        }
      }

      if (descContainer) {
        let shadowRoot = null;
        let imgElements = [];

        if (descContainer.shadowRoot) {
          shadowRoot = descContainer.shadowRoot;
        } else {
          // 深度遍历所有子孙节点寻找隐藏的 shadowRoot 挂载点
          const allChildren = descContainer.getElementsByTagName('*');
          for (let el of allChildren) {
            if (el.shadowRoot) {
              shadowRoot = el.shadowRoot;
              break;
            }
          }
        }

        if (shadowRoot) {
          console.log('1688 Shadow Root detected in description, penetrating shadow DOM...');
          const allImgs = Array.from(shadowRoot.querySelectorAll('img'));
          // 过滤掉任何处于推荐模块 (如 offer-list-wrapper) 内的图片，仅保留商品真实的详情图
          imgElements = allImgs.filter(img => {
            let parent = img.parentElement;
            while (parent && parent !== shadowRoot) {
              const className = (parent.className || '').toString();
              const idName = (parent.id || '').toString();
              if (
                className.includes('offer-list') || 
                className.includes('recommend') ||
                idName.includes('offer-list') || 
                idName.includes('recommend')
              ) {
                return false;
              }
              parent = parent.parentElement;
            }
            return true;
          });
        } else {
          imgElements = Array.from(descContainer.querySelectorAll('img'));
        }

        if (imgElements.length > 0) {
          const lazyImgs = imgElements.map(img => {
            return img.getAttribute('src') || 
                   img.getAttribute('lazy-src') || 
                   img.getAttribute('data-lazy-src') || 
                   img.getAttribute('data-src') ||
                   img.getAttribute('data-lazyload') ||
                   img.getAttribute('data-original');
          }).filter(Boolean);
          
          if (lazyImgs.length > 0) {
            detailImgs = [...new Set(lazyImgs.map(get1688HighResUrl))].filter(url => !url.toLowerCase().endsWith('.svg') && !url.includes('/svg/'));
          }
        }
      }

      // 流程 B: 只有当本地 DOM 没有解析到任何详情图时，才调用远程接口解析作为降维兜底
      if (detailImgs.length === 0) {
        console.log('1688 local DOM got 0 detail images, falling back to remote desc url...');
        const htmlText = document.documentElement.outerHTML;
        const descUrlMatch = htmlText.match(/["'](https?:)?\/\/[^"'\s]*?(desc\.1688\.com|cbu01\.alicdn\.com|itemcdn\.tmall\.com)\/desc\/[^"'\s]+?["']/i) ||
                             htmlText.match(/["'](https?:)?\/\/[^"'\s]+?\/desc\/[^"'\s]+?["']/i);
        
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
          console.log('Fetching 1688 description via background proxy:', descUrl);
          const response = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'proxyFetchText', url: descUrl }, resolve);
          });

          if (response && response.success && response.text) {
            const descText = response.text;
            const imgRegex = /(?:src|data-lazyload|data-src)\s*=\s*\\?["']([^"'\s]+?)\\?["']/gi;
            let match;
            while ((match = imgRegex.exec(descText)) !== null) {
              let imgUrl = match[1].replace(/\\/g, '');
              if (imgUrl.startsWith('//')) {
                imgUrl = 'https:' + imgUrl;
              }
              const lowerUrl = imgUrl.toLowerCase();
              if (
                lowerUrl.includes('alicdn.com') && 
                !lowerUrl.endsWith('.svg') && 
                !lowerUrl.includes('/svg/') &&
                !lowerUrl.endsWith('.gif') &&
                !lowerUrl.includes('space.gif') &&
                !lowerUrl.includes('shim.gif')
              ) {
                detailImgs.push(get1688HighResUrl(imgUrl));
              }
            }
          }
        }
      }

      // 最终赋值与容错
      if (detailImgs.length > 0) {
        data.description = detailImgs.map(img => `<img src="${img}" />`).join('\n');
        if (data.images.length === 0) {
          data.images = detailImgs.slice(0, 5);
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

/**
 * 获取 Ozon 高清 1200px 原图
 */
function getOzonHighResUrl(url) {
  if (!url) return '';
  let clean = url;
  if (clean.startsWith('//')) {
    clean = 'https:' + clean;
  }
  // 将 Ozon CDN 的小图标识 /wc250/ /wc700/ 替换为最清大图 /wc1200/
  clean = clean.replace(/\/wc\d+\//i, '/wc1200/');
  return clean;
}
