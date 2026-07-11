/*
 * Hi English - PWA 安装引导
 * 三端（iOS / Android / HarmonyOS）均支持"添加到主屏幕"；
 * 安卓 Chrome/Edge 可一键安装，苹果/鸿蒙为图文引导手动添加。
 * 支持 Safari / 华为浏览器 / Chrome / Edge / Firefox 等任意现代浏览器。
 */
(function () {
  'use strict';

  var KEY_DISMISS = 'hi_english_install_dismissed';
  var deferredPrompt = null;

  function detectPlatform() {
    var ua = navigator.userAgent || '';
    var u = ua.toLowerCase();
    var isIOS = /iphone|ipad|ipod/.test(u) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isAndroid = /android/.test(u);
    var isHarmony = /harmonyos|huawei|honor/.test(u);
    var isMobile = isIOS || isAndroid || isHarmony || /mobile/.test(u);
    // 微信 / 钉钉 / 微博 / QQ 内置浏览器（限制麦克风与 PWA 安装）
    var isInApp = /micromessenger|dingtalk|weibo|qq\//.test(u);
    var isSafari = /safari/.test(u) && !/chrome/.test(u) && !/chromium/.test(u);
    var isChrome = /chrome|chromium|crios/.test(u) && !/edg/.test(u);
    var isEdge = /edg/.test(u);
    var isHuaweiBrowser = /huaweibrowser|huaweibrowserlite/.test(u);
    var isFirefox = /firefox|fxios/.test(u);
    return {
      isIOS: isIOS, isAndroid: isAndroid, isHarmony: isHarmony,
      isMobile: isMobile, isInApp: isInApp,
      isSafari: isSafari, isChrome: isChrome, isEdge: isEdge,
      isHuaweiBrowser: isHuaweiBrowser, isFirefox: isFirefox
    };
  }

  var P = detectPlatform();

  // 捕获安卓 Chrome/Edge/Samsung 的原生安装事件（必须在页面加载时注册）
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });

  function canNativeInstall() {
    return !!deferredPrompt && (P.isAndroid || P.isChrome || P.isEdge);
  }

  function doNativeInstall() {
    if (canNativeInstall()) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        deferredPrompt = null;
        if (choice.outcome === 'accepted') dismiss(true);
      });
      return true;
    }
    return false;
  }

  function isDismissed() {
    try { return localStorage.getItem(KEY_DISMISS) === '1'; } catch (e) { return false; }
  }
  function dismiss(permanent) {
    if (permanent) { try { localStorage.setItem(KEY_DISMISS, '1'); } catch (e) {} }
    var b = document.getElementById('install-banner');
    if (b) b.style.display = 'none';
    var m = document.getElementById('install-modal-mask');
    if (m) m.style.display = 'none';
  }

  // 按平台/浏览器返回引导文案与配图
  function getGuide() {
    if (P.isInApp) {
      return {
        title: '请先在系统浏览器中打开',
        tip: '当前在 App 内置浏览器中，无法安装到主屏幕。',
        steps: [
          { icon: '···', text: '点击右上角「···」或「↗」' },
          { icon: '🌐', text: '选择「在浏览器中打开」' },
          { icon: '📱', text: '用 Chrome / Safari / 华为浏览器打开后，再安装' }
        ]
      };
    }
    if (P.isIOS) {
      if (P.isSafari) {
        return {
          title: '添加到主屏幕（Safari）',
          tip: '苹果系统限制，需手动 3 步，无法一键安装。',
          steps: [
            { icon: '⬆', text: '点击底部中间的「分享」图标' },
            { icon: '➕', text: '向上滑动找到并点击「添加到主屏幕」' },
            { icon: '✓', text: '点击右上角「添加」即可' }
          ]
        };
      }
      return {
        title: '添加到主屏幕（Chrome）',
        tip: 'iOS 上的 Chrome 使用苹果内核，需手动添加。',
        steps: [
          { icon: '⋮', text: '点击右下角「⋯」菜单' },
          { icon: '➕', text: '点击「添加到主屏幕」' },
          { icon: '✓', text: '点击「添加」即可' }
        ]
      };
    }
    if (P.isHarmony) {
      if (P.isHuaweiBrowser) {
        return {
          title: '添加到主屏幕（华为浏览器）',
          tip: '华为浏览器支持一键添加到主屏幕。',
          steps: [
            { icon: '⋮', text: '点击右下角「菜单」按钮' },
            { icon: '➕', text: '点击「添加到主屏幕」' },
            { icon: '✓', text: '点击「添加」即可' }
          ]
        };
      }
      return {
        title: '添加到主屏幕（Chrome）',
        tip: '鸿蒙 Chrome 需手动添加到主屏幕。',
        steps: [
          { icon: '⋮', text: '点击右上角「⋯」菜单' },
          { icon: '➕', text: '点击「添加到主屏幕」' },
          { icon: '✓', text: '点击「添加」即可' }
        ]
      };
    }
    if (P.isAndroid) {
      if (canNativeInstall()) {
        return {
          title: '一键安装到主屏幕',
          tip: '点击下方「安装」按钮即可，体验接近原生 App。',
          steps: [
            { icon: '📲', text: '点击「安装」→ 确认' },
            { icon: '🏠', text: '主屏幕出现 Hi English 图标即完成' }
          ],
          native: true
        };
      }
      return {
        title: '添加到主屏幕（Android）',
        tip: '当前浏览器不支持一键安装，手动添加同样好用。',
        steps: [
          { icon: '⋮', text: '点击右上角「⋯」菜单' },
          { icon: '➕', text: '点击「安装应用 / 添加到主屏幕」' },
          { icon: '✓', text: '点击「安装」即可' }
        ]
      };
    }
    // 桌面端
    return {
      title: '安装到桌面',
      tip: '可像 App 一样在桌面打开，离线也能用。',
      steps: [
        { icon: '🔒', text: '点击地址栏右侧的「安装」图标' },
        { icon: '🖥', text: '或浏览器菜单 →「安装 Hi English」' }
      ]
    };
  }

  // ===== UI 渲染 =====
  var cssInjected = false;
  function ensureCss() {
    if (cssInjected) return;
    var s = document.createElement('style');
    s.textContent = [
      '#install-banner{position:fixed;left:50%;transform:translateX(-50%);bottom:72px;width:92%;max-width:400px;',
      'background:#fff;border:1px solid #E8E8E8;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);',
      'padding:12px 14px;display:flex;align-items:center;gap:10px;z-index:9000;font-size:13px;}',
      '#install-banner .ib-icon{font-size:22px;}',
      '#install-banner .ib-text{flex:1;color:#333;line-height:1.4;}',
      '#install-banner .ib-btn{background:#4A90D9;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;}',
      '#install-banner .ib-close{background:none;border:none;color:#999;font-size:18px;cursor:pointer;padding:0 4px;}',
      '#install-modal-mask{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;justify-content:center;align-items:center;}',
      '#install-modal-mask.show{display:flex;}',
      '.install-modal{background:#fff;border-radius:16px;padding:24px 20px;width:90%;max-width:340px;text-align:center;animation:popIn .25s ease;}',
      '.install-modal h3{font-size:17px;margin-bottom:6px;color:#333;}',
      '.install-modal .im-tip{font-size:12px;color:#999;margin-bottom:16px;line-height:1.5;}',
      '.install-step{display:flex;align-items:center;gap:12px;background:#F5F7FA;border-radius:10px;padding:12px;margin-bottom:10px;text-align:left;}',
      '.install-step .is-icon{width:36px;height:36px;border-radius:50%;background:#E8F2FC;color:#4A90D9;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}',
      '.install-step .is-text{font-size:13px;color:#333;line-height:1.4;}',
      '.install-modal .im-actions{display:flex;gap:10px;margin-top:8px;}',
      '.install-modal .im-btn{flex:1;padding:11px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;}',
      '.install-modal .im-btn.primary{background:#4A90D9;color:#fff;}',
      '.install-modal .im-btn.ghost{background:#F5F7FA;color:#666;}',
      '@keyframes popIn{from{transform:scale(.85);opacity:0}to{transform:scale(1);opacity:1}}'
    ].join('');
    document.head.appendChild(s);
    cssInjected = true;
  }

  function showModal() {
    ensureCss();
    var g = getGuide();
    var stepsHtml = g.steps.map(function (st) {
      return '<div class="install-step"><div class="is-icon">' + st.icon + '</div>' +
        '<div class="is-text">' + st.text + '</div></div>';
    }).join('');

    var mask = document.getElementById('install-modal-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'install-modal-mask';
      mask.innerHTML = '<div class="install-modal">' +
        '<h3 id="im-title"></h3>' +
        '<div class="im-tip" id="im-tip"></div>' +
        '<div id="im-steps"></div>' +
        '<div class="im-actions">' +
        '<button class="im-btn ghost" onclick="InstallGuide.closeModal()">关闭</button>' +
        '<button class="im-btn primary" id="im-primary" onclick="InstallGuide.primary()">知道了</button>' +
        '</div></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', function (e) { if (e.target === mask) InstallGuide.closeModal(); });
    }
    document.getElementById('im-title').textContent = g.title;
    document.getElementById('im-tip').textContent = g.tip || '';
    document.getElementById('im-steps').innerHTML = stepsHtml;
    var primary = document.getElementById('im-primary');
    if (g.native) {
      primary.textContent = '安装';
      primary.onclick = function () { doNativeInstall(); InstallGuide.closeModal(); };
    } else {
      primary.textContent = '知道了';
      primary.onclick = function () { InstallGuide.closeModal(); };
    }
    mask.classList.add('show');
  }

  function showBanner() {
    if (isDismissed()) return;
    ensureCss();
    var b = document.getElementById('install-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'install-banner';
      b.innerHTML = '<span class="ib-icon">📱</span>' +
        '<span class="ib-text">安装 Hi English 到主屏幕，像 App 一样随时学习</span>' +
        '<button class="ib-btn" id="ib-action">查看</button>' +
        '<button class="ib-close" id="ib-close">×</button>';
      document.body.appendChild(b);
      var actionBtn = document.getElementById('ib-action');
      actionBtn.textContent = canNativeInstall() ? '安装' : '查看';
      actionBtn.onclick = function () {
        if (canNativeInstall()) { doNativeInstall(); }
        else { showModal(); }
      };
      document.getElementById('ib-close').onclick = function () { dismiss(true); };
    }
    b.style.display = 'flex';
  }

  // 登录后弹一次（仅移动端）
  function maybeShow() {
    if (!P.isMobile) return;       // 桌面端不弹 banner，但 modal 仍可手动触发
    if (isDismissed()) return;
    showBanner();
  }

  window.InstallGuide = {
    maybeShow: maybeShow,
    showModal: showModal,
    closeModal: function () {
      var m = document.getElementById('install-modal-mask');
      if (m) m.classList.remove('show');
    },
    primary: function () { /* placeholder, overwritten per guide */ }
  };

  // 移动端：登录页(index.html)与学员端(student.html)登录落地后均自动弹一次
  if (P.isMobile) {
    window.addEventListener('DOMContentLoaded', function () { setTimeout(maybeShow, 800); });
  }
})();
