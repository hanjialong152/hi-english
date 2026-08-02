// ===================================================
// Hi English - Service Worker v98 (PWA安装支持)
// ===================================================
// v98: 搜索框修复(手机端键盘收走+切换阶段清空搜索)；bump 缓存名强制刷新全部静态资源
// v96: 数据呈现改造(当月/往月/累计)发布；bump 缓存名强制刷新全部静态资源
// v95: 静态资源策略从"网络优先"改为"缓存优先"
//      修复普通模式首次访问慢(~1min)问题：
//      原因：SW 网络优先对每个静态请求都重新走网络，
//      在 Render 上每次 fetch 被拦截后重发耗时 4-16s（直连只需几百ms），
//      多个 JS 文件叠加导致首屏约 1 分钟。
//      改为缓存优先后：有缓存直接返回(0ms)，后台静默更新；
//      API 和音频保持原有逻辑不变。
//
// v94-v28: (保留历史版本记录)
// v94: 前一版本
// v88: 同步公网翻页尽头全屏阻断页修复（student.js）；bump 核心缓存强制刷新 JS
// v87: 管理员端导出改真XLSX（XLSX库生成）；团队/分组周测月测平均分显示保留2小数
// v84: 月测顶部最高分提示修正
// v83: 根治周测/月测 DOM id 冲突；月测麦克风通过无留痕修复
// v78: 回退 dirty phrase 为 dirty surface defect
var CACHE_VERSION = 'hi-english-v98';
var CORE_CACHE = 'hi-english-core-v98';
var AUDIO_CACHE = 'hi-english-audio-v35';

var CORE_FILES = [
  './',
  './index.html',
  './student.html',
  './admin.html',
  './style.css',
  './css/style.css',
  './app.js',
  './words_data.js',
  './js/common.js',
  './js/student.js',
  './js/admin.js',
  './manifest.json',
  './service-worker.js',
  './icon-192.png',
  './icon-512.png',
  './icon-apple.png',
  './favicon.png',
  './admin.css'
];

self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CORE_CACHE).then(function(cache) {
      return cache.addAll(CORE_FILES);
    }).catch(function() {})
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(name) {
        if (name !== CORE_CACHE && name !== AUDIO_CACHE) {
          return caches.delete(name);
        }
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // API 请求：永远走网络，不缓存（确保跨终端数据一致性）
  if (url.pathname.indexOf('/api/') !== -1) {
    event.respondWith(
      fetch(event.request).catch(function() {
        return new Response('{"success":false,"error":"offline"}', {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 音频文件：网络优先（音频需要最新版本，且体积大不适合预缓存）
  if (url.pathname.indexOf('/audio/') !== -1 || url.pathname.match(/\.(mp3|wav)$/)) {
    event.respondWith(
      fetch(event.request).then(function(resp) {
        if (resp.ok) {
          var clone = resp.clone();
          caches.open(AUDIO_CACHE).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return resp;
      }).catch(function() {
        return caches.match(event.request).then(function(cached) {
          return cached || new Response('', { status: 404 });
        });
      })
    );
    return;
  }

  // 静态文件（JS/CSS/HTML/图片）：缓存优先
  // 有缓存直接返回（0ms），同时后台发网络请求静默更新缓存
  // 无缓存时走网络（首次访问或缓存被清除时）
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      var networkFetch = fetch(event.request).then(function(resp) {
        if (resp.ok && resp.type !== 'opaque') {
          var clone = resp.clone();
          caches.open(CORE_CACHE).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return resp;
      });
      // 有缓存立即返回，无缓存等网络
      return cached || networkFetch;
    }).catch(function() {
      // 完全离线时的兜底
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
      return new Response('离线', { status: 503 });
    })
  );
});

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 点击通知栏消息时，聚焦已打开的学员端页面或新开一个
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || 'student.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        if (c.url.indexOf('student.html') !== -1 && 'focus' in c) {
          return c.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./' + targetUrl);
      }
    })
  );
});
