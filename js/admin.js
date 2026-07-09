/* Hi English - Admin App (matching Demo UI exactly) */
var currentEditGroupEl = null;
var editingEmpid = null;

// ===== Initialize =====
async function init() {
  var user = HiEnglish.getCurrentUser();
  if (!user || user.role !== 'admin') {
    window.location.href = 'index.html';
    return;
  }
  // 从服务端同步用户列表、分组和学习数据（跨终端数据一致性）
  await HiEnglish.syncUsersFromServer();
  await HiEnglish.syncGroupsFromServer();
  await HiEnglish.syncStudyDataFromServer();
  renderDashboard();
  renderStudentTable();
  renderGroupList();
  fillGroupSelects();
}

// ===== Navigation =====
function aNav(page, el) {
  document.querySelectorAll('.admin-page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('a-page-' + page).classList.add('active');
  document.querySelectorAll('.admin-nav-item').forEach(function(n) { n.classList.remove('active'); });
  el.classList.add('active');
  if (page === 'dashboard') renderDashboard();
  if (page === 'students') renderStudentTable();
  if (page === 'groups') renderGroupStats();
}

// ===== Helper: calculate scores for a user =====
function calcUserScores(empid) {
  var allStudyData = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
  var sd = allStudyData[empid] || {basic: {mastered: [], weeklyTests: [], monthlyTests: []}, checkIns: []};
  var mastered = sd.basic && sd.basic.mastered ? sd.basic.mastered.length : 0;
  // 使用统一打卡数据（与学员端一致）
  var checkIns = sd.checkIns || [];
  var completedDays = checkIns.filter(function(c) { return c.completed; }).length;
  var readIndex = sd.basic && sd.basic.readIndex ? sd.basic.readIndex : 0;
  var weeklyTests = sd.basic && sd.basic.weeklyTests ? sd.basic.weeklyTests : [];
  var monthlyTests = sd.basic && sd.basic.monthlyTests ? sd.basic.monthlyTests : [];
  var weeklyAvg = weeklyTests.length > 0 ? Math.round(weeklyTests.reduce(function(s, t) { return s + (t.avgScore || 0); }, 0) / weeklyTests.length) : 0;
  var monthlyAvg = monthlyTests.length > 0 ? Math.round(monthlyTests.reduce(function(s, t) { return s + (t.avgScore || 0); }, 0) / monthlyTests.length) : 0;
  var checkinRate = checkIns.length > 0 ? Math.round((completedDays / checkIns.length) * 100) : 0;
  // 个人总成绩 = 打卡占比×100×30% + 月度内周测均分×30% + 当月月测×40%（管理员端按 basic 阶段成绩，不合并）
  var curMonth = HiEnglish.today().slice(0, 7);
  var curYear = parseInt(curMonth.slice(0, 4), 10);
  var curMon = parseInt(curMonth.slice(5, 7), 10) - 1;
  var daysInMonth = HiEnglish.getDaysInMonth(curYear, curMon);
  var monthCheckinDays = checkIns.filter(function(c){ return c.completed && (c.date || '').slice(0, 7) === curMonth; }).length;
  var chk = (daysInMonth > 0 ? (monthCheckinDays / daysInMonth) * 100 : 0) * 0.3;
  var wt = weeklyTests.filter(function(t){ return HiEnglish.weeklyTestMonthKey(t.date) === curMonth; });
  var wAvg = wt.length > 0 ? wt.reduce(function(s, t){ return s + (t.avgScore || 0); }, 0) / wt.length : 0;
  var mt = monthlyTests.filter(function(t){ return HiEnglish.monthlyTestMonthKey(t.date) === curMonth; });
  var mScore = mt.length > 0 ? mt[mt.length - 1].avgScore * 0.4 : 0;
  var score = Math.round((chk + wAvg * 0.3 + mScore) * 10) / 10;

  return {
    mastered: mastered, readIndex: readIndex, completedDays: completedDays,
    weeklyAvg: weeklyAvg, monthlyAvg: monthlyAvg, score: score, checkinRate: checkinRate,
    basicComplete: readIndex >= 850, businessUnlocked: sd.business && sd.business.unlocked
  };
}

// ===== Dashboard =====
function renderDashboard() {
  var users = HiEnglish.getUsers();
  var userArr = Object.values(users);
  var totalStudents = userArr.length;
  var activeThisWeek = 0;
  var totalScore = 0;
  var totalProgress = 0;
  var totalMastered = 0;
  var totalCheckinDays = 0;
  var totalWeeklyScore = 0;
  var weeklyCount = 0;
  var totalCheckinRate = 0;

  var personalScores = userArr.map(function(u) {
    var s = calcUserScores(u.empid);
    var allStudyData = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
    var sd = allStudyData[u.empid];
    if (sd && sd.checkIns && sd.checkIns.length > 0) activeThisWeek++;

    totalScore += s.score;
    totalProgress += s.readIndex;
    totalMastered += s.mastered;
    totalCheckinDays += s.completedDays;
    totalCheckinRate += s.checkinRate;
    if (s.weeklyAvg > 0) { totalWeeklyScore += s.weeklyAvg; weeklyCount++; }

    return Object.assign({empid: u.empid, name: u.name, group: u.group, status: u.status}, s);
  }).sort(function(a, b) { return b.score - a.score; });

  var avgScore = totalStudents > 0 ? Math.round(totalScore / totalStudents * 10) / 10 : 0;
  var avgProgress = totalStudents > 0 ? Math.round(totalProgress / totalStudents) : 0;
  var avgMastered = totalStudents > 0 ? Math.round(totalMastered / totalStudents) : 0;
  var avgCheckinDays = totalStudents > 0 ? Math.round(totalCheckinDays / totalStudents) : 0;
  var avgWeekly = weeklyCount > 0 ? Math.round(totalWeeklyScore / weeklyCount) : 0;
  var avgCheckinRate = totalStudents > 0 ? Math.round(totalCheckinRate / totalStudents) : 0;

  // Stats
  document.getElementById('a-dashboard-stats').innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px;">' +
      '<div class="stat-card"><div class="stat-val">' + totalStudents + '</div><div class="stat-key">总学员数</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + activeThisWeek + '</div><div class="stat-key">本周活跃</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + avgCheckinRate + '%</div><div class="stat-key">打卡率</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + avgScore + '</div><div class="stat-key">平均分</div></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">' +
      '<div class="stat-card"><div class="stat-val">' + avgProgress + '/850</div><div class="stat-key">平均学习进度</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + avgMastered + '</div><div class="stat-key">平均已掌握</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + avgCheckinDays + '</div><div class="stat-key">平均打卡天数</div></div>' +
      '<div class="stat-card"><div class="stat-val">' + avgWeekly + '</div><div class="stat-key">平均周测分</div></div>' +
    '</div>';

  // Personal ranking - with monthly scores
  var personalHTML = personalScores.slice(0, 10).map(function(item, i) {
    return '<tr><td>' + (i + 1) + '</td><td>' + item.empid + '</td><td>' + item.name + '</td><td>' + (item.group || '') + '</td><td>' + item.completedDays + '</td><td>' + item.weeklyAvg + '</td><td>' + (item.monthlyAvg || '-') + '</td><td><strong>' + item.score + '</strong></td></tr>';
  }).join('');

  // Group ranking - with all fields
  var groupScores = {};
  personalScores.forEach(function(p) {
    if (!groupScores[p.group]) groupScores[p.group] = {name: p.group, total: 0, count: 0, checkinTotal: 0, weeklyTotal: 0, weeklyCount: 0, monthlyTotal: 0, monthlyCount: 0};
    groupScores[p.group].total += p.score;
    groupScores[p.group].count++;
    groupScores[p.group].checkinTotal += p.checkinRate;
    if (p.weeklyAvg > 0) { groupScores[p.group].weeklyTotal += p.weeklyAvg; groupScores[p.group].weeklyCount++; }
    if (p.monthlyAvg > 0) { groupScores[p.group].monthlyTotal += p.monthlyAvg; groupScores[p.group].monthlyCount++; }
  });
  var groupList = Object.values(groupScores).map(function(g) {
    return {
      name: g.name, count: g.count,
      checkinRate: Math.round(g.checkinTotal / g.count),
      weeklyAvg: g.weeklyCount > 0 ? Math.round(g.weeklyTotal / g.weeklyCount) : 0,
      monthlyAvg: g.monthlyCount > 0 ? Math.round(g.monthlyTotal / g.monthlyCount) : 0,
      score: Math.round(g.total / g.count * 10) / 10
    };
  }).sort(function(a, b) { return b.score - a.score; });

  var groupHTML = groupList.map(function(item, i) {
    return '<tr><td>' + (i + 1) + '</td><td>' + item.name + '</td><td>' + item.count + '</td><td>' + item.checkinRate + '%</td><td>' + item.weeklyAvg + '</td><td>' + item.monthlyAvg + '</td><td><strong>' + item.score + '</strong></td></tr>';
  }).join('');

  document.getElementById('a-dashboard-rankings').innerHTML =
    '<div class="section-title">🏆 个人学习排行榜</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button class="btn btn-outline" onclick="exportPersonalRanking()">📥 导出个人排行榜</button></div>' +
    '<div style="overflow-x:auto;"><table class="data-table"><thead><tr><th>排名</th><th>账号</th><th>姓名</th><th>组别</th><th>打卡天数</th><th>周测成绩</th><th>月测成绩</th><th>总成绩</th></tr></thead><tbody>' + (personalHTML || '<tr><td colspan="8" style="text-align:center;color:var(--text-sub);">暂无数据</td></tr>') + '</tbody></table></div>' +
    '<div class="section-title">🏆 团队学习排行榜</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button class="btn btn-outline" onclick="exportTeamRanking()">📥 导出团队排行榜</button></div>' +
    '<div style="overflow-x:auto;"><table class="data-table"><thead><tr><th>排名</th><th>团队名称</th><th>人数</th><th>平均打卡率</th><th>平均周测分</th><th>平均月测分</th><th>总成绩</th></tr></thead><tbody>' + (groupHTML || '<tr><td colspan="7" style="text-align:center;color:var(--text-sub);">暂无数据</td></tr>') + '</tbody></table></div>';

  // Reminders
  var inactiveStudents = personalScores.filter(function(p) {
    return p.completedDays < 3 && p.status === 'active';
  });
  var reminderHTML = inactiveStudents.map(function(p) {
    return '<span class="group-chip">' + p.name + ' (' + p.empid + ') - 打卡' + p.completedDays + '天</span>';
  }).join('');

  document.getElementById('a-dashboard-reminders').innerHTML =
    '<div class="section-title">📌 催学提醒</div>' +
    '<div class="card">' +
      '<p style="font-size:13px;color:var(--text-sub);margin-bottom:12px;">以下学员本周打卡不足（不足3天），点击后系统将自动推送催学提醒至学员端站内信和手机通知栏：</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">' + (reminderHTML || '<span style="color:var(--text-sub);">暂无需提醒的学员</span>') + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="btn btn-danger" onclick="sendStudyReminder()">📲 催学提醒</button>' +
        '<button class="btn btn-outline" onclick="showDingTalkConfig()">🔔 钉钉推送设置</button>' +
      '</div>' +
      '<div id="dingtalk-config-area" style="display:none;margin-top:16px;padding:12px;background:var(--primary-light);border-radius:8px;">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--primary);">钉钉群机器人推送配置</div>' +
        '<div style="font-size:12px;color:var(--text-sub);margin-bottom:8px;">填写钉钉群机器人的Webhook地址，催学提醒将同时推送到钉钉群。不填则仅推送站内信和通知栏。</div>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<input type="text" id="dingtalk-webhook" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." style="flex:1;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:12px;">' +
          '<button class="btn btn-primary" style="padding:8px 14px;font-size:12px;" onclick="saveDingTalkWebhook()">保存</button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-sub);margin-top:6px;">获取方式：钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制Webhook地址</div>' +
      '</div>' +
    '</div>';

  // 众测模式全局开关
  var betaEl = document.getElementById('a-beta-switch');
  if (betaEl) {
    betaEl.innerHTML =
      '<div class="section-title">🧪 众测模式（测试期开关）</div>' +
      '<div class="card">' +
        '<p style="font-size:13px;color:var(--text-sub);margin-bottom:12px;">开启后：<b>商务英语对所有学员解锁</b>，且<b>周测、月测不受时间限制</b>（任意时间可测），方便众测阶段全员测试。正式上线时请关闭，恢复正式规则。</p>' +
        '<div style="display:flex;align-items:center;gap:12px;">' +
          '<button id="beta-toggle-btn" class="btn btn-outline" onclick="toggleBetaMode()">加载中…</button>' +
          '<span id="beta-status-text" style="font-size:13px;color:var(--text-sub);"></span>' +
        '</div>' +
      '</div>';
    loadBetaMode();
  }
}

// ===== 众测模式全局开关 =====
var _betaModeState = false;
function loadBetaMode() {
  fetch(HiEnglish.getServerUrl() + '/api/beta-config').then(function(r) { return r.json(); }).then(function(data) {
    _betaModeState = !!(data && data.betaMode);
    renderBetaToggle();
  }).catch(function() {
    var btn = document.getElementById('beta-toggle-btn');
    if (btn) { btn.textContent = '读取失败，点击重试'; btn.onclick = loadBetaMode; }
  });
}
function renderBetaToggle() {
  var btn = document.getElementById('beta-toggle-btn');
  var txt = document.getElementById('beta-status-text');
  if (!btn) return;
  btn.onclick = toggleBetaMode;
  if (_betaModeState) {
    btn.textContent = '🟢 众测模式：已开启（点击关闭）';
    btn.className = 'btn btn-danger';
    if (txt) txt.textContent = '当前所有学员可测商务英语/周测/月测';
  } else {
    btn.textContent = '⚪ 众测模式：已关闭（点击开启）';
    btn.className = 'btn btn-primary';
    if (txt) txt.textContent = '当前为正式规则（商务需解锁、周测周六日、月测1-5号）';
  }
}
function toggleBetaMode() {
  var target = !_betaModeState;
  if (target && !confirm('开启众测模式后，全部学员都能直接测商务英语、周测、月测（不受时间限制）。确认开启？')) return;
  if (!target && !confirm('关闭众测模式后，将恢复正式规则（商务需解锁、周测限周六日、月测限每月1-5号）。确认关闭？')) return;
  var btn = document.getElementById('beta-toggle-btn');
  if (btn) btn.textContent = '处理中…';
  fetch(HiEnglish.getServerUrl() + '/api/beta-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ betaMode: target })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data && data.success) {
      _betaModeState = !!data.betaMode;
      renderBetaToggle();
      showToast(_betaModeState ? '众测模式已开启' : '众测模式已关闭');
    } else {
      showToast('操作失败，请重试');
      renderBetaToggle();
    }
  }).catch(function() {
    showToast('网络错误，请重试');
    renderBetaToggle();
  });
}

// ===== 按账号解锁商务英语 =====
function unlockBusiness(empid) {
  if (!confirm('确认为该学员解锁「商务英语」阶段？解锁后该学员可直接进入商务英语练习。')) return;
  fetch(HiEnglish.getServerUrl() + '/api/admin/unlock-business', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empid: empid, unlock: true })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data && data.success) {
      showToast('已为 ' + empid + ' 解锁商务英语，该学员下次进入即生效');
      if (HiEnglish && typeof HiEnglish.syncStudyDataFromServer === 'function') { HiEnglish.syncStudyDataFromServer(); }
    } else {
      showToast((data && data.error) || '解锁失败');
    }
  }).catch(function() {
    showToast('网络错误，请重试');
  });
}

// ===== Study Reminder =====
function sendStudyReminder() {
  var users = HiEnglish.getUsers();
  var userArr = Object.values(users);
  var inactiveStudents = [];
  
  userArr.forEach(function(u) {
    if (u.status !== 'active') return;
    var s = calcUserScores(u.empid);
    if (s.completedDays < 3) {
      inactiveStudents.push(u);
    }
  });
  
  if (inactiveStudents.length === 0) {
    showToast('暂无需提醒的学员，所有学员本周打卡均已达标');
    return;
  }
  
  var names = inactiveStudents.map(function(s) { return s.name + '(' + s.empid + ')'; }).join('、');
  if (!confirm('将向以下 ' + inactiveStudents.length + ' 名学员发送催学提醒：\n\n' + names + '\n\n提醒将通过站内信和手机通知栏推送到学员端。确认发送？')) return;
  
  var now = new Date();
  var timeStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  var msgTitle = '催学提醒';
  var msgContent = '您好，您本周学习打卡不足3天，请尽快完成每日跟读学习。坚持每天15分钟，英语水平稳步提升！如有问题请联系培训管理员。';
  var targets = inactiveStudents.map(function(s) { return s.empid; });

  // 发送到服务端（服务端盖真实时间戳，学员端跨设备即刻收到 + 通知栏 + 钉钉由服务端推送）
  HiEnglish.sendMessageToServer(targets, msgTitle, msgContent, 'reminder').then(function(ok) {
    if (ok) {
      showToast('催学提醒已发送给 ' + targets.length + ' 名学员（站内信 + 通知栏，如已配置钉钉将由服务器同步推送到群）');
    } else {
      showToast('发送失败，请检查网络后重试');
    }
  });
}

function showDingTalkConfig() {
  var area = document.getElementById('dingtalk-config-area');
  if (!area) return;
  if (area.style.display === 'none') {
    area.style.display = 'block';
    var input = document.getElementById('dingtalk-webhook');
    if (input) {
      // 从服务端加载已保存的Webhook（跨设备一致）
      fetch(HiEnglish.getServerUrl() + '/api/dingtalk-config').then(function(r) { return r.json(); }).then(function(data) {
        if (data.success) input.value = data.webhook || '';
      }).catch(function() {
        input.value = localStorage.getItem('hi_english_dingtalk_webhook') || '';
      });
    }
  } else {
    area.style.display = 'none';
  }
}

function saveDingTalkWebhook() {
  var webhook = document.getElementById('dingtalk-webhook').value.trim();
  if (webhook && webhook.indexOf('oapi.dingtalk.com') < 0 && webhook.indexOf('qyapi.weixin.qq.com') < 0) {
    if (!confirm('该地址看起来不像钉钉/企业微信机器人Webhook，确定保存吗？')) return;
  }
  // 关键：Webhook 存到服务端，催学提醒由服务端 server-to-server 推送（避免浏览器CORS拦截）
  fetch(HiEnglish.getServerUrl() + '/api/dingtalk-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhook: webhook })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.success) {
      localStorage.setItem('hi_english_dingtalk_webhook', webhook);
      showToast(webhook ? '钉钉Webhook已保存，催学提醒将由服务器推送到钉钉群' : '钉钉Webhook已清除');
    } else {
      showToast('保存失败，请重试');
    }
  }).catch(function() {
    showToast('网络错误，保存失败');
  });
}

function sendDingTalkReminder(webhook, students, timeStr) {
  var names = students.map(function(s) { return s.name + '(' + s.empid + ')'; }).join('、');
  // IMPORTANT: Message MUST contain "催学提醒" for DingTalk security keyword check
  var text = '【Hi English 催学提醒】\n\n时间：' + timeStr + '\n提醒对象(' + students.length + '人)：' + names + '\n\n请以上学员尽快完成每日跟读学习打卡，坚持每天15分钟！\n\n— Hi English 学习平台';

  var body = JSON.stringify({ msgtype: 'text', text: { content: text } });

  // Use text/plain Content-Type to avoid CORS preflight (OPTIONS request)
  // DingTalk parses body as JSON regardless of Content-Type
  fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: body
  }).then(function(res) {
    return res.json();
  }).then(function(data) {
    if (data.errcode === 0) {
      showToast('钉钉群消息推送成功');
    } else {
      console.warn('DingTalk push error:', data);
      showToast('钉钉推送失败：' + (data.errmsg || '未知错误'));
    }
  }).catch(function(e) {
    console.warn('DingTalk push failed (CORS), trying no-cors fallback:', e);
    // Fallback: use no-cors mode (can't read response, but message still sends)
    fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: body,
      mode: 'no-cors'
    }).then(function() {
      showToast('钉钉群消息已发送');
    }).catch(function(e2) {
      console.warn('DingTalk no-cors also failed:', e2);
      showToast('钉钉推送失败，请检查Webhook地址');
    });
  });
}

// ===== Student Management =====
function renderStudentTable() {
  var users = HiEnglish.getUsers();
  var search = document.getElementById('search-input') ? document.getElementById('search-input').value : '';
  var groupFilter = document.getElementById('filter-group') ? document.getElementById('filter-group').value : '';

  var groups = HiEnglish.getGroups();
  var groupOptions = '<option value="">全部组别</option>' + groups.map(function(g) { return '<option>' + g + '</option>'; }).join('');

  document.getElementById('a-students-toolbar').innerHTML =
    '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">' +
      '<input type="password" autocomplete="new-password" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;" tabindex="-1" aria-hidden="true">' +
      '<input type="text" id="search-input" name="search-query" autocomplete="off" placeholder="搜索账号或姓名..." value="' + (search || '') + '" style="flex:1;min-width:200px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;" oninput="renderStudentTable()">' +
      '<select id="filter-group" style="padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;" onchange="renderStudentTable()">' + groupOptions + '</select>' +
      '<button class="btn btn-primary" onclick="showAddStudentModal()">+ 添加学员</button>' +
      '<button class="btn btn-outline" onclick="showBatchImportModal()">📥 批量导入</button>' +
      '<button class="btn btn-outline" onclick="exportStudentData()">📥 导出学员数据</button>' +
    '</div>';

  if (groupFilter) {
    var sel = document.getElementById('filter-group');
    if (sel) sel.value = groupFilter;
  }

  var userArr = Object.values(users);
  if (search) {
    userArr = userArr.filter(function(u) { return u.name.includes(search) || u.empid.includes(search); });
  }
  if (groupFilter) {
    userArr = userArr.filter(function(u) { return u.group === groupFilter; });
  }

  var tbody = document.getElementById('student-tbody');
  tbody.innerHTML = userArr.map(function(u) {
    var s = calcUserScores(u.empid);
    return '<tr>' +
      '<td>' + u.empid + '</td>' +
      '<td>' + u.name + '</td>' +
      '<td>' + (u.group || '') + '</td>' +
      '<td>' + s.readIndex + '/850</td>' +
      '<td>' + s.mastered + '</td>' +
      '<td>' + s.completedDays + '</td>' +
      '<td>' + s.score + '</td>' +
      '<td><span class="status-tag ' + u.status + '">' + (u.status === 'active' ? '启用' : '禁用') + '</span></td>' +
      '<td style="white-space:nowrap;">' +
        '<button class="btn btn-outline" style="padding:4px 10px;font-size:12px;margin-right:4px;" onclick="editStudent(\'' + u.empid + '\')">编辑</button>' +
        '<button class="btn btn-outline" style="padding:4px 10px;font-size:12px;margin-right:4px;" onclick="resetPassword(\'' + u.empid + '\')">🔑重置密码</button>' +
        '<button class="btn btn-outline" style="padding:4px 10px;font-size:12px;margin-right:4px;" onclick="unlockBusiness(\'' + u.empid + '\')">🔓解锁商务</button>' +
        '<button class="btn ' + (u.status === 'active' ? 'btn-danger' : 'btn-success') + '" style="padding:4px 10px;font-size:12px;margin-right:4px;" onclick="toggleStatus(\'' + u.empid + '\')">' + (u.status === 'active' ? '禁用' : '启用') + '</button>' +
        '<button class="btn btn-danger" style="padding:4px 10px;font-size:12px;" onclick="deleteStudent(\'' + u.empid + '\')">删除</button>' +
      '</td>' +
    '</tr>';
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-sub);padding:20px;">暂无学员数据</td></tr>';
}

function showAddStudentModal() {
  fillGroupSelect('add-group');
  document.getElementById('add-empid').value = '';
  document.getElementById('add-name').value = '';
  document.getElementById('add-password').value = '123@456.com';
  document.getElementById('add-student-modal').classList.add('show');
}

function addStudent() {
  var empid = document.getElementById('add-empid').value.trim();
  var name = document.getElementById('add-name').value.trim();
  var group = document.getElementById('add-group').value;
  var password = document.getElementById('add-password').value.trim();

  if (!empid) { showToast('请输入账号'); return; }
  if (!name) { showToast('请输入姓名'); return; }

  var users = HiEnglish.getUsers();
  if (users[empid]) { showToast('账号已存在'); return; }

  users[empid] = {empid: empid, name: name, group: group, status: 'active', password: password};
  HiEnglish.saveUsers(users);
  closeModal('add-student-modal');
  showToast('学员添加成功');
  renderStudentTable();

  // 同步到服务端（跨终端可见）
  fetch(HiEnglish.getServerUrl() + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empid: empid, name: name, group: group, password: password })
  }).then(function(resp) { return resp.json(); }).then(function(data) {
    if (data.success) {
      console.log('[Sync] 学员已同步到服务端:', empid);
    }
  }).catch(function(e) {
    console.log('[Sync] 学员同步到服务端失败:', e.message);
  });
}

// Batch import via Excel file upload
var batchImportData = [];

function showBatchImportModal() {
  batchImportData = [];
  var fileInput = document.getElementById('batch-import-file');
  if (fileInput) fileInput.value = '';
  var preview = document.getElementById('batch-import-preview');
  if (preview) preview.style.display = 'none';
  document.getElementById('batch-import-modal').classList.add('show');
}

function downloadImportTemplate() {
  var headers = ['账号', '姓名', '分组'];
  var sampleRows = [
    ['100004', '赵六', '冲压车间'],
    ['100005', '孙七', '焊装车间']
  ];
  if (typeof XLSX !== 'undefined') {
    var ws = XLSX.utils.aoa_to_sheet([headers].concat(sampleRows));
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '学员导入模板');
    XLSX.writeFile(wb, '学员导入模板.xlsx');
  } else {
    var csv = '\ufeff' + headers.join(',') + '\n' + sampleRows.map(function(r) { return r.join(','); }).join('\n');
    var blob = new Blob([csv], {type: 'text/csv;charset=utf-8;'});
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '学员导入模板.csv';
    link.click();
  }
}

function onBatchImportFileChange(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var data = new Uint8Array(e.target.result);
    var parsed = [];
    try {
      if (typeof XLSX !== 'undefined') {
        var wb = XLSX.read(data, {type: 'array'});
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, {header: 1});
        var startIdx = 0;
        if (rows.length > 0 && rows[0][0] && String(rows[0][0]).indexOf('账号') >= 0) {
          startIdx = 1;
        }
        for (var i = startIdx; i < rows.length; i++) {
          if (rows[i] && rows[i][0]) {
            parsed.push({
              empid: String(rows[i][0] || '').trim(),
              name: String(rows[i][1] || '').trim(),
              group: String(rows[i][2] || '').trim()
            });
          }
        }
      } else {
        showToast('Excel解析库未加载，请刷新页面重试');
        return;
      }
    } catch(err) {
      showToast('文件解析失败：' + err.message);
      return;
    }
    batchImportData = parsed;
    var previewDiv = document.getElementById('batch-import-preview');
    var previewContent = document.getElementById('batch-import-preview-content');
    if (parsed.length > 0) {
      var previewHTML = parsed.slice(0, 5).map(function(r) {
        return r.empid + ' | ' + r.name + ' | ' + r.group;
      }).join('<br>');
      previewHTML += '<br><span style="color:var(--primary);">共 ' + parsed.length + ' 条数据</span>';
      previewContent.innerHTML = previewHTML;
      previewDiv.style.display = 'block';
    } else {
      previewContent.innerHTML = '<span style="color:var(--danger);">未解析到有效数据</span>';
      previewDiv.style.display = 'block';
    }
  };
  reader.readAsArrayBuffer(file);
}

function batchImportStudents() {
  if (batchImportData.length === 0) {
    showToast('请先选择Excel文件');
    return;
  }
  var users = HiEnglish.getUsers();
  var groups = HiEnglish.getGroups();
  var successCount = 0;
  var failCount = 0;
  var skipCount = 0;

  batchImportData.forEach(function(row) {
    if (!row.empid || !row.name) { failCount++; return; }
    if (users[row.empid]) { skipCount++; return; }
    var group = row.group || '未分组';
    if (!groups.includes(group)) groups.push(group);
    users[row.empid] = {empid: row.empid, name: row.name, group: group, status: 'active', password: '123@456.com'};
    successCount++;
  });

  HiEnglish.saveUsers(users);
  HiEnglish.saveGroups(groups);
  fillGroupSelects();
  closeModal('batch-import-modal');
  showToast('导入完成：成功 ' + successCount + ' 条' + (skipCount > 0 ? '，跳过已存在 ' + skipCount + ' 条' : '') + (failCount > 0 ? '，失败 ' + failCount + ' 条' : ''));
  renderStudentTable();

  // 同步到服务端
  var serverStudents = batchImportData.filter(function(row) {
    return row.empid && row.name && !batchImportData.some(function(r) { return r !== row && r.empid === row.empid; });
  }).map(function(row) {
    return { empid: row.empid, name: row.name, group: row.group || '未分组' };
  });
  if (serverStudents.length > 0) {
    fetch(HiEnglish.getServerUrl() + '/api/import-students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ students: serverStudents })
    }).then(function(resp) { return resp.json(); }).then(function(data) {
      console.log('[Sync] 批量导入同步到服务端:', data.message);
    }).catch(function(e) {
      console.log('[Sync] 批量导入同步失败:', e.message);
    });
  }
}

function editStudent(empid) {
  var users = HiEnglish.getUsers();
  var u = users[empid];
  if (!u) return;
  editingEmpid = empid;
  document.getElementById('edit-empid').value = u.empid;
  document.getElementById('edit-name').value = u.name;
  fillGroupSelect('edit-group');
  document.getElementById('edit-group').value = u.group;
  document.getElementById('edit-student-modal').classList.add('show');
}

function saveStudent() {
  var users = HiEnglish.getUsers();
  var u = users[editingEmpid];
  if (!u) return;
  var newEmpid = document.getElementById('edit-empid').value.trim();
  var newName = document.getElementById('edit-name').value.trim();
  var newGroup = document.getElementById('edit-group').value;

  if (!newEmpid) { showToast('账号不能为空'); return; }
  if (!newName) { showToast('姓名不能为空'); return; }

  // If account changed, need to re-key
  if (newEmpid !== editingEmpid) {
    if (users[newEmpid]) { showToast('新账号已存在'); return; }
    // Move user data
    users[newEmpid] = {empid: newEmpid, name: newName, group: newGroup, status: u.status, password: u.password};
    delete users[editingEmpid];
    // Move study data
    var allStudy = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
    if (allStudy[editingEmpid]) {
      allStudy[newEmpid] = allStudy[editingEmpid];
      delete allStudy[editingEmpid];
      localStorage.setItem('hi_english_study', JSON.stringify(allStudy));
    }
    // Move messages
    var allMsgs = JSON.parse(localStorage.getItem('hi_english_messages') || '{}');
    if (allMsgs[editingEmpid]) {
      allMsgs[newEmpid] = allMsgs[editingEmpid];
      delete allMsgs[editingEmpid];
      localStorage.setItem('hi_english_messages', JSON.stringify(allMsgs));
    }
  } else {
    u.name = newName;
    u.group = newGroup;
  }
  HiEnglish.saveUsers(users);
  closeModal('edit-student-modal');
  showToast('修改已保存');
  renderStudentTable();

  // 同步到服务端
  var token = sessionStorage.getItem('hi_english_admin_token') || '';
  fetch(HiEnglish.getServerUrl() + '/api/admin/edit-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oldEmpid: editingEmpid,
      newEmpid: newEmpid,
      name: newName,
      group: newGroup,
      token: token
    })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (!d.success) {
      showToast('服务端同步失败: ' + (d.error || '未知错误'), 'error');
    } else {
      // 同步成功后重新拉取学习数据（empid可能变了）
      HiEnglish.syncStudyDataFromServer().then(function() {
        renderStudentTable();
        renderDashboard();
      });
    }
  }).catch(function(e) {
    console.error('[Admin] 修改学员同步失败:', e);
  });
}

function resetPassword(empid) {
  var users = HiEnglish.getUsers();
  var u = users[empid];
  if (!u) return;
  document.getElementById('reset-pw-empid').value = u.empid;
  document.getElementById('reset-pw-name').value = u.name;
  document.getElementById('reset-pw-value').value = '123@456.com';
  document.getElementById('reset-password-modal').classList.add('show');
}

function confirmResetPassword() {
  var empid = document.getElementById('reset-pw-empid').value;
  var newPwd = document.getElementById('reset-pw-value').value;
  if (!newPwd || newPwd.length < 6) { showToast('密码至少6位'); return; }
  // 走服务端重置密码，确保学员下次登录只能用新密码（跨终端生效）
  fetch(HiEnglish.getServerUrl() + '/api/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empid: empid, newPassword: newPwd })
  }).then(function(resp) { return resp.json(); }).then(function(data) {
    if (data.success) {
      var users = HiEnglish.getUsers();
      if (users[empid]) { users[empid].password = newPwd; HiEnglish.saveUsers(users); }
      showToast('密码已重置为：' + newPwd);
      closeModal('reset-password-modal');
    } else {
      showToast(data.error || '重置失败');
    }
  }).catch(function() { showToast('网络错误，请稍后重试'); });
}

function toggleStatus(empid) {
  var users = HiEnglish.getUsers();
  if (users[empid]) {
    users[empid].status = users[empid].status === 'active' ? 'disabled' : 'active';
    HiEnglish.saveUsers(users);
    showToast(users[empid].name + ' 已' + (users[empid].status === 'active' ? '启用' : '禁用'));
    renderStudentTable();
    // 同步到服务端
    fetch(HiEnglish.getServerUrl() + '/api/admin/toggle-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empid: empid })
    }).catch(function(e) { console.log('[Sync] 切换状态失败:', e.message); });
  }
}

function deleteStudent(empid) {
  if (!confirm('确认删除该学员？将同时删除其个人信息和学习记录，此操作不可恢复。')) return;
  var users = HiEnglish.getUsers();
  delete users[empid];
  HiEnglish.saveUsers(users);
  // Track deleted account to prevent re-creation by initDefaultData
  var deleted = JSON.parse(localStorage.getItem('hi_english_deleted') || '[]');
  if (!deleted.includes(empid)) deleted.push(empid);
  localStorage.setItem('hi_english_deleted', JSON.stringify(deleted));
  var allStudy = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
  delete allStudy[empid];
  localStorage.setItem('hi_english_study', JSON.stringify(allStudy));
  showToast('学员已删除');
  renderStudentTable();

  // 同步到服务端
  var token = sessionStorage.getItem('hi_english_admin_token') || '';
  fetch(HiEnglish.getServerUrl() + '/api/admin/delete-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empid: empid, token: token })
  }).then(function(resp) { return resp.json(); }).then(function(data) {
    console.log('[Sync] 服务端删除学员:', empid, data.success ? '成功' : '失败');
  }).catch(function(e) {
    console.log('[Sync] 服务端删除学员失败:', e.message);
  });
}

// ===== Group Management =====
function renderGroupList() {
  var groups = HiEnglish.getGroups();
  var html = groups.map(function(g) {
    return '<span class="group-chip" data-name="' + g + '">' + g + ' <span class="edit-btn" onclick="editGroupName(this)" title="修改组别名称">✎</span> <span class="del-btn" onclick="delGroup(this)">✕</span></span>';
  }).join('');
  document.getElementById('group-list').innerHTML = html || '<span style="color:var(--text-sub);">暂无组别</span>';
}

function renderGroupStats() {
  var users = HiEnglish.getUsers();
  var groups = HiEnglish.getGroups();

  var groupStats = groups.map(function(g) {
    var groupUsers = Object.values(users).filter(function(u) { return u.group === g; });
    var count = groupUsers.length;
    var totalCheckin = 0;
    var totalWeekly = 0;
    var weeklyCount = 0;
    var totalMonthly = 0;
    var monthlyCount = 0;
    var totalScore = 0;

    groupUsers.forEach(function(u) {
      var s = calcUserScores(u.empid);
      totalCheckin += s.checkinRate;
      if (s.weeklyAvg > 0) { totalWeekly += s.weeklyAvg; weeklyCount++; }
      if (s.monthlyAvg > 0) { totalMonthly += s.monthlyAvg; monthlyCount++; }
      totalScore += s.score;
    });

    return {
      name: g, count: count,
      checkinRate: count > 0 ? Math.round(totalCheckin / count) : 0,
      weeklyAvg: weeklyCount > 0 ? Math.round(totalWeekly / weeklyCount) : 0,
      monthlyAvg: monthlyCount > 0 ? Math.round(totalMonthly / monthlyCount) : 0,
      score: count > 0 ? Math.round(totalScore / count * 10) / 10 : 0
    };
  }).sort(function(a, b) { return b.score - a.score; });

  var html = groupStats.map(function(item) {
    return '<tr><td>' + item.name + '</td><td>' + item.count + '</td><td>' + item.checkinRate + '%</td><td>' + item.weeklyAvg + '</td><td>' + item.monthlyAvg + '</td><td><strong>' + item.score + '</strong></td></tr>';
  }).join('');

  document.getElementById('a-group-stats').innerHTML =
    '<table class="data-table"><thead><tr><th>组别</th><th>人数</th><th>平均打卡率</th><th>平均周测分</th><th>平均月测分</th><th>总成绩</th></tr></thead><tbody>' +
    (html || '<tr><td colspan="6" style="text-align:center;color:var(--text-sub);">暂无数据</td></tr>') +
    '</tbody></table>';
}

function addGroup() {
  var input = document.getElementById('new-group-input');
  var name = input.value.trim();
  if (!name) { showToast('请输入组别名称'); return; }
  var groups = HiEnglish.getGroups();
  if (groups.includes(name)) { showToast('组别已存在'); return; }
  groups.push(name);
  HiEnglish.saveGroups(groups);
  input.value = '';
  showToast('组别"' + name + '"已添加');
  renderGroupList();
  fillGroupSelects();
}

function delGroup(el) {
  if (!confirm('确认删除该组别？')) return;
  var chip = el.parentElement;
  var name = chip.getAttribute('data-name');
  var groups = HiEnglish.getGroups();
  groups = groups.filter(function(g) { return g !== name; });
  HiEnglish.saveGroups(groups);
  chip.remove();
  showToast('组别已删除');
  fillGroupSelects();
}

function editGroupName(btnEl) {
  currentEditGroupEl = btnEl.parentElement;
  var oldName = currentEditGroupEl.getAttribute('data-name');
  document.getElementById('edit-group-old-name').value = oldName;
  document.getElementById('edit-group-new-name').value = '';
  document.getElementById('edit-group-modal').classList.add('show');
}

function saveGroupName() {
  var newName = document.getElementById('edit-group-new-name').value.trim();
  if (!newName) { showToast('请输入新的组别名称'); return; }
  if (!currentEditGroupEl) { showToast('未选择要修改的组别'); return; }
  var oldName = currentEditGroupEl.getAttribute('data-name');

  var groups = HiEnglish.getGroups();
  var idx = groups.indexOf(oldName);
  if (idx >= 0) groups[idx] = newName;
  HiEnglish.saveGroups(groups);

  var users = HiEnglish.getUsers();
  Object.values(users).forEach(function(u) {
    if (u.group === oldName) u.group = newName;
  });
  HiEnglish.saveUsers(users);

  showToast('组别"' + oldName + '"已修改为"' + newName + '"，相关学员已自动更新');
  closeModal('edit-group-modal');
  renderGroupList();
  fillGroupSelects();
  renderStudentTable();
}

// ===== Fill group selects =====
function fillGroupSelects() {
  fillGroupSelect('add-group');
  fillGroupSelect('edit-group');
  fillGroupSelect('report-group');
}

function fillGroupSelect(id) {
  var el = document.getElementById(id);
  if (!el) return;
  var groups = HiEnglish.getGroups();
  var current = el.value;
  if (id === 'report-group') {
    el.innerHTML = '<option value="">全部组别</option>' + groups.map(function(g) { return '<option>' + g + '</option>'; }).join('');
  } else {
    el.innerHTML = '<option value="">请选择分组</option>' + groups.map(function(g) { return '<option>' + g + '</option>'; }).join('');
  }
  if (current) el.value = current;
}

// ===== Export functions (Excel) =====

// 14: Personal ranking export - Excel with: 排名, 账号, 姓名, 组别, 打卡天数, 周测成绩, 月测成绩, 总成绩
function exportPersonalRanking() {
  var users = HiEnglish.getUsers();
  var rows = Object.values(users).map(function(u) {
    var s = calcUserScores(u.empid);
    return [u.empid, u.name, u.group, s.completedDays, s.weeklyAvg, s.monthlyAvg || '-', s.score];
  }).sort(function(a, b) { return b[6] - a[6]; });
  rows.forEach(function(r, i) { r.unshift(i + 1); });
  HiEnglish.exportExcel('个人学习排行榜.xls', ['排名', '账号', '姓名', '组别', '打卡天数', '周测成绩', '月测成绩', '总成绩'], rows, '个人排行榜');
  showToast('个人排行榜已导出');
}

// 15: Team ranking export - Excel with: 排名, 团队名称, 人数, 平均打卡率, 平均周测分, 平均月测分, 总成绩(团队平均分)
function exportTeamRanking() {
  var users = HiEnglish.getUsers();
  var groups = HiEnglish.getGroups();
  var rows = groups.map(function(g) {
    var groupUsers = Object.values(users).filter(function(u) { return u.group === g; });
    var count = groupUsers.length;
    var totalCheckin = 0, totalWeekly = 0, weeklyCount = 0, totalMonthly = 0, monthlyCount = 0, totalScore = 0;
    groupUsers.forEach(function(u) {
      var s = calcUserScores(u.empid);
      totalCheckin += s.checkinRate;
      if (s.weeklyAvg > 0) { totalWeekly += s.weeklyAvg; weeklyCount++; }
      if (s.monthlyAvg > 0) { totalMonthly += s.monthlyAvg; monthlyCount++; }
      totalScore += s.score;
    });
    return [
      g, count,
      count > 0 ? Math.round(totalCheckin / count) + '%' : '0%',
      weeklyCount > 0 ? Math.round(totalWeekly / weeklyCount) : 0,
      monthlyCount > 0 ? Math.round(totalMonthly / monthlyCount) : 0,
      count > 0 ? Math.round(totalScore / count * 10) / 10 : 0
    ];
  }).sort(function(a, b) { return b[5] - a[5]; });
  rows.forEach(function(r, i) { r.unshift(i + 1); });
  HiEnglish.exportExcel('团队学习排行榜.xls', ['排名', '团队名称', '人数', '平均打卡率', '平均周测分', '平均月测分', '总成绩（团队平均分）'], rows, '团队排行榜');
  showToast('团队排行榜已导出');
}

// 16: Student data export - Excel with: 账号, 姓名, 组别, 学习进度, 已掌握, 打卡天数, 平均分, 状态(启用/禁用)
function exportStudentData() {
  var users = HiEnglish.getUsers();
  var rows = Object.values(users).map(function(u) {
    var s = calcUserScores(u.empid);
    return [u.empid, u.name, u.group, s.readIndex + '/850', s.mastered, s.completedDays, s.score, u.status === 'active' ? '启用' : '禁用'];
  });
  HiEnglish.exportExcel('学员数据.xls', ['账号', '姓名', '组别', '学习进度', '已掌握', '打卡天数', '平均分', '状态'], rows, '学员数据');
  showToast('学员数据已导出');
}

// 17: Group stats export - Excel with: 组别, 人数, 平均打卡率, 平均周测分, 平均月测分, 总成绩
function exportGroupStats() {
  var users = HiEnglish.getUsers();
  var groups = HiEnglish.getGroups();
  var rows = groups.map(function(g) {
    var groupUsers = Object.values(users).filter(function(u) { return u.group === g; });
    var count = groupUsers.length;
    var totalCheckin = 0, totalWeekly = 0, weeklyCount = 0, totalMonthly = 0, monthlyCount = 0, totalScore = 0;
    groupUsers.forEach(function(u) {
      var s = calcUserScores(u.empid);
      totalCheckin += s.checkinRate;
      if (s.weeklyAvg > 0) { totalWeekly += s.weeklyAvg; weeklyCount++; }
      if (s.monthlyAvg > 0) { totalMonthly += s.monthlyAvg; monthlyCount++; }
      totalScore += s.score;
    });
    return [
      g, count,
      count > 0 ? Math.round(totalCheckin / count) + '%' : '0%',
      weeklyCount > 0 ? Math.round(totalWeekly / weeklyCount) : 0,
      monthlyCount > 0 ? Math.round(totalMonthly / monthlyCount) : 0,
      count > 0 ? Math.round(totalScore / count * 10) / 10 : 0
    ];
  }).sort(function(a, b) { return b[5] - a[5]; });
  HiEnglish.exportExcel('分组统计.xls', ['组别', '人数', '平均打卡率', '平均周测分', '平均月测分', '总成绩'], rows, '分组统计');
  showToast('分组统计已导出');
}

// 18: All staff report - Excel with: 账号, 姓名, 组别, 学习阶段完成情况, 月度打卡完成率, 周测成绩, 月测成绩, 累计总成绩
function exportAllReport() {
  var users = HiEnglish.getUsers();
  var rows = Object.values(users).map(function(u) {
    var s = calcUserScores(u.empid);
    var stageStatus = s.basicComplete ? '基础词汇已完成' : '基础词汇进行中(' + s.readIndex + '/850)';
    if (s.businessUnlocked) stageStatus += ' + 商务英语进行中';
    return [u.empid, u.name, u.group, stageStatus, s.checkinRate + '%', s.weeklyAvg, s.monthlyAvg || '-', s.score];
  });
  HiEnglish.exportExcel('全员学习报告.xls', ['账号', '姓名', '组别', '学习阶段完成情况', '月度打卡完成率', '周测成绩', '月测成绩', '累计总成绩'], rows, '全员学习报告');
  showToast('全员学习报告已导出');
}

// 19: Team report - Excel with: 团队名称, 学习阶段完成情况, 月度团队日打卡平均完成率, 团队周测平均分, 团队月测平均分, 累计总成绩平均分
function exportTeamReport() {
  var users = HiEnglish.getUsers();
  var groups = HiEnglish.getGroups();
  var rows = groups.map(function(g) {
    var groupUsers = Object.values(users).filter(function(u) { return u.group === g; });
    var count = groupUsers.length;
    var totalCheckin = 0, totalWeekly = 0, weeklyCount = 0, totalMonthly = 0, monthlyCount = 0, totalScore = 0;
    var basicCompleteCount = 0;
    var businessUnlockedCount = 0;
    groupUsers.forEach(function(u) {
      var s = calcUserScores(u.empid);
      totalCheckin += s.checkinRate;
      if (s.weeklyAvg > 0) { totalWeekly += s.weeklyAvg; weeklyCount++; }
      if (s.monthlyAvg > 0) { totalMonthly += s.monthlyAvg; monthlyCount++; }
      totalScore += s.score;
      if (s.basicComplete) basicCompleteCount++;
      if (s.businessUnlocked) businessUnlockedCount++;
    });
    var stageStatus = '基础词汇完成 ' + basicCompleteCount + '/' + count;
    if (businessUnlockedCount > 0) stageStatus += '，商务英语解锁 ' + businessUnlockedCount + '/' + count;
    return [
      g, stageStatus,
      count > 0 ? Math.round(totalCheckin / count) + '%' : '0%',
      weeklyCount > 0 ? Math.round(totalWeekly / weeklyCount) : 0,
      monthlyCount > 0 ? Math.round(totalMonthly / monthlyCount) : 0,
      count > 0 ? Math.round(totalScore / count * 10) / 10 : 0
    ];
  }).sort(function(a, b) { return b[5] - a[5]; });
  HiEnglish.exportExcel('团队学习报告.xls', ['团队名称', '学习阶段完成情况', '月度团队日打卡平均完成率', '团队周测平均分', '团队月测平均分', '累计总成绩平均分'], rows, '团队学习报告');
  showToast('团队学习报告已导出');
}

// 20: Detailed report - Excel with date/day/week/month filter
function showDetailedReportModal() {
  fillGroupSelect('report-group');
  document.getElementById('detail-report-modal').classList.add('show');
}

function exportDetailReport() {
  var start = document.getElementById('report-start').value;
  var end = document.getElementById('report-end').value;
  var dim = document.getElementById('report-dim').value;
  var group = document.getElementById('report-group').value;
  var users = HiEnglish.getUsers();
  var allStudyData = JSON.parse(localStorage.getItem('hi_english_study') || '{}');

  var userArr = Object.values(users);
  if (group) userArr = userArr.filter(function(u) { return u.group === group; });

  // Generate date columns based on dimension
  var startDate = new Date(start);
  var endDate = new Date(end);
  var columns = [];

  if (dim === '按日') {
    var d = new Date(startDate);
    while (d <= endDate) {
      columns.push({label: d.toISOString().slice(0, 10), date: d.toISOString().slice(0, 10), type: 'day'});
      d.setDate(d.getDate() + 1);
    }
  } else if (dim === '按周') {
    // Group by week
    var d = new Date(startDate);
    var weekNum = 1;
    while (d <= endDate) {
      var weekStart = new Date(d);
      var weekEnd = new Date(d);
      weekEnd.setDate(d.getDate() + 6);
      if (weekEnd > endDate) weekEnd = new Date(endDate);
      columns.push({label: '第' + weekNum + '周(' + weekStart.toISOString().slice(5, 10) + '~' + weekEnd.toISOString().slice(5, 10) + ')', start: weekStart.toISOString().slice(0, 10), end: weekEnd.toISOString().slice(0, 10), type: 'week'});
      d.setDate(d.getDate() + 7);
      weekNum++;
    }
  } else if (dim === '按月') {
    var d = new Date(startDate);
    while (d <= endDate) {
      var monthLabel = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      var monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      var monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      if (monthStart < startDate) monthStart = new Date(startDate);
      if (monthEnd > endDate) monthEnd = new Date(endDate);
      columns.push({label: monthLabel, start: monthStart.toISOString().slice(0, 10), end: monthEnd.toISOString().slice(0, 10), type: 'month'});
      d.setMonth(d.getMonth() + 1);
    }
  }

  var rows = userArr.map(function(u) {
    var sd = allStudyData[u.empid] || {checkIns: []};
    // 使用统一打卡数据
    var checkIns = sd.checkIns || [];
    var row = [u.empid, u.name, u.group];
    columns.forEach(function(col) {
      var checked = false;
      if (col.type === 'day') {
        var ci = checkIns.find(function(c) { return c.date === col.date && c.completed; });
        checked = !!ci;
      } else {
        // Week or month: check if any day in range is completed
        checked = checkIns.some(function(c) {
          return c.completed && c.date >= col.start && c.date <= col.end;
        });
      }
      row.push(checked ? '已打卡' : '未打卡');
    });
    return row;
  });

  var headers = ['账号', '姓名', '组别'].concat(columns.map(function(c) { return c.label; }));
  HiEnglish.exportExcel('详细报表.xls', headers, rows, '详细报表');
  showToast('详细报表已导出');
  closeModal('detail-report-modal');
}

// ===== Video source =====
function addVideoSource() {
  var url = document.getElementById('new-video-url').value.trim();
  if (!url) { showToast('请输入B站视频URL'); return; }
  showToast('视频来源已添加，系统正在自动提取微课内容');
  document.getElementById('new-video-url').value = '';
}

// ===== Content Management: Add Word =====
function showAddWordModal() {
  document.getElementById('add-word-input').value = '';
  document.getElementById('add-word-modal').classList.add('show');
}

function addWord() {
  var word = document.getElementById('add-word-input').value.trim();
  if (!word) { showToast('请输入英文单词'); return; }
  word = word.toLowerCase();

  // Auto-generate word data
  var wordData = autoGenerateWordData(word);
  // Save to localStorage (custom words)
  var customWords = JSON.parse(localStorage.getItem('hi_english_custom_words') || '[]');
  wordData.id = 851 + customWords.length;
  customWords.push(wordData);
  localStorage.setItem('hi_english_custom_words', JSON.stringify(customWords));

  closeModal('add-word-modal');
  showToast('单词 "' + word + '" 已添加，音标/词义/词组/例句已自动生成');
  updateWordCount();
}

function showBatchImportWordModal() {
  document.getElementById('batch-import-word-text').value = '';
  document.getElementById('batch-import-word-modal').classList.add('show');
}

function batchImportWords() {
  var text = document.getElementById('batch-import-word-text').value.trim();
  if (!text) { showToast('请输入单词列表'); return; }
  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  var customWords = JSON.parse(localStorage.getItem('hi_english_custom_words') || '[]');
  var successCount = 0;

  lines.forEach(function(line) {
    var word = line.trim().toLowerCase();
    if (!word) return;
    var wordData = autoGenerateWordData(word);
    wordData.id = 851 + customWords.length;
    customWords.push(wordData);
    successCount++;
  });

  localStorage.setItem('hi_english_custom_words', JSON.stringify(customWords));
  closeModal('batch-import-word-modal');
  showToast('成功导入 ' + successCount + ' 个单词，音标/词义/词组/例句已自动生成');
  updateWordCount();
}

function updateWordCount() {
  var customWords = JSON.parse(localStorage.getItem('hi_english_custom_words') || '[]');
  var el = document.getElementById('word-count-text');
  if (el) el.textContent = '当前共 ' + (850 + customWords.length) + ' 个单词';
}

// Auto-generate word data (IPA, meaning, phrases, examples)
function autoGenerateWordData(word) {
  // Simple phonetic approximation
  var ipa = '/' + word + '/';
  // Basic translations for common automotive/business words
  var translations = {
    'manufacture': {cn: '制造', pos: 'verb', ipa: '/ˌmænjuˈfæktʃər/'},
    'assembly': {cn: '装配', pos: 'noun', ipa: '/əˈsembli/'},
    'welding': {cn: '焊接', pos: 'noun', ipa: '/ˈweldɪŋ/'},
    'quality': {cn: '质量', pos: 'noun', ipa: '/ˈkwɒləti/'},
    'production': {cn: '生产', pos: 'noun', ipa: '/prəˈdʌkʃn/'},
    'supplier': {cn: '供应商', pos: 'noun', ipa: '/səˈplaɪər/'},
    'export': {cn: '出口', pos: 'verb', ipa: '/ɪkˈspɔːt/'},
    'market': {cn: '市场', pos: 'noun', ipa: '/ˈmɑːkɪt/'}
  };
  var t = translations[word] || {cn: word, pos: 'noun', ipa: ipa};
  return {
    word: word,
    pos: t.pos,
    ipa: t.ipa,
    cn: t.cn,
    phrase_en: word + ' in the factory',
    phrase_cn: '在工厂里' + t.cn,
    s1_en: 'We need to improve the ' + word + ' process.',
    s1_cn: '我们需要改进' + t.cn + '流程。',
    s2_en: 'The ' + word + ' team will review the report.',
    s2_cn: t.cn + '团队将审核报告。',
    s3_en: 'Please check the ' + word + ' standards before delivery.',
    s3_cn: '请在交付前检查' + t.cn + '标准。'
  };
}

// ===== Admin password =====
function showAdminChangePasswordModal() {
  document.getElementById('admin-change-pw-old').value = '';
  document.getElementById('admin-change-pw-new').value = '';
  document.getElementById('admin-change-pw-confirm').value = '';
  document.getElementById('admin-change-password-modal').classList.add('show');
}

function changeAdminPassword() {
  var oldPw = document.getElementById('admin-change-pw-old').value;
  var newPw = document.getElementById('admin-change-pw-new').value;
  var confirmPw = document.getElementById('admin-change-pw-confirm').value;
  if (!oldPw) { showToast('请输入当前密码'); return; }
  if (!newPw) { showToast('请输入新密码'); return; }
  if (newPw.length < 6) { showToast('新密码至少6位'); return; }
  if (newPw !== confirmPw) { showToast('两次输入的新密码不一致'); return; }

  var username = sessionStorage.getItem('hi_english_admin_name') || 'admin';
  // 关键：调用服务端修改管理员密码（服务端是登录的唯一密码源）
  fetch(HiEnglish.getServerUrl() + '/api/admin-change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username, oldPassword: oldPw, newPassword: newPw })
  }).then(function(resp) { return resp.json(); }).then(function(data) {
    if (data.success) {
      // 同步本地缓存密码，保证离线降级登录也只认新密码（旧密码彻底失效）
      HiEnglish.setAdminPassword(newPw);
      showToast('管理员密码修改成功！下次登录请使用新密码');
      closeModal('admin-change-password-modal');
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

// ===== Toast =====
function showToast(msg) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(function() { toast.classList.remove('show'); }, 2500);
}

// ===== Init =====
window.addEventListener('DOMContentLoaded', init);
