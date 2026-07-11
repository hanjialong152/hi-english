/*
 * Hi English - 三端下载/安装渠道弹窗
 * 安卓 / 苹果(iOS) / 鸿蒙(HarmonyOS) 均可"添加到主屏幕"（PWA）；
 * 安卓 Chrome/Edge 支持一键安装，苹果/鸿蒙为图文引导。
 *
 * 行为（按需求）：
 *  - 登录学员端后自动弹出（每次进入都弹，确保用户能看到下载渠道）。
 *  - 弹窗可手动关闭（× / 点遮罩 / 关闭按钮）。
 *  - 不设"不再提示"、不设常驻按钮——避免引导被关掉后用户再也找不到入口。
 */
(function () {
  'use strict';

  var deferredPrompt = null;

  function detectPlatform() {
    var ua = navigator.userAgent || '';
    var u = ua.toLowerCase();
    var isIOS = /iphone|ipad|ipod/.test(u) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isAndroid = /android/.test(u);
    var isHarmony = /harmonyos|huawei|honor/.test(u);
    var isMobile = isIOS || isAndroid || isHarmony || /mobile/.test(u);
    var isInApp = /micromessenger|dingtalk|weibo|qq\//.test(u);
    var isSafari = /safari/.test(u) && !/chrome/.test(u) && !/chromium/.test(u);
    var isChrome = /chrome|chromium|crios/.test(u) && !/edg/.test(u);
    var isEdge = /edg/.test(u);
    var isHuaweiBrowser = /huaweibrowser|huaweibrowserlite/.test(u);
    return {
      isIOS: isIOS, isAndroid: isAndroid, isHarmony: isHarmony,
      isMobile: isMobile, isInApp: isInApp,
      isSafari: isSafari, isChrome: isChrome, isEdge: isEdge,
      isHuaweiBrowser: isHuaweiBrowser
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
        if (choice.outcome === 'accepted') {
          closeModal();
        } else {
          closeModal();
        }
      });
      return true;
    }
    return false;
  }

  // ===== 每个平台的分步引导 =====
  var GUIDES = {
    inapp: {
      title: '请先在系统浏览器中打开',
      tip: '当前在 App 内置浏览器中，无法直接安装到主屏幕。',
      steps: [
        { icon: '···', text: '点击右上角「···」或「↗」' },
        { icon: '🌐', text: '选择「在浏览器中打开」' },
        { icon: '📱', text: '用 Chrome / Safari / 华为浏览器打开后，再安装' }
      ]
    },
    ios_safari: {
      title: '苹果 Safari · 添加到主屏幕',
      tip: '苹果系统限制，需手动 3 步，无法一键安装。',
      steps: [
        { icon: '⬆', text: '点击底部中间的「分享」图标' },
        { icon: '➕', text: '向上滑动找到并点击「添加到主屏幕」' },
        { icon: '✓', text: '点击右上角「添加」即可' }
      ]
    },
    ios_chrome: {
      title: '苹果 Chrome · 添加到主屏幕',
      tip: 'iOS 上的 Chrome 使用苹果内核，需手动添加。',
      steps: [
        { icon: '⋮', text: '点击右下角「⋯」菜单' },
        { icon: '➕', text: '点击「添加到主屏幕」' },
        { icon: '✓', text: '点击「添加」即可' }
      ]
    },
    harmony_hw: {
      title: '鸿蒙 · 华为浏览器添加到主屏幕',
      tip: '华为浏览器支持一键添加到主屏幕。',
      steps: [
        { icon: '⋮', text: '点击右下角「菜单」按钮' },
        { icon: '➕', text: '点击「添加到主屏幕」' },
        { icon: '✓', text: '点击「添加」即可' }
      ]
    },
    harmony_chrome: {
      title: '鸿蒙 · Chrome 添加到主屏幕',
      tip: '鸿蒙 Chrome 需手动添加到主屏幕。',
      steps: [
        { icon: '⋮', text: '点击右上角「⋯」菜单' },
        { icon: '➕', text: '点击「添加到主屏幕」' },
        { icon: '✓', text: '点击「添加」即可' }
      ]
    },
    android_native: {
      title: '安卓 · 一键安装到主屏幕',
      tip: '点击下方「安装」按钮即可，体验接近原生 App。',
      steps: [
        { icon: '📲', text: '点击「安装」→ 确认' },
        { icon: '🏠', text: '主屏幕出现 Hi English 图标即完成' }
      ],
      native: true
    },
    android_manual: {
      title: '安卓 · 添加到主屏幕',
      tip: '当前浏览器不支持一键安装，手动添加同样好用。',
      steps: [
        { icon: '⋮', text: '点击右上角「⋯」菜单' },
        { icon: '➕', text: '点击「安装应用 / 添加到主屏幕」' },
        { icon: '✓', text: '点击「安装」即可' }
      ]
    },
    desktop: {
      title: '安装到桌面',
      tip: '可像 App 一样在桌面打开，离线也能用。',
      steps: [
        { icon: '🔒', text: '点击地址栏右侧的「安装」图标' },
        { icon: '🖥', text: '或浏览器菜单 →「安装 Hi English」' }
      ]
    }
  };

  // 决定三端 tab 与默认选中
  function resolveTabs() {
    if (P.isInApp) {
      return { tabs: [{ key: 'inapp', label: '📋 浏览器打开', guideKey: 'inapp' }], def: 'inapp' };
    }
    if (!P.isMobile) {
      return { tabs: [{ key: 'desktop', label: '🖥 桌面', guideKey: 'desktop' }], def: 'desktop' };
    }
    var tabs = [
      { key: 'android', label: '🤖 安卓', guideKey: canNativeInstall() ? 'android_native' : 'android_manual' },
      { key: 'ios', label: '🍎 苹果', guideKey: P.isSafari ? 'ios_safari' : 'ios_chrome' },
      { key: 'harmony', label: '🌟 鸿蒙', guideKey: P.isHuaweiBrowser ? 'harmony_hw' : 'harmony_chrome' }
    ];
    var def = 'android';
    if (P.isIOS) def = 'ios';
    else if (P.isHarmony) def = 'harmony';
    return { tabs: tabs, def: def };
  }

  // ===== UI 渲染 =====
  var cssInjected = false;
  function ensureCss() {
    if (cssInjected) return;
    var s = document.createElement('style');
    s.textContent = [
      '#install-modal-mask{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;justify-content:center;align-items:flex-start;padding-top:14vh;box-sizing:border-box;}',
      '#install-modal-mask.show{display:flex;}',
      '.dg-modal{background:#fff;border-radius:16px;padding:22px 20px 18px;width:92%;max-width:360px;text-align:center;animation:popIn .25s ease;position:relative;}',
      '.dg-modal h3{font-size:17px;margin:0 0 4px;color:#222;}',
      '.dg-modal .dg-tip{font-size:12px;color:#999;margin-bottom:14px;line-height:1.5;}',
      '.dg-tabs{display:flex;gap:8px;margin-bottom:14px;}',
      '.dg-tab{flex:1;padding:9px 4px;border:1px solid #E8E8E8;border-radius:10px;background:#F5F7FA;color:#666;font-size:13px;font-weight:600;cursor:pointer;}',
      '.dg-tab.active{background:#E8F2FC;border-color:#4A90D9;color:#4A90D9;}',
      '.dg-step{display:flex;align-items:center;gap:12px;background:#F5F7FA;border-radius:10px;padding:11px 12px;margin-bottom:9px;text-align:left;}',
      '.dg-step .ds-icon{width:34px;height:34px;border-radius:50%;background:#E8F2FC;color:#4A90D9;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;}',
      '.dg-step .ds-text{font-size:13px;color:#333;line-height:1.4;}',
      '.dg-actions{display:flex;gap:10px;margin-top:6px;}',
      '.dg-btn{flex:1;padding:11px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;}',
      '.dg-btn.primary{background:#4A90D9;color:#fff;}',
      '.dg-btn.ghost{background:#F5F7FA;color:#666;}',
      '.dg-close{position:absolute;top:10px;right:12px;background:none;border:none;color:#bbb;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;}',
      '@keyframes popIn{from{transform:scale(.85);opacity:0}to{transform:scale(1);opacity:1}}'
    ].join('');
    document.head.appendChild(s);
    cssInjected = true;
  }

  function renderBody(guideKey) {
    var g = GUIDES[guideKey] || GUIDES.android_manual;
    var stepsHtml = (g.steps || []).map(function (st) {
      return '<div class="dg-step"><div class="ds-icon">' + st.icon + '</div>' +
        '<div class="ds-text">' + st.text + '</div></div>';
    }).join('');
    var body = document.getElementById('dg-body');
    if (body) body.innerHTML = stepsHtml;
    var primary = document.getElementById('dg-primary');
    if (primary) {
      if (g.native) {
        primary.textContent = '安装';
        primary.onclick = function () { doNativeInstall(); };
      } else {
        primary.textContent = '知道了';
        primary.onclick = function () { closeModal(); };
      }
    }
  }

  function showDownloadGuide() {
    ensureCss();
    var resolved = resolveTabs();
    var mask = document.getElementById('install-modal-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'install-modal-mask';
      mask.innerHTML = '<div class="dg-modal">' +
        '<button class="dg-close" onclick="InstallGuide.closeModal()">×</button>' +
        '<h3 id="dg-title"></h3>' +
        '<div class="dg-tip" id="dg-tip"></div>' +
        '<div class="dg-tabs" id="dg-tabs"></div>' +
        '<div id="dg-body"></div>' +
        '<div class="dg-actions">' +
        '<button class="dg-btn ghost" onclick="InstallGuide.closeModal()">关闭</button>' +
        '<button class="dg-btn primary" id="dg-primary">知道了</button>' +
        '</div>' +
        '</div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', function (e) { if (e.target === mask) closeModal(); });
    }
    // 渲染 tab
    var tabsHtml = resolved.tabs.map(function (t) {
      return '<div class="dg-tab' + (t.key === resolved.def ? ' active' : '') + '" data-guide="' + t.guideKey + '" data-key="' + t.key + '">' + t.label + '</div>';
    }).join('');
    var tabsEl = document.getElementById('dg-tabs');
    tabsEl.innerHTML = tabsHtml;
    tabsEl.querySelectorAll('.dg-tab').forEach(function (el) {
      el.onclick = function () {
        tabsEl.querySelectorAll('.dg-tab').forEach(function (x) { x.classList.remove('active'); });
        el.classList.add('active');
        renderBody(el.getAttribute('data-guide'));
      };
    });
    // 默认选中平台
    var defGuide = (resolved.tabs.filter(function (t) { return t.key === resolved.def; })[0] || resolved.tabs[0]).guideKey;
    var dg = GUIDES[defGuide] || GUIDES.android_manual;
    document.getElementById('dg-title').textContent = dg.title;
    document.getElementById('dg-tip').textContent = dg.tip || '';
    renderBody(defGuide);
    mask.classList.add('show');
  }

  function closeModal() {
    var m = document.getElementById('install-modal-mask');
    if (m) m.classList.remove('show');
  }

  var SESSION_KEY = 'dg_autoshow_dismiss';
  function markAutoShown() { try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) {} }
  function shouldAutoShow() { try { return !sessionStorage.getItem(SESSION_KEY); } catch (e) { return true; } }
  function resetAutoShow() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

  // 登录后自动弹；同一浏览器会话内刷新页面不重复弹，仅重新登录（doStudentLogin 清标记）才再弹
  function maybeAutoShow() {
    if (!shouldAutoShow()) return;
    showDownloadGuide();
    markAutoShown();
  }

  window.InstallGuide = {
    maybeAutoShow: maybeAutoShow,
    showDownloadGuide: showDownloadGuide,
    closeModal: closeModal,
    resetAutoShow: resetAutoShow
  };
})();
