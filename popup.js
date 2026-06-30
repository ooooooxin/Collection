/**
 * 跨境智采 - Popup Panel Logic
 * 实现单品采集、WebP转换、ZIP打包、批量采集并发、Excel解析、类目自动抓取及翻译CSV导出
 */

// === 模拟 Chrome 插件上下文 (用于在普通浏览器窗口直接双击 popup.html 运行与演示) ===
if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
  console.log('Running in browser preview mode (Mocking Chrome Extension APIs)');
  
  // 模拟批量任务进度
  function simulateBatchScrapeProgress(urls) {
    let idx = 0;
    const interval = setInterval(() => {
      if (idx >= urls.length) {
        clearInterval(interval);
        if (window.mockMessageListener) {
          window.mockMessageListener({
            action: 'taskFinished',
            taskState: {
              status: 'completed',
              results: urls.map((u, i) => ({ title: `Mock 商品 ${i + 1}`, url: u, price: '99.00', platform: 'shopify', images: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400'] }))
            }
          });
        }
        localStorage.removeItem('mock_currentTask');
        return;
      }
      
      const taskState = {
        id: 'mock_task_123',
        urls: urls,
        currentIndex: idx,
        results: urls.slice(0, idx + 1).map((u, i) => ({ title: `Mock 商品 ${i + 1}`, url: u, price: '99.00', platform: 'shopify', images: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400'] })),
        status: 'running'
      };
      localStorage.setItem('mock_currentTask', JSON.stringify(taskState));
      idx++;
    }, 1000);
  }

  window.chrome = {
    runtime: {
      sendMessage: (message, callback) => {
        console.log('[Mock runtime.sendMessage]', message);
        setTimeout(() => {
          if (message.action === 'proxyFetchImage') {
            callback({ success: true, base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
          } else if (message.action === 'startBatchScrape') {
            callback({ success: true, result: { taskId: 'mock_task_123', message: 'Mock 批量任务已启动' } });
            simulateBatchScrapeProgress(message.urls);
          } else if (message.action === 'getRules') {
            callback({ success: true, rules: {} });
          } else {
            callback({ success: true });
          }
        }, 500);
      },
      onMessage: {
        addListener: (listener) => {
          window.mockMessageListener = listener;
        }
      },
      getURL: (path) => path
    },
    storage: {
      local: {
        get: async (keys) => {
          const res = {};
          keys.forEach(k => {
            const val = localStorage.getItem('mock_' + k);
            res[k] = val ? JSON.parse(val) : null;
          });
          return res;
        },
        set: async (obj) => {
          Object.entries(obj).forEach(([k, v]) => {
            localStorage.setItem('mock_' + k, JSON.stringify(v));
          });
        },
        remove: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          arr.forEach(k => localStorage.removeItem('mock_' + k));
        }
      },
      onChanged: {
        addListener: () => {}
      }
    },
    tabs: {
      query: async () => {
        return [{ id: 1, url: 'https://demo.shopify.com/products/mock-fancy-sneaker' }];
      },
      sendMessage: (tabId, message, callback) => {
        console.log('[Mock tabs.sendMessage]', message);
        setTimeout(() => {
          if (message.action === 'scrapeCurrentPage') {
            callback({
              success: true,
              data: {
                id: 'mock_12345',
                title: 'Mock 极光跑鞋 Pro Max',
                url: 'https://demo.shopify.com/products/mock-fancy-sneaker',
                platform: 'shopify',
                price: '199.00',
                description: '<p>这是一款由 Antigravity 生成的高端模拟跑鞋，具有透气和酷炫暗黑毛玻璃外观。</p>',
                images: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400'],
                variants: [
                  { sku: 'MS-RED-XL', title: '红色 / XL', price: '199.00', option1: '红色', option2: 'XL' },
                  { sku: 'MS-BLUE-L', title: '蓝色 / L', price: '189.00', option1: '蓝色', option2: 'L' }
                ],
                options: [{ name: 'Color', values: ['红色', '蓝色'] }, { name: 'Size', values: ['XL', 'L'] }]
              }
            });
          } else if (message.action === 'extractCategoryUrls') {
            callback({
              success: true,
              urls: [
                'https://demo.shopify.com/products/shoes-1',
                'https://demo.shopify.com/products/shoes-2',
                'https://demo.shopify.com/products/shoes-3'
              ]
            });
          } else if (message.action === 'performNextPageClick') {
            callback({ success: true });
          }
        }, 600);
      }
    },
    downloads: {
      download: (options) => {
        console.log('[Mock downloads.download]', options);
        const a = document.createElement('a');
        a.href = options.url;
        a.download = options.filename || 'download';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    }
  };
}

// 全局状态
let currentScrapedProduct = null;
let userLevel = 'free'; // 'free' 或 'vip'
let translationDict = {};

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  await loadUserData();
  await loadDictConfig();
  await checkCurrentPageStatus();
  
  // 绑定事件
  document.getElementById('btnQuickScrape').addEventListener('click', handleQuickScrape);
  document.getElementById('btnDownloadZip').addEventListener('click', downloadMediaZip);
  document.getElementById('btnCopyTitle').addEventListener('click', copyTitle);
  document.getElementById('btnCopyDesc').addEventListener('click', copyDescription);
  document.getElementById('btnExportShopifyCsv').addEventListener('click', () => exportCsv('shopify'));
  document.getElementById('btnExportShoplineCsv').addEventListener('click', () => exportCsv('shopline'));
  document.getElementById('btnSubmitBatch').addEventListener('click', handleBatchScrape);
  document.getElementById('btnVerifyAuth').addEventListener('click', verifyAuthToken);
  document.getElementById('btnResetAuth').addEventListener('click', resetAuthToken);
  document.getElementById('btnSaveDict').addEventListener('click', saveDictConfig);
  
  // Excel 上传事件
  const excelZone = document.getElementById('excelUploadZone');
  const excelInput = document.getElementById('fileExcelInput');
  excelZone.addEventListener('click', () => excelInput.click());
  excelInput.addEventListener('change', handleExcelImport);
  
  // 类目抓取事件
  document.getElementById('btnStartCategoryScrape').addEventListener('click', handleCategoryScrape);

  // 监听后台任务状态
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'taskFinished') {
      updateBatchProgress(message.taskState);
    }
  });

  // 定期轮询检查后台任务进度
  setInterval(checkRunningTaskProgress, 1000);
});

/* ==================== 1. UI Tabs 导航 ==================== */
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const target = tab.getAttribute('data-tab');
      document.getElementById(target).classList.add('active');
    });
  });
}

/* ==================== 2. 用户与配置载入 ==================== */
async function loadUserData() {
  const storage = await chrome.storage.local.get(['jwtToken', 'userLevel', 'dailyQuota']);
  
  // 模拟 JWT 登录校验逻辑
  if (storage.jwtToken) {
    document.getElementById('txtJwtToken').value = storage.jwtToken;
    userLevel = storage.userLevel || 'free';
  } else {
    userLevel = 'free';
  }
  
  updateUserLevelBadge();
  
  // 显示每日免费额度
  const todayStr = new Date().toLocaleDateString();
  const quota = storage.dailyQuota || { date: todayStr, count: 0 };
  const currentCount = quota.date === todayStr ? quota.count : 0;
  document.getElementById('lblDailyQuota').innerText = `${currentCount} / 5 次`;
}

function updateUserLevelBadge() {
  const badge = document.getElementById('userLevelBadge');
  if (userLevel === 'vip') {
    badge.className = 'badge badge-vip';
    badge.innerText = '高级会员 (VIP)';
    document.getElementById('excelVipWarn').classList.add('hidden');
    document.getElementById('btnStartCategoryScrape').classList.remove('disabled');
    document.getElementById('btnStartCategoryScrape').removeAttribute('disabled');
  } else {
    badge.className = 'badge badge-free';
    badge.innerText = '普通会员 (免费)';
    document.getElementById('excelVipWarn').classList.remove('hidden');
  }
}

// 校验授权码 (Mock)
async function verifyAuthToken() {
  const token = document.getElementById('txtJwtToken').value.trim();
  if (!token) {
    showToast('请输入有效的激活码！', 'error');
    return;
  }

  // 为了演示，如果输入包含 "vip" 或者 "ooooxin" 字符，即激活为高级会员，否则为普通激活
  showToast('正在校验云端激活码...', 'info');
  
  setTimeout(async () => {
    let level = 'free';
    if (token.toLowerCase().includes('vip') || token.toLowerCase().includes('ooooxin') || token === 'qwe123456') {
      level = 'vip';
      showToast('激活成功！已解锁高级会员权益。', 'success');
    } else {
      level = 'free';
      showToast('普通码激活成功，每日额度 5 次。', 'success');
    }

    await chrome.storage.local.set({
      jwtToken: token,
      userLevel: level
    });
    userLevel = level;
    updateUserLevelBadge();
  }, 1000);
}

async function resetAuthToken() {
  await chrome.storage.local.remove(['jwtToken', 'userLevel']);
  document.getElementById('txtJwtToken').value = '';
  userLevel = 'free';
  updateUserLevelBadge();
  showToast('账号已注销', 'info');
}

// 字典配置
async function loadDictConfig() {
  const storage = await chrome.storage.local.get(['translationDict']);
  const defaultDict = {
    "红色": "Red", "蓝色": "Blue", "黑色": "Black", "白色": "White", "绿色": "Green",
    "黄色": "Yellow", "灰色": "Grey", "粉色": "Pink", "紫色": "Purple", "橙色": "Orange",
    "大号": "L", "中号": "M", "小号": "S", "加大号": "XL", "双加大": "XXL"
  };
  translationDict = storage.translationDict || defaultDict;
  
  // 显示在界面上
  const dictStr = Object.entries(translationDict).map(([k, v]) => `${k}:${v}`).join('\n');
  document.getElementById('txtDictConfig').value = dictStr;
}

async function saveDictConfig() {
  const val = document.getElementById('txtDictConfig').value.trim();
  const newDict = {};
  val.split('\n').forEach(line => {
    const parts = line.split(':');
    if (parts.length === 2) {
      newDict[parts[0].trim()] = parts[1].trim();
    }
  });
  await chrome.storage.local.set({ translationDict: newDict });
  translationDict = newDict;
  showToast('翻译词典配置已保存', 'success');
}

/* ==================== 3. 页面嗅探控制 ==================== */
async function checkCurrentPageStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // 1. 尝试检测类目商品数
  chrome.tabs.sendMessage(tab.id, { action: 'extractCategoryUrls' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.success && response.urls && response.urls.length > 0) {
      document.getElementById('lblCategoryDetectedCount').innerText = response.urls.length;
      document.getElementById('btnStartCategoryScrape').classList.remove('disabled');
      document.getElementById('btnStartCategoryScrape').removeAttribute('disabled');
      
      // 保存检测到的 urls 以便后面抓取
      window.categoryUrls = response.urls;
    }
  });

  // 2. 检查是否为支持的单品详情页
  // 通过向 content 发消息嗅探
  chrome.tabs.sendMessage(tab.id, { action: 'scrapeCurrentPage' }, (response) => {
    if (chrome.runtime.lastError) {
      // 说明 Content script 还没加载好，或者该页面无法注入
      setSniffBarStatus(false, '未检测到支持的商品页面');
      return;
    }

    if (response && response.success && response.data) {
      const data = response.data;
      setSniffBarStatus(true, `检测到 [${data.platform.toUpperCase()}] 商品详情页`);
      showScrapedProduct(data);
    } else {
      setSniffBarStatus(false, '未检测到支持的商品页面');
    }
  });
}

function setSniffBarStatus(active, text) {
  const sniffBar = document.getElementById('sniffBar');
  const btn = document.getElementById('btnQuickScrape');
  
  document.getElementById('sniffText').innerText = text;
  
  if (active) {
    sniffBar.className = 'sniff-bar activated';
    btn.className = 'btn-quick';
    btn.removeAttribute('disabled');
  } else {
    sniffBar.className = 'sniff-bar deactivated';
    btn.className = 'btn-quick disabled';
    btn.setAttribute('disabled', 'true');
  }
}

// “一键采集”按钮点击处理
async function handleQuickScrape() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  showToast('抓取数据中...', 'info');
  chrome.tabs.sendMessage(tab.id, { action: 'scrapeCurrentPage' }, (response) => {
    if (response && response.success && response.data) {
      showScrapedProduct(response.data);
      showToast('数据采集完成！', 'success');
    } else {
      showToast('采集失败：' + (response?.error || '未知错误'), 'error');
    }
  });
}

// 展示已抓取的单品数据
function showScrapedProduct(product) {
  currentScrapedProduct = product;
  
  // 更新 UI
  document.getElementById('singleEmptyState').classList.add('hidden');
  document.getElementById('singleDataPanel').classList.remove('hidden');
  
  document.getElementById('productTitle').innerText = product.title;
  document.getElementById('productPrice').innerText = product.price;
  document.getElementById('productPlatform').innerText = product.platform.toUpperCase();
  
  // 封面图
  if (product.images && product.images.length > 0) {
    document.getElementById('productCover').src = product.images[0];
  } else {
    document.getElementById('productCover').src = 'icons/icon128.png';
  }
}

/* ==================== 4. 媒体资产 ZIP 打包下载 ==================== */
async function downloadMediaZip() {
  if (!currentScrapedProduct) return;

  const btn = document.getElementById('btnDownloadZip');
  const originalText = btn.innerText;
  btn.innerText = '正在处理图片...';
  btn.disabled = true;

  try {
    const zip = new JSZip();
    const shouldConvert = document.getElementById('chkWebpToJpg').checked;
    
    // 创建图片文件夹
    const imgFolder = zip.folder("images");
    
    const imageUrls = currentScrapedProduct.images || [];
    showToast(`正在转换并打包 ${imageUrls.length} 张图片...`, 'info');

    // 并行下载并转换图片
    const downloadPromises = imageUrls.map(async (url, idx) => {
      try {
        // 1. 通过 Background.js 代理 fetch 并转为 Base64 以绕过 Canvas CORS
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'proxyFetchImage', url }, resolve);
        });

        if (!response || !response.success) {
          throw new Error(response?.error || '代理获取图片失败');
        }

        let fileData = response.base64;
        let ext = getFileExtension(url) || 'jpg';
        
        // 2. 如果是 WebP 且勾选了“转 JPG”，则在 Canvas 中转换
        if (shouldConvert && (ext.toLowerCase() === 'webp' || fileData.startsWith('data:image/webp'))) {
          fileData = await convertWebpToJpg(fileData);
          ext = 'jpg';
        }

        // 去掉 base64 的头部 data:image/xxx;base64,
        const binaryData = atob(fileData.split(',')[1]);
        const arrayBuffer = new ArrayBuffer(binaryData.length);
        const ia = new Uint8Array(arrayBuffer);
        for (let i = 0; i < binaryData.length; i++) {
          ia[i] = binaryData.charCodeAt(i);
        }

        imgFolder.file(`prod_img_${idx + 1}.${ext}`, arrayBuffer);
      } catch (err) {
        console.warn(`Failed to process image ${url}:`, err);
      }
    });

    await Promise.all(downloadPromises);

    // 生成 ZIP
    const content = await zip.generateAsync({ type: "blob" });
    const filename = `${currentScrapedProduct.title.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '_')}_media.zip`;
    
    // 触发下载
    const blobUrl = URL.createObjectURL(content);
    chrome.downloads.download({
      url: blobUrl,
      filename: filename,
      saveAs: true
    });
    
    showToast('ZIP 包生成成功！', 'success');
  } catch (err) {
    showToast('生成 ZIP 失败：' + err.message, 'error');
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
}

// 纯前端 WebP 转 JPG
async function convertWebpToJpg(base64Data) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      // 转为 jpg，质量 0.9
      const jpgBase64 = canvas.toDataURL('image/jpeg', 0.9);
      resolve(jpgBase64);
    };
    img.onerror = (e) => reject(new Error('图片解码失败'));
    img.src = base64Data;
  });
}

function getFileExtension(url) {
  const parts = url.split('?')[0].split('.');
  if (parts.length > 1) {
    return parts.pop().toLowerCase();
  }
  return '';
}

/* ==================== 5. 快捷文本复制 ==================== */
function copyTitle() {
  if (!currentScrapedProduct) return;
  navigator.clipboard.writeText(currentScrapedProduct.title);
  showToast('标题已复制！', 'success');
}

function copyDescription() {
  if (!currentScrapedProduct) return;
  // 去除所有 HTML 标签
  const cleanText = currentScrapedProduct.description.replace(/<[^>]+>/g, '').trim();
  navigator.clipboard.writeText(cleanText);
  showToast('描述纯文本已复制！', 'success');
}

/* ==================== 6. CSV 格式包生成 ==================== */
function translateOption(val) {
  if (!val) return '';
  // 匹配多语言映射，例如“红色/XL”
  const parts = val.split('/').map(p => p.trim());
  const translatedParts = parts.map(p => translationDict[p] || p);
  return translatedParts.join(' / ');
}

function exportCsv(type = 'shopify') {
  if (!currentScrapedProduct) return;
  
  const headers = [
    'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
    'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
    'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Variant Inventory Qty',
    'Image Src', 'Image Position'
  ];

  const handle = currentScrapedProduct.title.toLowerCase().substring(0, 30).replace(/[^a-z0-9]/g, '-');
  const rows = [];

  // 获取变体
  const variants = currentScrapedProduct.variants || [];
  const images = currentScrapedProduct.images || [];

  // 构建多行变体及图片列表
  const maxLines = Math.max(variants.length, images.length, 1);

  for (let i = 0; i < maxLines; i++) {
    const v = variants[i] || {};
    const imgUrl = images[i] || '';

    // 变体选项值映射翻译
    const opt1Val = v.option1 ? translateOption(v.option1) : '';
    const opt2Val = v.option2 ? translateOption(v.option2) : '';
    const opt3Val = v.option3 ? translateOption(v.option3) : '';

    const row = [
      handle,                                                   // Handle
      i === 0 ? escapeCsvField(currentScrapedProduct.title) : '',// Title (首行输出)
      i === 0 ? escapeCsvField(currentScrapedProduct.description) : '', // Body HTML (首行输出)
      i === 0 ? escapeCsvField(type === 'shopify' ? 'Shopify' : 'Shopline') : '', // Vendor
      i === 0 ? 'General' : '',                                 // Type
      '',                                                       // Tags
      'TRUE',                                                   // Published
      i === 0 ? 'Size/Color' : '',                              // Option1 Name (首行)
      opt1Val,                                                  // Option1 Value
      '',                                                       // Option2 Name
      opt2Val,                                                  // Option2 Value
      '',                                                       // Option3 Name
      opt3Val,                                                  // Option3 Value
      v.sku || '',                                              // Variant SKU
      v.price || currentScrapedProduct.price,                   // Variant Price
      v.compare_at_price || '',                                 // Variant Compare At Price
      v.inventory_quantity || 99,                              // Variant Inventory Qty
      imgUrl,                                                   // Image Src
      imgUrl ? (i + 1) : ''                                     // Image Position
    ];
    rows.push(row);
  }

  // 组装 CSV 字符串 (CSV 必须要 UTF-8 with BOM 以防中文乱码)
  let csvContent = '\uFEFF';
  csvContent += headers.join(',') + '\n';
  rows.forEach(r => {
    csvContent += r.join(',') + '\n';
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const blobUrl = URL.createObjectURL(blob);
  
  chrome.downloads.download({
    url: blobUrl,
    filename: `${handle}_${type}_export.csv`,
    saveAs: true
  });

  showToast(`${type.toUpperCase()} CSV 导出成功！`, 'success');
}

function escapeCsvField(val) {
  if (!val) return '""';
  let clean = val.replace(/"/g, '""'); // 双引号转义
  return `"${clean}"`;
}

/* ==================== 7. 批量采集处理 ==================== */
async function handleBatchScrape() {
  const text = document.getElementById('txtBatchUrls').value.trim();
  if (!text) {
    showToast('请输入采集链接！', 'error');
    return;
  }

  const urls = text.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
  if (urls.length === 0) {
    showToast('未检测到有效的 HTTP 商品链接！', 'error');
    return;
  }

  // 1. 会员权益前置检验
  if (userLevel === 'free') {
    if (urls.length > 1) {
      showToast('免费会员单次仅支持采集 1 个链接！请升级 VIP。', 'error');
      return;
    }
  }

  // 2. 向后台发送批量采集请求
  showToast('批量任务正在初始化...', 'info');
  document.getElementById('batchProgressContainer').classList.remove('hidden');
  
  chrome.runtime.sendMessage({
    action: 'startBatchScrape',
    urls: urls,
    userLevel: userLevel
  }, (response) => {
    if (response && response.success) {
      showToast('任务已成功在后台跑起来了！', 'success');
      checkRunningTaskProgress();
    } else {
      showToast('批量初始化失败：' + response.error, 'error');
    }
  });
}

// 检查后台运行的批量任务进度
async function checkRunningTaskProgress() {
  const storage = await chrome.storage.local.get(['currentTask']);
  const task = storage.currentTask;
  
  if (!task) return;

  const progressContainer = document.getElementById('batchProgressContainer');
  const progressBar = document.getElementById('batchProgressBar');
  const statusLabel = document.getElementById('lblBatchProgressStatus');

  if (task.status === 'running') {
    progressContainer.classList.remove('hidden');
    const pct = Math.round((task.currentIndex / task.urls.length) * 100);
    progressBar.style.width = `${pct}%`;
    statusLabel.innerText = `正在采集: ${task.currentIndex + 1}/${task.urls.length} (已完成 ${task.results.length} 个)`;
  } else if (task.status === 'completed') {
    progressBar.style.width = '100%';
    statusLabel.innerText = `采集完成！共成功 ${task.results.length} 个`;
    // 更新展示列表
    if (task.results.length > 0) {
      showScrapedProduct(task.results[0]); // 默认显示第一个采集成功的商品
    }
    // 任务完成后清除 storage 中状态
    await chrome.storage.local.remove(['currentTask']);
    setTimeout(() => {
      progressContainer.classList.add('hidden');
    }, 4000);
  }
}

function updateBatchProgress(taskState) {
  const progressBar = document.getElementById('batchProgressBar');
  const statusLabel = document.getElementById('lblBatchProgressStatus');
  progressBar.style.width = '100%';
  statusLabel.innerText = `任务已完成！成功 ${taskState.results.length} 个商品`;
}

/* ==================== 8. Excel 表格导入 (SheetJS) ==================== */
function handleExcelImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

      // 提取表格中所有的 URL
      const urls = [];
      json.forEach(row => {
        row.forEach(cell => {
          if (typeof cell === 'string' && (cell.startsWith('http://') || cell.startsWith('https://'))) {
            const cleanUrl = cell.trim();
            if (!urls.includes(cleanUrl)) urls.push(cleanUrl);
          }
        });
      });

      if (urls.length === 0) {
        showToast('表格中没有提取到有效的商品链接！', 'error');
        return;
      }

      // 保存检测到的 URL 列表
      window.excelUrls = urls;
      
      document.getElementById('lblExcelFileName').innerText = file.name;
      document.getElementById('lblExcelUrlCount').innerText = urls.length;
      document.getElementById('excelInfoPanel').classList.remove('hidden');
      
      showToast(`成功解析 Excel，抓取到 ${urls.length} 个 URL`, 'success');
    } catch (err) {
      showToast('解析 Excel 失败：' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

// 开始对导入的 Excel 链接进行抓取
async function handleExcelScrape() {
  if (!window.excelUrls || window.excelUrls.length === 0) return;

  let urlsToScrape = window.excelUrls;
  if (userLevel === 'free') {
    urlsToScrape = window.excelUrls.slice(0, 3); // 免费限额 3 条
    showToast('免费版仅处理前 3 条，升级高级版解除限制', 'warning');
  }

  showToast('开始解析 Excel 导入任务...', 'info');
  document.getElementById('excelProgressContainer').classList.remove('hidden');

  chrome.runtime.sendMessage({
    action: 'startBatchScrape',
    urls: urlsToScrape,
    userLevel: userLevel
  }, (response) => {
    if (response && response.success) {
      // 通过轮询监听任务进度
      pollExcelProgress(urlsToScrape.length);
    } else {
      showToast('任务提交失败: ' + response.error, 'error');
    }
  });
}

// 绑定 Excel 确认按钮事件
document.getElementById('btnStartExcelScrape').addEventListener('click', handleExcelScrape);

function pollExcelProgress(totalCount) {
  const interval = setInterval(async () => {
    const storage = await chrome.storage.local.get(['currentTask']);
    const task = storage.currentTask;
    
    if (!task) {
      clearInterval(interval);
      return;
    }

    const progressBar = document.getElementById('excelProgressBar');
    const statusLabel = document.getElementById('lblExcelProgressStatus');
    const textLabel = document.getElementById('lblExcelStatusText');

    if (task.status === 'running') {
      const pct = Math.round((task.currentIndex / totalCount) * 100);
      progressBar.style.width = `${pct}%`;
      statusLabel.innerText = `进度: ${task.currentIndex + 1}/${totalCount}`;
      textLabel.innerText = `正在抓取第 ${task.currentIndex + 1} 个链接...`;
    } else if (task.status === 'completed') {
      progressBar.style.width = '100%';
      statusLabel.innerText = `进度: ${totalCount}/${totalCount}`;
      textLabel.innerText = `采集完成！已成功抓取所有链接！`;
      clearInterval(interval);
      
      setTimeout(() => {
        document.getElementById('excelProgressContainer').classList.add('hidden');
      }, 4000);
    }
  }, 1000);
}

/* ==================== 9. 类目/Collection 一键扒取 ==================== */
async function handleCategoryScrape() {
  if (userLevel !== 'vip') {
    showToast('类目翻页抓取为高级 VIP 功能！请绑定 VIP 激活码以启用。', 'warning');
    return;
  }

  if (!window.categoryUrls || window.categoryUrls.length === 0) {
    showToast('当前页面未嗅探到任何商品链接！', 'error');
    return;
  }

  const pageCount = parseInt(document.getElementById('numPageCount').value) || 5;
  showToast(`开始扒取类目商品！目标翻页: ${pageCount} 页`, 'info');
  document.getElementById('categoryProgressContainer').classList.remove('hidden');
  
  // 模拟翻页与后台多链接队列抓取
  let allUrls = [...window.categoryUrls];
  const progressBar = document.getElementById('categoryProgressBar');
  const progressStatus = document.getElementById('lblCategoryProgressStatus');

  progressBar.style.width = '20%';
  progressStatus.innerText = `已嗅探第 1 页，共 ${allUrls.length} 个链接...`;

  // 模拟翻页点击 
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let currentPage = 1;

  const turnPageAndExtract = () => {
    if (currentPage >= pageCount) {
      // 达到指定页数，开始把抓取的所有商品链接送入批量抓取队列中
      startCategoryTaskScraping(allUrls);
      return;
    }

    progressStatus.innerText = `正在跳转至第 ${currentPage + 1} 页...`;
    
    chrome.tabs.sendMessage(tab.id, { action: 'performNextPageClick' }, (res) => {
      if (res && res.success) {
        currentPage++;
        progressBar.style.width = `${Math.round((currentPage / pageCount) * 100)}%`;
        
        // 延时 2.5 秒等待页面渲染和下一页数据生成
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'extractCategoryUrls' }, (resUrls) => {
            if (resUrls && resUrls.success && resUrls.urls) {
              const newUrls = resUrls.urls.filter(u => !allUrls.includes(u));
              allUrls = [...allUrls, ...newUrls];
              progressStatus.innerText = `第 ${currentPage} 页数据就绪，追加 ${newUrls.length} 个链接...`;
              turnPageAndExtract();
            } else {
              progressStatus.innerText = `已到达最后一页，终止翻页。`;
              startCategoryTaskScraping(allUrls);
            }
          });
        }, 2500);
      } else {
        progressStatus.innerText = `无法点击下一页，翻页抓取提前结束。`;
        startCategoryTaskScraping(allUrls);
      }
    });
  };

  turnPageAndExtract();
}

function startCategoryTaskScraping(urls) {
  const progressBar = document.getElementById('categoryProgressBar');
  const progressStatus = document.getElementById('lblCategoryProgressStatus');
  
  progressStatus.innerText = `已成功嗅探 ${urls.length} 个去重商品！正在创建抓取队列...`;
  
  chrome.runtime.sendMessage({
    action: 'startBatchScrape',
    urls: urls,
    userLevel: userLevel
  }, (response) => {
    if (response && response.success) {
      showToast(`类目 ${urls.length} 个商品后台采集已启动！`, 'success');
      // 监控该批量任务
      pollExcelProgress(urls.length); 
      setTimeout(() => {
        document.getElementById('categoryProgressContainer').classList.add('hidden');
      }, 5000);
    } else {
      showToast('提交类目抓取任务失败: ' + response.error, 'error');
    }
  });
}

/* ==================== 辅助 UI 工具 ==================== */
function showToast(message, type = 'info') {
  const footer = document.getElementById('lblSystemMessage');
  footer.innerText = message;
  
  if (type === 'success') {
    footer.style.color = '#10b981';
  } else if (type === 'error') {
    footer.style.color = '#f43f5e';
  } else if (type === 'warning') {
    footer.style.color = '#f59e0b';
  } else {
    footer.style.color = '#06b6d4';
  }
}
