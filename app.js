// ===================================================
// Hi English 学习APP - 主逻辑（修复版）
// ===================================================

// ---- 状态管理 ----
let currentUser = null;
let learnMode = 'sequential';
let currentIndex = 0;
let learnQueue = [];
let isRecording = false;
let micTimeoutTimer = null; // 录音超时安全网
let micStarting = false; // 防止重复调用start
let recognitionTextBuffer = ''; // 收集识别到的文本（含interim）
let evaluatedAlready = false; // 防止evaluateSpeaking被多次调用
let speakTarget = 'word';
let speakZoneExpanded = false;
let allData = [];
let recognizedText = '';
let currentAudio = null;
const AUDIO_VERSION = '?v=5'; // 音频版本号，修改后强制浏览器刷新缓存

// ---- 初始化 ----
document.addEventListener('DOMContentLoaded', () => {
  allData = window.WORDS_DATA || [];
  // 取消自动登录，用户必须重新输入密码
  localStorage.removeItem('english_user');
  currentUser = null;
  initSpeechRecognition();
});

// ---- 页面切换 ----
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navMap = { 'page-home': 0, 'page-wordlist': 1, 'page-report': 2 };
  if (navMap[pageId] !== undefined) {
    const items = document.querySelectorAll('.nav-item');
    if (items[navMap[pageId]]) items[navMap[pageId]].classList.add('active');
  }

  if (pageId === 'page-wordlist') renderWordList();
  if (pageId === 'page-report') generateReport();
  if (pageId === 'page-home') updateHomeStats();
}

// ---- 登录 ----
const API_BASE = '';

async function doLogin() {
  const empid = document.getElementById('input-empid').value.trim();
  const password = document.getElementById('input-password').value;
  if (!empid) { showToast('请输入工号'); return; }
  if (!password) { showToast('请输入密码'); return; }

  try {
    const resp = await fetch(API_BASE + '/api/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ empid, password })
    });
    const data = await resp.json();
    if (!data.success) {
      showToast(data.error || '登录失败');
      return;
    }
    currentUser = { empid, name: data.user.name, loginTime: Date.now() };
    localStorage.setItem('english_user', JSON.stringify(currentUser));
    await loadStudyDataFromServer();
    recordLogin();
    initUserSession();
    showPage('page-home');
  } catch (err) {
    showToast('网络错误，无法连接服务器');
  }
}

async function logout() {
  if (!confirm('确认退出登录？')) return;
  const ud = getUserData();
  if (ud && currentUser) {
    await saveStudyDataToServer(ud);
  }
  localStorage.removeItem('english_user');
  currentUser = null;
  showPage('page-login');
}

function recordLogin() {
  const ud = getUserData();
  if (!ud) return;
  ud.lastLogin = Date.now();
  ud.loginCount = (ud.loginCount || 0) + 1;
  saveUserData(ud);
  syncToGlobalList(ud);
}

// ---- 用户数据存储 ----
function getUserData() {
  if (!currentUser) return null;
  const key = `eng_ud_${currentUser.empid}`;
  const d = localStorage.getItem(key);
  return d ? JSON.parse(d) : null;
}

let saveTimer = null;
function saveUserData(data) {
  const key = `eng_ud_${currentUser.empid}`;
  data.updatedAt = Date.now();
  localStorage.setItem(key, JSON.stringify(data));
  syncToGlobalList(data);
  // 防抖保存到后端
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveStudyDataToServer(data); }, 2000);
}

// ---- 后端数据同步 ----
async function loadStudyDataFromServer() {
  if (!currentUser) return;
  try {
    const resp = await fetch(`${API_BASE}/api/study-data?empid=${currentUser.empid}`);
    const data = await resp.json();
    if (data.success && data.studyData) {
      localStorage.setItem(`eng_ud_${currentUser.empid}`, JSON.stringify(data.studyData));
    }
  } catch (err) {
    console.warn('从后端加载学习记录失败:', err);
  }
}

async function saveStudyDataToServer(data) {
  if (!currentUser) return;
  try {
    await fetch(`${API_BASE}/api/study-data`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ empid: currentUser.empid, studyData: data })
    });
  } catch (err) {
    console.warn('保存到后端失败:', err);
  }
}

// ---- 修改密码 ----
function showChangePasswordModal() {
  document.getElementById('pwd-modal-mask').style.display = 'flex';
}
function closePwdModal() {
  document.getElementById('pwd-modal-mask').style.display = 'none';
  document.getElementById('pwd-old').value = '';
  document.getElementById('pwd-new').value = '';
  document.getElementById('pwd-confirm').value = '';
}
async function submitChangePassword() {
  const oldPwd = document.getElementById('pwd-old').value;
  const newPwd = document.getElementById('pwd-new').value;
  const confirmPwd = document.getElementById('pwd-confirm').value;
  if (!oldPwd) { showToast('请输入原密码'); return; }
  if (newPwd.length < 6) { showToast('新密码至少6位'); return; }
  if (newPwd !== confirmPwd) { showToast('两次密码不一致'); return; }
  try {
    const resp = await fetch(`${API_BASE}/api/change-password`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ empid: currentUser.empid, oldPassword: oldPwd, newPassword: newPwd })
    });
    const data = await resp.json();
    if (data.success) { showToast('密码修改成功'); closePwdModal(); }
    else { showToast(data.error || '修改失败'); }
  } catch (err) { showToast('网络错误'); }
}

function syncToGlobalList(ud) {
  // 同步到管理后台能看到的全局学员列表
  let allUsers = JSON.parse(localStorage.getItem('eng_all_users') || '[]');
  const idx = allUsers.findIndex(u => u.empid === ud.empid);
  const summary = {
    empid: ud.empid,
    name: ud.name,
    learnedCount: (ud.learnedIds || []).length,
    masteredCount: (ud.masteredIds || []).length,
    lastLogin: ud.lastLogin || ud.updatedAt,
    totalStudySeconds: ud.totalStudySeconds || 0,
    sessions: ud.sessions || [],
    studyDates: ud.studyDates || [],
    createdAt: ud.createdAt,
    avgScore: calcAvgScore(ud),
  };
  if (idx >= 0) allUsers[idx] = summary;
  else allUsers.push(summary);
  localStorage.setItem('eng_all_users', JSON.stringify(allUsers));
}

function calcAvgScore(ud) {
  const scores = Object.values(ud.speakScores || {});
  if (!scores.length) return 0;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// ---- 会话初始化 ----
function initUserSession() {
  document.getElementById('user-display').textContent = `${currentUser.name} (${currentUser.empid})`;
  updateHomeStats();
  renderWordList();
  updateRecentWord();
}

function updateHomeStats() {
  const ud = getUserData();
  if (!ud) return;
  const learned = ud.learnedIds.length;
  const mastered = ud.masteredIds.length;
  const total = allData.length;
  
  document.getElementById('home-progress-bar').style.width = `${(learned / total * 100).toFixed(1)}%`;
  document.getElementById('home-progress-text').textContent = `${learned} / ${total} 词`;
  document.getElementById('stat-learned').textContent = learned;
  document.getElementById('stat-mastered').textContent = mastered;
  
  // 计算学习天数 - 使用 studyDates
  const days = (ud.studyDates || []).length;
  document.getElementById('stat-days').textContent = days || (ud.loginCount > 0 ? 1 : 0);
}

function updateRecentWord() {
  const ud = getUserData();
  if (!ud) return;
  const lastIdx = ud.lastIndex || 0;
  const word = allData[lastIdx];
  if (word) {
    document.getElementById('recent-word').textContent = word.word;
    document.getElementById('recent-word-zh').textContent = word.zh;
  }
}

// ---- 学习模式 ----
function startLearn(mode) {
  learnMode = mode;
  const ud = getUserData();
  if (!ud) return;

  if (mode === 'sequential') {
    learnQueue = allData.map((_, i) => i);
    currentIndex = ud.lastIndex || 0;
  } else if (mode === 'review') {
    const learnedIds = new Set(ud.learnedIds);
    learnQueue = allData.reduce((arr, w, i) => {
      if (learnedIds.has(w.id)) arr.push(i);
      return arr;
    }, []);
    if (!learnQueue.length) { showToast('还没有已学单词，先顺序学习吧！'); return; }
    currentIndex = 0;
  } else if (mode === 'practice') {
    // 拼写练习 - 按顺序对850词
    learnQueue = allData.map((_, i) => i);
    currentIndex = ud.lastIndex || 0;
    renderSpellPage();
    showPage('page-spell');
    startStudyTimer();
    return;
  } else if (mode === 'test') {
    // 随机测试
    learnQueue = [...allData.keys()].sort(() => Math.random() - 0.5).slice(0, 20);
    currentIndex = 0;
  }

  renderLearnPage();
  showPage('page-learn');
  
  // 开始计时
  startStudyTimer();
}

function resumeLearn() {
  startLearn('sequential');
}

let studyStartTime = null;
let studyTimer = null;

function startStudyTimer() {
  studyStartTime = Date.now();
}

function endStudyTimer() {
  if (!studyStartTime) return;
  const seconds = Math.floor((Date.now() - studyStartTime) / 1000);
  const ud = getUserData();
  if (ud) {
    ud.totalStudySeconds = (ud.totalStudySeconds || 0) + seconds;
    saveUserData(ud);
  }
  studyStartTime = null;
}

// ---- 渲染学习页 ----
function renderLearnPage() {
  const qIdx = learnQueue[currentIndex];
  if (qIdx === undefined) return;
  const word = allData[qIdx];
  if (!word) return;

  document.getElementById('learn-current').textContent = currentIndex + 1;
  document.getElementById('learn-total').textContent = learnQueue.length;
  document.getElementById('learn-progress-bar').style.width = 
    `${((currentIndex + 1) / learnQueue.length * 100).toFixed(1)}%`;

  // 填充单词内容
  document.getElementById('wc-pos').textContent = word.pos || 'n.';
  document.getElementById('wc-ipa').textContent = word.ipa || '';
  document.getElementById('wc-word').textContent = word.word;
  document.getElementById('wc-zh').textContent = word.zh || '';

  // 词组
  const phrases = cleanPhrases(word.phrases);
  document.getElementById('wc-phrases').textContent = phrases || '—';

  // 例句
  const examples = buildExamples(word);
  ['ex1', 'ex2', 'ex3'].forEach((k, i) => {
    const en = document.getElementById(`${k}-en`);
    const zh = document.getElementById(`${k}-zh`);
    if (examples[i]) {
      en.textContent = examples[i].en;
      zh.textContent = examples[i].zh;
    } else {
      en.textContent = '';
      zh.textContent = '';
    }
  });

  // 更新收藏按钮
  const ud = getUserData();
  const isFav = ud && ud.favoriteIds.includes(word.id);
  document.getElementById('btn-fav').textContent = isFav ? '★' : '☆';

  // 重置跟读区（默认选中读词组）
  speakTarget = 'phrase';
  document.querySelectorAll('.speak-target-btn').forEach(b => b.classList.remove('active'));
  var stPhraseBtn = document.getElementById('st-phrase');
  if (stPhraseBtn) stPhraseBtn.classList.add('active');
  updateSpeakTargetDisplay();
  var speakTipEl = document.getElementById('speak-tip');
  if (speakTipEl) speakTipEl.textContent = '先听标准发音，再按住麦克风跟读';
  var recInd = document.getElementById('recording-indicator');
  if (recInd) recInd.style.display = 'none';
  
  // 标记为已学
  markLearned(word.id);

  // 自动朗读
  setTimeout(() => speakWord(), 400);
}

function cleanPhrases(phrases) {
  if (!phrases) return '';
  // 去除混入的例句内容
  let clean = phrases;
  // 去掉大写字母开头的完整句子（以句号结尾）
  clean = clean.replace(/[A-Z][^,;]+\./g, '').trim();
  // 规范化分隔符
  clean = clean.replace(/;/g, ', ').replace(/\s{2,}/g, ' ').trim();
  if (clean.length > 80) clean = clean.slice(0, 80) + '...';
  return clean;
}

function buildExamples(word) {
  const examples = [];
  // 构建例句数组
  const pairs = [
    { en: word.ex1, zh: word.ex1_zh },
    { en: word.ex2, zh: word.ex2_zh },
    { en: word.ex3, zh: word.ex3_zh },
  ];
  
  for (const p of pairs) {
    const en = (p.en || '').trim();
    const zh = (p.zh || '').trim();
    if (en.length > 2) {
      // 清理zh中混入的英文
      let cleanZh = zh.replace(/[A-Za-z'.,!?]+/g, '').trim();
      examples.push({ en, zh: cleanZh || zh });
    }
  }
  return examples;
}

// ---- 语音朗读 ----
// 语音朗读
var synth = window.speechSynthesis || window.webkitSpeechSynthesis;
var currentSpeechText = '';
var isSpeaking = false;
var ttsMode = 'auto';
var voicesReady = false;

// 预加载语音列表（Chrome需要异步加载）
function loadVoices() {
  if (!speechSynthesis) return [];
  const voices = speechSynthesis.getVoices();
  if (voices.length > 0) voicesReady = true;
  return voices;
}
if (speechSynthesis) {
  loadVoices();
  speechSynthesis.onvoiceschanged = () => { voicesReady = true; loadVoices(); };
}

// 检测原生TTS是否真的可用（有英语声音）
function nativeTTSAvailable() {
  if (!speechSynthesis) return false;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return false;
  const enVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('en'));
  return !!enVoice;
}

// 在线TTS备用方案（Google Translate TTS）
function speakOnline(text, lang = 'en-US', rate = 0.85) {
  return new Promise(resolve => {
    if (!text) { resolve(); return; }
    // 停止之前的音频
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    // Google Translate TTS
    const tld = lang === 'en-US' ? 'com' : 'com';
    const url = `https://translate.google.${tld}/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(text)}`;
    const audio = new Audio(url);
    audio.playbackRate = rate;
    currentAudio = audio;
    
    audio.onended = () => { currentAudio = null; resolve(); };
    audio.onerror = () => {
      currentAudio = null;
      // 再尝试另一个备用TTS
      tryOnlineTTS2(text, lang, rate).then(resolve).catch(() => resolve());
    };
    
    // 注意：Google TTS可能有CORS限制，如果不能直接播放会触发onerror
    audio.play().catch(err => {
      console.warn('Google TTS播放失败:', err);
      currentAudio = null;
      tryOnlineTTS2(text, lang, rate).then(resolve).catch(() => resolve());
    });
  });
}

// 备用TTS方案2 - ResponsiveVoice JS
let responsiveVoiceLoaded = false;
function tryOnlineTTS2(text, lang, rate) {
  return new Promise(resolve => {
    if (!responsiveVoiceLoaded) {
      const script = document.createElement('script');
      script.src = 'https://code.responsivevoice.org/responsivevoice.js';
      script.onload = () => {
        responsiveVoiceLoaded = true;
        try {
          window.responsiveVoice.speak(text, 'US English Female', { rate, onend: resolve });
        } catch(e) { resolve(); }
      };
      script.onerror = () => resolve();
      document.head.appendChild(script);
    } else {
      try {
        window.responsiveVoice.speak(text, 'US English Female', { rate, onend: resolve });
      } catch(e) { resolve(); }
    }
  });
}

// 统一的朗读函数
// 优先使用本地预生成的MP3音频文件，保证一定有声音
function speak(text, lang = 'en-US', rate = 0.85) {
  return new Promise(resolve => {
    if (!text) { resolve(); return; }
    
    // 停止之前的播放
    if (speechSynthesis) speechSynthesis.cancel();
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    
    // 优先尝试本地预生成的音频文件
    const localAudioUrl = getLocalAudioUrl(text);
    if (localAudioUrl) {
      const audio = new Audio(localAudioUrl);
      audio.playbackRate = rate;
      currentAudio = audio;
      
      let resolved = false;
      const finishOnce = () => { if (!resolved) { resolved = true; currentAudio = null; resolve(); } };
      audio.onended = finishOnce;
      audio.onerror = () => {
        console.warn('本地音频失败，降级到TTS:', localAudioUrl);
        currentAudio = null;
        // 降级到TTS
        speakFallback(text, lang, rate).then(resolve);
      };
      
      audio.play().then(() => {
        // 播放成功
      }).catch(err => {
        console.warn('本地音频播放失败:', err);
        currentAudio = null;
        speakFallback(text, lang, rate).then(resolve);
      });
      
      // 超时保护
      setTimeout(() => { if (!resolved && (!currentAudio || currentAudio.ended)) finishOnce(); }, 15000);
    } else {
      // 没有本地音频，直接用TTS
      speakFallback(text, lang, rate).then(resolve);
    }
  });
}

// 根据当前内容获取本地音频文件URL
function getLocalAudioUrl(text) {
  if (!text) return null;
  text = text.trim();
  
  // 获取当前单词ID
  const qIdx = learnQueue[currentIndex];
  if (qIdx === undefined) return null;
  const word = allData[qIdx];
  if (!word) return null;
  const wid = word.id;
  
  // 单词
  if (text === word.word) {
    return `audio/w_${wid}.mp3`;
  }
  // 词组
  const phrases = cleanPhrases(word.phrases);
  if (text === phrases) {
    return `audio/p_${wid}.mp3`;
  }
  // 例句
  const examples = buildExamples(word);
  for (let i = 0; i < examples.length; i++) {
    if (text === examples[i].en) {
      return `audio/e_${wid}_${i+1}.mp3`;
    }
  }
  return null;
}

// TTS降级方案
function speakFallback(text, lang = 'en-US', rate = 0.85) {
  return new Promise(resolve => {
    if (!text) { resolve(); return; }
    
    const useNative = ttsMode === 'native' || (ttsMode === 'auto' && nativeTTSAvailable());
    
    if (useNative) {
      try {
        const utt = new SpeechSynthesisUtterance(text);
        utt.lang = lang;
        utt.rate = rate;
        utt.pitch = 1.0;
        const voices = speechSynthesis.getVoices();
        const enVoice = voices.find(v => v.lang && v.lang.startsWith('en') && /Google|Microsoft|Samantha|Alex|Daniel/i.test(v.name)) 
          || voices.find(v => v.lang && v.lang.startsWith('en'));
        if (enVoice) utt.voice = enVoice;
        
        let resolved = false;
        utt.onend = () => { if (!resolved) { resolved = true; resolve(); } };
        utt.onerror = () => {
          if (!resolved) { resolved = true; speakOnline(text, lang, rate).then(resolve); }
        };
        speechSynthesis.speak(utt);
        setTimeout(() => {
          if (!resolved && !speechSynthesis.speaking) {
            resolved = true;
            speakOnline(text, lang, rate).then(resolve);
          }
        }, 3000);
      } catch(e) {
        speakOnline(text, lang, rate).then(resolve);
      }
    } else {
      speakOnline(text, lang, rate).then(resolve);
    }
  });
}

function speakWord() {
  var qIdx = learnQueue[currentIndex];
  if (qIdx === undefined) return;
  var word = allData[qIdx];
  if (!word) return;
  var audioUrl = 'audio/w_' + word.id + '.mp3' + AUDIO_VERSION;
  playAudioDirect(audioUrl);
}

function speakPhrases() {
  var qIdx = learnQueue[currentIndex];
  if (qIdx === undefined) return;
  var word = allData[qIdx];
  if (!word) return;
  var phrasesEl = document.getElementById('wc-phrases');
  if (!phrasesEl || !phrasesEl.textContent || phrasesEl.textContent === '—') return;
  var audioUrl = 'audio/p_' + word.id + '.mp3' + AUDIO_VERSION;
  playAudioDirect(audioUrl);
}

function speakExample(idx) {
  var qIdx = learnQueue[currentIndex];
  if (qIdx === undefined) return;
  var word = allData[qIdx];
  if (!word) return;
  var wid = word.id;
  var audioUrl = 'audio/e_' + wid + '_' + (idx + 1) + '.mp3' + AUDIO_VERSION;
  playAudioDirect(audioUrl);
}

// 直接播放音频文件的核心函数
function playAudioDirect(url) {
  // 停止之前的
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  
  var audio = new Audio(url);
  currentAudio = audio;
  
  audio.onended = function() { currentAudio = null; };
  audio.onerror = function(e) {
    console.warn('音频播放失败:', url, e);
    currentAudio = null;
    // 降级到TTS
    // 从URL反推文本
    var text = '';
    try {
      var parts = url.replace('audio/', '').replace('.mp3', '').split('_');
      var type = parts[0]; // w, p, or e
      var id = parseInt(parts[1]);
      var w = allData.find(function(x) { return x.id === id; });
      if (w) {
        if (type === 'w') { text = w.word; }
        else if (type === 'p') {
          var cp = cleanPhrases(w.phrases);
          text = cp || w.word;
        } else if (type === 'e') {
          var exIdx = parseInt(parts[2]) - 1;
          var examples = buildExamples(w);
          if (examples[exIdx]) text = examples[exIdx].en;
          else text = w.word;
        }
      }
    } catch(err) {}
    
    if (text) speakFallback(text, 'en-US', 0.8).then(function(){});
    else showToast('⚠️ 音频加载失败，请检查网络');
  };
  
  var playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(function(err) {
      console.warn('audio.play被拒绝:', err);
      // 自动播放策略限制时尝试TTS
      showToast('🔊 请点击喇叭图标再次播放');
    });
  }
}

// 朗读整个单词（单词+词组+例句）- 使用预生成音频
async function speakAll() {
  var qIdx = learnQueue[currentIndex];
  if (qIdx === undefined) return;
  var word = allData[qIdx];
  if (!word) return;
  
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  
  // 1. 播放单词音频
  var wAudio = 'audio/w_' + word.id + '.mp3' + AUDIO_VERSION;
  await playAudioAndWait(wAudio);
  await new Promise(r => setTimeout(r, 300));
  
  // 2. 播放词组音频
  var phrasesEl = document.getElementById('wc-phrases');
  if (phrasesEl && phrasesEl.textContent && phrasesEl.textContent !== '—') {
    var pAudio = 'audio/p_' + word.id + '.mp3' + AUDIO_VERSION;
    await playAudioAndWait(pAudio);
    await new Promise(r => setTimeout(r, 200));
  }
  
  // 3. 播放3个例句音频
  for (let i = 0; i < 3; i++) {
    var eAudio = 'audio/e_' + word.id + '_' + (i+1) + '.mp3' + AUDIO_VERSION;
    await playAudioAndWait(eAudio);
    await new Promise(r => setTimeout(r, 150));
  }
}

// 播放音频并等待完成
function playAudioAndWait(url) {
  return new Promise((resolve) => {
    var audio = new Audio(url);
    currentAudio = audio;
    
    audio.onended = function() {
      currentAudio = null;
      resolve();
    };
    
    audio.onerror = function() {
      console.warn('音频播放失败:', url);
      currentAudio = null;
      resolve();  // 即使失败也继续
    };
    
    audio.play().catch(function(err) {
      console.warn('播放被拒绝:', err);
      currentAudio = null;
      resolve();
    });
  });
}

// ---- 语音识别（跟读） ----
// 方案：MediaRecorder录音 → 上传后端API → Google语音识别 → 评分
// 这个方案比浏览器原生SpeechRecognition更可靠
var speakTargetText = ''; // 当前要读的文本

// MediaRecorder 相关状态
var mediaRecorder = null;
var audioChunks = [];
var mediaStream = null;
var micStartTime = 0; // 录音开始时间戳

// 后端API地址（自动检测：同源使用相对路径，不同源用完整URL）
var TRANSCRIBE_API = '/api/transcribe';

// 语音识别模式：'backend'(后端API) | 'browser'(浏览器原生) | 'unknown'(未检测)
var SPEECH_MODE = 'unknown';
var speechModePromise = null;
// 浏览器原生 SpeechRecognition 相关状态
var webRecognition = null;
var recognitionFinalText = '';
var recognitionInterimText = '';
var recognitionDone = false;
var micUpTriggered = false; // 标记是否已触发松手停止

function initSpeechRecognition() {
  // 只使用 MediaRecorder 方案（录音上传后端识别）
  // 不再使用浏览器原生 SpeechRecognition（国内手机无法访问 Google 服务器）
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    var tip = document.getElementById('speak-tip');
    if (tip) tip.innerHTML = '⚠️ 当前浏览器不支持录音<br>请使用 <b>Chrome</b> 或 <b>Safari</b> 浏览器';
    return false;
  }
  return true;
}

// 设置跟读目标
function setSpeakTarget(target) {
  speakTarget = target;
  document.querySelectorAll('.speak-target-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`st-${target}`).classList.add('active');
  updateSpeakTargetDisplay();
  playSpeakTargetAudio();
}

function updateSpeakTargetDisplay() {
  const qIdx = learnQueue[currentIndex];
  if (qIdx === undefined) return;
  const word = allData[qIdx];
  if (!word) return;
  
  const display = document.getElementById('speak-target-display');
  
  if (speakTarget === 'phrase') {
    const phrases = cleanPhrases(word.phrases);
    if (phrases) {
      speakTargetText = phrases;
      display.textContent = phrases;
    } else {
      // 没有词组时回退到例句
      const examples = buildExamples(word);
      speakTargetText = examples.length > 0 ? examples[0].en : word.word;
      display.textContent = speakTargetText;
    }
  } else {
    const examples = buildExamples(word);
    if (examples.length > 0) {
      speakTargetText = examples[0].en;
      display.textContent = examples[0].en;
    } else {
      speakTargetText = word.word;
      display.textContent = word.word;
    }
  }
}

function playSpeakTargetAudio() {
  if (!speakTargetText) return;
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  speak(speakTargetText, 'en-US', 0.85);
}

// =====================================================
// 按下麦克风 —— 开始录音（MediaRecorder 方案）
// 录音上传到后端 API（Netlify Serverless Function）识别
// =====================================================
function micDown() {
  // 防止重复触发
  if (isRecording || micStarting) {
    console.log('[MIC] 已在录音中，忽略重复触发');
    return;
  }

  // 检查浏览器支持
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    showToast('浏览器不支持录音，请使用Chrome或Safari');
    return;
  }

  // 重置状态
  micStarting = true;
  evaluatedAlready = false;
  isRecording = false;
  audioChunks = [];

  // 停止正在播放的音频
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }

  var tipEl = document.getElementById('speak-tip');
  if (tipEl) tipEl.textContent = '';

  // 显示录音中UI：变橘色
  var btn = document.getElementById('btn-mic');
  if (btn) btn.classList.add('recording');
  var ind = document.getElementById('recording-indicator');
  if (ind) ind.style.display = 'flex';
  var label = document.getElementById('mic-label');
  if (label) label.textContent = '正在聆听...';

  console.log('[MIC] 正在请求麦克风权限...');

  // 请求麦克风权限并开始录音
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(function(stream) {
      mediaStream = stream;
      
      // 选择浏览器支持的音频格式
      var mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/ogg';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = ''; // 让浏览器自动选择
        }
      }
      
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
      audioChunks = [];
      
      mediaRecorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };
      
      mediaRecorder.onstop = function() {
        // 录音停止后，上传识别
        console.log('[MIC] 录音停止，准备上传识别，音频片段数: ' + audioChunks.length);
        uploadAndTranscribe();
      };
      
      mediaRecorder.onerror = function(e) {
        console.error('[MIC] MediaRecorder错误:', e);
        cleanupMic();
        restoreMicUI();
        if (!evaluatedAlready) {
          evaluatedAlready = true;
          showScoreModal(0, '录音出错，请重试');
        }
      };
      
      // 开始录音
      mediaRecorder.start();
      isRecording = true;
      micStarting = false;
      micStartTime = Date.now();
      console.log('[MIC] 录音已开始');
      var label2 = document.getElementById('mic-label');
      if (label2) label2.textContent = '松手结束';

      // 在document级别注册松手事件
      document.addEventListener('touchend', _docTouchEnd, {passive: false});
      document.addEventListener('touchcancel', _docTouchCancel, {passive: false});
      document.addEventListener('mouseup', _docMouseUp, {passive: false});

      // 超时安全网：15秒自动停止
      clearMicTimeout();
      micTimeoutTimer = setTimeout(function() {
        if (!isRecording) return;
        console.log('[MIC] 录音超时(15秒)');
        micUp();
      }, 15000);
      
    })
    .catch(function(err) {
      console.error('[MIC] 麦克风权限获取失败:', err.name, err.message);
      micStarting = false;
      isRecording = false;
      restoreMicUI();
      if (!evaluatedAlready) {
        evaluatedAlready = true;
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showScoreModal(0, '麦克风权限被拒绝，请点击地址栏🔒图标允许麦克风');
        } else if (err.name === 'NotFoundError') {
          showScoreModal(0, '未找到麦克风设备，请检查手机麦克风是否正常');
        } else {
          showScoreModal(0, '麦克风启动失败(' + err.name + ')，请重试');
        }
      }
    });
}

// =====================================================
// 松开麦克风 —— 停止录音，触发上传识别
// =====================================================
function micUp() {
  if (!isRecording && !micStarting) return;

  // 移除松手事件监听
  document.removeEventListener('touchend', _docTouchEnd);
  document.removeEventListener('touchcancel', _docTouchCancel);
  document.removeEventListener('mouseup', _docMouseUp);
  clearMicTimeout();
  
  if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') {
    // 停止录音，onstop回调里会自动上传识别
    try { mediaRecorder.stop(); } catch(e) { console.warn('[MIC] stop失败:', e); }
    isRecording = false;
    micStarting = false;
    
    // 显示"识别中"状态
    var label = document.getElementById('mic-label');
    if (label) label.textContent = '识别中...';
    var btn = document.getElementById('btn-mic');
    if (btn) btn.classList.remove('recording'); // 变回蓝色
    var ind = document.getElementById('recording-indicator');
    if (ind) ind.style.display = 'none';
  } else {
    // 还没开始录音就松手了（micStarting=true但isRecording=false）
    micStarting = false;
    isRecording = false;
    restoreMicUI();
  }
}

// =====================================================
// 上传音频到后端识别
// 浏览器端将 webm 转为 16kHz mono PCM，上传 raw 数据
// Serverless Function 无需 ffmpeg，直接转发给 Google API
// =====================================================
function uploadAndTranscribe() {
  // 检查录音数据
  if (!audioChunks || audioChunks.length === 0) {
    console.warn('[MIC] 没有录音数据');
    cleanupMic();
    restoreMicUI();
    if (!evaluatedAlready) {
      evaluatedAlready = true;
      showScoreModal(0, '录音太短，请按住麦克风大声朗读');
    }
    return;
  }

  var audioBlob = new Blob(audioChunks, { type: audioChunks[0].type || 'audio/webm' });
  console.log('[MIC] 音频大小: ' + audioBlob.size + ' bytes, 类型: ' + audioBlob.type);

  if (audioBlob.size < 200) {
    console.warn('[MIC] 录音数据太小: ' + audioBlob.size + ' bytes');
    cleanupMic();
    restoreMicUI();
    if (!evaluatedAlready) {
      evaluatedAlready = true;
      showScoreModal(0, '录音太短，请按住麦克风大声朗读');
    }
    return;
  }

  // 显示上传中
  var label = document.getElementById('mic-label');
  if (label) label.textContent = '识别中...';

  // 超时保护：25秒
  var uploadTimeout = setTimeout(function() {
    if (evaluatedAlready) return;
    console.warn('[MIC] 上传识别超时');
    cleanupMic();
    restoreMicUI();
    evaluatedAlready = true;
    showScoreModal(0, '识别超时，请检查网络后重试');
  }, 25000);

  // 浏览器端转换：webm → 16kHz mono PCM
  convertToPcm16(audioBlob)
    .then(function(pcmData) {
      console.log('[MIC] PCM转换成功: ' + pcmData.byteLength + ' bytes');
      // 上传 raw PCM
      var formData = new FormData();
      formData.append('audio', new Blob([pcmData], { type: 'audio/l16' }), 'recording.pcm');

      return fetch(TRANSCRIBE_API, {
        method: 'POST',
        body: formData
      });
    })
    .then(function(response) {
      console.log('[MIC] 后端响应状态: ' + response.status);
      return response.json();
    })
    .then(function(data) {
      clearTimeout(uploadTimeout);
      cleanupMic();
      restoreMicUI();

      if (evaluatedAlready) return;

      console.log('[MIC] 识别结果:', data);

      if (data.success && data.text) {
        evaluateSpeaking(data.text);
      } else {
        evaluatedAlready = true;
        var errMsg = data.error || '未能识别语音，请重试';
        showScoreModal(0, errMsg);
      }
    })
    .catch(function(err) {
      clearTimeout(uploadTimeout);
      cleanupMic();
      restoreMicUI();

      console.error('[MIC] 上传失败:', err);
      if (!evaluatedAlready) {
        evaluatedAlready = true;
        showScoreModal(0, '网络错误，无法连接语音识别服务，请检查网络后重试');
      }
    });
}

// 将音频 Blob 转换为 16kHz mono 16-bit PCM (ArrayBuffer)
function convertToPcm16(audioBlob) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() {
      var arrayBuffer = reader.result;

      // 用 AudioContext 解码音频
      var AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        reject(new Error('浏览器不支持 AudioContext'));
        return;
      }

      var audioCtx = new AudioContextClass();
      audioCtx.decodeAudioData(arrayBuffer)
        .then(function(audioBuffer) {
          console.log('[MIC] 解码成功: ' + audioBuffer.duration.toFixed(2) + 's, ' + audioBuffer.sampleRate + 'Hz, ' + audioBuffer.numberOfChannels + 'ch');

          // 用 OfflineAudioContext 重采样到 16kHz mono
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
          // 提取 Float32 样本，转为 Int16 PCM
          var float32Data = renderedBuffer.getChannelData(0);
          var pcm16 = new Int16Array(float32Data.length);

          // 检测音量
          var sumSq = 0;
          for (var i = 0; i < float32Data.length; i++) {
            var s = float32Data[i];
            // 限幅
            s = Math.max(-1, Math.min(1, s));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            sumSq += s * s;
          }

          var rms = Math.sqrt(sumSq / float32Data.length);
          console.log('[MIC] PCM: ' + pcm16.length + ' samples, RMS=' + rms.toFixed(4) + ', duration=' + (pcm16.length / 16000).toFixed(2) + 's');

          if (rms < 0.01) {
            reject(new Error('SILENT'));
            return;
          }

          // 关闭 audioCtx
          if (audioCtx.close) audioCtx.close();

          resolve(pcm16.buffer);
        })
        .catch(function(err) {
          if (audioCtx.close) audioCtx.close();
          console.error('[MIC] 解码失败:', err);
          reject(err);
        });
    };
    reader.onerror = function() {
      reject(new Error('文件读取失败'));
    };
    reader.readAsArrayBuffer(audioBlob);
  });
}

// 清理麦克风资源
function cleanupMic() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(function(t) { t.stop(); });
    mediaStream = null;
  }
  mediaRecorder = null;
  audioChunks = [];
}

// 识别结束后恢复UI
function restoreMicUI() {
  var btn = document.getElementById('btn-mic');
  if (btn) btn.classList.remove('recording');
  var ind = document.getElementById('recording-indicator');
  if (ind) ind.style.display = 'none';
  var label = document.getElementById('mic-label');
  if (label) label.textContent = '按住说话';
}

// 重置麦克风UI到默认状态
function resetMicUI(keepLabel) {
  clearMicTimeout();
  var btn = document.getElementById('btn-mic');
  if (btn) btn.classList.remove('recording');
  var ind = document.getElementById('recording-indicator');
  if (ind) ind.style.display = 'none';
  if (!keepLabel) {
    var label = document.getElementById('mic-label');
    if (label) label.textContent = '按住说话';
  }
}

// Document级别的事件处理
function _docTouchEnd(e) { 
  e.preventDefault();
  micUp(); 
}
function _docTouchCancel() { 
  // 忽略 touchcancel，防止误触松手
}
function _docMouseUp() { micUp(); }

function clearMicTimeout() {
  if (micTimeoutTimer) {
    clearTimeout(micTimeoutTimer);
    micTimeoutTimer = null;
  }
}

function evaluateSpeaking(recognized) {
  // 防止多次弹窗
  if (evaluatedAlready) return;
  evaluatedAlready = true;

  var target = (speakTargetText || speakPracticeTarget || '').toLowerCase().trim();
  recognized = (recognized || '').toLowerCase().trim();

  var score = 0;
  var detail = '';

  if (!recognized) {
    score = 0;
    detail = '没有听到您的声音，请按住麦克风再试一次';
  } else if (recognized === target) {
    score = 100;
    detail = '发音非常标准！';
  } else if (recognized.includes(target)) {
    // 识别结果包含目标词（可能有额外内容如 "let uh"）
    score = 90;
    detail = '很好！发音正确';
  } else if (target.includes(recognized)) {
    score = 85;
    detail = '发音不错，已包含目标内容';
  } else {
    // 清理识别结果中常见的填充词后再比对
    var cleanRecognized = recognized
      .replace(/\s*(uh|um|ah|er|mm|hm)\s*/g, ' ')   // 去掉语气词
      .replace(/^(the|a|an|i|it|is|to|my|we|they)\s+/, '')  // 去掉开头的常见词
      .replace(/\s+(the|a|an|is|was|were|to|for|on|in|at)$/, '')  // 去掉结尾的常见词
      .replace(/[.,!?;:]/g, '')            // 去掉标点
      .replace(/\s+/g, ' ')
      .trim();

    // 尝试用清理后的文本匹配
    if (cleanRecognized === target) {
      score = 95;
      detail = '发音正确！';
    } else if (cleanRecognized.includes(target) || target.includes(cleanRecognized)) {
      score = 85;
      detail = '基本正确，注意清晰度';
    } else {
      // 用原始文本和清理后的文本分别计算相似度，取较高者
      var sim1 = similarity(recognized, target);
      var sim2 = similarity(cleanRecognized, target);
      var bestSim = Math.max(sim1, sim2);
      score = Math.round(bestSim * 100);
      detail = score >= 70 ? '基本正确，注意个别发音' : '发音偏差较大，请多听标准发音后再试';
    }
  }

  // 弹窗显示分数
  showScoreModal(score, detail);

  // 提示再试一次
  var tipEl = document.getElementById('speak-tip');
  if (tipEl) tipEl.textContent = '按住麦克风再试一次';

  // 保存跟读成绩
  var ud = getUserData();
  if (ud) {
    var qIdx = learnQueue[currentIndex];
    var word = allData[qIdx];
    if (word) {
      if (!ud.speakScores) ud.speakScores = {};
      ud.speakScores[word.id] = Math.max(ud.speakScores[word.id] || 0, score);
      // 跟读分数达到80以上标记为掌握
      if (score >= 80 && ud.masteredIds && !ud.masteredIds.includes(word.id)) {
        ud.masteredIds.push(word.id);
      }
      saveUserData(ud);
    }
  }
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  const editDist = levenshtein(longer, shorter);
  return (longer.length - editDist) / longer.length;
}

function levenshtein(s, t) {
  const m = s.length, n = t.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = s[i-1] === t[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// ---- 导航 ----
function prevWord() {
  if (currentIndex > 0) {
    currentIndex--;
    renderLearnPage();
  } else {
    showToast('已经是第一个单词了');
  }
}

function nextWord() {
  if (currentIndex < learnQueue.length - 1) {
    currentIndex++;
    renderLearnPage();
    // 保存进度
    if (learnMode === 'sequential') {
      const ud = getUserData();
      if (ud) { ud.lastIndex = learnQueue[currentIndex]; saveUserData(ud); }
    }
  } else {
    // 学习完成
    finishLearnSession();
  }
}

function exitLearn() {
  endStudyTimer();
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (webRecognition) { try { webRecognition.abort(); } catch(e) {} webRecognition = null; }
  if (mediaRecorder && isRecording) { try { mediaRecorder.stop(); } catch(e) {} }
  if (mediaStream) { mediaStream.getTracks().forEach(function(t) { t.stop(); }); mediaStream = null; }
  updateHomeStats();
  updateRecentWord();
  showPage('page-home');
}

function finishLearnSession() {
  endStudyTimer();
  // 记录本次学习
  const ud = getUserData();
  if (ud) {
    if (!ud.sessions) ud.sessions = [];
    ud.sessions.push({
      date: Date.now(),
      mode: learnMode,
      count: learnQueue.length,
      score: calcAvgScore(ud),
    });
    saveUserData(ud);
  }
  showToast('🎉 本轮学习完成！');
  setTimeout(() => {
    updateHomeStats();
    showPage('page-home');
  }, 1500);
}

// ---- 标记已学/收藏 ----
function markLearned(wordId) {
  const ud = getUserData();
  if (!ud) return;
  if (!ud.learnedIds.includes(wordId)) {
    ud.learnedIds.push(wordId);
    saveUserData(ud);
  }
  markStudyDate();
}

function markStudyDate() {
  const ud = getUserData();
  if (!ud) return;
  const today = new Date().toDateString();
  if (!ud.studyDates) ud.studyDates = [];
  if (!ud.studyDates.includes(today)) {
    ud.studyDates.push(today);
    saveUserData(ud);
  }
}

function toggleFavorite() {
  const qIdx = learnQueue[currentIndex];
  const word = allData[qIdx];
  if (!word) return;
  const ud = getUserData();
  if (!ud) return;
  const idx = ud.favoriteIds.indexOf(word.id);
  if (idx >= 0) {
    ud.favoriteIds.splice(idx, 1);
    document.getElementById('btn-fav').textContent = '☆';
    showToast('已取消收藏');
  } else {
    ud.favoriteIds.push(word.id);
    document.getElementById('btn-fav').textContent = '★';
    showToast('已加入收藏');
  }
  saveUserData(ud);
}

// ---- 单词列表 ----
function renderWordList(filter = 'all', search = '') {
  const container = document.getElementById('wordlist-container');
  if (!container) return;
  const ud = getUserData() || { learnedIds: [], masteredIds: [], favoriteIds: [] };
  const learnedSet = new Set(ud.learnedIds);
  const masteredSet = new Set(ud.masteredIds);

  let filtered = allData.filter(w => {
    const matchSearch = !search || w.word.includes(search.toLowerCase()) || (w.zh || '').includes(search);
    const matchFilter = filter === 'all' ? true
      : filter === 'learned' ? learnedSet.has(w.id)
      : filter === 'mastered' ? masteredSet.has(w.id)
      : !learnedSet.has(w.id);
    return matchSearch && matchFilter;
  });

  container.innerHTML = filtered.map(w => {
    const status = masteredSet.has(w.id) ? '⭐' : learnedSet.has(w.id) ? '✅' : '○';
    return `
      <div class="word-list-item" onclick="jumpToWord(${w.id})">
        <div class="wli-num">${w.id}</div>
        <div class="wli-word">
          <div class="wli-word-en">${w.word}</div>
          <div class="wli-word-zh">${w.zh || ''}</div>
        </div>
        <div class="wli-status">${status}</div>
        <button class="wli-btn-speak" onclick="event.stopPropagation();speak('${w.word}','en-US',0.8)">🔊</button>
      </div>
    `;
  }).join('');
}

function filterWords() {
  const search = document.getElementById('wl-search').value.trim();
  const filter = document.getElementById('wl-filter').value;
  renderWordList(filter, search);
}

function jumpToWord(wordId) {
  const idx = allData.findIndex(w => w.id === wordId);
  if (idx < 0) return;
  learnMode = 'sequential';
  learnQueue = allData.map((_, i) => i);
  currentIndex = idx;
  renderLearnPage();
  showPage('page-learn');
  startStudyTimer();
}

// ---- 报告 ----
function generateReport() {
  const ud = getUserData();
  if (!ud) return;

  const total = allData.length;
  const learned = ud.learnedIds.length;
  const mastered = ud.masteredIds.length;
  const avgSpeak = calcAvgScore(ud);
  const progress = (learned / total * 100).toFixed(1);
  const sessions = ud.sessions || [];
  const studyMins = Math.floor((ud.totalStudySeconds || 0) / 60);
  const days = (ud.studyDates || []).length || 1;

  // 综合评分
  let score = 0;
  score += Math.min(40, (learned / total) * 40); // 学习进度40%
  score += Math.min(30, (mastered / Math.max(learned, 1)) * 30); // 掌握率30%
  score += Math.min(20, (avgSpeak / 100) * 20); // 跟读成绩20%
  score += Math.min(10, Math.min(days, 10)); // 坚持天数10%
  score = Math.round(score);

  document.getElementById('report-score').textContent = score;

  // 统计
  document.getElementById('report-stats').innerHTML = `
    <div class="rs-item"><div class="rs-val">${learned}</div><div class="rs-key">已学单词</div></div>
    <div class="rs-item"><div class="rs-val">${mastered}</div><div class="rs-key">已掌握</div></div>
    <div class="rs-item"><div class="rs-val">${progress}%</div><div class="rs-key">学习进度</div></div>
    <div class="rs-item"><div class="rs-val">${studyMins}分</div><div class="rs-key">累计学习时长</div></div>
    <div class="rs-item"><div class="rs-val">${days}</div><div class="rs-key">学习天数</div></div>
    <div class="rs-item"><div class="rs-val">${avgSpeak || '--'}</div><div class="rs-key">跟读平均分</div></div>
  `;

  // 改进建议
  const suggestions = generateSuggestions({ learned, mastered, total, avgSpeak, days, studyMins });
  document.getElementById('report-suggestions').innerHTML = suggestions.map(s => 
    `<div class="suggestion-item">${s.icon} <span>${s.text}</span></div>`
  ).join('');

  // 学习记录
  const recentSessions = sessions.slice(-7).reverse();
  document.getElementById('report-history').innerHTML = recentSessions.length ? 
    recentSessions.map(s => `
      <div class="history-item">
        <span class="history-date">${formatDate(s.date)}</span>
        <span>学习${s.count}词 · ${modeLabel(s.mode)}</span>
        <span style="color:var(--primary)">${s.score}分</span>
      </div>
    `).join('') : '<div style="color:var(--text-sub);text-align:center;padding:16px">暂无学习记录</div>';
}

function generateSuggestions({ learned, mastered, total, avgSpeak, days, studyMins }) {
  const suggestions = [];
  const progress = learned / total;

  if (progress < 0.1) {
    suggestions.push({ icon: '🚀', text: `您刚刚开始学习，建议每天坚持学习20-30个单词，保持学习节奏很重要！` });
  } else if (progress < 0.5) {
    suggestions.push({ icon: '📈', text: `已学习${learned}个单词，进展不错！继续保持，距离完成还有${total - learned}词。` });
  } else {
    suggestions.push({ icon: '🏆', text: `已完成超过一半的学习量，非常棒！坚持到最后！` });
  }

  if (avgSpeak > 0 && avgSpeak < 70) {
    suggestions.push({ icon: '🎤', text: `跟读平均分${avgSpeak}分，建议多做口语练习，注意听标准发音后再跟读。` });
  } else if (avgSpeak >= 70) {
    suggestions.push({ icon: '🎯', text: `跟读得分${avgSpeak}分，发音表现良好！继续保持。` });
  } else {
    suggestions.push({ icon: '🎤', text: `还没有进行跟读练习，建议在学习单词后使用麦克风跟读，强化发音记忆。` });
  }

  if (mastered < learned * 0.5 && learned > 10) {
    suggestions.push({ icon: '🔄', text: `已学${learned}词但掌握了${mastered}词，建议多用复习模式强化记忆，提高掌握率。` });
  }

  if (days < 3) {
    suggestions.push({ icon: '📅', text: `坚持学习天数较少，建议每天定时学习，养成良好的英语学习习惯。` });
  } else {
    suggestions.push({ icon: '🔥', text: `已坚持${days}天，坚持就是胜利！` });
  }

  if (studyMins < 10) {
    suggestions.push({ icon: '⏱️', text: `每次学习时间可以适当延长，建议每天至少学习15-20分钟效果更佳。` });
  }

  return suggestions.slice(0, 4);
}

// ---- 拼写练习 ----
let spellCurrentWord = null;

function renderSpellPage() {
  const qIdx = learnQueue[currentIndex];
  if (qIdx === undefined) return;
  const word = allData[qIdx];
  if (!word) return;
  spellCurrentWord = word;

  document.getElementById('spell-current').textContent = currentIndex + 1;
  document.getElementById('spell-total').textContent = learnQueue.length;
  document.getElementById('spell-progress-bar').style.width = ((currentIndex + 1) / learnQueue.length * 100).toFixed(1) + '%';
  document.getElementById('spell-zh').textContent = word.zh || '';
  document.getElementById('spell-pos').textContent = word.pos || '';

  const input = document.getElementById('spell-input');
  input.value = '';
  input.disabled = false;
  input.style.display = '';
  document.getElementById('spell-feedback').style.display = 'none';
  document.getElementById('spell-actions').style.display = 'none';

  setTimeout(() => { playSpellAudio(); input.focus(); }, 400);
  markStudyDate();
}

function playSpellAudio() {
  if (!spellCurrentWord) return;
  playAudioDirect('audio/w_' + spellCurrentWord.id + '.mp3' + AUDIO_VERSION);
}

function onSpellKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitSpell();
  }
}

function submitSpell() {
  if (!spellCurrentWord) return;
  const input = document.getElementById('spell-input');
  const userInput = input.value.trim().toLowerCase();
  const correctWord = spellCurrentWord.word.toLowerCase().trim();
  if (!userInput) { showToast('请输入单词'); return; }

  input.disabled = true;
  const feedback = document.getElementById('spell-feedback');
  const resultIcon = document.getElementById('spell-result-icon');
  const resultWord = document.getElementById('spell-result-word');
  const resultMsg = document.getElementById('spell-result-msg');
  const actions = document.getElementById('spell-actions');
  feedback.style.display = 'block';
  actions.style.display = 'flex';

  if (userInput === correctWord) {
    resultIcon.textContent = '👍';
    resultIcon.className = 'spell-result-icon correct';
    resultWord.textContent = spellCurrentWord.word;
    resultMsg.textContent = '拼写正确！';
    actions.style.display = 'none';
    markLearned(spellCurrentWord.id);
    setTimeout(() => nextSpell(), 1500);
  } else {
    resultIcon.textContent = '💪';
    resultIcon.className = 'spell-result-icon wrong';
    resultWord.textContent = '正确答案：' + spellCurrentWord.word;
    resultMsg.textContent = '你的答案：' + input.value;
    document.getElementById('spell-next-btn').textContent = '再试一次';
    // 错误时清空输入框允许重试
    input.disabled = false;
    input.value = '';
    input.focus();
    // 隐藏actions，等重新答对再显示
    actions.style.display = 'none';
    feedback.style.display = 'block';
  }
}

function nextSpell() {
  if (currentIndex < learnQueue.length - 1) {
    currentIndex++;
    const ud = getUserData();
    if (ud) { ud.lastIndex = learnQueue[currentIndex]; saveUserData(ud); }
    renderSpellPage();
  } else {
    finishLearnSession();
  }
}

function exitSpell() {
  endStudyTimer();
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  const ud = getUserData();
  if (ud) { ud.lastIndex = learnQueue[currentIndex]; saveUserData(ud); }
  updateHomeStats();
  updateRecentWord();
  showPage('page-home');
}

// ---- 工具函数 ----

// 评分弹窗
function showScoreModal(score, detail) {
  var mask = document.getElementById('score-modal-mask');
  if (!mask) return;
  var scoreEl = document.getElementById('score-modal-score');
  var msgEl = document.getElementById('score-modal-msg');
  var detailEl = document.getElementById('score-modal-detail');
  var iconEl = document.getElementById('score-modal-icon');

  scoreEl.textContent = score + '分';
  scoreEl.className = 'score-modal-score';
  detailEl.textContent = detail || '';

  var msg = '';
  var icon = '';
  if (score >= 90) {
    scoreEl.classList.add('good');
    msg = '太棒了！';
    icon = '🎉';
  } else if (score >= 70) {
    scoreEl.classList.add('ok');
    msg = '不错！';
    icon = '👍';
  } else {
    scoreEl.classList.add('bad');
    msg = '继续加油！';
    icon = '💪';
  }
  msgEl.textContent = msg;
  iconEl.textContent = icon;

  mask.classList.add('show');
}

function closeScoreModal() {
  var mask = document.getElementById('score-modal-mask');
  if (mask) mask.classList.remove('show');
}

// 跟读区展开/收起
function toggleSpeakZone() {
  var zone = document.getElementById('speak-zone');
  var label = document.getElementById('drag-label');
  if (!zone) return;
  speakZoneExpanded = !speakZoneExpanded;
  if (speakZoneExpanded) {
    zone.classList.add('expanded');
    if (label) label.textContent = '点击收回跟读区 ▼';
  } else {
    zone.classList.remove('expanded');
    if (label) label.textContent = '点击打开跟读区 ▲';
  }
}

function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// 调试信息面板（已关闭，不显示）
function showDebugInfo(msg) {
  // 调试面板已关闭，不再显示
  console.log('[DEBUG] ' + msg);
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

function modeLabel(mode) {
  const m = { sequential: '顺序', review: '复习', practice: '拼写', test: '测试' };
  return m[mode] || mode;
}
