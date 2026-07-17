// ===================================================
// Hi English - Service Worker v28 (PWA安装支持)
// ===================================================
// v28: 学习清单标签双达标+筛选按钮缩小；商务跟读提示+分数颜色；补卡逻辑修复；拼写练习上一题+词性缩小；钉钉催学移动端列表
// v27: 学习清单加"已学"按钮+重排+已学筛选含双达标；readIndex合并改"最后停留页"优先；bump 核心缓存强制刷新 JS
// v25: 已学逻辑改为"真实听过音频才算" + 定位页精确停留；bump 核心缓存强制刷新 JS
// v24: 音频缓存版本提升，强制刷新重新生成的发音MP3
// v22: 移动端通知栏推送（showNotification + notificationclick）
// v21: 修复分组数据持久化 + 搜索栏禁止浏览器自动填充
// v48: 补卡2项UI修复（日历选中框跟随点击日期/去补卡按钮日期字体缩小防换行）
// v47: 4项Bug修复（补卡入口/禁用拦截/状态标签/报表日期联动）强制刷新缓存

var CACHE_VERSION = 'hi-english-v48';
var CORE_CACHE = 'hi-english-core-v48';
var AUDIO_CACHE = 'hi-english-audio-v31';

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
  './admin.css',
  './admin.js'
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

  // 音频文件：网络优先
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

  // 其他文件：网络优先
  event.respondWith(
    fetch(event.request).then(function(resp) {
      if (resp.ok && resp.type !== 'opaque') {
        var clone = resp.clone();
        caches.open(CORE_CACHE).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return resp;
    }).catch(function() {
      return caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('离线', { status: 503 });
      });
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
