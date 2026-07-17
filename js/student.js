/* Hi English - Student App (matching Demo UI exactly) */
var words = [];
var lessons = [];
var studyData = null;
var currentStage = 'basic';
var currentIndex = 0;
var studyTimer = null;
var studySeconds = 0;
var testWords = [];
var testWordIndex = 0;
var testScores = {};
var learnMode = 'read';
var speakTarget = 'phrase';
var makeupDate = null;
var selectedMakeupDate = null; // 日历弹窗中选中的可补卡日期
var isAudioActive = false;
// Test sub-items for current test word
var testSubItems = [];
var testSubScores = {};
var bizSpellTarget = ''; // Current business spell practice target word
var BETA_MODE = false; // 众测模式：开启后商务英语对所有人解锁 + 周测/月测不受时间限制

// ===== Initialize =====
async function init() {
  var user = HiEnglish.getCurrentUser();
  // getCurrentUser() now returns null if account was deleted or disabled
  if (!user || user.role !== 'student') {
    window.location.href = 'index.html';
    return;
  }

  refreshUserInfo(user);
  startAccountWatchdog();

  // 显示同步中提示（跨终端首次打开时用户能看到系统在拉数据，而非误以为丢数据）
  _showSyncLoading(true);

  words = await HiEnglish.loadWords();
  var lessonsData = await HiEnglish.loadLessons();
  lessons = lessonsData.lessons || [];

  studyData = HiEnglish.getStudyData(user.empid);
  // 从服务端拉取最新学习数据（跨终端同步）——带3次重试（common.js内退避）
  var serverData = await HiEnglish.fetchServerStudyData(user.empid);
  if (serverData) {
    studyData = serverData;
    // 旧格式数据迁移（learnedIds/masteredIds → basic.learned/mastered）
    if (studyData.learnedIds || studyData.masteredIds || studyData.lastIndex !== undefined) {
      console.log('[Migrate] 检测到旧格式学习数据，开始迁移...');
      studyData.basic = {
        readIndex: studyData.lastIndex || 0,
        spellIndex: 0,
        learned: studyData.learnedIds || [],
        learnedDates: {},
        mastered: studyData.masteredIds || [],
        speakScores: {},
        weeklyTests: [],
        monthlyTests: [],
        totalSeconds: studyData.totalStudySeconds || 0
      };
      // 迁移 studyDates (array of date strings → learnedDates map)
      if (studyData.studyDates && studyData.studyDates.length) {
        studyData.studyDates.forEach(function(d) { studyData.basic.learnedDates[d] = true; });
      }
      studyData.business = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: false };
      delete studyData.learnedIds; delete studyData.masteredIds; delete studyData.lastIndex;
      delete studyData.studyDates; delete studyData.totalStudySeconds; delete studyData.sessions;
      saveStudyData();
      console.log('[Migrate] 数据迁移完成');
    }
    // 确保结构完整
    if (!studyData.basic) studyData.basic = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, weeklyTests: [], monthlyTests: [], totalSeconds: 0 };
    if (!studyData.business) studyData.business = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: false };
  }
  // Migrate: ensure learnedDates exists (backward compat)
  if (!studyData.basic.learnedDates) studyData.basic.learnedDates = {};
  if (!studyData.business.learnedDates) studyData.business.learnedDates = {};
  // ===== 统一打卡数据：将 basic/business 的 checkIns 合并到顶层 studyData.checkIns（一次性、幂等）=====
  // 根因：两个阶段各自维护独立 checkIns 数组，导致切换阶段后打卡进度不一致、管理端与学员端统计歧义。
  // 修复：顶层 checkIns 为唯一真相；basic/business 下的 checkIns 合并进顶层后删除 sub-field。
  if (unifyCheckIns()) {
    saveStudyData();
    console.log('[Migrate] 打卡数据已统一合并为顶层 checkIns');
  }
  if (studyData.basic.mastered.length >= 850) {
    studyData.business.unlocked = true;
  }

  // 跨终端同步兜底：如果拉取到的数据看起来像全新账号（已学=0且已掌握=0），
  // 可能是 Render 冷启动 / 网络抖动导致前3次重试全部落在服务端恢复过程中。
  // 延迟2秒后再拉一次（此时服务端应已就绪），避免用户看到空数据以为丢进度。
  var isFreshAccount = (!studyData.basic || studyData.basic.learned.length === 0) &&
    (!studyData.basic || studyData.basic.mastered.length === 0) &&
    (!studyData.business || studyData.business.learned.length === 0);
  if (isFreshAccount && !window._syncRetryDone) {
    window._syncRetryDone = true;
    console.log('[Sync] 数据看起来像新账号，2秒后尝试延迟重拉...');
    await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    var retryData = await HiEnglish.fetchServerStudyData(user.empid);
    if (retryData && (retryData.basic.learned.length > 0 || retryData.basic.mastered.length > 0 || retryData.business.learned.length > 0)) {
      studyData = retryData;
      console.log('[Sync] 延迟重拉成功，已恢复学习数据');
      // 重新确保结构完整
      if (!studyData.basic) studyData.basic = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, weeklyTests: [], monthlyTests: [], totalSeconds: 0 };
      if (!studyData.business) studyData.business = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: false };
      if (!studyData.basic.learnedDates) studyData.basic.learnedDates = {};
      if (!studyData.business.learnedDates) studyData.business.learnedDates = {};
      unifyCheckIns();
      saveStudyData();
    } else {
      console.log('[Sync] 延迟重拉仍未拿到数据，确认为新账号或服务端确实无记录');
    }
  }

  // 全量延迟兜底（5秒后）：无论是否像新账号，都再拉一次服务端数据做静默对比更新。
  // 覆盖场景：Chrome刚完成打卡→推送还在路上→Edge立刻打开→首次拉到旧打卡数据（59%）。
  // 5秒足够Chrome的400ms防抖+网络往返+服务端处理完成。
  setTimeout(function() {
    if (!HiEnglish.getCurrentUser()) return;
    HiEnglish.fetchServerStudyData(user.empid).then(function(latestData) {
      if (!latestData) return;
      var todayStr = HiEnglish.today();
      var localToday = (studyData.checkIns||[]).find(function(c){return c.date===todayStr;});
      var serverToday = (latestData.checkIns||[]).find(function(c){return c.date===todayStr;});
      var hasNewerCheckin = serverToday && (
        (serverToday.seconds||0) > (localToday&&localToday.seconds||0) ||
        (serverToday.completed && !(localToday&&localToday.completed))
      );
      var hasMoreProgress =
        (latestData.basic&&latestData.basic.learned.length||0) > (studyData.basic&&studyData.basic.learned.length||0) ||
        (latestData.basic&&latestData.basic.mastered.length||0) > (studyData.basic&&studyData.basic.mastered.length||0) ||
        (latestData.business&&latestData.business.learned.length||0) > (studyData.business&&studyData.business.learned.length||0);
      if (hasNewerCheckin || hasMoreProgress) {
        console.log('[Sync] 5秒兜底重拉发现更新，静默合并', hasNewerCheckin?'(打卡)':'(进度)');
        studyData = latestData;
        if (!studyData.basic) studyData.basic = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0 };
        if (!studyData.business) studyData.business = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: false };
        unifyCheckIns();
        saveStudyData();
        renderHome();
        renderCheckIn();
        renderStageSwitcher();
      }
    });
  }, 5000);

  // 隐藏同步加载提示
  _showSyncLoading(false);

  // ===== 强制推送：init完成后立即把本地真相推到服务端（无论是否变化）=====
  (function forcePushOnInit() {
    var u = HiEnglish.getCurrentUser();
    if (u && studyData) {
      // 延迟500ms确保结构完整，然后立即推送一次
      setTimeout(function() {
        HiEnglish.pushServerStudyDataImmediate(u.empid, studyData);
        console.log('[Sync] init完成，已强制推送本地数据到服务端');
      }, 500);
    }
  })();

  // 注：手动同步按钮已移除，跨终端同步现由系统自动完成（登录即同步 + 实时推送 + 可见性自愈）

  // 众测模式：从服务端拉取全局开关，开启则解锁商务英语并放开周测/月测时间限制
  fetch(HiEnglish.getServerUrl() + '/api/beta-config').then(function(r) { return r.json(); }).then(function(data) {
    if (data && data.betaMode) {
      BETA_MODE = true;
      if (studyData && studyData.business && !studyData.business.unlocked) {
        studyData.business.unlocked = true;
      }
      renderStageSwitcher();
    }
  }).catch(function() {});

  renderStageSwitcher();
  renderHome();
  updateMessageBadge();

  // 登录后自动弹出"三端下载/安装渠道"引导（每个会话一次，可手动关闭）
  if (window.InstallGuide && window.InstallGuide.maybeAutoShow) {
    setTimeout(function () { window.InstallGuide.maybeAutoShow(); }, 1200);
  }

  // 启动周期性同步（每60秒静默推一次），兜底防止单次推送因网络/后台限制失败
  HiEnglish.startPeriodicSync(user.empid, function() { return studyData; });
  
  // Initialize recording button event delegation
  _setupRecEventDelegation();
  
  // Initialize browser notifications
  initNotifications();
  // Start watching for new messages from admin
  startMessageWatcher();

  // 页面隐藏/关闭时立即推送学习数据到服务端（防止数据丢失）
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
      HiEnglish.flushServerStudyData();
    } else if (document.visibilityState === 'visible') {
      // 页面回到前台：立即推送本地真相 + 拉取服务端最新
      var u = HiEnglish.getCurrentUser();
      if (u && studyData) {
        HiEnglish.pushServerStudyDataImmediate(u.empid, studyData);
        HiEnglish.fetchServerStudyData(u.empid).then(function(serverData) {
          if (serverData) {
            studyData = serverData;
            if (!studyData.basic) studyData.basic = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0 };
            if (!studyData.business) studyData.business = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: false };
            unifyCheckIns();
            saveStudyData();
            renderHome();
            renderCheckIn();
            renderStageSwitcher();
          }
        });
      }
    }
  });
  window.addEventListener('beforeunload', function() {
    HiEnglish.flushServerStudyData();
  });
  // 从后台切回前台时，重新拉取服务端最新数据
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      var user = HiEnglish.getCurrentUser();
      if (user) {
        HiEnglish.fetchServerStudyData(user.empid).then(function(serverData) {
          if (serverData) {
            studyData = serverData;
            if (!studyData.basic) studyData.basic = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0 };
            if (!studyData.business) studyData.business = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: false };
            // 统一打卡数据迁移（与 init() 中一致）
            if (unifyCheckIns()) saveStudyData();
            renderHome();
            renderStageSwitcher();
            console.log('[Sync] 从后台切回，已同步服务端最新数据');
          }
        });
      }
    }
  });
}

// Refresh user info display from latest localStorage data
function refreshUserInfo(user) {
  if (!user) user = HiEnglish.getCurrentUser();
  if (!user) return;
  document.getElementById('s-name').textContent = user.name;
  document.getElementById('s-group').textContent = user.group || '未分组';
  document.getElementById('s-avatar').textContent = user.name ? user.name.charAt(0) : '?';
}

// Watchdog: check every 5 seconds if account is still valid
// If admin deletes or disables the account, force logout immediately
var watchdogTimer = null;
var _isManualLogout = false; // 标记是否为主动退出，避免误报"账号被删除"
function startAccountWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  _isManualLogout = false;
  watchdogTimer = setInterval(function() {
    var user = HiEnglish.getCurrentUser();
    if (!user && !_isManualLogout) {
      // Account was deleted or disabled (非主动退出情况)
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      alert('您的账号已被管理员删除或禁用，请联系管理员。');
      window.location.href = 'index.html';
    }
    // 如果是主动退出（logout已清除session），不做任何处理
  }, 5000);
}

function stopAccountWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

// ===== Browser Notifications =====
// Request permission for showing notifications in phone/computer notification bar
function initNotifications() {
  if (!('Notification' in window)) {
    console.log('This browser does not support notifications.');
    return;
  }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(function(permission) {
      if (permission === 'granted') {
        console.log('Notification permission granted.');
      }
    });
  }
}

// Show a browser notification (appears in phone notification bar / system tray)
function showBrowserNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') {
    // Permission not granted, try requesting again
    Notification.requestPermission().then(function(permission) {
      if (permission === 'granted') {
        _createNotification(title, body);
      }
    });
    return;
  }
  _createNotification(title, body);
}

function _createNotification(title, body) {
  var options = {
    body: body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'hi-english-reminder',
    renotify: true,
    requireInteraction: false,
    vibrate: [200, 100, 200],
    data: { url: 'student.html' }
  };
  // 移动端 Chrome/Android 禁止 new Notification() 构造函数（会抛"Illegal constructor"），
  // 必须通过 ServiceWorkerRegistration.showNotification() 才能在手机通知栏弹出
  if ('serviceWorker' in navigator && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(function(reg) {
      return reg.showNotification(title, options);
    }).catch(function(e) {
      console.warn('SW通知失败，降级到桌面通知:', e);
      _fallbackNotification(title, body);
    });
  } else {
    _fallbackNotification(title, body);
  }
}

// 桌面浏览器降级方案（不支持ServiceWorker时）
function _fallbackNotification(title, body) {
  try {
    var notification = new Notification(title, {
      body: body,
      icon: 'icon-192.png',
      tag: 'hi-english-reminder',
      requireInteraction: false
    });
    setTimeout(function() { notification.close(); }, 10000);
    notification.onclick = function() {
      window.focus();
      notification.close();
      sNav('messages');
    };
  } catch(e) {
    console.warn('Failed to create notification:', e);
  }
}

// ===== Message Watcher =====
// 轮询服务端新消息（跨设备），检测到后弹出浏览器通知栏提醒
var lastMsgMaxTime = 0;   // 已知的最新消息时间戳
var messageWatchTimer = null;

async function startMessageWatcher() {
  if (messageWatchTimer) clearInterval(messageWatchTimer);

  var user = HiEnglish.getCurrentUser();
  if (!user) return;

  // 初始化：记录当前最新消息时间戳，避免为历史消息重复弹通知
  try {
    var initMsgs = await HiEnglish.fetchServerMessages(user.empid);
    lastMsgMaxTime = initMsgs.reduce(function(mx, m) {
      return Math.max(mx, Number(m.time) || 0);
    }, 0);
  } catch (e) {
    lastMsgMaxTime = Date.now();
  }
  updateMessageBadge();

  // 每 15 秒轮询服务端一次，检测管理员新推送的催学提醒
  messageWatchTimer = setInterval(function() {
    checkForNewNotifications();
  }, 15000);

  // 从后台切回前台时立即检查一次
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      checkForNewNotifications();
    }
  });
}

async function checkForNewNotifications() {
  var user = HiEnglish.getCurrentUser();
  if (!user) return;

  try {
    var messages = await HiEnglish.fetchServerMessages(user.empid);
    // 找出比上次已知时间更新的消息
    var newMsgs = messages.filter(function(m) {
      return (Number(m.time) || 0) > lastMsgMaxTime;
    });
    if (newMsgs.length > 0) {
      // 更新最新时间戳
      lastMsgMaxTime = newMsgs.reduce(function(mx, m) {
        return Math.max(mx, Number(m.time) || 0);
      }, lastMsgMaxTime);
      // 取最新一条弹出通知栏
      var latest = newMsgs.sort(function(a, b) {
        return (Number(b.time) || 0) - (Number(a.time) || 0);
      })[0];
      showBrowserNotification('📢 ' + (latest.title || '新消息'), latest.content || '');
      showToast('收到新的' + (latest.title || '消息') + '，请查看站内信');
    }
    // 无论是否新消息都刷新徽章
    updateMessageBadge();
    // 若当前正在消息页，刷新列表
    if (typeof currentPage !== 'undefined' && currentPage === 'messages') {
      _renderMessagesList(messages);
    }
  } catch (e) {
    // 网络异常忽略，下次轮询重试
  }
}

// ===== Navigation =====
var currentPage = 'home';
function sNav(page) {
  currentPage = page;
  // Always refresh user info when navigating (picks up admin changes)
  refreshUserInfo();
  document.querySelectorAll('#student-app .page').forEach(function(p){ p.classList.remove('active'); });
  document.getElementById('s-page-' + page).classList.add('active');
  document.querySelectorAll('#student-app .bottom-nav .nav-item').forEach(function(n){ n.classList.remove('active'); });
  var navMap = {home:0, wordlist:1, report:2};
  var items = document.querySelectorAll('#student-app .bottom-nav .nav-item');
  if (items[navMap[page]]) items[navMap[page]].classList.add('active');
  if (page === 'wordlist') renderWordList('all');
  if (page === 'report') renderReport();
  if (page === 'messages') renderMessages();
}

function backHome() {
  // Cancel any active voice input before leaving
  if (recState.active) {
    cancelVoiceInput();
  }
  isAudioActive = false;
  stopStudyTimer();
  saveStudyData();
  makeupDate = null;
  sNav('home');
  renderHome();
}

function goLearn() {
  learnMode = 'read';
  currentIndex = studyData[currentStage].readIndex;
  showLearnPage();
  startStudyTimer();
}

function goSpell() {
  learnMode = 'spell';
  currentIndex = studyData[currentStage].spellIndex;
  showSpellPage();
  startStudyTimer();
}

function goWeeklyTest() {
  // 周测仅每周六、周日可以测试（众测模式下不受时间限制）
  var dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat
  if (!BETA_MODE && dayOfWeek !== 6 && dayOfWeek !== 0) {
    testWordIndex = 0;
    testWords = [];
    testSubItems = [];
    testSubScores = {};
    sNav('weekly');
    renderWeeklyTest(true);
    return;
  }
  prepareTest('weekly');
}

function goMonthlyTest() {
  // 月测仅每月1日至5日可以测试（众测模式下不受时间限制）
  var dayOfMonth = new Date().getDate();
  if (!BETA_MODE && (dayOfMonth < 1 || dayOfMonth > 5)) {
    testWordIndex = 0;
    testWords = [];
    testSubItems = [];
    testSubScores = {};
    sNav('monthly');
    renderMonthlyTest(true);
    return;
  }
  prepareTest('monthly');
}

function logout() {
  _isManualLogout = true;
  stopAccountWatchdog();
  HiEnglish.logout();
}

// ===== Stage Switcher =====
function renderStageSwitcher() {
  var container = document.getElementById('s-stage-switcher');
  var basicActive = currentStage === 'basic';
  var businessUnlocked = studyData.business.unlocked;
  container.innerHTML =
    '<div class="stage-tab ' + (basicActive ? 'active' : '') + '" onclick="switchStage(\'basic\')">基础词汇练习</div>' +
    '<div class="stage-tab ' + (!basicActive ? 'active' : '') + ' ' + (!businessUnlocked ? 'locked' : '') + '" onclick="switchStage(\'business\')">' +
    '商务英语练习 ' + (!businessUnlocked ? '<span class="lock-icon">🔒</span>' : '') +
    '</div>';
}

function switchStage(stage) {
  if (stage === 'business' && !studyData.business.unlocked) {
    showToast('需完成基础词汇练习阶段后解锁');
    return;
  }
  currentStage = stage;
  renderStageSwitcher();
  renderHome();
}

// ===== Home Page =====
function renderHome() {
  // Always refresh user info from localStorage to pick up admin changes (group rename, etc.)
  refreshUserInfo();

  var stageData = studyData[currentStage];
  var totalItems = currentStage === 'basic' ? words.length : lessons.length;
  // 已学=真实听过音频（audioDone），与学习清单/报告页一致；readIndex 仍用于顺序进度定位
  var learnedCount = getLearnedCount(currentStage);
  var masteredCount = getMasteredCount(currentStage);
  var progressPercent = totalItems > 0 ? Math.floor((learnedCount / totalItems) * 100) : 0;

  // Progress card
  document.getElementById('s-progress-card').innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="font-size:14px;font-weight:600;">学习进度</span>' +
      '<span style="font-size:13px;color:var(--text-sub);">' + learnedCount + ' / ' + totalItems + (currentStage === 'basic' ? ' 词' : ' 课') + '</span>' +
    '</div>' +
    '<div class="progress-bar"><div class="fill" style="width:' + progressPercent + '%;"></div></div>' +
    '<div class="stat-grid" style="margin-top:12px;">' +
      '<div class="stat-card"><div class="stat-val">' + learnedCount + '</div><div class="stat-key">已学</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + masteredCount + '</div><div class="stat-key">已掌握</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + (studyData.checkIns || []).filter(function(c){return c.completed;}).length + '</div><div class="stat-key">学习天数</div></div>' +
    '</div>';

  // Check-in progress
  renderCheckIn();

  // Learning modes — 使用统一打卡数据
  var today = HiEnglish.today();
  var todayCheckIn = (studyData.checkIns || []).find(function(c){return c.date === today;});
  var todayCompleted = todayCheckIn && todayCheckIn.completed;
  // 补卡入口：只要上周六到今天（不含今天）之间有未完成的打卡就显示，与今天是否完成无关
  var hasMissingThisWeek = false;
  var todayDate = new Date();
  var dayOfWeek = todayDate.getDay(); // 0=Sun..6=Sat
  var diffToSat = (dayOfWeek + 1) % 7; // 今天到上周六的天数（周六=0，周日=1，周一=2..）
  var saturday = new Date(todayDate);
  saturday.setDate(todayDate.getDate() - diffToSat);
  saturday.setHours(0, 0, 0, 0);
  // 检查上周六到今天（不含今天）之间是否还有未完成的打卡
  for (var d = 0; d < diffToSat; d++) {
    var checkDate = new Date(saturday);
    checkDate.setDate(saturday.getDate() + d);
    var checkDateStr = formatDateStr(checkDate);
    if (checkDateStr >= today) break; // 不包含今天及未来
    var c = (studyData.checkIns || []).find(function(x){return x.date === checkDateStr;});
    if (!c || !c.completed) {
      hasMissingThisWeek = true;
      break;
    }
  }
  var showMakeupBadge = hasMissingThisWeek;

  document.getElementById('s-learn-modes').innerHTML =
    '<div class="mode-card" onclick="goLearn()" style="position:relative;">' +
      (showMakeupBadge ? '<span class="badge-dot" onclick="event.stopPropagation();showCalendar()">补卡</span>' : '') +
      '<div class="mode-icon">📖</div>' +
      '<div class="mode-name">跟读学习</div>' +
      '<div class="mode-sub daily">每日必学</div>' +
    '</div>' +
    '<div class="mode-card" onclick="goSpell()">' +
      '<div class="mode-icon">✍️</div>' +
      '<div class="mode-name">拼写练习</div>' +
      '<div class="mode-sub">选学</div>' +
    '</div>';

  document.getElementById('s-test-modes').innerHTML =
    '<div class="mode-card" onclick="goWeeklyTest()">' +
      '<div class="mode-icon">📝</div>' +
      '<div class="mode-name">周测模式</div>' +
      '<div class="mode-sub">周学习内容随机测</div>' +
    '</div>' +
    '<div class="mode-card" onclick="goMonthlyTest()">' +
      '<div class="mode-icon">📅</div>' +
      '<div class="mode-name">月测模式</div>' +
      '<div class="mode-sub">月学习内容随机测</div>' +
    '</div>';
}

// ===== Check-in Progress (统一打卡：basic和商务共享同一进度) =====
function renderCheckIn() {
  // 使用顶层统一的 checkIns，不再按阶段分离
  var allCheckIns = studyData.checkIns || [];
  var today = HiEnglish.today();
  var todayCheckIn = allCheckIns.find(function(c){return c.date === today;});
  if (!todayCheckIn) {
    todayCheckIn = {date: today, seconds: 0, completed: false};
    allCheckIns.push(todayCheckIn);
  }
  var progress = Math.min(100, Math.floor((todayCheckIn.seconds / 900) * 100));
  var remaining = Math.max(0, 900 - todayCheckIn.seconds);
  var mins = Math.floor(remaining / 60);
  var secs = remaining % 60;
  var circumference = 188.5;
  var offset = circumference - (progress / 100) * circumference;
  var statusText = todayCheckIn.completed ? '✅ 今日打卡已完成' : '还需 ' + mins + '分' + secs + '秒 完成打卡';

  document.getElementById('s-checkin').innerHTML =
    '<div class="progress-info">' +
      '<span class="progress-label">今日打卡进度</span>' +
      '<span class="progress-text">' + statusText + '</span>' +
      '<span class="progress-sub">每日最低15分钟 · 播放音频和朗读才计入时长</span>' +
    '</div>' +
    '<div class="timer-ring">' +
      '<svg width="72" height="72">' +
        '<circle cx="36" cy="36" r="30" fill="none" stroke="#E8E8E8" stroke-width="6"/>' +
        '<circle cx="36" cy="36" r="30" fill="none" stroke="' + (todayCheckIn.completed ? '#52C41A' : '#4A90D9') + '" stroke-width="6" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '"/>' +
      '</svg>' +
      '<span class="pct">' + progress + '%</span>' +
    '</div>';
}

// ===== Speak with timer tracking =====
function speakWithTimer(text) {
  isAudioActive = true;
  HiEnglish.speak(text, {
    onend: function() {
      setTimeout(function() { isAudioActive = false; }, 500);
    },
    onerror: function() {
      isAudioActive = false;
    }
  });
}

// 基础词汇：优先播放本地真人录制 mp3（兼容性最好），失败自动回退 TTS
var AUDIO_VER = '?v=20260712e';
function playBasicAudio(type, id, text) {
  isAudioActive = true;
  var url;
  // 商务英语句子调用时 type='b_1_0'（已含文件名），id 位置实为文本内容
  var isBiz = type.indexOf('b_') === 0;
  // 解析 track 信息：用于记录"哪个词/课的哪个音频已听"（单词 w 不计入已学）
  var trackStage, trackItemId, trackKey;
  if (isBiz) {
    var parts = type.split('_'); // ['b', lessonId, sentIdx]
    trackStage = 'business';
    trackItemId = parts[1];
    trackKey = type; // 'b_1_0'
    url = 'audio/' + type + '.mp3' + AUDIO_VER;
  } else {
    trackStage = 'basic';
    trackItemId = id;   // word.id
    trackKey = type;    // 'w' / 'p' / 'e1' / 'e2' / 'e3'
    if (type === 'w') url = 'audio/w_' + id + '.mp3' + AUDIO_VER;
    else if (type === 'p') url = 'audio/p_' + id + '.mp3' + AUDIO_VER;
    else url = 'audio/e_' + id + '_' + type.slice(1) + '.mp3' + AUDIO_VER;
  }
  // 商务音频调用只传了2个参数，id 位置实为文本，作为 TTS 兜底
  var fallbackText = text || (isBiz ? id : null);
  // 单词 w 不计入已学，仅词组 p + 例句 e1/e2/e3 + 商务句子 b_* 计入
  var shouldTrack = (trackStage === 'business') || (trackKey !== 'w');
  HiEnglish.playAudioOrSpeak(url, fallbackText, {
    onend: function() {
      setTimeout(function() { isAudioActive = false; }, 500);
      if (shouldTrack) markAudioPlayed(trackStage, String(trackItemId), trackKey);
    },
    onerror: function() { isAudioActive = false; }
  });
}

// ===== 已学定义：真实听过音频才算（词组+全部例句 或 商务全部句子） =====
// 注意：历史 learned[] 仅作留痕，不用于"已学"统计（避免未听音频却算已学）

// 返回某词/课"必须听完"的音频 key 列表（单词 w 不计入）
function requiredAudioKeys(id, stage) {
  if (stage === 'basic') {
    var word = words.find(function(w) { return String(w.id) === String(id); });
    if (!word) return [];
    var keys = ['p'];
    if (word.s1_en) keys.push('e1');
    if (word.s2_en) keys.push('e2');
    if (word.s3_en) keys.push('e3');
    return keys;
  } else {
    var lesson = lessons.find(function(l) { return String(l.id) === String(id); });
    if (!lesson || !lesson.sentences) return [];
    var n = lesson.sentences.length;
    var keys2 = [];
    for (var i = 0; i < n; i++) keys2.push('b_' + id + '_' + i);
    return keys2;
  }
}

// 该词/课所有必需音频是否都已听过
function isAudioLearned(id, stage) {
  var ad = (studyData[stage].audioDone || {})[String(id)] || {};
  var req = requiredAudioKeys(id, stage);
  return req.length > 0 && req.every(function(k) { return ad[k]; });
}

// 是否点过≥1个喇叭（学习中判定：点了≥1个但没播完）。与 isAudioLearned 区分：这里只要有任意一条音频被点播过即算。
function isAudioStarted(id, stage) {
  var ad = (studyData[stage].audioDone || {})[String(id)] || {};
  return Object.keys(ad).some(function(k) { return ad[k]; });
}

// 统一四态分类（互斥，优先级：已掌握 > 已学(听完) > 学习中(点过≥1) > 未学）
// 解决 Bug③：①"未学"不再混入"已掌握"；②"学习中"卡片数与清单数完全一致。
function classifyItem(id, stage) {
  var sd = studyData[stage];
  var isMastered = (sd.mastered || []).some(function(x) { return String(x) === String(id); });
  if (isMastered) return 'mastered';
  if (isAudioLearned(id, stage)) return 'learned';   // 已学（听完音频），不用管是否已掌握
  if (isAudioStarted(id, stage)) return 'learning';  // 学习中（点过≥1个喇叭但没播完）
  return 'unlearned';                                // 未学（其余）
}

// 已学数（遍历词库/课库，统计已听完必需音频的条数）
function getLearnedCount(stage) {
  var pool = stage === 'basic' ? words : lessons;
  var n = 0;
  pool.forEach(function(it) { if (isAudioLearned(it.id, stage)) n++; });
  return n;
}

// 已掌握数（去重）
function getMasteredCount(stage) {
  var m = studyData[stage].mastered || [];
  return new Set(m.map(function(x) { return String(x); })).size;
}

// 学习中 = 点过≥1个喇叭但未听完且未掌握（与"学习中"筛选项口径完全一致，避免卡片数≠清单数）
function getLearningCount(stage) {
  var pool = stage === 'basic' ? words : lessons;
  var n = 0;
  pool.forEach(function(it) { if (classifyItem(it.id, stage) === 'learning') n++; });
  return n;
}

// 记录某音频已播放（onend 触发）；完成全部必需音频时记录完成日期；局部刷新 UI
function markAudioPlayed(stage, itemId, key) {
  var sd = studyData[stage];
  if (!sd.audioDone) sd.audioDone = {};
  if (!sd.audioDone[itemId]) sd.audioDone[itemId] = {};
  var prevDone = isAudioLearned(itemId, stage);
  sd.audioDone[itemId][key] = true;
  if (!prevDone && isAudioLearned(itemId, stage)) {
    if (!sd.audioDoneDate) sd.audioDoneDate = {};
    sd.audioDoneDate[itemId] = HiEnglish.today();
  }
  saveStudyData();
  updateAudioStatusUI(stage, itemId);
}

// 局部更新学习卡上的"已听 x/y"状态行 + 已听喇叭置灰（不打断正在播放的音频）
function updateAudioStatusUI(stage, itemId) {
  if (currentStage !== stage) return;
  var curId = (stage === 'basic') ? (words[currentIndex] && words[currentIndex].id) : (lessons[currentIndex] && lessons[currentIndex].id);
  if (String(curId) !== String(itemId)) return;
  var ad = (studyData[stage].audioDone || {})[String(itemId)] || {};
  var req = requiredAudioKeys(itemId, stage);
  var done = req.filter(function(k) { return ad[k]; }).length;
  var statusEl = document.getElementById('audio-status-' + stage);
  if (statusEl) {
    if (done >= req.length) {
      statusEl.innerHTML = '<span style="color:#52C41A;font-weight:600;">✅ 已学</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--text-sub);">🔊 已听 ' + done + '/' + req.length + '</span>';
    }
  }
  req.forEach(function(k) {
    var btn = document.getElementById('audio-btn-' + stage + '-' + k);
    if (btn && ad[k]) btn.style.opacity = '0.5';
  });
}

// ===== Learn Page (Read) =====
function showLearnPage() {
  document.querySelectorAll('#student-app .page').forEach(function(p){ p.classList.remove('active'); });
  document.getElementById('s-page-learn').classList.add('active');

  var title = currentStage === 'basic' ? '跟读学习 · 每日必学' : '商务英语 · 跟读学习';
  document.getElementById('s-learn-title').textContent = title;

  if (currentStage === 'basic') {
    renderWordLearnCard();
  } else {
    renderLessonLearnCard();
  }
}

function renderWordLearnCard() {
  var total = words.length;
  if (currentIndex >= total) {
    document.getElementById('s-learn-content').innerHTML = '<div class="test-locked"><div class="lock-icon">🎉</div><div class="lock-msg">恭喜！已完成全部850词学习</div><div style="margin-top:24px;"><button class="btn btn-outline" onclick="backHome()">返回首页</button></div></div>';
    return;
  }

  var word = words[currentIndex];
  var stageData = studyData.basic;
  var scores = stageData.speakScores[word.id] || {};
  var masteredCount = getMasteredCount('basic');

  // Check-in progress bar — 使用统一打卡数据（补卡时按 makeupDate 计算，显示层与计时器日期一致）
  var targetDate = makeupDate || HiEnglish.today();
  var todayCheckIn = (studyData.checkIns || []).find(function(c){return c.date === targetDate;});
  var checkSecs = todayCheckIn ? todayCheckIn.seconds : 0;
  var checkProgress = Math.min(100, Math.floor((checkSecs / 900) * 100));
  var circumference = 188.5;
  var checkOffset = circumference - (checkProgress / 100) * circumference;

  var makeupTip = makeupDate ? '<div class="alert-box alert-info" style="margin:8px 12px;">📌 正在为 ' + makeupDate + ' 补卡，完成15分钟学习后补卡成功</div>' : '';

  var checkinHTML = makeupTip +
    '<div class="checkin-progress" style="margin:8px 12px;">' +
      '<div class="progress-info">' +
        '<span class="progress-label">' + (makeupDate ? '补卡进度（' + makeupDate + '）' : '今日打卡进度') + '</span>' +
        '<span class="progress-text">' + (todayCheckIn && todayCheckIn.completed ? '✅ 已完成' : '播放音频或朗读才计时') + '</span>' +
        '<span class="progress-sub">超过15分钟后进度不再增加</span>' +
      '</div>' +
      '<div class="timer-ring">' +
        '<svg width="72" height="72">' +
          '<circle cx="36" cy="36" r="30" fill="none" stroke="#E8E8E8" stroke-width="6"/>' +
          '<circle cx="36" cy="36" r="30" fill="none" stroke="#52C41A" stroke-width="6" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + checkOffset + '"/>' +
        '</svg>' +
        '<span class="pct">' + checkProgress + '%</span>' +
      '</div>' +
    '</div>';

  var progressPercent = Math.floor((currentIndex / total) * 100);

  // Header with word + speaker button
  var headerHTML =
    '<div class="learn-header">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:13px;color:var(--text-sub);">第 ' + (currentIndex + 1) + ' / ' + total + ' 词</span>' +
        '<span style="font-size:13px;color:var(--primary);">已掌握 ' + masteredCount + ' 词</span>' +
      '</div>' +
      '<div class="progress-bar"><div class="fill" style="width:' + progressPercent + '%;"></div></div>' +
      '<div style="display:flex;align-items:center;justify-content:center;gap:12px;">' +
        '<div class="learn-word">' + word.word + '</div>' +
        '<button onclick="playBasicAudio(\'w\',\'' + word.id + '\',\'' + escapeQuotes(word.word) + '\')" style="border:none;background:none;font-size:24px;cursor:pointer;">🔊</button>' +
      '</div>' +
      '<div class="learn-ipa">' + (word.ipa || '') + '  ' + (word.pos || '') + '</div>' +
      '<div class="learn-zh">' + (word.cn || '') + '</div>' +
    '</div>';

  // Phrases - no parenthetical content, with speaker
  var phraseHTML =
    '<div class="learn-section">' +
      '<h4>📌 常见词组 <button id="audio-btn-basic-p" onclick="playBasicAudio(\'p\',\'' + word.id + '\',\'' + escapeQuotes(word.phrase_en) + '\')" style="float:right;border:none;background:none;font-size:16px;cursor:pointer;">🔊</button></h4>' +
      '<div style="font-size:15px;">' +
        '<div style="margin-bottom:4px;">' + word.phrase_en + '</div>' +
        '<div style="font-size:13px;color:var(--text-sub);">' + word.phrase_cn + '</div>' +
      '</div>' +
    '</div>';

  // Example sentences - remove parenthetical from header
  var exHTML =
    '<div class="learn-section">' +
      '<h4>💬 例句</h4>' +
      '<div style="margin-bottom:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="font-size:14px;">' + word.s1_en + '</span>' +
          '<button id="audio-btn-basic-e1" onclick="playBasicAudio(\'e1\',\'' + word.id + '\',\'' + escapeQuotes(word.s1_en) + '\')" style="border:none;background:none;font-size:16px;cursor:pointer;">🔊</button>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--text-sub);">' + word.s1_cn + '</div>' +
      '</div>' +
      '<div style="margin-bottom:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="font-size:14px;">' + word.s2_en + '</span>' +
          '<button id="audio-btn-basic-e2" onclick="playBasicAudio(\'e2\',\'' + word.id + '\',\'' + escapeQuotes(word.s2_en) + '\')" style="border:none;background:none;font-size:16px;cursor:pointer;">🔊</button>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--text-sub);">' + word.s2_cn + '</div>' +
      '</div>' +
      '<div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="font-size:14px;">' + word.s3_en + '</span>' +
          '<button id="audio-btn-basic-e3" onclick="playBasicAudio(\'e3\',\'' + word.id + '\',\'' + escapeQuotes(word.s3_en) + '\')" style="border:none;background:none;font-size:16px;cursor:pointer;">🔊</button>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--text-sub);">' + word.s3_cn + '</div>' +
      '</div>' +
    '</div>';

  // Speak practice - no explanation text
  var phraseScore = scores.phrase;
  var ex1Score = scores.ex1;
  var ex2Score = scores.ex2;
  var ex3Score = scores.ex3;

  var speakBtnsHTML =
    '<div class="learn-section">' +
      '<h4>🎤 跟读练习（词组+3例句均需80分以上）</h4>' +
      '<div class="speak-target-btns">' +
        '<button class="speak-target-btn ' + (speakTarget === 'phrase' ? 'active' : '') + '" onclick="setSpeakTarget(this,\'phrase\',\'' + word.id + '\')">词组 ' + scoreHTML(phraseScore) + '</button>' +
        '<button class="speak-target-btn ' + (speakTarget === 'ex1' ? 'active' : '') + '" onclick="setSpeakTarget(this,\'ex1\',\'' + word.id + '\')">例句1 ' + scoreHTML(ex1Score) + '</button>' +
        '<button class="speak-target-btn ' + (speakTarget === 'ex2' ? 'active' : '') + '" onclick="setSpeakTarget(this,\'ex2\',\'' + word.id + '\')">例句2 ' + scoreHTML(ex2Score) + '</button>' +
        '<button class="speak-target-btn ' + (speakTarget === 'ex3' ? 'active' : '') + '" onclick="setSpeakTarget(this,\'ex3\',\'' + word.id + '\')">例句3 ' + scoreHTML(ex3Score) + '</button>' +
      '</div>' +
      '<div id="speak-content-preview" style="background:var(--primary-light);border-radius:10px;padding:14px;margin-bottom:12px;">' +
        '<div id="speak-en" style="font-size:15px;font-weight:600;color:var(--text);line-height:1.6;">' + getSpeakContent(word, speakTarget).en + '</div>' +
      '</div>' +
      '<div id="voice-area-learn" style="text-align:center;">' +
        '<button class="rec-btn" data-mode="learn" data-arg="' + word.id + '">🎤</button>' +
        '<div class="rec-score" id="rec-score-learn" style="display:none;"></div>' +
        '<div style="font-size:12px;color:var(--warning);margin-top:4px;" id="mic-hint">' + getSpeakHint(phraseScore, ex1Score, ex2Score, ex3Score) + '</div>' +
      '</div>' +
    '</div>';

  var navHTML =
    '<div style="display:flex;gap:8px;padding:12px;">' +
      '<button class="btn btn-outline" style="flex:1;" onclick="prevWord()">‹ 上一个</button>' +
      '<button class="btn btn-primary" style="flex:1;" onclick="nextWord()">下一个 ›</button>' +
    '</div>';

  var adNow = (studyData.basic.audioDone || {})[String(word.id)] || {};
  var reqNow = requiredAudioKeys(word.id, 'basic');
  var doneNow = reqNow.filter(function(k){ return adNow[k]; }).length;
  var statusTextNow = doneNow >= reqNow.length ? '<span style="color:#52C41A;font-weight:600;">✅ 已学</span>' : '<span style="color:var(--text-sub);">🔊 已听 ' + doneNow + '/' + reqNow.length + '</span>';
  var statusHTML = '<div style="padding:0 12px 8px;text-align:right;font-size:13px;" id="audio-status-basic">' + statusTextNow + '</div>';

  document.getElementById('s-learn-content').innerHTML = checkinHTML + headerHTML + phraseHTML + exHTML + statusHTML + speakBtnsHTML + navHTML;
  _setupRecEventDelegation();
  // 渲染后按 audioDone 把已点过的喇叭保持浅色（翻页后重渲染也能保留）
  updateAudioStatusUI(currentStage, String(word.id));
}

function renderLessonLearnCard() {
  var total = lessons.length;
  if (currentIndex >= total) {
    document.getElementById('s-learn-content').innerHTML = '<div class="test-locked"><div class="lock-icon">🎉</div><div class="lock-msg">恭喜！已完成全部116课学习</div><div style="margin-top:24px;"><button class="btn btn-outline" onclick="backHome()">返回首页</button></div></div>';
    return;
  }

  var lesson = lessons[currentIndex];
  var progressPercent = Math.floor((currentIndex / total) * 100);
  var stageData = studyData.business;
  var makeupTip = makeupDate ? '<div class="alert-box alert-info" style="margin:8px 12px;">📌 正在为 ' + makeupDate + ' 补卡，完成15分钟学习后补卡成功</div>' : '';

  // Check-in progress bar — 使用统一打卡数据（补卡时按 makeupDate 计算，显示层与计时器日期一致）
  var targetDate = makeupDate || HiEnglish.today();
  var todayCheckIn = (studyData.checkIns || []).find(function(c){return c.date === targetDate;});
  var checkSecs = todayCheckIn ? todayCheckIn.seconds : 0;
  var checkProgress = Math.min(100, Math.floor((checkSecs / 900) * 100));
  var circumference = 188.5;
  var checkOffset = circumference - (checkProgress / 100) * circumference;

  var checkinHTML = makeupTip +
    '<div class="checkin-progress" style="margin:8px 12px;">' +
      '<div class="progress-info">' +
        '<span class="progress-label">' + (makeupDate ? '补卡进度（' + makeupDate + '）' : '今日打卡进度') + '</span>' +
        '<span class="progress-text">' + (todayCheckIn && todayCheckIn.completed ? '✅ 已完成' : '播放音频或朗读才计时') + '</span>' +
        '<span class="progress-sub">超过15分钟后进度不再增加</span>' +
      '</div>' +
      '<div class="timer-ring">' +
        '<svg width="72" height="72">' +
          '<circle cx="36" cy="36" r="30" fill="none" stroke="#E8E8E8" stroke-width="6"/>' +
          '<circle cx="36" cy="36" r="30" fill="none" stroke="#52C41A" stroke-width="6" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + checkOffset + '"/>' +
        '</svg>' +
        '<span class="pct">' + checkProgress + '%</span>' +
      '</div>' +
    '</div>';

  var headerHTML =
    '<div class="learn-header">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:13px;color:var(--text-sub);">第 ' + (currentIndex + 1) + ' / ' + total + ' 课</span>' +
        '<span style="font-size:13px;color:var(--primary);">已掌握 ' + getMasteredCount('business') + ' 课</span>' +
      '</div>' +
      '<div class="progress-bar"><div class="fill" style="width:' + progressPercent + '%;"></div></div>' +
      '<div class="learn-word" style="font-size:22px;">' + lesson.title + '</div>' +
      '<div class="learn-zh">' + lesson.titleCn + '</div>' +
    '</div>';

  // Sentences with audio playback (mp3优先，TTS兜底)
  var sentencesHTML = lesson.sentences.map(function(s, i) {
    return '<div class="learn-section">' +
      '<h4>' + (s.speaker === 'A' ? '👤 A' : '👤 B') + ' <button id="audio-btn-business-b_' + lesson.id + '_' + i + '" onclick="playBasicAudio(\'b_' + lesson.id + '_' + i + '\',\'' + escapeQuotes(s.en) + '\')" style="float:right;border:none;background:none;font-size:16px;cursor:pointer;">🔊</button></h4>' +
      '<div style="font-size:15px;margin-bottom:4px;">' + s.en + '</div>' +
      '<div style="font-size:13px;color:var(--text-sub);">' + s.zh + '</div>' +
    '</div>';
  }).join('');

  var adNowB = (studyData.business.audioDone || {})[String(lesson.id)] || {};
  var reqNowB = requiredAudioKeys(lesson.id, 'business');
  var doneNowB = reqNowB.filter(function(k){ return adNowB[k]; }).length;
  var statusTextB = doneNowB >= reqNowB.length ? '<span style="color:#52C41A;font-weight:600;">✅ 已学</span>' : '<span style="color:var(--text-sub);">🔊 已听 ' + doneNowB + '/' + reqNowB.length + '</span>';
  var statusHTML = '<div style="padding:0 12px 8px;text-align:right;font-size:13px;" id="audio-status-business">' + statusTextB + '</div>';

  // Speak practice section — one recording button per sentence
  var lessonScores = stageData.speakScores[lesson.id] || {};
  var speakPracticeHTML =
    '<div class="learn-section">' +
      '<h4>🎤 跟读练习（每句均需80分以上才算掌握）</h4>';

  lesson.sentences.forEach(function(s, i) {
    var sentScore = lessonScores['s' + i];
    speakPracticeHTML +=
      '<div style="margin-bottom:14px;padding:12px;background:var(--bg);border-radius:8px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
          '<span style="font-size:13px;color:var(--primary);font-weight:600;">' + (s.speaker === 'A' ? '👤 A' : '👤 B') + ' · 句' + (i + 1) + '</span>' +
          scoreHTML(sentScore) +
        '</div>' +
        '<div style="font-size:14px;margin-bottom:8px;line-height:1.5;">' + s.en + '</div>' +
        '<div id="voice-area-biz-' + i + '" style="text-align:center;">' +
          '<button class="rec-btn" data-mode="learn-biz" data-arg="' + i + '">🎤</button>' +
          '<div class="rec-score" id="rec-score-biz-' + i + '" style="display:none;"></div>' +
        '</div>' +
      '</div>';
  });

  speakPracticeHTML += '</div>';

  // 商务微课跟读学习提示：全部句子≥80分才算掌握
  var bizSpeakHint = getLessonSpeakHint(lessonScores, lesson.sentences);
  speakPracticeHTML +=
    '<div style="margin:0 12px 12px;padding:12px;background:var(--bg);border-radius:8px;font-size:13px;color:var(--text);text-align:center;">' +
      bizSpeakHint +
    '</div>';

  var navHTML =
    '<div style="display:flex;gap:8px;padding:12px;">' +
      '<button class="btn btn-outline" style="flex:1;" onclick="prevWord()">‹ 上一课</button>' +
      '<button class="btn btn-primary" style="flex:1;" onclick="nextWord()">下一课 ›</button>' +
    '</div>';

  document.getElementById('s-learn-content').innerHTML = checkinHTML + headerHTML + sentencesHTML + statusHTML + speakPracticeHTML + navHTML;
  _setupRecEventDelegation();
  // 渲染后按 audioDone 把已点过的喇叭保持浅色（翻页后重渲染也能保留）
  updateAudioStatusUI(currentStage, String(lesson.id));
}

// ===== Speak practice helpers =====
function escapeQuotes(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function scoreHTML(score) {
  if (!score) return '<span style="font-size:11px;color:var(--text-sub);">未测</span>';
  var cls = score >= 80 ? 'score-pass' : 'score-fail';
  return '<span class="score-mark ' + cls + '">' + score + '</span>';
}

function getSpeakContent(word, target) {
  var map = {
    phrase: {en: word.phrase_en + '<br><span style="font-size:13px;color:var(--text-sub);">' + word.phrase_cn + '</span>'},
    ex1: {en: word.s1_en},
    ex2: {en: word.s2_en},
    ex3: {en: word.s3_en}
  };
  return map[target] || map.phrase;
}

function getLessonSpeakHint(scores, sentences) {
  if (!scores || !sentences || sentences.length === 0) return '所有句子暂未全部达80分，请继续完成';
  var allPassed = sentences.every(function(s, i) {
    var sc = scores['s' + i];
    return sc && sc >= 80;
  });
  if (allPassed) return '✅ 全部通过，微课已掌握';
  return '所有句子暂未全部达80分，请继续完成';
}

function getSpeakHint(p, e1, e2, e3) {
  var missing = [];
  if (!p || p < 80) missing.push('词组');
  if (!e1 || e1 < 80) missing.push('例句1');
  if (!e2 || e2 < 80) missing.push('例句2');
  if (!e3 || e3 < 80) missing.push('例句3');
  if (missing.length === 0) return '✅ 全部通过，单词已掌握';
  return '所有' + missing.join('、') + '未达80分，请继续完成';
}

function setSpeakTarget(btn, target, wordId) {
  speakTarget = target;
  document.querySelectorAll('.speak-target-btn').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  var word = words.find(function(w){return String(w.id) === String(wordId);});
  if (!word) return;
  var c = getSpeakContent(word, target);
  document.getElementById('speak-en').innerHTML = c.en;
}

// ===== Voice Recording (浏览器录音 + 服务端 Whisper 识别) =====
// 录音上传到 Render 服务器 /api/transcribe，服务端用开源 Whisper 模型识别（非谷歌）
// 返回文本后前端用 similarity 评分，80分通过
// 服务器不可用时降级到时长评分

// 后端API地址
var TRANSCRIBE_API = 'https://hi-english.onrender.com/api/transcribe';

var recState = {
  active: false,
  mode: null,
  wordId: null,
  testIdx: null,
  targetText: '',
  startTime: 0,
  cooldown: false,
  cooldownTimer: null,
  mediaRecorder: null,
  mediaStream: null,
  audioChunks: [],
  micStarting: false,
  userReleased: false,
  evaluatedAlready: false,
  cancelled: false,
  micPermissionGranted: false,
  maxTimer: null,
  uploadTimer: null,
  onstopSafetyTimer: null,
  usingTouch: false
};

// 服务器预热：页面加载后5秒 ping Render，防止录音时冷启动
function warmupServer() {
  var url = TRANSCRIBE_API.replace('/api/transcribe', '/api/keepalive');
  fetch(url, { method: 'GET' })
    .then(function() { console.log('[Server] 预热成功'); })
    .catch(function() { console.log('[Server] 预热失败（可能休眠中）'); });
}
setTimeout(warmupServer, 5000);

function _getRecIds(mode, idx) {
  if (mode === 'learn') {
    return { area: 'voice-area-learn', label: 'rec-label-learn', score: 'rec-score-learn' };
  } else if (mode === 'learn-biz') {
    return { area: 'voice-area-biz-' + idx, label: 'rec-label-biz-' + idx, score: 'rec-score-biz-' + idx };
  } else {
    return { area: 'voice-area-test-' + idx, label: 'rec-label-test-' + idx, score: 'rec-score-test-' + idx };
  }
}

function _updateRecButtonUI(mode, idx, recording) {
  var ids = _getRecIds(mode, idx);
  var area = document.getElementById(ids.area);
  if (!area) return;
  var btn = area.querySelector('.rec-btn, .rec-btn-sm');
  var label = document.getElementById(ids.label);
  if (btn) {
    if (recording) btn.classList.add('recording');
    else btn.classList.remove('recording');
  }
  if (label) {
    if (recording) { label.textContent = '松手结束'; label.classList.add('recording'); }
    else { label.textContent = '长按麦克风朗读，松手评分'; label.classList.remove('recording'); }
  }
}

// ===== 长按开始录音 =====
function startVoiceInput(mode, arg, isTouch) {
  if (recState.active) return;
  if (recState.cooldown) {
    showToast('请稍等片刻再试');
    return;
  }
  if (isTouch) recState.usingTouch = true;
  if (!isTouch && recState.usingTouch) { recState.usingTouch = false; return; }

  // 获取目标文本
  var targetText = '';
  var wordId = null;
  var testIdx = null;

  if (mode === 'learn') {
    wordId = arg;
    var word = words.find(function(w){ return String(w.id) === String(wordId); });
    if (!word) return;
    // 剥离HTML标签，只保留纯英文文本用于语音对比
    targetText = getSpeakContent(word, speakTarget).en.replace(/<[^>]*>/g, '').trim();
  } else if (mode === 'learn-biz') {
    var sentIdx = parseInt(arg, 10);
    var lesson = lessons[currentIndex];
    if (!lesson || !lesson.sentences[sentIdx]) return;
    targetText = lesson.sentences[sentIdx].en;
    wordId = lesson.id;
    testIdx = sentIdx;
  } else if (mode === 'test') {
    testIdx = parseInt(arg, 10);
    var item = testSubItems[testIdx];
    if (!item) return;
    targetText = item.en;
  }

  // 检查浏览器支持
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    showToast('浏览器不支持录音，请使用Chrome或Safari');
    return;
  }

  // 重置状态
  recState.mode = mode;
  recState.wordId = wordId;
  recState.testIdx = testIdx;
  recState.targetText = targetText;
  recState.startTime = Date.now();
  recState.active = true;
  recState.audioChunks = [];
  recState.micStarting = true;
  recState.userReleased = false;
  recState.evaluatedAlready = false;
  recState.cancelled = false;
  isAudioActive = true;

  // 停止正在播放的音频
  if (window.speechSynthesis) speechSynthesis.cancel();

  // *** 关键：在 getUserMedia 之前就注册松手监听 ***
  // 防止权限弹框期间松手丢失
  document.addEventListener('touchend', _onRelease, { passive: false });
  document.addEventListener('touchcancel', _onRelease, { passive: false });
  document.addEventListener('mouseup', _onRelease);

  // 15秒最大录音时间
  recState.maxTimer = setTimeout(function() {
    if (recState.active) {
      console.log('[MIC] 录音超时(15秒)，自动停止');
      _stopRecording();
    }
  }, 15000);

  _updateRecButtonUI(mode, testIdx, true);
  console.log('[MIC] 正在请求麦克风权限...');

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(function(stream) {
      // 检查录音是否已被取消（用户导航离开了页面）
      if (recState.cancelled || !recState.mode) {
        console.log('[MIC] 录音已取消，释放麦克风流');
        stream.getTracks().forEach(function(t) { t.stop(); });
        _removeReleaseListeners();
        if (recState.maxTimer) { clearTimeout(recState.maxTimer); recState.maxTimer = null; }
        return;
      }
      // 检查用户是否已在权限弹框期间松手
      if (recState.userReleased) {
        console.log('[MIC] 用户已松手，停止录音流');
        stream.getTracks().forEach(function(t) { t.stop(); });
        _removeReleaseListeners();
        if (recState.maxTimer) { clearTimeout(recState.maxTimer); recState.maxTimer = null; }
        recState.micStarting = false;
        recState.active = false;
        _updateRecButtonUI(recState.mode, recState.testIdx, false);
        if (!recState.micPermissionGranted) {
          recState.micPermissionGranted = true;
          showToast('麦克风权限已获取，请再次长按朗读');
        }
        return;
      }

      recState.mediaStream = stream;
      recState.micPermissionGranted = true;

      // 选择浏览器支持的音频格式（iOS Safari 用 mp4，Chrome 用 webm）
      var mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/mp4';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/ogg';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = '';
          }
        }
      }

      recState.mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType: mimeType })
        : new MediaRecorder(stream);
      recState.audioChunks = [];

      recState.mediaRecorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) recState.audioChunks.push(e.data);
      };

      recState.mediaRecorder.onstop = function() {
        if (recState.cancelled) {
          console.log('[MIC] 录音已取消，跳过onstop处理');
          return;
        }
        console.log('[MIC] 录音停止，准备上传识别');
        uploadAndTranscribe();
      };

      recState.mediaRecorder.onerror = function(e) {
        console.error('[MIC] MediaRecorder错误:', e);
        _cleanupMic();
        _restoreRecUI();
        if (!recState.evaluatedAlready) {
          recState.evaluatedAlready = true;
          showScoreModal(0, '录音出错，请重试');
        }
      };

      recState.mediaRecorder.start();
      recState.micStarting = false;
      recState.startTime = Date.now();
      console.log('[MIC] 录音已开始');
      var label = document.getElementById(_getRecIds(recState.mode, recState.testIdx).label);
      if (label) label.textContent = '松手结束';
    })
    .catch(function(err) {
      console.error('[MIC] 麦克风权限获取失败:', err.name, err.message);
      _removeReleaseListeners();
      if (recState.maxTimer) { clearTimeout(recState.maxTimer); recState.maxTimer = null; }
      recState.micStarting = false;
      recState.active = false;
      _updateRecButtonUI(recState.mode, recState.testIdx, false);
      if (!recState.evaluatedAlready) {
        recState.evaluatedAlready = true;
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showScoreModal(0, '麦克风权限被拒绝，请在浏览器设置中允许麦克风权限');
        } else if (err.name === 'NotFoundError') {
          showScoreModal(0, '未找到麦克风设备');
        } else {
          showScoreModal(0, '麦克风启动失败，请重试');
        }
      }
    });
}

// ===== 松手停止录音 =====
function _onRelease(e) {
  // 防止 touchend + mouseup 双触发
  if (e.type === 'touchend' || e.type === 'touchcancel') {
    recState.usingTouch = true;
  } else if (e.type === 'mouseup' && recState.usingTouch) {
    recState.usingTouch = false;
    return;
  }

  if (!recState.active && !recState.micStarting) return;

  _removeReleaseListeners();
  if (recState.maxTimer) { clearTimeout(recState.maxTimer); recState.maxTimer = null; }

  if (recState.micStarting) {
    // getUserMedia 还在进行中（权限弹框还没关闭），标记已松手
    recState.userReleased = true;
    recState.micStarting = false;
    console.log('[MIC] 用户在权限弹框期间松手');
    return;
  }

  _stopRecording();
}

function _stopRecording() {
  if (recState.mediaRecorder && recState.mediaRecorder.state === 'recording') {
    try { recState.mediaRecorder.stop(); } catch(e) { console.warn('[MIC] stop失败:', e); }
  }
  // 安全机制：3秒后如果 onstop 未触发 uploadAndTranscribe，强制重置状态
  // 防止某些浏览器（如Safari）MediaRecorder 卡死导致后续录音不可用
  if (recState.onstopSafetyTimer) clearTimeout(recState.onstopSafetyTimer);
  recState.onstopSafetyTimer = setTimeout(function() {
    if (recState.active && !recState.evaluatedAlready) {
      console.warn('[MIC] onstop超时未触发，强制重置录音状态');
      _cleanupMic();
      _restoreRecUI();
      recState.evaluatedAlready = true;
      showScoreModal(0, '录音处理超时，请重试');
      _recReset();
      _recStartCooldown();
    }
  }, 3000);
  // 显示"识别中"状态
  var ids = _getRecIds(recState.mode, recState.testIdx);
  var label = document.getElementById(ids.label);
  if (label) { label.textContent = '识别中...'; label.classList.remove('recording'); }
  var area = document.getElementById(ids.area);
  if (area) {
    var btn = area.querySelector('.rec-btn, .rec-btn-sm');
    if (btn) btn.classList.remove('recording');
  }
}

function _removeReleaseListeners() {
  document.removeEventListener('touchend', _onRelease);
  document.removeEventListener('touchcancel', _onRelease);
  document.removeEventListener('mouseup', _onRelease);
}

// ===== 上传音频到后端识别 =====
function uploadAndTranscribe() {
  // onstop 已正常触发，清除安全定时器
  if (recState.onstopSafetyTimer) { clearTimeout(recState.onstopSafetyTimer); recState.onstopSafetyTimer = null; }
  // 检查录音是否已被取消（如用户导航离开页面）
  if (recState.cancelled || !recState.mode) {
    console.log('[MIC] 录音已取消，跳过上传识别');
    return;
  }
  if (!recState.audioChunks || recState.audioChunks.length === 0) {
    console.warn('[MIC] 没有录音数据');
    _cleanupMic();
    _restoreRecUI();
    if (!recState.evaluatedAlready) {
      recState.evaluatedAlready = true;
      showScoreModal(0, '录音太短，请按住麦克风大声朗读');
    }
    _recReset();
    _recStartCooldown();
    return;
  }

  var audioBlob = new Blob(recState.audioChunks, { type: recState.audioChunks[0].type || 'audio/webm' });
  console.log('[MIC] 音频大小: ' + audioBlob.size + ' bytes, 类型: ' + audioBlob.type);

  if (audioBlob.size < 200) {
    _cleanupMic();
    _restoreRecUI();
    if (!recState.evaluatedAlready) {
      recState.evaluatedAlready = true;
      showScoreModal(0, '录音太短，请按住麦克风大声朗读');
    }
    _recReset();
    _recStartCooldown();
    return;
  }

  // 超时保护：25秒 → 降级到时长评分（最高60分，不能通过）
  recState.uploadTimer = setTimeout(function() {
    if (recState.evaluatedAlready || recState.cancelled) return;
    console.warn('[MIC] 识别超时，降级到时长评分');
    _cleanupMic();
    _restoreRecUI();
    recState.evaluatedAlready = true;
    var dur = (Date.now() - recState.startTime) / 1000;
    var score = Math.min(60, _durationFallbackScore(recState.targetText, dur));
    showScoreModal(score, '识别超时，按时长评分（最高60分）');
    _recApplyScore(recState.mode, score);
  }, 25000);

  // 浏览器端转换：webm → 16kHz mono PCM
  _convertToPcm16(audioBlob)
    .then(function(pcmData) {
      if (recState.cancelled) return; // 录音已取消，丢弃结果
      console.log('[MIC] PCM转换成功: ' + pcmData.byteLength + ' bytes');
      var formData = new FormData();
      formData.append('audio', new Blob([pcmData], { type: 'audio/l16' }), 'recording.pcm');
      return fetch(TRANSCRIBE_API, { method: 'POST', body: formData });
    })
    .then(function(response) {
      if (recState.cancelled) return null; // 录音已取消，丢弃结果
      console.log('[MIC] 后端响应状态: ' + response.status);
      return response.json();
    })
    .then(function(data) {
      if (!data) return; // 被取消
      if (recState.uploadTimer) { clearTimeout(recState.uploadTimer); recState.uploadTimer = null; }
      _cleanupMic();
      _restoreRecUI();
      if (recState.evaluatedAlready || recState.cancelled) return;
      console.log('[MIC] 识别结果:', data);
      if (data.success && data.text) {
        _evaluateSpeaking(data.text);
      } else {
        // 识别未成功：服务器收到了音频但无法识别出有效英文
        recState.evaluatedAlready = true;
        var dur = (Date.now() - recState.startTime) / 1000;
        var _tk = (recState.targetText || '').trim().split(/\s+/).filter(Boolean);
        // 短句宽限：单/双词目标（如 Why? / Okay.），确属朗读但 ASR 未识别，
        // 给封顶 80 的通过分，避免被无意义卡死（需满足最短时长，防误触静音）
        if (_tk.length <= 2 && dur >= 0.4) {
          showScoreModal(80, '朗读通过');
          _recApplyScore(recState.mode, 80);
        } else {
          var score = dur >= 1.5 ? 35 : 25;
          showScoreModal(score, '语音识别未成功，请清晰朗读英文后重试');
          _recApplyScore(recState.mode, score);
        }
      }
    })
    .catch(function(err) {
      if (recState.uploadTimer) { clearTimeout(recState.uploadTimer); recState.uploadTimer = null; }
      _cleanupMic();
      _restoreRecUI();
      if (recState.cancelled) return; // 录音已取消，不显示弹窗
      console.error('[MIC] 上传失败:', err);
      if (!recState.evaluatedAlready) {
        recState.evaluatedAlready = true;
        if (err && err.message === 'SILENT') {
          showScoreModal(0, '没有听到声音，请大声朗读后重试');
          _recApplyScore(recState.mode, 0);
        } else {
          // 网络错误：服务器不可达，按时长评分但最高60分（不能通过）
          var dur = (Date.now() - recState.startTime) / 1000;
          var score = Math.min(60, _durationFallbackScore(recState.targetText, dur));
          showScoreModal(score, '网络错误，按时长评分（最高60分）');
          _recApplyScore(recState.mode, score);
        }
      }
    });
}

// 将音频 Blob 转换为 16kHz mono 16-bit PCM
function _convertToPcm16(audioBlob) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() {
      var arrayBuffer = reader.result;
      var AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) { reject(new Error('浏览器不支持 AudioContext')); return; }
      var audioCtx = new AudioContextClass();
      audioCtx.decodeAudioData(arrayBuffer)
        .then(function(audioBuffer) {
          console.log('[MIC] 解码成功: ' + audioBuffer.duration.toFixed(2) + 's, ' + audioBuffer.sampleRate + 'Hz');
          var targetSampleRate = 16000;
          var targetLength = Math.ceil(audioBuffer.duration * targetSampleRate);
          var offlineCtx = new OfflineAudioContext(1, targetLength, targetSampleRate);
          var source = offlineCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineCtx.destination);
          source.start(0);
          return offlineCtx.startRendering();
        })
        .then(function(renderedBuffer) {
          var float32Data = renderedBuffer.getChannelData(0);
          var pcm16 = new Int16Array(float32Data.length);
          var sumSq = 0;
          for (var i = 0; i < float32Data.length; i++) {
            var s = float32Data[i];
            s = Math.max(-1, Math.min(1, s));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            sumSq += s * s;
          }
          var rms = Math.sqrt(sumSq / float32Data.length);
          console.log('[MIC] PCM: ' + pcm16.length + ' samples, RMS=' + rms.toFixed(4));
          if (rms < 0.01) { reject(new Error('SILENT')); return; }
          if (audioCtx.close) audioCtx.close();
          resolve(pcm16.buffer);
        })
        .catch(function(err) {
          if (audioCtx.close) audioCtx.close();
          console.error('[MIC] 解码失败:', err);
          reject(err);
        });
    };
    reader.onerror = function() { reject(new Error('文件读取失败')); };
    reader.readAsArrayBuffer(audioBlob);
  });
}

function _cleanupMic() {
  if (recState.mediaStream) {
    recState.mediaStream.getTracks().forEach(function(t) { t.stop(); });
    recState.mediaStream = null;
  }
  recState.mediaRecorder = null;
  recState.audioChunks = [];
}

function _restoreRecUI() {
  var ids = _getRecIds(recState.mode, recState.testIdx);
  var area = document.getElementById(ids.area);
  if (area) {
    var btn = area.querySelector('.rec-btn, .rec-btn-sm');
    if (btn) btn.classList.remove('recording');
  }
  var label = document.getElementById(ids.label);
  if (label) { label.textContent = '长按麦克风朗读，松手评分'; label.classList.remove('recording'); }
}

// ===== 评分：对比识别文本和目标文本 =====
function _evaluateSpeaking(recognized) {
  if (recState.evaluatedAlready) return;
  recState.evaluatedAlready = true;

  var targetRaw = (recState.targetText || '').toLowerCase().trim();
  // 归一化：去标点、压缩空格，用于稳健比对（"why?" 与 "why" 视为一致）
  var target = targetRaw.replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ').trim();
  recognized = (recognized || '').toLowerCase().trim();
  var recNorm = recognized.replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ').trim();

  var score = 0;
  var detail = '';

  if (!recognized) {
    score = 0;
    detail = '没有听到您的声音，请按住麦克风再试一次';
  } else if (recNorm === target) {
    score = 100;
    detail = '发音非常标准！';
  } else if (recognized.includes(targetRaw) || recNorm.includes(target)) {
    score = 90;
    detail = '很好！发音正确';
  } else {
    // 清理常见填充词后再比对
    var clean = recNorm
      .replace(/\s*(uh|um|ah|er|mm|hm)\s*/g, ' ')
      .replace(/^(the|a|an|i|it|is|to|my|we|they)\s+/, '')
      .replace(/\s+(the|a|an|is|was|were|to|for|on|in|at)$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    // 词覆盖率：识别文本按顺序覆盖目标多少比例词（防"只读片段就 80+"）
    var cov = tokenCoverage(clean, target);
    if (cov >= 0.95) {
      var isShort = target.split(/\s+/).filter(Boolean).length <= 2;
      score = isShort ? 100 : 85;
      detail = '发音不错，已读全目标内容';
    } else if (cov >= 0.8) {
      score = 80 + Math.round((cov - 0.8) * 75); // 80~约97
      detail = '基本读全，注意个别词';
    } else {
      // 覆盖率低：可能是(1)只读片段，或(2)整句但有多处替换/错词
      // 用字符级相似度区分：相似度高=整句近读（可过），相似度低=真片段（不过）
      var sim1 = _similarity(recognized, target);
      var sim2 = _similarity(clean, target);
      var bestSim = Math.max(sim1, sim2);
      if (bestSim >= 0.8) {
        score = Math.round(bestSim * 100);
        detail = '基本正确，注意个别发音';
      } else {
        score = Math.min(78, Math.round(bestSim * 100)); // 只读片段，封顶不过 80
        detail = '只读了一部分，请完整朗读整句后再试';
      }
    }
  }

  showScoreModal(score, detail);
  _recApplyScore(recState.mode, score);
}

// 计算识别文本按顺序覆盖目标文本的词比例（0~1）：用于防"只读片段即高分"
function tokenCoverage(rec, tgt) {
  var rt = (rec || '').split(/\s+/).filter(Boolean);
  var tt = (tgt || '').split(/\s+/).filter(Boolean);
  if (!tt.length || !rt.length) return 0;
  var i = 0, matched = 0;
  for (var k = 0; k < rt.length && i < tt.length; k++) {
    if (rt[k] === tt[i]) { matched++; i++; }
  }
  return matched / tt.length;
}

function _similarity(a, b) {
  if (!a || !b) return 0;
  var longer = a.length > b.length ? a : b;
  var shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  var editDist = _levenshtein(longer, shorter);
  return (longer.length - editDist) / longer.length;
}

function _levenshtein(s, t) {
  var m = s.length, n = t.length;
  var dp = [];
  for (var i = 0; i <= m; i++) { dp[i] = []; for (var j = 0; j <= n; j++) { dp[i][j] = 0; } }
  for (var i = 0; i <= m; i++) dp[i][0] = i;
  for (var j = 0; j <= n; j++) dp[0][j] = j;
  for (var i = 1; i <= m; i++) {
    for (var j = 1; j <= n; j++) {
      dp[i][j] = s[i-1] === t[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// ===== 时长评分兜底（仅网络错误/超时时使用，最高70分）=====
function _durationFallbackScore(targetText, duration) {
  if (!targetText || duration < 0.3) return 0;
  var wordCount = targetText.split(/\s+/).length;
  var expectedDuration = wordCount * 0.5;
  if (duration < 0.5) return 10;
  var ratio = duration / expectedDuration;
  if (ratio >= 0.5 && ratio <= 2.0) {
    var baseScore = 55;
    var deviation = Math.abs(1 - ratio);
    var bonus = Math.round((1 - deviation) * 15);
    return Math.min(70, baseScore + bonus);
  } else if (ratio > 2.0 && ratio < 3.0) {
    return 50;
  } else if (ratio < 0.5) {
    return 30;
  }
  return 40;
}

// ===== 分数弹窗 =====
function showScoreModal(score, detail) {
  var mask = document.getElementById('score-modal-mask');
  if (!mask) { console.warn('[Score] score-modal-mask not found'); return; }
  var scoreEl = document.getElementById('score-modal-score');
  var msgEl = document.getElementById('score-modal-msg');
  var detailEl = document.getElementById('score-modal-detail');
  var iconEl = document.getElementById('score-modal-icon');

  if (scoreEl) scoreEl.textContent = score + '分';
  if (detailEl) detailEl.textContent = detail || '';

  var msg = '';
  var icon = '';
  var color = '';
  if (score >= 90) { msg = '太棒了！'; icon = '🎉'; color = '#52c41a'; }
  else if (score >= 80) { msg = '通过！'; icon = '✅'; color = '#52c41a'; }
  else if (score >= 70) { msg = '不错！'; icon = '👍'; color = '#faad14'; }
  else { msg = '继续加油！'; icon = '💪'; color = '#ff4d4f'; }

  if (msgEl) msgEl.textContent = msg;
  if (iconEl) iconEl.textContent = icon;
  if (scoreEl) scoreEl.style.color = color;

  mask.style.display = 'flex';
}

function closeScoreModal() {
  var mask = document.getElementById('score-modal-mask');
  if (mask) mask.style.display = 'none';
}

// ===== 保存分数到学习记录 =====
function _recApplyScore(mode, score) {
  var user = HiEnglish.getCurrentUser();
  if (!user) return;
  score = Math.round(score);
  var stageData = studyData[currentStage];

  if (mode === 'learn') {
    var wordId = recState.wordId;
    var word = words.find(function(w){ return String(w.id) === String(wordId); });
    if (!word) { _recReset(); return; }
    var scores = stageData.speakScores[wordId] || {};
    scores[speakTarget] = score;
    stageData.speakScores[wordId] = scores;
    var allPass = true;
    var targets = ['phrase', 'ex1', 'ex2', 'ex3'];
    for (var i = 0; i < targets.length; i++) {
      if (!scores[targets[i]] || scores[targets[i]] < 80) { allPass = false; break; }
    }
    if (allPass && !stageData.mastered.includes(wordId)) {
      stageData.mastered.push(wordId);
      showToast('恭喜！已掌握 ' + word.word);
    }
    saveStudyData();
    _recReset();
    _recStartCooldown();
    renderWordLearnCard();

  } else if (mode === 'learn-biz') {
    var lesson = lessons[currentIndex];
    if (!lesson) { _recReset(); return; }
    var scores = stageData.speakScores[lesson.id] || {};
    scores['s' + recState.testIdx] = score;
    stageData.speakScores[lesson.id] = scores;
    var allPass = true;
    for (var i = 0; i < lesson.sentences.length; i++) {
      if (!scores['s' + i] || scores['s' + i] < 80) { allPass = false; break; }
    }
    if (allPass && !stageData.mastered.includes(lesson.id)) {
      stageData.mastered.push(lesson.id);
      showToast('恭喜！已掌握 ' + lesson.title);
    }
    saveStudyData();
    _recReset();
    _recStartCooldown();
    renderLessonLearnCard();

  } else if (mode === 'test') {
    var testIdxSaved = recState.testIdx;
    testSubScores[testIdxSaved] = score;
    _recReset();
    _recStartCooldown();
    _updateRecButtonUI(mode, testIdxSaved, false);
    var ids = _getRecIds(mode, testIdxSaved);
    var scoreEl = document.getElementById(ids.score);
    if (scoreEl) {
      scoreEl.style.display = 'block';
      scoreEl.textContent = score + '分';
      scoreEl.className = 'rec-score ' + (score >= 80 ? 'pass' : 'fail');
    }
    _checkTestAllPass();
  }
}

function _checkTestAllPass() {
  var allPass = true;
  var totalScore = 0;
  var count = 0;
  for (var i = 0; i < testSubItems.length; i++) {
    if (testSubScores[i] === undefined) { allPass = false; break; }
    if (testSubScores[i] < 80) { allPass = false; }
    totalScore += testSubScores[i];
    count++;
  }
  if (allPass && count > 0) {
    var avgScore = Math.round(totalScore / count);
    testScores[testWordIndex] = avgScore;
    var passEl = document.getElementById('test-all-pass');
    if (passEl) {
      passEl.style.display = 'block';
      passEl.textContent = '✅ 全部通过！平均分 ' + avgScore + '，点击「下一题」继续';
    }
    showToast('本题全部通过！' + avgScore + '分');
  }
}

function submitVoiceInput() {
  if (!recState.active) return;
  _stopRecording();
}

function _restoreVoiceArea(type, idx, wordId, score) {
  var ids = _getRecIds('test', idx);
  var area = document.getElementById(ids.area);
  if (!area) return;
  var btn = area.querySelector('.rec-btn, .rec-btn-sm');
  var scoreEl = document.getElementById(ids.score);
  if (btn) btn.classList.remove('recording');
  if (scoreEl) {
    if (score) {
      scoreEl.style.display = 'block';
      scoreEl.textContent = score + '分';
      scoreEl.className = 'rec-score ' + (score >= 80 ? 'pass' : 'fail');
    } else {
      scoreEl.style.display = 'none';
    }
  }
}

function cancelVoiceInput() {
  var mode = recState.mode;
  var idx = recState.testIdx;
  var wordId = recState.wordId;
  // 标记为已取消，阻止异步onstop触发uploadAndTranscribe
  recState.cancelled = true;
  if (recState.active) {
    if (recState.mediaRecorder && recState.mediaRecorder.state === 'recording') {
      try { recState.mediaRecorder.stop(); } catch(e) {}
    }
  }
  isAudioActive = false;
  _recReset();
  _recStartCooldown();
  if (mode === 'learn') renderWordLearnCard();
  else if (mode === 'learn-biz') renderLessonLearnCard();
  else if (mode === 'test') _restoreVoiceArea('test', idx, wordId, undefined);
}

function _recStartCooldown() {
  recState.cooldown = true;
  if (recState.cooldownTimer) clearTimeout(recState.cooldownTimer);
  recState.cooldownTimer = setTimeout(function() { recState.cooldown = false; }, 500);
}

function _recReset() {
  recState.active = false;
  recState.startTime = 0;
  recState.mode = null;
  recState.wordId = null;
  recState.testIdx = null;
  recState.targetText = '';
  recState.audioChunks = [];
  recState.micStarting = false;
  recState.userReleased = false;
  recState.evaluatedAlready = false;
  // 注意：cancelled 不在此处重置，只由 startVoiceInput 重置
  // 这样 cancelVoiceInput 设置的 cancelled=true 能被异步 onstop 检测到
  recState.usingTouch = false;
  if (recState.maxTimer) { clearTimeout(recState.maxTimer); recState.maxTimer = null; }
  if (recState.uploadTimer) { clearTimeout(recState.uploadTimer); recState.uploadTimer = null; }
  if (recState.onstopSafetyTimer) { clearTimeout(recState.onstopSafetyTimer); recState.onstopSafetyTimer = null; }
  if (recState.mediaStream) {
    recState.mediaStream.getTracks().forEach(function(t) { t.stop(); });
    recState.mediaStream = null;
  }
  if (recState.mediaRecorder) {
    try { recState.mediaRecorder.stop(); } catch(e) {}
    recState.mediaRecorder = null;
  }
  isAudioActive = false;
  _removeReleaseListeners();
}

// ===== Event delegation for recording buttons =====
function _setupRecEventDelegation() {
  var containers = ['s-learn-content', 's-weekly-content', 's-monthly-content'];
  containers.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el || el._recPatched) return;
    // touchstart：移动端按下
    el.addEventListener('touchstart', function(ev) {
      var btn = ev.target.closest('.rec-btn, .rec-btn-sm');
      if (!btn) return;
      ev.preventDefault();
      var mode = btn.getAttribute('data-mode');
      var arg = btn.getAttribute('data-arg');
      if (mode && arg !== null) startVoiceInput(mode, arg, true);
    }, { passive: false });
    // mousedown：桌面端按下
    el.addEventListener('mousedown', function(ev) {
      var btn = ev.target.closest('.rec-btn, .rec-btn-sm');
      if (!btn) return;
      var mode = btn.getAttribute('data-mode');
      var arg = btn.getAttribute('data-arg');
      if (mode && arg !== null) startVoiceInput(mode, arg, false);
    });
    el._recPatched = true;
  });
}


// ===== Word navigation =====
function prevWord() {
  if (currentIndex > 0) {
    currentIndex--;
    // 精确停留：往回翻也记住最后停留页（定位页下次从这一页开始）
    studyData[currentStage].readIndex = currentIndex;
    saveStudyData();
    if (currentStage === 'basic') renderWordLearnCard();
    else renderLessonLearnCard();
  }
}

function nextWord() {
  var stageData = studyData[currentStage];
  currentIndex++;
  // 精确停留：无论前进后退都记住最后停留页（定位页下次从这一页开始）
  stageData.readIndex = currentIndex;
  var today = HiEnglish.today();
  if (currentStage === 'basic') {
    var prevWordId = words[currentIndex - 1] ? words[currentIndex - 1].id : null;
    // 用 String() 兼容 ID 类型不一致（number vs string）
    if (prevWordId && !stageData.learned.some(function(x) { return String(x) === String(prevWordId); })) {
      stageData.learned.push(String(prevWordId));
    }
    if (prevWordId) stageData.learnedDates[String(prevWordId)] = today;
  } else {
    var prevLessonId = lessons[currentIndex - 1] ? lessons[currentIndex - 1].id : null;
    if (prevLessonId && !stageData.learned.some(function(x) { return String(x) === String(prevLessonId); })) {
      stageData.learned.push(String(prevLessonId));
    }
    if (prevLessonId) stageData.learnedDates[String(prevLessonId)] = today;
  }
  saveStudyData();
  if (currentStage === 'basic') renderWordLearnCard();
  else renderLessonLearnCard();
}

// ===== Spell Practice =====
function showSpellPage() {
  document.querySelectorAll('#student-app .page').forEach(function(p){ p.classList.remove('active'); });
  document.getElementById('s-page-spell').classList.add('active');

  var total = currentStage === 'basic' ? words.length : lessons.length;
  if (currentIndex >= total) {
    document.getElementById('s-spell-content').innerHTML = '<div class="test-locked"><div class="lock-icon">🎉</div><div class="lock-msg">拼写练习已完成</div></div>';
    return;
  }

  if (currentStage === 'basic') {
    var word = words[currentIndex];
    var progressPercent = Math.floor((currentIndex / total) * 100);
    document.getElementById('s-spell-content').innerHTML =
      '<div class="learn-header">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="font-size:13px;color:var(--text-sub);">第 ' + (currentIndex + 1) + ' / ' + total + ' 词</span>' +
          '<span style="font-size:13px;color:var(--primary);">独立进度</span>' +
        '</div>' +
        '<div class="progress-bar"><div class="fill" style="width:' + progressPercent + '%;background:var(--success);"></div></div>' +
      '</div>' +
      '<div class="learn-section" style="text-align:center;padding:30px 16px;">' +
        '<button onclick="speakWithTimer(\'' + escapeQuotes(word.word) + '\')" style="border:none;background:none;font-size:48px;cursor:pointer;">🔊</button>' +
        '<div style="font-size:13px;color:var(--text-sub);margin-top:8px;">点击播放发音</div>' +
        '<div style="margin-top:20px;">' +
          '<div style="font-size:12px;color:var(--text-sub);margin-bottom:6px;">' + (word.pos || '') + '</div>' +
          '<div style="font-size:18px;margin-bottom:8px;color:var(--text);">' + (word.cn || '') + '</div>' +
          '<input type="text" id="spell-input" placeholder="请输入英文单词" style="width:100%;padding:12px;border:2px solid var(--border);border-radius:8px;font-size:18px;text-align:center;outline:none;" onfocus="this.style.borderColor=\'var(--primary)\'" onblur="this.style.borderColor=\'var(--border)\'" onkeydown="if(event.key===\'Enter\')submitSpell()">' +
        '</div>' +
        '<div id="spell-result"></div>' +
        '<button class="btn btn-primary btn-block" style="margin-top:16px;" onclick="submitSpell()">提交</button>' +
      '</div>' +
      '<div class="alert-box alert-info">ℹ️ 拼写练习进度独立于跟读学习，各有自己的学习节奏</div>' +
      '<div style="display:flex;gap:8px;padding:12px;">' +
        '<button class="btn btn-outline" style="flex:1;" onclick="backHome()">返回首页</button>' +
        '<button class="btn btn-outline" style="flex:1;" onclick="prevSpell()" ' + (currentIndex === 0 ? 'disabled' : '') + '>‹ 上一个</button>' +
        '<button class="btn btn-outline" style="flex:1;" onclick="nextSpell()">下一个 ›</button>' +
      '</div>';
    setTimeout(function() { document.getElementById('spell-input').focus(); }, 100);
  } else {
    // Business stage: fill-in-the-blank with high-frequency words from lesson sentences
    renderBusinessSpellPage();
  }
}

// Business spell practice: extract keywords from lesson sentences, create fill-in-the-blank
function renderBusinessSpellPage() {
  var total = lessons.length;
  var lesson = lessons[currentIndex];
  var progressPercent = Math.floor((currentIndex / total) * 100);

  // Common English stop words to filter out
  var stopWords = {'the':1,'a':1,'an':1,'is':1,'are':1,'was':1,'were':1,'be':1,'been':1,'being':1,'have':1,'has':1,'had':1,'do':1,'does':1,'did':1,'will':1,'would':1,'could':1,'should':1,'may':1,'might':1,'must':1,'can':1,'shall':1,'to':1,'of':1,'in':1,'on':1,'at':1,'by':1,'for':1,'with':1,'about':1,'as':1,'into':1,'like':1,'through':1,'after':1,'over':1,'between':1,'out':1,'against':1,'during':1,'without':1,'before':1,'under':1,'around':1,'among':1,'and':1,'but':1,'or':1,'not':1,'no':1,'so':1,'than':1,'too':1,'very':1,'just':1,'also':1,'only':1,'up':1,'down':1,'off':1,'again':1,'then':1,'once':1,'here':1,'there':1,'when':1,'where':1,'why':1,'how':1,'all':1,'each':1,'every':1,'both':1,'few':1,'more':1,'most':1,'other':1,'some':1,'such':1,'any':1,'this':1,'that':1,'these':1,'those':1,'i':1,'you':1,'he':1,'she':1,'it':1,'we':1,'they':1,'me':1,'him':1,'her':1,'us':1,'them':1,'my':1,'your':1,'his':1,'its':1,'our':1,'their':1,'what':1,'which':1,'who':1,'whom':1,'whose':1,'if':1,'because':1,'while':1,'though':1,'although':1,'since':1,'until':1,'unless':1,"don't":1,"i'll":1,"i've":1,"it's":1,"that's":1,"let's":1};

  // Collect keyword candidates from all sentences (length >= 4, not stop words)
  var candidates = [];
  lesson.sentences.forEach(function(s, sIdx) {
    var sentWords = s.en.replace(/[^a-zA-Z\s']/g, '').split(/\s+/);
    sentWords.forEach(function(w) {
      var lower = w.toLowerCase();
      if (lower.length >= 4 && !stopWords[lower]) {
        // Avoid duplicates - prefer first occurrence
        var exists = candidates.find(function(c) { return c.word.toLowerCase() === lower; });
        if (!exists) {
          candidates.push({word: w, sentence: s.en, zh: s.zh, speaker: s.speaker, sIdx: sIdx});
        }
      }
    });
  });

  if (candidates.length === 0) {
    document.getElementById('s-spell-content').innerHTML =
      '<div class="test-locked"><div class="lock-icon">📝</div><div class="lock-msg">本课暂无适合的拼写练习词汇</div></div>' +
      '<div style="display:flex;gap:8px;padding:12px;">' +
        '<button class="btn btn-outline" style="flex:1;" onclick="backHome()">返回首页</button>' +
        '<button class="btn btn-outline" style="flex:1;" onclick="nextSpell()">跳过 ›</button>' +
      '</div>';
    return;
  }

  // Pick a word for this lesson (deterministic based on lesson id for stability)
  var pickIdx = (lesson.id * 7 + 3) % candidates.length;
  var target = candidates[pickIdx];

  // Create fill-in-the-blank sentence
  var escapedWord = target.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var blanked = target.sentence.replace(new RegExp('\\b' + escapedWord + '\\b', 'i'), '______');

  // Store target for submitSpell
  bizSpellTarget = target.word;

  document.getElementById('s-spell-content').innerHTML =
    '<div class="learn-header">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:13px;color:var(--text-sub);">第 ' + (currentIndex + 1) + ' / ' + total + ' 课</span>' +
        '<span style="font-size:13px;color:var(--primary);">独立进度</span>' +
      '</div>' +
      '<div class="progress-bar"><div class="fill" style="width:' + progressPercent + '%;background:var(--success);"></div></div>' +
    '</div>' +
    '<div class="learn-section" style="padding:20px 16px;">' +
      '<div style="font-size:13px;color:var(--text-sub);margin-bottom:10px;">' + (target.speaker === 'A' ? '👤 A' : '👤 B') + ' · 来自本课例句</div>' +
      '<div style="font-size:16px;line-height:1.8;margin-bottom:8px;color:var(--text);">' + blanked + '</div>' +
      '<div style="font-size:14px;color:var(--text-sub);margin-bottom:20px;">' + target.zh + '</div>' +
      '<div style="text-align:center;">' +
        '<button onclick="speakWithTimer(\'' + escapeQuotes(target.word) + '\')" style="border:none;background:none;font-size:36px;cursor:pointer;">🔊</button>' +
        '<div style="font-size:13px;color:var(--text-sub);margin-top:4px;">点击播放单词发音</div>' +
      '</div>' +
      '<div style="margin-top:16px;">' +
        '<input type="text" id="spell-input" placeholder="请输入缺失的单词" style="width:100%;padding:12px;border:2px solid var(--border);border-radius:8px;font-size:18px;text-align:center;outline:none;" onfocus="this.style.borderColor=\'var(--primary)\'" onblur="this.style.borderColor=\'var(--border)\'" onkeydown="if(event.key===\'Enter\')submitSpell()">' +
      '</div>' +
      '<div id="spell-result"></div>' +
      '<button class="btn btn-primary btn-block" style="margin-top:16px;" onclick="submitSpell()">提交</button>' +
    '</div>' +
    '<div class="alert-box alert-info">ℹ️ 拼写练习进度独立于跟读学习，各有自己的学习节奏</div>' +
    '<div style="display:flex;gap:8px;padding:12px;">' +
      '<button class="btn btn-outline" style="flex:1;" onclick="backHome()">返回首页</button>' +
      '<button class="btn btn-outline" style="flex:1;" onclick="prevSpell()" ' + (currentIndex === 0 ? 'disabled' : '') + '>‹ 上一个</button>' +
      '<button class="btn btn-outline" style="flex:1;" onclick="nextSpell()">下一个 ›</button>' +
    '</div>';
  setTimeout(function() { document.getElementById('spell-input').focus(); }, 100);
}

function submitSpell() {
  var input = document.getElementById('spell-input').value.trim().toLowerCase();
  if (currentStage === 'basic') {
    var word = words[currentIndex];
    if (input === word.word.toLowerCase()) {
      document.getElementById('spell-result').innerHTML = '<div style="padding:10px;background:var(--success-light);color:var(--success);border-radius:8px;margin-top:12px;font-size:14px;">✅ 正确！' + word.word + ' — ' + (word.ipa || '') + '</div>';
      speakWithTimer(word.word);
      setTimeout(function() { nextSpell(); }, 2000);
    } else {
      document.getElementById('spell-result').innerHTML = '<div style="padding:10px;background:var(--danger-light);color:var(--danger);border-radius:8px;margin-top:12px;font-size:14px;">❌ 错误。正确答案：' + word.word + '</div>';
    }
  } else {
    // Business stage
    var targetWord = bizSpellTarget || '';
    if (input && input === targetWord.toLowerCase()) {
      document.getElementById('spell-result').innerHTML = '<div style="padding:10px;background:var(--success-light);color:var(--success);border-radius:8px;margin-top:12px;font-size:14px;">✅ 正确！' + targetWord + '</div>';
      speakWithTimer(targetWord);
      setTimeout(function() { nextSpell(); }, 2000);
    } else {
      document.getElementById('spell-result').innerHTML = '<div style="padding:10px;background:var(--danger-light);color:var(--danger);border-radius:8px;margin-top:12px;font-size:14px;">❌ 错误。正确答案：' + targetWord + '</div>';
    }
  }
}

function nextSpell() {
  var stageData = studyData[currentStage];
  currentIndex++;
  if (currentIndex > stageData.spellIndex) stageData.spellIndex = currentIndex;
  saveStudyData();
  showSpellPage();
}

function prevSpell() {
  if (currentIndex > 0) {
    currentIndex--;
    showSpellPage();
  }
}

// ===== Tests =====
function prepareTest(type) {
  var pool;

  if (type === 'weekly') {
    pool = getWeeklyTestPool();
    if (pool.length < 10) {
      showToast('周学习内容少于10个单词或微课，请补卡');
      return;
    }
    testWords = pool.slice().sort(function() { return Math.random() - 0.5; }).slice(0, 10);
  } else {
    pool = getMonthlyTestPool();
    if (pool.length < 20) {
      showToast('月学习内容少于20个单词或微课，请补卡');
      return;
    }
    testWords = pool.slice().sort(function() { return Math.random() - 0.5; }).slice(0, 20);
  }

  testWordIndex = 0;
  testScores = {};
  testSubItems = [];
  testSubScores = {};
  sNav(type);
  if (type === 'weekly') renderWeeklyTest(false);
  else renderMonthlyTest(false);
}

// Get last Saturday to this Friday's learned items
function getWeeklyTestPool() {
  var stageData = studyData[currentStage];
  // 题池与"已学"同源：仅取真实听完整必需音频的词/课，按 audioDoneDate 做日期过滤
  var learnedDates = stageData.audioDoneDate || {};
  var learnedIds = Object.keys(stageData.audioDone || {}).filter(function(id){ return isAudioLearned(id, currentStage); });

  // Calculate last Saturday and this Friday
  var now = new Date();
  var dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  var lastSaturday;
  if (dayOfWeek === 6) {
    // Today is Saturday — last Saturday is today
    lastSaturday = new Date(now);
  } else {
    // Go back to the most recent Saturday
    var diff = dayOfWeek === 0 ? 1 : dayOfWeek + 1;
    lastSaturday = new Date(now);
    lastSaturday.setDate(now.getDate() - diff);
  }
  lastSaturday.setHours(0, 0, 0, 0);

  var thisFriday = new Date(lastSaturday);
  thisFriday.setDate(lastSaturday.getDate() + 6);
  thisFriday.setHours(23, 59, 59, 999);

  var startDateStr = formatDateStr(lastSaturday);
  var endDateStr = formatDateStr(thisFriday);

  // Filter learned items by date range — ID 类型兼容（learnedDates 的 key 可能为 string）
  var pool = [];
  learnedIds.forEach(function(id) {
    var sid = String(id);
    var learnedDate = learnedDates[sid];
    if (learnedDate && learnedDate >= startDateStr && learnedDate <= endDateStr) {
      if (currentStage === 'basic') {
        var word = words.find(function(w) { return String(w.id) === sid; });
        if (word) pool.push(word);
      } else {
        var lesson = lessons.find(function(l) { return String(l.id) === sid; });
        if (lesson) pool.push(lesson);
      }
    }
  });

  // Fallback: if no date-tracked items, use position-based (backward compat)
  if (pool.length === 0 && learnedIds.length > 0) {
    pool = learnedIds.map(function(id) {
      var sid = String(id);
      if (currentStage === 'basic') {
        return words.find(function(w) { return String(w.id) === sid; });
      } else {
        return lessons.find(function(l) { return String(l.id) === sid; });
      }
    }).filter(Boolean);
  }

  return pool;
}

// Get last month 1st to last day's learned items
function getMonthlyTestPool() {
  var stageData = studyData[currentStage];
  // 题池与"已学"同源：仅取真实听完整必需音频的词/课，按 audioDoneDate 做日期过滤
  var learnedDates = stageData.audioDoneDate || {};
  var learnedIds = Object.keys(stageData.audioDone || {}).filter(function(id){ return isAudioLearned(id, currentStage); });

  // Calculate last month start (1st) and end (last day)
  var now = new Date();
  var lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  lastMonthEnd.setHours(23, 59, 59, 999);

  var startDateStr = formatDateStr(lastMonthStart);
  var endDateStr = formatDateStr(lastMonthEnd);

  // Filter learned items by date range — ID 类型兼容（learnedDates 的 key 可能为 string）
  var pool = [];
  learnedIds.forEach(function(id) {
    var sid = String(id);
    var learnedDate = learnedDates[sid];
    if (learnedDate && learnedDate >= startDateStr && learnedDate <= endDateStr) {
      if (currentStage === 'basic') {
        var word = words.find(function(w) { return String(w.id) === sid; });
        if (word) pool.push(word);
      } else {
        var lesson = lessons.find(function(l) { return String(l.id) === sid; });
        if (lesson) pool.push(lesson);
      }
    }
  });

  // Fallback: if no date-tracked items, use position-based (backward compat)
  if (pool.length === 0 && learnedIds.length > 0) {
    pool = learnedIds.map(function(id) {
      var sid = String(id);
      if (currentStage === 'basic') {
        return words.find(function(w) { return String(w.id) === sid; });
      } else {
        return lessons.find(function(l) { return String(l.id) === sid; });
      }
    }).filter(Boolean);
  }

  return pool;
}

// Format date as YYYY-MM-DD
function formatDateStr(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function renderWeeklyTest(locked) {
  var content = document.getElementById('s-weekly-content');
  if (locked) {
    content.innerHTML = '<div class="test-locked"><div class="lock-icon">⏰</div><div class="lock-msg">未到周测时间，请每周六、日进行测试</div><div style="margin-top:24px;"><button class="btn btn-outline" onclick="backHome()">返回首页</button></div></div>';
    return;
  }
  renderTestCard('weekly', content);
}

function renderMonthlyTest(locked) {
  var content = document.getElementById('s-monthly-content');
  if (locked) {
    content.innerHTML = '<div class="test-locked"><div class="lock-icon">📅</div><div class="lock-msg">未到月测时间，请每月1日~5日进行测试</div><div style="margin-top:24px;"><button class="btn btn-outline" onclick="backHome()">返回首页</button></div></div>';
    return;
  }
  renderTestCard('monthly', content);
}

function renderTestCard(type, content) {
  var totalCount = testWords.length;
  var testItem = testWords[testWordIndex];
  if (!testItem) {
    content.innerHTML = '<div class="test-locked"><div class="lock-icon">📝</div><div class="lock-msg">暂无测试内容，请先学习</div></div>';
    return;
  }

  var testCountLabel = type === 'weekly' ? '10个单词或微课' : '20个单词或微课';

  // Build sub-items: each has its own Chinese text, English target, and mic button
  testSubItems = [];
  testSubScores = {};

  if (currentStage === 'basic') {
    var word = testItem;
    testSubItems = [
      {label: '📌 词组', zh: word.phrase_cn, en: word.phrase_en, key: 'phrase'},
      {label: '💬 例句1', zh: word.s1_cn, en: word.s1_en, key: 'ex1'},
      {label: '💬 例句2', zh: word.s2_cn, en: word.s2_en, key: 'ex2'},
      {label: '💬 例句3', zh: word.s3_cn, en: word.s3_en, key: 'ex3'},
    ];
  } else {
    var lesson = testItem;
    lesson.sentences.forEach(function(s, i) {
      testSubItems.push({
        label: s.speaker === 'A' ? '👤 A' : '👤 B',
        zh: s.zh,
        en: s.en,
        key: 's' + i
      });
    });
  }

  var intro =
    '<div class="test-intro">' +
      '<div class="test-icon">' + (type === 'weekly' ? '📝' : '📅') + '</div>' +
      '<h3>' + (type === 'weekly' ? '本周周测' : '本月月测') + '</h3>' +
      '<div class="test-sub">' + (type === 'weekly' ? '上周应学内容随机抽取（' + testCountLabel + '）' : '上月应学内容随机抽取（' + testCountLabel + '）') + '</div>' +
      '<div class="alert-box alert-info" style="text-align:left;">ℹ️ 测试规则：只显示中文，长按麦克风朗读英文，松手后自动评分，每项80分以上通过</div>' +
    '</div>';

  // Each sub-item gets its own card with Chinese text + recording button
  var itemsHTML = testSubItems.map(function(item, idx) {
    return '<div class="test-sub-card">' +
      '<div style="font-size:13px;color:var(--primary);font-weight:600;margin-bottom:6px;">' + item.label + '（看中文说英文）</div>' +
      '<div style="font-size:17px;color:var(--text);margin-bottom:10px;line-height:1.6;">' + item.zh + '</div>' +
      '<div id="voice-area-test-' + idx + '" style="text-align:center;">' +
        '<button class="rec-btn-sm" data-mode="test" data-arg="' + idx + '">🎤</button>' +
        '<div class="rec-label" id="rec-label-test-' + idx + '">长按麦克风朗读，松手评分</div>' +
        '<div class="rec-score" id="rec-score-test-' + idx + '" style="display:none;"></div>' +
      '</div>' +
    '</div>';
  }).join('');

  var cardHTML =
    '<div class="test-card">' +
      '<div class="test-num">第 ' + (testWordIndex + 1) + ' / ' + totalCount + ' 题' + (currentStage === 'business' ? ' · ' + testItem.title : '') + '</div>' +
      itemsHTML +
      '<div id="test-all-pass" style="display:none;text-align:center;padding:12px;background:var(--success-light);border-radius:8px;margin-top:12px;font-size:14px;color:var(--success);font-weight:600;"></div>' +
    '</div>';

  var nav =
    '<div style="display:flex;gap:8px;padding:12px;">' +
      '<button class="btn btn-outline" style="flex:1;" onclick="backHome()">退出测试</button>' +
      '<button class="btn btn-primary" style="flex:1;" onclick="nextTestWord(\'' + type + '\')">下一题 ›</button>' +
    '</div>' +
    '<div class="alert-box alert-info">📊 本轮进度：' + (testWordIndex + 1) + '/' + totalCount + ' · 已通过 ' + Object.keys(testScores).length + ' 题</div>';

  content.innerHTML = intro + cardHTML + nav;
  _setupRecEventDelegation();
}

function nextTestWord(type) {
  testWordIndex++;
  if (testWordIndex >= testWords.length) {
    // Test complete
    var passed = Object.keys(testScores).length;
    var total = testWords.length;
    var avgScore = total > 0 && passed > 0 ? Math.round(Object.values(testScores).reduce(function(a,b){return a+b;}, 0) / passed) : 0;

    // Record test result
    var stageData = studyData[currentStage];
    var testResult = {date: HiEnglish.today(), avgScore: avgScore, passed: passed, total: total};
    if (type === 'weekly') {
      stageData.weeklyTests.push(testResult);
    } else {
      stageData.monthlyTests.push(testResult);
    }
    saveStudyData();

    showToast('测试完成！通过 ' + passed + '/' + total + ' 题，平均分 ' + avgScore);
    setTimeout(function() { backHome(); }, 1500);
    return;
  }
  var content = document.getElementById(type === 'weekly' ? 's-weekly-content' : 's-monthly-content');
  renderTestCard(type, content);
}

// ===== Word List (ALL 850 words) =====
var wlFilter = 'all';
var wlSearch = '';

function renderWordList(filter) {
  if (filter) wlFilter = filter;
  var stageData = studyData[currentStage];
  var container = document.getElementById('s-wordlist-content');

  // Stats overview — 已学=真实听过音频（audioDone），与首页/报告页一致
  var learnedCount = getLearnedCount(currentStage);
  var masteredCount = getMasteredCount(currentStage);
  var learningCount = getLearningCount(currentStage);
  var totalWords = currentStage === 'basic' ? words.length : lessons.length;
  var progressPercent = totalWords > 0 ? Math.floor((learnedCount / totalWords) * 100) : 0;

  var statsHTML =
    '<div class="card" style="text-align:center;">' +
      '<div class="stat-grid" style="margin:0;">' +
        '<div class="stat-card"><div class="stat-val">' + learnedCount + '</div><div class="stat-key">已学</div></div>' +
        '<div class="stat-card"><div class="stat-val">' + masteredCount + '</div><div class="stat-key">已掌握</div></div>' +
        '<div class="stat-card"><div class="stat-val">' + (learningCount > 0 ? learningCount : 0) + '</div><div class="stat-key">学习中</div></div>' +
      '</div>' +
      '<div style="margin-top:10px;font-size:13px;color:var(--text-sub);">共 ' + totalWords + (currentStage === 'basic' ? ' 词' : ' 课') + ' · 进度 ' + progressPercent + '%</div>' +
    '</div>';

  // Filter buttons
  var filterHTML =
    '<div class="wl-filter">' +
      '<button class="wl-filter-btn ' + (wlFilter === 'all' ? 'active' : '') + '" onclick="renderWordList(\'all\')">全部</button>' +
      '<button class="wl-filter-btn ' + (wlFilter === 'learned' ? 'active' : '') + '" onclick="renderWordList(\'learned\')">已学</button>' +
      '<button class="wl-filter-btn ' + (wlFilter === 'mastered' ? 'active' : '') + '" onclick="renderWordList(\'mastered\')">已掌握</button>' +
      '<button class="wl-filter-btn ' + (wlFilter === 'learning' ? 'active' : '') + '" onclick="renderWordList(\'learning\')">学习中</button>' +
      '<button class="wl-filter-btn ' + (wlFilter === 'unlearned' ? 'active' : '') + '" onclick="renderWordList(\'unlearned\')">未学</button>' +
    '</div>';

  // Search
  var wlPlaceholder = currentStage === 'basic' ? '搜索单词或中文...' : '搜索微课名称或中文...';
  var searchHTML = '<div style="padding:0 12px 8px;position:relative;"><input type="password" autocomplete="new-password" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;" tabindex="-1" aria-hidden="true"><input type="text" class="wl-search" name="wl-search-query" autocomplete="off" placeholder="' + wlPlaceholder + '" value="' + wlSearch + '" oninput="onWlSearch(this.value)"></div>';

  // Filter words — 统一用 classifyItem 四态分类，确保卡片数与清单数一致、未学不含已掌握/已学
  var displayItems = currentStage === 'basic' ? words : lessons;
  if (wlFilter === 'learned') {
    // 已学：音频全部听完（isAudioLearned），含"双达标"（音频+跟读都过）——与卡片"已学"口径一致
    displayItems = displayItems.filter(function(w) { return isAudioLearned(w.id, currentStage); });
  } else if (wlFilter === 'mastered') {
    displayItems = displayItems.filter(function(w) { return classifyItem(w.id, currentStage) === 'mastered'; });
  } else if (wlFilter === 'learning') {
    displayItems = displayItems.filter(function(w) { return classifyItem(w.id, currentStage) === 'learning'; });
  } else if (wlFilter === 'unlearned') {
    displayItems = displayItems.filter(function(w) { return classifyItem(w.id, currentStage) === 'unlearned'; });
  }

  if (wlSearch) {
    var s = wlSearch.toLowerCase();
    displayItems = displayItems.filter(function(w) {
      if (currentStage === 'basic') {
        return (w.word && w.word.toLowerCase().includes(s)) || (w.cn && w.cn.includes(wlSearch));
      } else {
        return (w.title && w.title.toLowerCase().includes(s)) || (w.titleCn && w.titleCn.includes(wlSearch));
      }
    });
  }

  // Render ALL items (no limit)
  var statusText = {mastered: '已掌握', learned: '已学', learning: '学习中', unlearned: '未学'};
  var listHTML = displayItems.map(function(w) {
    var status = classifyItem(w.id, currentStage);
    // 双达标（音频+跟读都过）同时显示“已学”和“已掌握”两个标签
    var isMastered = status === 'mastered';
    var isLearned = isAudioLearned(w.id, currentStage);
    var statusTagsHTML = '';
    if (isMastered) {
      statusTagsHTML = '<div class="wl-status-wrap"><span class="wl-status learned">' + statusText.learned + '</span><span class="wl-status mastered">' + statusText.mastered + '</span></div>';
    } else if (isLearned) {
      statusTagsHTML = '<span class="wl-status learned">' + statusText.learned + '</span>';
    } else {
      statusTagsHTML = '<span class="wl-status ' + status + '">' + statusText[status] + '</span>';
    }
    if (currentStage === 'basic') {
      return '<div class="word-list-item">' +
        '<div class="wl-num ' + status + '">' + w.id + '</div>' +
        '<div style="flex:1;">' +
          '<div class="wl-word">' + w.word + ' <span class="wl-ipa">' + (w.ipa || '') + '</span></div>' +
          '<div class="wl-zh">' + (w.cn || '') + '</div>' +
        '</div>' +
        statusTagsHTML +
      '</div>';
    } else {
      return '<div class="word-list-item">' +
        '<div class="wl-num ' + status + '">' + w.id + '</div>' +
        '<div style="flex:1;">' +
          '<div class="wl-word">' + w.title + '</div>' +
          '<div class="wl-zh">' + (w.titleCn || '') + '</div>' +
        '</div>' +
        statusTagsHTML +
      '</div>';
    }
  }).join('');

  var countInfo = '<div style="padding:0 12px 4px;font-size:12px;color:var(--text-sub);">显示 ' + displayItems.length + ' / ' + totalWords + (currentStage === 'basic' ? ' 个单词' : ' 门微课') + '</div>';

  container.innerHTML = statsHTML + filterHTML + searchHTML + countInfo + '<div id="wl-list" style="padding:0 12px 12px;">' + (listHTML || '<div style="text-align:center;padding:20px;color:var(--text-sub);">暂无数据</div>') + '</div>';
}

function onWlSearch(val) {
  wlSearch = val;
  renderWordList();
}

// ===== Report Page (先同步服务端最新数据，确保与管理员端一致) =====
async function renderReport() {
  // Refresh user info to pick up any admin changes
  refreshUserInfo();

  var user = HiEnglish.getCurrentUser();
  // 关键修复：进入报告页前，先从服务端拉取最新学习数据和用户列表
  // 根因：清除缓存后 localStorage 为空，renderReport 纯读本地导致显示初始错误数据；
  //        即使未清缓存，本地数据也可能滞后于管理员端（管理员刚修改了数据）
  if (user) {
    var serverData = await HiEnglish.fetchServerStudyData(user.empid);
    if (serverData) {
      studyData = serverData;
      // 统一打卡迁移（与服务端合并后确保顶层 checkIns 为唯一真相）
      if (unifyCheckIns()) saveStudyData();
      console.log('[Report] 已从服务端同步最新学习数据');
    }
    // 同步用户列表（确保排行榜数据准确）
    await HiEnglish.syncUsersFromServer();
  }

  var stageData = studyData[currentStage];
  // 使用统一打卡数据（不再按阶段分离）
  var allCheckIns = studyData.checkIns || [];
  var totalDays = allCheckIns.length;
  var completedDays = allCheckIns.filter(function(c){return c.completed;}).length;
  // 已学=真实听过音频（audioDone），与首页/学习清单一致
  var masteredCount = getMasteredCount(currentStage);
  var learnedCount = getLearnedCount(currentStage);
  var totalItems = currentStage === 'basic' ? words.length : lessons.length;
  var progressPercent = totalItems > 0 ? Math.floor((learnedCount / totalItems) * 100) : 0;
  var totalSeconds = allCheckIns.reduce(function(s, c){return s + (c.seconds || 0);}, 0);
  var totalMinutes = Math.floor(totalSeconds / 60);

  // 计算总成绩（合并 basic+business 两阶段周测/月测，共用 common.js 统一函数）
  var curMonth = HiEnglish.today().slice(0, 7); // 当前自然月 "YYYY-MM"
  var _sc = HiEnglish.calcMonthlyScore(studyData, curMonth); // studyData 为当前用户完整数据（含两阶段+顶层checkIns）
  var checkinScore = _sc.checkinScore;
  var weeklyScore = _sc.weeklyScore;
  var monthlyScore = _sc.monthlyScore;
  var totalScore = _sc.total;

  var scoreHTML =
    '<div class="card" style="text-align:center;">' +
      '<div style="font-size:12px;color:var(--text-sub);">综合得分</div>' +
      '<div style="font-size:40px;font-weight:700;color:var(--primary);margin:8px 0;">' + totalScore + '</div>' +
    '</div>';

  var statsHTML =
    '<div class="stat-grid">' +
      '<div class="stat-card"><div class="stat-val">' + learnedCount + '</div><div class="stat-key">已学</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + masteredCount + '</div><div class="stat-key">已掌握</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + progressPercent + '%</div><div class="stat-key">学习进度</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + totalMinutes + '分</div><div class="stat-key">累计学习</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + completedDays + '</div><div class="stat-key">学习天数</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + (stageData.weeklyTests.length > 0 ? Math.round(stageData.weeklyTests.reduce(function(s,t){return s+(t.avgScore||0);},0)/stageData.weeklyTests.length) : 0) + '</div><div class="stat-key">周测均分</div></div>' +
    '</div>';

  // Rankings
  var users = HiEnglish.getUsers();
  var user = HiEnglish.getCurrentUser();
  // 关键修复：排行榜需要全体学员数据，从服务端拉取（与管理员端同一数据源）。
  // 根因：过去只读 localStorage，手机端/清缓存后本地只有自己一条 → 其他人全0、与管理端不一致。
  // 服务端不可达时降级用本地数据，绝不用空对象覆盖导致全0。
  var allStudyData = await HiEnglish.fetchAllStudyData();
  if (!allStudyData || Object.keys(allStudyData).length === 0) {
    allStudyData = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
  }
  // 自己的数据用当前最新的 studyData（含本次会话未推送的改动）
  if (user && studyData) allStudyData[user.empid] = studyData;

  var personalScores = Object.keys(users).map(function(empid) {
    var sd = allStudyData[empid] || {};
    var stage = sd[currentStage] || {mastered: []};
    var mastered = stage.mastered ? stage.mastered.length : 0;
    // 合并两阶段口径，共用 common.js 统一函数
    var sc = HiEnglish.calcMonthlyScore(sd, curMonth);
    return {empid: empid, name: users[empid].name, group: users[empid].group, score: sc.total, mastered: mastered, checkInDays: sc.monthCheckinDays};
  }).sort(function(a, b) { return b.score - a.score; });

  var personalRankHTML = personalScores.slice(0, 10).map(function(item, i) {
    var cls = i === 0 ? 'top1' : (i === 1 ? 'top2' : (i === 2 ? 'top3' : ''));
    var selfCls = item.empid === user.empid ? ' self' : '';
    var fmtScore = Number.isInteger(item.score) ? String(item.score) : item.score.toFixed(1).replace(/\.0$/, '');
    return '<div class="rank-item' + selfCls + '"><span class="rank-num ' + cls + '">' + (i + 1) + '</span><span class="rank-name">' + item.name + ' · ' + (item.group || '') + '</span><span class="rank-score">' + fmtScore + '</span></div>';
  }).join('');

  // Group rankings
  var groupScores = {};
  personalScores.forEach(function(p) {
    if (!groupScores[p.group]) groupScores[p.group] = {name: p.group, total: 0, count: 0};
    groupScores[p.group].total += p.score;
    groupScores[p.group].count++;
  });
  var groupList = Object.values(groupScores).map(function(g) {
    return {name: g.name, avg: Math.round(g.total / g.count * 10) / 10};
  }).sort(function(a, b) { return b.avg - a.avg; });

  var groupRankHTML = groupList.slice(0, 10).map(function(item, i) {
    var cls = i === 0 ? 'top1' : (i === 1 ? 'top2' : (i === 2 ? 'top3' : ''));
    var selfCls = item.name === user.group ? ' self' : '';
    var fmtAvg = Number.isInteger(item.avg) ? String(item.avg) : item.avg.toFixed(1).replace(/\.0$/, '');
    return '<div class="rank-item' + selfCls + '"><span class="rank-num ' + cls + '">' + (i + 1) + '</span><span class="rank-name">' + item.name + (item.name === user.group ? '（我组）' : '') + '</span><span class="rank-score">' + fmtAvg + '</span></div>';
  }).join('');

  var scoreBreakdownHTML =
    '<div class="section-title">📊 成绩构成</div>' +
    '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>打卡天数占比（30%）</span><span style="font-weight:600;">' + checkinScore + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>周测平均分（30%）</span><span style="font-weight:600;">' + weeklyScore + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>月测成绩（40%）</span><span style="font-weight:600;">' + monthlyScore + '</span></div>' +
      '<div style="border-top:1px solid var(--border);padding-top:8px;display:flex;justify-content:space-between;"><span style="font-weight:700;">总成绩</span><span style="font-weight:700;color:var(--primary);font-size:18px;">' + totalScore + '</span></div>' +
    '</div>';

  document.getElementById('s-report-content').innerHTML = scoreHTML + statsHTML +
    '<div class="section-title">🏆 个人学习排行榜</div>' +
    '<div class="rank-list">' + (personalRankHTML || '<div style="text-align:center;padding:20px;color:var(--text-sub);">暂无排行数据</div>') + '</div>' +
    '<div class="section-title">🏆 小组学习排行榜</div>' +
    '<div class="rank-list">' + (groupRankHTML || '<div style="text-align:center;padding:20px;color:var(--text-sub);">暂无排行数据</div>') + '</div>' +
    scoreBreakdownHTML;
}

// ===== Messages =====
async function renderMessages() {
  var user = HiEnglish.getCurrentUser();
  if (!user) return;
  // 先渲染本地缓存（快速展示），再异步拉取服务端最新数据
  _renderMessagesList(HiEnglish.getMessages(user.empid));
  // 从服务端拉取真实消息（含真实接收时间戳）
  var messages = await HiEnglish.fetchServerMessages(user.empid);
  _renderMessagesList(messages);
  updateMessageBadge();
}

function _renderMessagesList(messages) {
  messages = messages || [];
  // 按真实时间倒序（最新在前）
  var allMsgs = messages.slice().sort(function(a, b) {
    return (Number(b.time) || 0) - (Number(a.time) || 0);
  });

  var msgsHTML = allMsgs.map(function(m) {
    var typeText = {reminder: '催学提醒', weekly: '周测提醒', monthly: '月测提醒', system: '系统通知', progress: '进度提醒'};
    return '<div class="msg-item ' + (m.read ? '' : 'unread') + '" data-msgid="' + (m.id || '') + '">' +
      '<div class="msg-header">' +
        '<span class="msg-type type-' + (m.type || 'system') + '">' + (typeText[m.type] || '系统通知') + '</span>' +
        '<span class="msg-time">' + HiEnglish.formatMsgTime(m.time) + '</span>' +
      '</div>' +
      '<div class="msg-title">' + (m.title || '') + '</div>' +
      '<div class="msg-body">' + (m.content || '') + '</div>' +
      '<div class="msg-actions">' +
        (m.type === 'reminder' ? '<button class="btn btn-primary" style="padding:6px 14px;font-size:12px;" onclick="goLearn();markMsgRead(this)">去学习</button>' : '') +
        '<button class="btn btn-outline" style="padding:6px 14px;font-size:12px;" onclick="markMsgRead(this)">标记已读</button>' +
      '</div>' +
    '</div>';
  }).join('');

  document.getElementById('s-messages-content').innerHTML =
    '<div class="card">' +
      '<div style="font-size:14px;font-weight:600;margin-bottom:10px;">🔔 提醒设置</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;"><div><div style="font-size:14px;">手机通知栏提醒</div><div style="font-size:12px;color:var(--text-sub);">每日自动推送打卡提醒至手机通知栏</div></div><div style="width:44px;height:24px;background:var(--primary);border-radius:12px;position:relative;cursor:pointer;" onclick="toggleSwitch(this)"><div style="width:20px;height:20px;background:#fff;border-radius:50%;position:absolute;top:2px;right:2px;transition:all .2s;"></div></div></div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;"><div><div style="font-size:14px;">钉钉消息提醒</div><div style="font-size:12px;color:var(--text-sub);">每日自动通过钉钉发送学习提醒</div></div><div style="width:44px;height:24px;background:var(--primary);border-radius:12px;position:relative;cursor:pointer;" onclick="toggleSwitch(this)"><div style="width:20px;height:20px;background:#fff;border-radius:50%;position:absolute;top:2px;right:2px;transition:all .2s;"></div></div></div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;"><div><div style="font-size:14px;">每日自动提醒</div><div style="font-size:12px;color:var(--text-sub);">每天定时提醒未完成打卡</div></div><div style="width:44px;height:24px;background:var(--primary);border-radius:12px;position:relative;cursor:pointer;" onclick="toggleSwitch(this)"><div style="width:20px;height:20px;background:#fff;border-radius:50%;position:absolute;top:2px;right:2px;transition:all .2s;"></div></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="section-title">📨 消息列表</div>' +
    '<div style="margin:0 12px;">' + (msgsHTML || '<div style="text-align:center;padding:20px;color:var(--text-sub);">暂无消息</div>') + '</div>';
}

function toggleSwitch(el) {
  var dot = el.querySelector('div');
  if (el.style.background === 'rgb(232, 232, 232)' || el.style.background === 'var(--border)') {
    el.style.background = 'var(--primary)';
    dot.style.right = '2px';
    showToast('提醒已开启');
  } else {
    el.style.background = 'var(--border)';
    dot.style.right = '22px';
    showToast('提醒已关闭');
  }
}

function markAllRead() {
  var user = HiEnglish.getCurrentUser();
  var messages = HiEnglish.getMessages(user.empid);
  messages.forEach(function(m) { m.read = true; });
  HiEnglish.saveMessages(user.empid, messages);
  // 同步已读状态到服务端
  HiEnglish.markMessagesReadServer(user.empid, [], true);
  document.querySelectorAll('.msg-item.unread').forEach(function(item) { item.classList.remove('unread'); });
  var badge = document.getElementById('s-msg-badge');
  if (badge) badge.style.display = 'none';
  showToast('已全部标记为已读');
}

function markMsgRead(btn) {
  var item = btn.closest('.msg-item');
  if (item) {
    item.classList.remove('unread');
    var msgId = item.getAttribute('data-msgid');
    var user = HiEnglish.getCurrentUser();
    if (user && msgId) {
      // 更新本地缓存
      var messages = HiEnglish.getMessages(user.empid);
      messages.forEach(function(m) { if (m.id === msgId) m.read = true; });
      HiEnglish.saveMessages(user.empid, messages);
      // 同步到服务端
      HiEnglish.markMessagesReadServer(user.empid, [msgId], false);
    }
  }
  updateMessageBadge();
}

function updateMessageBadge() {
  var user = HiEnglish.getCurrentUser();
  if (!user) return;
  var messages = HiEnglish.getMessages(user.empid);
  var unread = messages.filter(function(m) { return !m.read; }).length;
  var badge = document.getElementById('s-msg-badge');
  if (badge) {
    if (unread > 0) {
      badge.textContent = unread;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }
}

// ===== Calendar =====
function showCalendar() {
  var stageData = studyData[currentStage];
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var todayStr = formatDateStr(now);
  document.getElementById('cal-title').textContent = '📅 ' + year + '年' + (month + 1) + '月 打卡日历';

  var firstDay = new Date(year, month, 1).getDay();
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var todayDate = now.getDate();

  // Calculate this week's Saturday (week start) and Friday (week end) as Date objects
  // Week = Saturday to Friday
  var dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  var saturdayOffset;
  if (dayOfWeek === 6) {
    saturdayOffset = 0;
  } else {
    saturdayOffset = dayOfWeek === 0 ? 1 : dayOfWeek + 1;
  }
  var weekSaturday = new Date(now);
  weekSaturday.setDate(now.getDate() - saturdayOffset);
  weekSaturday.setHours(0, 0, 0, 0);
  var weekFriday = new Date(weekSaturday);
  weekFriday.setDate(weekSaturday.getDate() + 6);
  weekFriday.setHours(23, 59, 59, 999);
  var weekSaturdayStr = formatDateStr(weekSaturday);
  var weekFridayStr = formatDateStr(weekFriday);

  // Helper: check if a date string is in this week (Sat-Fri)
  function isInThisWeekStr(dateStr) {
    return dateStr >= weekSaturdayStr && dateStr <= weekFridayStr;
  }

  var html = '';
  selectedMakeupDate = null; // 重置选中状态
  var calGoBtn = document.getElementById('cal-go-btn');
  if (calGoBtn) calGoBtn.textContent = '去打卡';
  var heads = ['日','一','二','三','四','五','六'];
  heads.forEach(function(h) { html += '<div class="cal-head">' + h + '</div>'; });

  // Fill leading empty cells + previous month's trailing days (if in this week)
  var prevMonthDays = new Date(year, month, 0).getDate(); // last day of prev month
  for (var i = 0; i < firstDay; i++) {
    var prevDay = prevMonthDays - firstDay + 1 + i;
    var prevMonth = month === 0 ? 11 : month - 1;
    var prevYear = month === 0 ? year - 1 : year;
    var prevDateStr = prevYear + '-' + String(prevMonth + 1).padStart(2, '0') + '-' + String(prevDay).padStart(2, '0');
    var prevCheckIn = (studyData.checkIns || []).find(function(c) { return c.date === prevDateStr; });
    var prevInWeek = isInThisWeekStr(prevDateStr);
    var prevIsPast = prevDateStr < todayStr;

    if (prevInWeek && prevIsPast) {
      var pClasses = 'cal-day prev-month';
      if (!prevCheckIn || !prevCheckIn.completed) {
        pClasses += ' undone';
        html += '<div class="' + pClasses + '" data-date="' + prevDateStr + '" style="cursor:pointer;text-decoration:underline;opacity:0.6;" onclick="selectMakeupDate(\'' + prevDateStr + '\')">' + prevDay + '</div>';
      } else {
        pClasses += ' done';
        html += '<div class="' + pClasses + '" style="opacity:0.6;">' + prevDay + '</div>';
      }
    } else {
      html += '<div class="cal-day empty"></div>';
    }
  }

  for (var d = 1; d <= daysInMonth; d++) {
    var classes = 'cal-day';
    var dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    var checkIn = (studyData.checkIns || []).find(function(c) { return c.date === dateStr; });
    var isInThisWeek = isInThisWeekStr(dateStr);

    if (d > todayDate) {
      // Future dates — cannot interact
      classes += ' future';
      html += '<div class="' + classes + '">' + d + '</div>';
    } else if (d < todayDate) {
      // Past dates
      if (!checkIn || !checkIn.completed) {
        classes += ' undone';
        if (isInThisWeek) {
          // Only this week (Sat-Fri) past dates can be made up
          html += '<div class="' + classes + '" data-date="' + dateStr + '" style="cursor:pointer;text-decoration:underline;" onclick="selectMakeupDate(\'' + dateStr + '\')">' + d + '</div>';
        } else {
          html += '<div class="' + classes + '" onclick="showToast(\'该日期不在本周（上周六至本周五），无法补卡\')">' + d + '</div>';
        }
      } else {
        classes += ' done';
        html += '<div class="' + classes + '">' + d + '</div>';
      }
    } else {
      // Today — normal check-in, no makeup
      if (checkIn && checkIn.completed) {
        classes += ' done';
      } else {
        classes += ' today undone';
      }
      html += '<div class="' + classes + '">' + d + '</div>';
    }
  }

  document.getElementById('calendar-grid').innerHTML = html;
  document.getElementById('calendar-modal').classList.add('show');
}

// Makeup: start study session for the selected date (not direct completion)
function startMakeup(dateStr) {
  makeupDate = dateStr;
  closeCalendar();
  showToast('开始为 ' + dateStr + ' 补卡，请完成15分钟学习');
  goLearn();
}

// 选中可补卡日期：记录、移动选中框、改写底部按钮文案
function selectMakeupDate(dateStr) {
  selectedMakeupDate = dateStr;
  // 移动蓝色选中框到被点击的日期格子
  var grid = document.getElementById('calendar-grid');
  if (grid) {
    var cells = grid.querySelectorAll('.cal-day');
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.remove('selected');
    }
    var target = grid.querySelector('.cal-day[data-date="' + dateStr + '"]');
    if (target) target.classList.add('selected');
  }
  var btn = document.getElementById('cal-go-btn');
  if (btn) {
    // dateStr 形如 2026-07-15 → 显示 7月15日（日期部分小一号，避免手机换行）
    var md = dateStr.slice(5).split('-');
    btn.innerHTML = '去补卡（<span style="font-size:0.82em;">' + Number(md[0]) + '月' + Number(md[1]) + '日</span>）';
  }
}

// 日历底部按钮：有选中日期则补卡，否则去今日打卡
function onCalendarGoBtn() {
  if (selectedMakeupDate) {
    startMakeup(selectedMakeupDate);
  } else {
    goLearnFromCalendar();
  }
}

function closeCalendar() {
  document.getElementById('calendar-modal').classList.remove('show');
  selectedMakeupDate = null;
}

function goLearnFromCalendar() {
  closeCalendar();
  goLearn();
}

// 统一打卡字段：把 basic/business 的 checkIns 合并进顶层 studyData.checkIns（去重取最大），
// 并删除 sub-field，使顶层 checkIns 成为唯一真相。幂等，返回是否发生变化。
function unifyCheckIns() {
  if (typeof studyData !== 'object' || !studyData) return false;
  var top = (studyData.checkIns && Array.isArray(studyData.checkIns)) ? studyData.checkIns : null;
  var map = {};
  (top || []).forEach(function(c) { if (c && c.date) map[c.date] = c; });
  var changed = false;
  ['basic', 'business'].forEach(function(stage) {
    var s = studyData[stage];
    if (s && Array.isArray(s.checkIns) && s.checkIns.length) {
      s.checkIns.forEach(function(c) {
        if (!c || !c.date) return;
        if (!map[c.date]) { map[c.date] = {date: c.date, seconds: c.seconds || 0, completed: !!c.completed}; changed = true; }
        else {
          var m = map[c.date];
          var ns = Math.max(m.seconds || 0, c.seconds || 0);
          var nc = m.completed || !!c.completed;
          if (ns !== m.seconds || nc !== m.completed) { m.seconds = ns; m.completed = nc; changed = true; }
        }
      });
      delete s.checkIns;
      changed = true;
    }
  });
  var unified = Object.keys(map).map(function(k) { return map[k]; });
  var before = JSON.stringify(top || []);
  studyData.checkIns = unified;
  if (JSON.stringify(unified) !== before) changed = true;
  return changed;
}

// ===== Study Timer (only counts when audio is active) =====
function startStudyTimer() {
  stopStudyTimer();
  studyTimer = setInterval(function() {
    if (!isAudioActive) return; // Only count when audio playing or mic recording
    // 统一打卡：写入顶层 checkIns，不再区分阶段
    var allCheckIns = studyData.checkIns || (studyData.checkIns = []);
    var targetDate = makeupDate || HiEnglish.today();
    var checkIn = allCheckIns.find(function(c) { return c.date === targetDate; });
    if (!checkIn) {
      checkIn = {date: targetDate, seconds: 0, completed: false};
      allCheckIns.push(checkIn);
    }
    if (checkIn.completed) return;
    checkIn.seconds += 1;
    if (checkIn.seconds >= 900) {
      checkIn.completed = true;
      if (makeupDate) {
        showToast('🎉 ' + makeupDate + ' 补卡成功！');
        makeupDate = null;
      } else {
        showToast('🎉 今日打卡完成！');
      }
      // 关键状态变化：立即推送（绕过防抖），确保跨终端秒级可见
      HiEnglish.pushServerStudyDataImmediate(HiEnglish.getCurrentUser().empid, studyData);
    }
    saveStudyData();
    renderCheckIn();
    // Skip card re-render during voice input to prevent DOM destruction (keyboard collapse)
    if (recState.active) return;
    // Update check-in progress in learn page if visible
    var learnCheckin = document.querySelector('#s-learn-content .checkin-progress');
    if (learnCheckin && currentStage === 'basic') {
      renderWordLearnCard();
    } else if (learnCheckin && currentStage === 'business') {
      renderLessonLearnCard();
    }
  }, 1000);
}

function stopStudyTimer() {
  if (studyTimer) { clearInterval(studyTimer); studyTimer = null; }
}

// ===== Save Study Data =====
function saveStudyData() {
  var user = HiEnglish.getCurrentUser();
  if (user) HiEnglish.saveStudyData(user.empid, studyData);
}

// ===== Change Password =====
function showChangePasswordModal() {
  document.getElementById('change-pw-old').value = '';
  document.getElementById('change-pw-new').value = '';
  document.getElementById('change-pw-confirm').value = '';
  document.getElementById('change-password-modal').classList.add('show');
}

function changeStudentPassword() {
  var oldPw = document.getElementById('change-pw-old').value;
  var newPw = document.getElementById('change-pw-new').value;
  var confirmPw = document.getElementById('change-pw-confirm').value;
  if (!oldPw) { showToast('请输入当前密码'); return; }
  if (!newPw) { showToast('请输入新密码'); return; }
  if (newPw.length < 6) { showToast('新密码至少6位'); return; }
  if (newPw !== confirmPw) { showToast('两次输入的新密码不一致'); return; }

  var user = HiEnglish.getCurrentUser();
  if (!user) { showToast('登录状态已失效，请重新登录'); return; }

  // 关键：调用服务端修改密码（服务端是登录的唯一密码源）
  fetch(HiEnglish.getServerUrl() + '/api/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empid: user.empid, oldPassword: oldPw, newPassword: newPw })
  }).then(function(resp) { return resp.json(); }).then(function(data) {
    if (data.success) {
      // 同步更新本地缓存密码（供离线降级登录使用）
      var users = HiEnglish.getUsers();
      if (users[user.empid]) { users[user.empid].password = newPw; HiEnglish.saveUsers(users); }
      // 更新"记住密码"里保存的凭据，避免下次自动填充旧密码
      var saved = localStorage.getItem('hi_english_saved_credentials');
      if (saved) {
        try {
          var c = JSON.parse(saved);
          if (c.account === user.empid) {
            c.password = newPw;
            localStorage.setItem('hi_english_saved_credentials', JSON.stringify(c));
          }
        } catch (e) {}
      }
      showToast('密码修改成功！下次登录请使用新密码');
      closeModal('change-password-modal');
    } else {
      showToast(data.error || '密码修改失败');
    }
  }).catch(function() {
    showToast('网络错误，请稍后重试');
  });
}

// ===== Modal helpers =====
function closeModal(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('show');
}

// ===== 同步加载提示（跨终端数据拉取时显示，避免用户误以为丢数据）=====
var _syncEl = null;
function _showSyncLoading(show) {
  if (!_syncEl) {
    _syncEl = document.createElement('div');
    _syncEl.id = 'sync-loading';
    _syncEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.95);padding:24px 36px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15);z-index:9999;text-align:center;font-size:15px;color:#333;display:none;';
    _syncEl.innerHTML = '<div style="font-size:18px;margin-bottom:8px;">🔄</div><div>正在同步学习数据...</div>';
    document.body.appendChild(_syncEl);
  }
  _syncEl.style.display = show ? 'block' : 'none';
}

// ===== Toast =====
function showToast(msg) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(function() { toast.classList.remove('show'); }, 2500);
}

// ===== Init =====
window.addEventListener('DOMContentLoaded', init);
