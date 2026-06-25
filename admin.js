// ===================================================
// Basic English 850 管理后台 JS
// ===================================================

const TOTAL_WORDS = 850;

let allUsers = [];
let adminToken = sessionStorage.getItem('admin_token') || null;

document.addEventListener('DOMContentLoaded', () => {
  if (adminToken) {
    document.getElementById('admin-login-mask').style.display = 'none';
    refreshData();
    setInterval(refreshData, 60000);
  } else {
    document.getElementById('admin-login-mask').style.display = 'flex';
  }
});

// ---- 管理员认证 ----
async function adminLogin() {
  const username = document.getElementById('admin-username').value.trim() || 'admin';
  const password = document.getElementById('admin-password').value;
  if (!password) { showToast('请输入密码'); return; }
  try {
    const resp = await fetch('/api/admin-login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ username, password })
    });
    const data = await resp.json();
    if (data.success) {
      adminToken = data.token;
      sessionStorage.setItem('admin_token', adminToken);
      document.getElementById('admin-login-mask').style.display = 'none';
      refreshData();
      setInterval(refreshData, 60000);
    } else {
      showToast(data.error || '登录失败');
    }
  } catch (err) { showToast('网络错误'); }
}

function adminLogout() {
  if (!confirm('确认退出管理后台？')) return;
  adminToken = null;
  sessionStorage.removeItem('admin_token');
  document.getElementById('admin-login-mask').style.display = 'flex';
}

function showAdminPwdModal() { document.getElementById('admin-pwd-modal').style.display = 'flex'; }
function closeAdminPwdModal() {
  document.getElementById('admin-pwd-modal').style.display = 'none';
  document.getElementById('admin-pwd-old').value = '';
  document.getElementById('admin-pwd-new').value = '';
  document.getElementById('admin-pwd-confirm').value = '';
}
async function submitAdminChangePassword() {
  const oldPwd = document.getElementById('admin-pwd-old').value;
  const newPwd = document.getElementById('admin-pwd-new').value;
  const confirmPwd = document.getElementById('admin-pwd-confirm').value;
  if (!oldPwd) { showToast('请输入原密码'); return; }
  if (newPwd.length < 6) { showToast('新密码至少6位'); return; }
  if (newPwd !== confirmPwd) { showToast('两次密码不一致'); return; }
  try {
    const resp = await fetch('/api/admin-change-password', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ username: 'admin', oldPassword: oldPwd, newPassword: newPwd })
    });
    const data = await resp.json();
    if (data.success) { showToast('密码修改成功'); closeAdminPwdModal(); }
    else { showToast(data.error || '修改失败'); }
  } catch (err) { showToast('网络错误'); }
}

// ---- 新增学员 ----
function showAddStudentModal() { document.getElementById('add-student-modal').style.display = 'flex'; }
function closeAddStudentModal() {
  document.getElementById('add-student-modal').style.display = 'none';
  document.getElementById('add-empid').value = '';
  document.getElementById('add-name').value = '';
}
async function addStudent() {
  const empid = document.getElementById('add-empid').value.trim();
  const name = document.getElementById('add-name').value.trim();
  if (!empid) { showToast('请输入工号'); return; }
  if (!name) { showToast('请输入姓名'); return; }
  try {
    const resp = await fetch('/api/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ empid, name })
    });
    const data = await resp.json();
    if (data.success) {
      showToast(data.message || '添加成功');
      closeAddStudentModal();
      refreshData();
    } else {
      showToast(data.error || '添加失败');
    }
  } catch (err) { showToast('网络错误'); }
}

// ---- 批量导入 ----
function downloadImportTemplate() {
  const data = [['工号', '姓名'], ['10001', '张三'], ['10002', '李四']];
  downloadXlsx(data, '学员导入模板.xlsx', '学员名单');
}

async function importStudents(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    // 跳过表头，从第2行开始
    const students = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i] && rows[i][0] && rows[i][1]) {
        students.push({ empid: String(rows[i][0]).trim(), name: String(rows[i][1]).trim() });
      }
    }
    if (!students.length) { showToast('未找到有效数据'); return; }
    const resp = await fetch('/api/import-students', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ students })
    });
    const data = await resp.json();
    if (data.success) {
      showToast(data.message || `导入完成`);
      refreshData();
    } else {
      showToast(data.error || '导入失败');
    }
  } catch (err) { showToast('文件解析失败'); }
  event.target.value = '';
}

// ---- 重置密码 ----
async function resetStudentPassword(empid, name) {
  if (!confirm(`确认重置 ${name} 的密码为 123@456.com？`)) return;
  try {
    const resp = await fetch('/api/reset-password', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ empid })
    });
    const data = await resp.json();
    if (data.success) { showToast(data.message || '重置成功'); }
    else { showToast(data.error || '重置失败'); }
  } catch (err) { showToast('网络错误'); }
}

// ---- 数据加载 ----
async function refreshData() {
  if (!adminToken) return;
  try {
    const resp = await fetch(`/api/admin/users?token=${adminToken}`);
    const data = await resp.json();
    if (data.success) {
      allUsers = data.users;
      localStorage.setItem('eng_all_users', JSON.stringify(allUsers));
    } else {
      allUsers = JSON.parse(localStorage.getItem('eng_all_users') || '[]');
    }
  } catch (err) {
    allUsers = JSON.parse(localStorage.getItem('eng_all_users') || '[]');
  }
  document.getElementById('update-time').textContent = `更新于 ${new Date().toLocaleTimeString()}`;
  renderOverview();
  renderStudents();
  renderProgress();
}

// ---- 总览 ----
function renderOverview() {
  const now = Date.now();
  const oneDayAgo = now - 24 * 3600 * 1000;
  const threeDaysAgo = now - 3 * 24 * 3600 * 1000;

  const total = allUsers.length;
  const activeToday = allUsers.filter(u => (u.lastLogin || 0) >= oneDayAgo).length;
  const inactive3 = allUsers.filter(u => (u.lastLogin || 0) < threeDaysAgo).length;
  const avgProgress = total > 0
    ? Math.round(allUsers.reduce((sum, u) => sum + (u.learnedCount || 0), 0) / total / TOTAL_WORDS * 100)
    : 0;

  document.getElementById('total-students').textContent = total;
  document.getElementById('active-today').textContent = activeToday;
  document.getElementById('inactive-students').textContent = inactive3;
  document.getElementById('avg-progress').textContent = avgProgress + '%';

  renderProgressDistribution();
  renderTopStudents();
  renderRecentActivity();
}

function renderProgressDistribution() {
  const total = allUsers.length || 1;
  const buckets = [
    { label: '未开始', min: 0, max: 0, color: 'red' },
    { label: '1%-25%', min: 1, max: 25, color: 'orange' },
    { label: '25%-50%', min: 26, max: 50, color: 'blue' },
    { label: '50%-75%', min: 51, max: 75, color: 'blue' },
    { label: '75%+', min: 76, max: 101, color: 'green' },
  ];

  const html = buckets.map(b => {
    const count = allUsers.filter(u => {
      const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
      return pct >= b.min && pct <= b.max;
    }).length;
    const pct = Math.round(count / total * 100);
    return `
      <div class="dist-row">
        <div class="dist-label">${b.label}</div>
        <div class="dist-bar-wrap">
          <div class="dist-bar ${b.color}" style="width:${pct}%"></div>
        </div>
        <div class="dist-count">${count}人</div>
      </div>
    `;
  }).join('');

  document.getElementById('progress-distribution').innerHTML = html;
}

function renderTopStudents() {
  const sorted = [...allUsers].sort((a, b) => (b.learnedCount || 0) - (a.learnedCount || 0)).slice(0, 10);
  const html = `<div class="top-list">` + sorted.map((u, i) => {
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : 'rn';
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    return `
      <div class="top-item" onclick="showStudentDetail('${u.empid}')">
        <div class="top-rank ${rankClass}">${i + 1}</div>
        <div class="top-name">${u.name || '—'}</div>
        <div class="top-empid">${u.empid}</div>
        <div class="top-progress">${pct}% (${u.learnedCount || 0}词)</div>
      </div>
    `;
  }).join('') + `</div>`;
  document.getElementById('top-students-list').innerHTML = sorted.length ? html : '<div style="text-align:center;color:#aaa;padding:20px">暂无学员数据</div>';
}

function renderRecentActivity() {
  // 按最近登录时间排序
  const sorted = [...allUsers].sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0)).slice(0, 15);
  const html = `<div class="activity-list">` + sorted.map(u => {
    const sessions = u.sessions || [];
    const lastSession = sessions[sessions.length - 1];
    const desc = lastSession
      ? `学习${lastSession.count}词，得分${lastSession.score}分`
      : `共学习${u.learnedCount || 0}词`;
    return `
      <div class="activity-item">
        <div class="activity-dot"></div>
        <div class="activity-name">${u.name}(${u.empid})</div>
        <div class="activity-desc">${desc}</div>
        <div class="activity-time">${formatTime(u.lastLogin)}</div>
      </div>
    `;
  }).join('') + `</div>`;
  document.getElementById('recent-activity').innerHTML = sorted.length ? html : '<div style="text-align:center;color:#aaa;padding:20px">暂无活动记录</div>';
}

// ---- 学员管理 ----
function renderStudents() {
  const search = (document.getElementById('student-search')?.value || '').toLowerCase();
  const filter = document.getElementById('student-filter')?.value || 'all';
  const sort = document.getElementById('student-sort')?.value || 'lastLogin';
  const now = Date.now();

  let list = [...allUsers].filter(u => {
    const matchSearch = !search || u.empid.toLowerCase().includes(search) || (u.name || '').toLowerCase().includes(search);
    const daysSince = (now - (u.lastLogin || 0)) / (24 * 3600 * 1000);
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    const matchFilter = filter === 'all' ? true
      : filter === 'active' ? daysSince < 1
      : filter === 'inactive3' ? daysSince >= 3
      : filter === 'inactive7' ? daysSince >= 7
      : (u.learnedCount || 0) === 0;
    return matchSearch && matchFilter;
  });

  // 排序
  list.sort((a, b) => {
    if (sort === 'lastLogin') return (b.lastLogin || 0) - (a.lastLogin || 0);
    if (sort === 'progress') return (b.learnedCount || 0) - (a.learnedCount || 0);
    if (sort === 'score') return (b.avgScore || 0) - (a.avgScore || 0);
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
    return 0;
  });

  document.getElementById('student-count').textContent = `共${list.length}人`;

  const tbody = document.getElementById('students-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#aaa;padding:32px">暂无学员数据</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(u => {
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    const daysSince = Math.floor((now - (u.lastLogin || 0)) / (24 * 3600 * 1000));
    const days = (u.studyDates || []).length;
    const status = getStatusBadge(daysSince, pct);
    
    // 进度条颜色
    const barColor = pct >= 75 ? '#52C41A' : pct >= 50 ? '#4F6AF0' : pct >= 25 ? '#FAAD14' : '#FF4D4F';

    return `
      <tr>
        <td>${u.empid}</td>
        <td><strong>${u.name || '—'}</strong></td>
        <td>
          <div class="progress-mini">
            <div class="progress-mini-bar">
              <div class="progress-mini-fill" style="width:${pct}%;background:${barColor}"></div>
            </div>
            <div class="progress-mini-text">${pct}%<br><span style="font-size:11px;color:#aaa">${u.learnedCount||0}词</span></div>
          </div>
        </td>
        <td>${u.masteredCount || 0}词</td>
        <td>${days}天</td>
        <td>${u.avgScore || 0}分</td>
        <td>${formatTime(u.lastLogin)}</td>
        <td>${status}</td>
        <td>
          <button class="btn-detail" onclick="showStudentDetail('${u.empid}')">详情</button>
          <button class="btn-notify" onclick="resetStudentPassword('${u.empid}','${u.name||''}')">重置密码</button>
        </td>
      </tr>
    `;
  }).join('');
}

function getStatusBadge(daysSince, pct) {
  if (daysSince < 1) return `<span class="status-badge status-active">今日学习</span>`;
  if (daysSince < 3) return `<span class="status-badge status-warn">${daysSince}天前学习</span>`;
  if (daysSince < 7) return `<span class="status-badge status-danger">${daysSince}天未学</span>`;
  if (pct === 0) return `<span class="status-badge status-new">未开始</span>`;
  return `<span class="status-badge status-danger">长期未学</span>`;
}

// ---- 进度跟踪 ----
function renderProgress() {
  renderLaggingList();
  renderProgressChart();
}

function renderLaggingList() {
  const now = Date.now();
  const lagging = [...allUsers]
    .filter(u => {
      const daysSince = (now - (u.lastLogin || 0)) / (24 * 3600 * 1000);
      return daysSince >= 3;
    })
    .sort((a, b) => (a.lastLogin || 0) - (b.lastLogin || 0))
    .slice(0, 20);

  const pctOf = u => Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
  const daysSince = u => Math.floor((now - (u.lastLogin || 0)) / (24 * 3600 * 1000));

  document.getElementById('lagging-list').innerHTML = lagging.length
    ? lagging.map(u => `
        <div class="lagging-item">
          <div class="lagging-info">
            <div class="lagging-name">${u.name}（${u.empid}）</div>
            <div class="lagging-detail">进度 ${pctOf(u)}% · 已学 ${u.learnedCount || 0} 词</div>
          </div>
          <div>
            <div class="lagging-days">${daysSince(u)}</div>
            <div class="lagging-unit">天未学</div>
          </div>
        </div>
      `).join('')
    : '<div style="text-align:center;color:#aaa;padding:20px">暂无落后学员 🎉</div>';
}

function renderProgressChart() {
  const sorted = [...allUsers].sort((a, b) => (b.learnedCount || 0) - (a.learnedCount || 0));
  
  const colors = ['#4F6AF0', '#52C41A', '#FAAD14', '#FF6B6B', '#9B59B6'];
  document.getElementById('progress-chart').innerHTML = sorted.map((u, i) => {
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    const color = colors[i % colors.length];
    return `
      <div class="pc-row">
        <div class="pc-name" title="${u.name}">${u.name}</div>
        <div class="pc-bar-wrap">
          <div class="pc-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="pc-pct">${pct}%</div>
      </div>
    `;
  }).join('') || '<div style="text-align:center;color:#aaa;padding:20px">暂无数据</div>';
}

// ---- 催学提醒 ----
function checkNotifyList() {
  const days = parseInt(document.getElementById('notify-days').value);
  const progress = parseInt(document.getElementById('notify-progress').value);
  const now = Date.now();

  const needNotify = allUsers.filter(u => {
    const daysSince = (now - (u.lastLogin || 0)) / (24 * 3600 * 1000);
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    return daysSince >= days || pct < progress;
  });

  document.getElementById('notify-result-card').style.display = 'block';
  document.getElementById('notify-list').innerHTML = needNotify.length
    ? needNotify.map(u => {
        const daysSince = Math.floor((now - (u.lastLogin || 0)) / (24 * 3600 * 1000));
        const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
        const reasons = [];
        if (daysSince >= days) reasons.push(`${daysSince}天未学习`);
        if (pct < progress) reasons.push(`进度仅${pct}%`);
        return `
          <div class="notify-item">
            <div class="notify-info">
              <div class="notify-name">${u.name}（${u.empid}）</div>
              <div class="notify-reason">${reasons.join(' · ')}</div>
            </div>
          </div>
        `;
      }).join('')
    : '<div style="text-align:center;color:#aaa;padding:20px">没有需要提醒的学员</div>';
  
  showToast(`筛选到 ${needNotify.length} 名需要提醒的学员`);
}

function exportNotifyList() {
  const days = parseInt(document.getElementById('notify-days').value);
  const progress = parseInt(document.getElementById('notify-progress').value);
  const now = Date.now();
  const list = allUsers.filter(u => {
    const daysSince = (now - (u.lastLogin || 0)) / (24 * 3600 * 1000);
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    return daysSince >= days || pct < progress;
  });
  const data = [['工号', '姓名', '进度(%)', '未学习天数', '原因']];
  list.forEach(u => {
    const daysSince = Math.floor((now - (u.lastLogin || 0)) / (24 * 3600 * 1000));
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    const reasons = [];
    if (daysSince >= days) reasons.push(`${daysSince}天未学习`);
    if (pct < progress) reasons.push(`进度仅${pct}%`);
    data.push([u.empid, u.name, pct, daysSince, reasons.join(' · ')]);
  });
  downloadXlsx(data, `催学名单_${new Date().toLocaleDateString()}.xlsx`, '催学名单');
}

function copyReminderMsg(name, empid, daysSince, pct) {
  const msg = `【英语学习提醒】
${name}同学您好！
您已有${daysSince}天未进行英语学习，当前学习进度仅为${pct}%（${Math.round(pct/100*TOTAL_WORDS)}/${TOTAL_WORDS}词）。
请尽快登录学习系统继续学习，加油💪`;
  
  if (navigator.clipboard) {
    navigator.clipboard.writeText(msg).then(() => showToast('提醒信息已复制到剪贴板'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = msg;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('提醒信息已复制');
  }
}

function copyNotifyMsg() {
  const days = parseInt(document.getElementById('notify-days').value);
  const progress = parseInt(document.getElementById('notify-progress').value);
  const now = Date.now();
  const list = allUsers.filter(u => {
    const daysSince = (now - (u.lastLogin || 0)) / (24 * 3600 * 1000);
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    return daysSince >= days || pct < progress;
  });

  const msg = `【英语学习集体提醒 ${new Date().toLocaleDateString()}】
以下学员请尽快登录系统进行英语学习：
${list.map(u => `• ${u.name}(${u.empid})`).join('\n')}

目标：完成850词基础英语学习
系统地址：请使用学习APP登录`;

  if (navigator.clipboard) {
    navigator.clipboard.writeText(msg).then(() => showToast('批量提醒信息已复制'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = msg;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('已复制');
  }
}

// ---- 导出 ----
function downloadXlsx(data, filename, sheetName) {
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
  XLSX.writeFile(wb, filename);
  showToast(`已导出：${filename}`);
}

function downloadDoc(htmlContent, filename) {
  const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  showToast(`已导出：${filename}`);
}

function exportAllStudents() {
  const data = [['工号', '姓名', '已学词数', '学习进度(%)', '已掌握', '平均跟读分', '学习天数', '累计时长(分)', '最近学习时间']];
  allUsers.forEach(u => {
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    const days = (u.studyDates || []).length;
    const mins = Math.floor((u.totalStudySeconds || 0) / 60);
    data.push([u.empid, u.name, u.learnedCount || 0, pct, u.masteredCount || 0, u.avgScore || 0, days, mins, formatTime(u.lastLogin)]);
  });
  downloadXlsx(data, `全员学习报告_${new Date().toLocaleDateString()}.xlsx`, '全员学习报告');
}

function exportProgressReport() {
  const now = Date.now();
  const total = allUsers.length;
  const avg = total > 0 ? Math.round(allUsers.reduce((s, u) => s + (u.learnedCount || 0), 0) / total) : 0;
  const active = allUsers.filter(u => (now - (u.lastLogin || 0)) < 24*3600*1000).length;

  const buckets = [
    { l: '未开始(0词)', f: u => u.learnedCount === 0 },
    { l: '初级(1-200词)', f: u => u.learnedCount > 0 && u.learnedCount <= 200 },
    { l: '中级(201-500词)', f: u => u.learnedCount > 200 && u.learnedCount <= 500 },
    { l: '高级(501-850词)', f: u => u.learnedCount > 500 },
  ];
  const distRows = buckets.map(b => {
    const cnt = allUsers.filter(b.f).length;
    return `<tr><td>${b.l}</td><td>${cnt}人</td><td>${total > 0 ? Math.round(cnt/total*100) : 0}%</td></tr>`;
  }).join('');
  const detailRows = [...allUsers].sort((a,b) => (b.learnedCount||0)-(a.learnedCount||0)).map((u, i) => {
    const pct = Math.round((u.learnedCount||0)/TOTAL_WORDS*100);
    return `<tr><td>${i+1}</td><td>${u.name}</td><td>${u.empid}</td><td>${pct}%</td><td>${u.learnedCount||0}词</td><td>${formatTime(u.lastLogin)}</td></tr>`;
  }).join('');

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>进度分析报告</title></head>
<body style="font-family:宋体;">
<h1 style="text-align:center;">Basic English 850 学习进度分析报告</h1>
<p>导出时间：${new Date().toLocaleString()}</p>
<h2>【总体概况】</h2>
<p>学员总数：${total}人<br>今日活跃：${active}人<br>平均学习词数：${avg}词（占比${Math.round(avg/TOTAL_WORDS*100)}%）</p>
<h2>【进度分布】</h2>
<table border="1" cellpadding="6" cellspacing="0"><tr><th>层级</th><th>人数</th><th>占比</th></tr>${distRows}</table>
<h2>【各学员详情】</h2>
<table border="1" cellpadding="6" cellspacing="0"><tr><th>排名</th><th>姓名</th><th>工号</th><th>进度</th><th>词数</th><th>最近学习</th></tr>${detailRows}</table>
</body></html>`;
  downloadDoc(html, `进度分析报告_${new Date().toLocaleDateString()}.doc`);
}

function exportRankList() {
  const sorted = [...allUsers].sort((a, b) => (b.learnedCount || 0) - (a.learnedCount || 0));
  const data = [['排名', '工号', '姓名', '已学词数', '进度(%)', '平均分']];
  sorted.forEach((u, i) => {
    const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
    data.push([i+1, u.empid, u.name, u.learnedCount||0, pct, (u.avgScore||0) + '分']);
  });
  downloadXlsx(data, `学习排行榜_${new Date().toLocaleDateString()}.xlsx`, '排行榜');
}

// ---- 学员详情弹窗 ----
function showStudentDetail(empid) {
  const u = allUsers.find(u => u.empid === empid);
  if (!u) return;

  const now = Date.now();
  const pct = Math.round((u.learnedCount || 0) / TOTAL_WORDS * 100);
  const daysSince = Math.floor((now - (u.lastLogin || 0)) / (24*3600*1000));
  const days = (u.studyDates || []).length;
  const mins = Math.floor((u.totalStudySeconds || 0) / 60);

  document.getElementById('modal-title').textContent = `${u.name}（${u.empid}）`;
  document.getElementById('modal-body').innerHTML = `
    <div class="detail-section">
      <h4>学习概况</h4>
      <div class="detail-grid">
        <div class="detail-item">
          <div class="detail-val">${u.learnedCount || 0}</div>
          <div class="detail-key">已学词数（/ ${TOTAL_WORDS}）</div>
        </div>
        <div class="detail-item">
          <div class="detail-val">${pct}%</div>
          <div class="detail-key">完成进度</div>
        </div>
        <div class="detail-item">
          <div class="detail-val">${u.masteredCount || 0}</div>
          <div class="detail-key">已掌握词数</div>
        </div>
        <div class="detail-item">
          <div class="detail-val">${u.avgScore || 0}分</div>
          <div class="detail-key">跟读平均分</div>
        </div>
        <div class="detail-item">
          <div class="detail-val">${days}</div>
          <div class="detail-key">学习天数</div>
        </div>
        <div class="detail-item">
          <div class="detail-val">${mins}分</div>
          <div class="detail-key">累计学习时长</div>
        </div>
      </div>
    </div>
    <div class="detail-section">
      <h4>登录信息</h4>
      <p style="font-size:13px;color:#888">
        最近登录：${formatTime(u.lastLogin)}<br>
        ${daysSince > 0 ? `已${daysSince}天未学习` : '今日已学习'}
      </p>
    </div>
    <div class="detail-section">
      <h4>近期学习记录</h4>
      <div class="session-list">
        ${(u.sessions || []).slice(-10).reverse().map(s => `
          <div class="session-item">
            <span class="session-date">${formatTime(s.date)}</span>
            <span>学习${s.count}词</span>
            <span style="color:var(--primary)">${s.score}分</span>
          </div>
        `).join('') || '<div style="color:#aaa;padding:10px">暂无记录</div>'}
      </div>
    </div>
  `;

  document.getElementById('student-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('student-modal').style.display = 'none';
}

// ---- Tab切换 ----
function showTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  
  const tabMap = {
    'tab-overview': 0, 'tab-students': 1, 'tab-progress': 2, 'tab-notify': 3, 'tab-export': 4
  };
  const items = document.querySelectorAll('.sidebar-nav .nav-item');
  const idx = tabMap[tabId];
  if (idx !== undefined) items[idx]?.classList.add('active');

  if (tabId === 'tab-progress') renderProgress();
}

// ---- 工具函数 ----
function formatTime(ts) {
  if (!ts) return '从未';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 86400 * 3) return `${Math.floor(diff / 86400)}天前`;
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

function downloadText(text, filename) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }); // BOM for Excel
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  showToast(`已导出：${filename}`);
}

function showToast(msg) {
  let toast = document.querySelector('.admin-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'admin-toast';
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1E2340;color:white;padding:12px 20px;border-radius:8px;font-size:14px;z-index:99999;opacity:0;transition:opacity 0.3s`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}
