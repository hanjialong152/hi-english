/* Hi English - Common JavaScript */
const HiEnglish = {
  // Data caches
  words850: null,
  lessons116: null,
  currentUser: null,
  _ttsVoices: [],
  _bestVoice: null,

  // ===== Server URL detection =====
  // 自动检测服务端地址：线上部署用同域，本地开发用 Render
  getServerUrl() {
    var host = window.location.hostname;
    // 线上部署（Render / CloudStudio）或本地 Flask 服务器：同域
    if (host.indexOf('onrender.com') >= 0 || host.indexOf('codebuddy.work') >= 0 ||
        host === 'localhost' || host === '127.0.0.1') {
      return window.location.origin;
    }
    return 'https://hi-english.onrender.com';
  },

  // ===== Server login (cross-device authentication) =====
  async serverLogin(account, password) {
    try {
      var resp = await fetch(this.getServerUrl() + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empid: account, password: password })
      });
      var data = await resp.json();
      if (data.success) {
        // 将服务端用户信息同步到 localStorage（供离线使用）
        var users = this.getUsers();
        users[account] = {
          empid: data.user.empid,
          name: data.user.name,
          group: data.user.group || '',
          status: data.user.status || 'active',
          password: password
        };
        this.saveUsers(users);
        // 设置 sessionStorage 登录状态（仅当前浏览器标签页有效）
        this.currentUser = Object.assign({}, users[account], { role: 'student' });
        sessionStorage.setItem('hi_english_user', JSON.stringify(this.currentUser));
        return { success: true, user: this.currentUser };
      }
      return { success: false, message: data.error || '账号或密码错误' };
    } catch(e) {
      console.log('[ServerLogin] 服务端不可达，降级到本地:', e.message);
      return null; // null 表示服务端不可达
    }
  },

  // ===== Fetch study data from server =====
  async fetchServerStudyData(empid) {
    try {
      var resp = await fetch(this.getServerUrl() + '/api/study-data?empid=' + encodeURIComponent(empid));
      var data = await resp.json();
      if (data.success && data.studyData) {
        // 将服务端数据写入 localStorage
        var all = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
        all[empid] = data.studyData;
        localStorage.setItem('hi_english_study', JSON.stringify(all));
        console.log('[Sync] 从服务端拉取学习数据成功');
        return data.studyData;
      }
      console.log('[Sync] 服务端无学习数据');
      return null;
    } catch(e) {
      console.log('[Sync] 拉取学习数据失败:', e.message);
      return null;
    }
  },

  // ===== Push study data to server (debounced) =====
  _syncTimer: null,
  _lastPushedData: null,
  pushServerStudyData(empid, data) {
    var self = this;
    this._lastPushedData = { empid: empid, data: data };
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(function() {
      self._doPush(empid, data);
    }, 2000); // 2秒防抖
  },

  // 立即推送未保存的数据（页面隐藏/关闭时调用）
  flushServerStudyData() {
    if (this._syncTimer && this._lastPushedData) {
      clearTimeout(this._syncTimer);
      this._syncTimer = null;
      var pending = this._lastPushedData;
      this._lastPushedData = null;
      // 使用 sendBeacon 确保页面关闭时数据也能发送
      if (navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify({ empid: pending.empid, studyData: pending.data })], { type: 'application/json' });
        navigator.sendBeacon(this.getServerUrl() + '/api/study-data', blob);
        console.log('[Sync] 学习数据已通过sendBeacon紧急推送');
      } else {
        this._doPush(pending.empid, pending.data);
      }
    }
  },

  _doPush(empid, data) {
    var self = this;
    fetch(self.getServerUrl() + '/api/study-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empid: empid, studyData: data })
    }).then(function(resp) {
      console.log('[Sync] 学习数据已推送到服务端');
    }).catch(function(e) {
      console.log('[Sync] 推送学习数据失败:', e.message);
    });
  },

  // ===== Sync users from server (for admin) =====
  async syncUsersFromServer() {
    try {
      var resp = await fetch(this.getServerUrl() + '/api/users');
      var data = await resp.json();
      if (data.success && data.users) {
        // 服务端数据为唯一数据源，完全覆盖本地
        var merged = {};
        var localUsers = this.getUsers();
        for (var empid in data.users) {
          var serverUser = data.users[empid];
          var localUser = localUsers[empid];
          merged[empid] = {
            empid: serverUser.empid,
            name: serverUser.name,
            group: serverUser.group || '',
            status: serverUser.status || 'active',
            password: localUser ? localUser.password : '123@456.com'
          };
        }
        this.saveUsers(merged);
        console.log('[Sync] 从服务端同步用户列表成功:', Object.keys(merged).length, '人');
        return merged;
      }
    } catch(e) {
      console.log('[Sync] 同步用户列表失败:', e.message);
    }
    return null;
  },

  // ===== Sync groups from server =====
  async syncGroupsFromServer() {
    try {
      var resp = await fetch(this.getServerUrl() + '/api/groups');
      var data = await resp.json();
      if (data.success && data.groups) {
        this.saveGroups(data.groups);
        console.log('[Sync] 从服务端同步分组成功');
        return data.groups;
      }
    } catch(e) {
      console.log('[Sync] 同步分组失败:', e.message);
    }
    return null;
  },

  async syncStudyDataFromServer() {
    try {
      var token = sessionStorage.getItem('hi_english_admin_token') || '';
      var resp = await fetch(this.getServerUrl() + '/api/admin/study-data?token=' + encodeURIComponent(token));
      var data = await resp.json();
      if (data.success && data.studyData) {
        // 服务端数据为唯一数据源，完全覆盖本地
        localStorage.setItem('hi_english_study', JSON.stringify(data.studyData));
        console.log('[Sync] 从服务端同步学习数据成功，共', Object.keys(data.studyData).length, '人');
        return data.studyData;
      }
    } catch(e) {
      console.log('[Sync] 同步学习数据失败:', e.message);
    }
    return null;
  },

  // API: Load 850 words
  async loadWords() {
    if (this.words850) return this.words850;
    try {
      const res = await fetch('data/ogden_850_final.json');
      this.words850 = await res.json();
      return this.words850;
    } catch(e) {
      console.error('Failed to load words:', e);
      return [];
    }
  },

  // API: Load 116 business lessons
  async loadLessons() {
    if (this.lessons116) return this.lessons116;
    try {
      const res = await fetch('data/business_lessons.json');
      this.lessons116 = await res.json();
      return this.lessons116;
    } catch(e) {
      console.error('Failed to load lessons:', e);
      return { lessons: [] };
    }
  },

  // TTS: Initialize voices - pick the most natural-sounding one
  initVoices() {
    if (!('speechSynthesis' in window)) return;
    var self = this;
    var selectBest = function() {
      var voices = window.speechSynthesis.getVoices();
      if (!voices || voices.length === 0) return;
      self._ttsVoices = voices;
      // 关键兼容性：优先选择"本地离线"英语语音（localService=true）。
      // "Google US English" 等云端语音依赖 Google 服务器，在国内电脑版 Chrome 常被网络拦截导致无声，
      // 因此把本地语音排在最前，云端语音作为最后兜底。
      var isLocalEn = function(v) { return v.localService && v.lang && v.lang.indexOf('en') === 0; };
      var preferences = [
        // Windows 本地自然语音（离线）
        function(v) { return isLocalEn(v) && v.name && (v.name.indexOf('Natural') >= 0 || v.name.indexOf('Neural') >= 0); },
        // Windows 本地 Microsoft 语音（Zira/Mark/David，离线）
        function(v) { return isLocalEn(v) && v.name && (v.name.indexOf('Zira') >= 0 || v.name.indexOf('Mark') >= 0 || v.name.indexOf('David') >= 0 || v.name.indexOf('Microsoft') >= 0); },
        // macOS 本地语音（离线）
        function(v) { return isLocalEn(v) && v.name && (v.name.indexOf('Samantha') >= 0 || v.name.indexOf('Daniel') >= 0 || v.name.indexOf('Alex') >= 0); },
        // 任意本地 en-US / en 语音
        function(v) { return v.localService && v.lang === 'en-US'; },
        function(v) { return isLocalEn(v); },
        // 兜底：云端语音（可能需要联网）
        function(v) { return v.name && v.name.indexOf('Google US English') >= 0; },
        function(v) { return v.lang === 'en-US'; },
        function(v) { return v.lang && v.lang.indexOf('en') === 0; },
        function(v) { return true; }
      ];
      for (var i = 0; i < preferences.length; i++) {
        var match = voices.find(preferences[i]);
        if (match) { self._bestVoice = match; break; }
      }
    };
    selectBest();
    window.speechSynthesis.onvoiceschanged = selectBest;
  },

  // TTS: Speak English text with natural voice
  speak(text, opts) {
    opts = opts || {};
    if (!('speechSynthesis' in window)) {
      if (opts.onerror) opts.onerror();
      return;
    }
    // Chrome fix: cancel any pending utterances before speaking
    window.speechSynthesis.cancel();
    // Chrome 桌面版常见 bug：合成引擎会卡在 paused 状态导致无声，先 resume 唤醒
    try { window.speechSynthesis.resume(); } catch (e) {}

    // Split long text into sentences for more natural delivery
    var sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    var rate = opts.rate || 0.85;
    var pitch = opts.pitch || 1.0;
    var self = this;

    // Chrome compatibility: ensure speechSynthesis is active after user interaction
    // Some Chrome versions (especially mobile) need a "warm-up" utterance first
    if (!self._ttsWarmupDone && sentences.length > 0) {
      self._ttsWarmupDone = true;
    }

    var speakIndex = 0;
    function speakNext() {
      if (speakIndex >= sentences.length) {
        if (opts.onend) opts.onend();
        return;
      }
      var sentence = sentences[speakIndex].trim();
      var utter = new SpeechSynthesisUtterance(sentence);
      utter.lang = 'en-US';
      utter.rate = rate + (speakIndex > 0 ? (Math.random() * 0.04 - 0.02) : 0);
      utter.pitch = pitch;
      utter.volume = 1;
      // Use the best available voice
      if (self._bestVoice) utter.voice = self._bestVoice;

      var isLast = (speakIndex === sentences.length - 1);
      if (isLast) {
        if (opts.onend) utter.onend = opts.onend;
        if (opts.onerror) utter.onerror = function(e) {
          console.warn('[TTS] speak error:', e.error, 'for:', sentence);
          if (opts.onerror) opts.onerror(e);
        };
      } else {
        utter.onend = function() { speakIndex++; speakNext(); };
        utter.onerror = function(e) {
          console.warn('[TTS] sentence error, continuing next:', e.error);
          speakIndex++; speakNext(); // 继续播放下一句而非中断全部
        };
      }

      try {
        window.speechSynthesis.speak(utter);
        // 看门狗：若首句在 350ms 内既未开始朗读也无待播队列，判定为静默失败，
        // 用"默认语音"（不指定 voice）重试一次，规避云端语音不可用的问题
        if (speakIndex === 0 && !self._ttsRetried) {
          setTimeout(function() {
            if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
              self._ttsRetried = true;
              self._bestVoice = null; // 放弃当前语音，改用浏览器默认语音
              try {
                var u2 = new SpeechSynthesisUtterance(sentences.join(' ').trim());
                u2.lang = 'en-US'; u2.rate = rate; u2.pitch = pitch; u2.volume = 1;
                if (opts.onend) u2.onend = opts.onend;
                if (opts.onerror) u2.onerror = opts.onerror;
                window.speechSynthesis.resume();
                window.speechSynthesis.speak(u2);
              } catch (err) { if (opts.onerror) opts.onerror(err); }
            } else {
              self._ttsRetried = false;
            }
          }, 350);
        }
      } catch(e) {
        console.warn('[TTS] speak() exception:', e.message);
        if (isLast && opts.onerror) opts.onerror(e);
        else { speakIndex++; speakNext(); }
      }
    }

    // Chrome-specific fix: on some mobile devices, speak() may not work if called too quickly
    // Add a small delay to let the browser's audio context initialize
    var isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
    if (isChrome && !window._ttsLastSpeakTime) {
      window._ttsLastSpeakTime = Date.now();
      speakNext();
    } else if (isChrome && (Date.now() - (window._ttsLastSpeakTime||0)) < 100) {
      // Too fast, add tiny delay for Chrome mobile
      setTimeout(function() {
        window._ttsLastSpeakTime = Date.now();
        speakNext();
      }, 50);
    } else {
      window._ttsLastSpeakTime = Date.now();
      speakNext();
    }
  },

  // Check if TTS is currently speaking
  isSpeaking() {
    return 'speechSynthesis' in window && window.speechSynthesis.speaking;
  },

  stopSpeak() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (this._curAudio) { try { this._curAudio.pause(); } catch (e) {} this._curAudio = null; }
  },

  // 播放本地录制的 mp3 音频（跨设备/浏览器兼容性最好，且可被 Service Worker 离线缓存）。
  // 若音频不存在或播放失败，则回退到 TTS 朗读 fallbackText。
  playAudioOrSpeak(url, fallbackText, opts) {
    opts = opts || {};
    var self = this;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (this._curAudio) { try { this._curAudio.pause(); } catch (e) {} }
    var audio = new Audio(url);
    this._curAudio = audio;
    var fellBack = false;
    var doFallback = function() {
      if (fellBack) return; fellBack = true;
      self._curAudio = null;
      if (fallbackText) { self.speak(fallbackText, opts); }
      else if (opts.onerror) opts.onerror();
    };
    audio.onended = function() { self._curAudio = null; if (opts.onend) opts.onend(); };
    audio.onerror = doFallback;
    var p = audio.play();
    if (p && typeof p.catch === 'function') { p.catch(doFallback); }
    // 兜底：若 800ms 内既没开始播放也没报错（某些浏览器静默失败），转 TTS
    setTimeout(function() {
      if (!fellBack && audio.paused && audio.currentTime === 0) { doFallback(); }
    }, 800);
  },

  // ===== Speech Recognition (Microphone) =====
  // Creates a SpeechRecognition instance for scoring
  createRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    var recognition = new SR();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;
    return recognition;
  },

  // Score the recognized text against target - lenient for Chinese accent
  // Returns score 0-98. Returns 0 if no speech was recognized.
  scoreSpeech(targetText, recognizedText) {
    if (!recognizedText || recognizedText.trim().length === 0) {
      // No speech detected - return 0, NOT a random passing score
      return 0;
    }
    // Normalize: lowercase, remove punctuation
    var normalize = function(s) {
      return s.toLowerCase().replace(/[^a-z\s']/g, '').replace(/\s+/g, ' ').trim();
    };
    var target = normalize(targetText);
    var recognized = normalize(recognizedText);
    var targetWords = target.split(' ').filter(Boolean);
    var recognizedWords = recognized.split(' ').filter(Boolean);

    if (targetWords.length === 0) return 0;
    if (recognizedWords.length === 0) return 0;

    // Word-level matching with fuzzy comparison
    var matched = 0;
    var targetRemaining = targetWords.slice();

    recognizedWords.forEach(function(rw) {
      // Exact match
      var exactIdx = targetRemaining.indexOf(rw);
      if (exactIdx >= 0) {
        matched++;
        targetRemaining.splice(exactIdx, 1);
        return;
      }
      // Fuzzy match for accent tolerance
      for (var i = 0; i < targetRemaining.length; i++) {
        if (HiEnglish._wordsSimilar(rw, targetRemaining[i])) {
          matched++;
          targetRemaining.splice(i, 1);
          break;
        }
      }
    });

    var matchRate = matched / targetWords.length;

    // Scoring: direct match rate → score (0% = 0, 80% = 80, 100% = 98)
    // With Vosk recognition, this means you must actually say the correct English words.
    // Saying "啦啦啦" or random sounds → Vosk outputs nothing or wrong words → low score.
    var score = Math.round(matchRate * 100);
    // Small bonus for longer phrases/sentences (harder to get right)
    if (targetWords.length > 5 && matchRate >= 0.8) {
      score += 3;
    }
    score = Math.min(98, Math.max(0, score));

    return score;
  },

  // Check if two words are similar (for accent tolerance)
  _wordsSimilar(a, b) {
    if (a === b) return true;
    if (a.length < 2 || b.length < 2) return a[0] === b[0];
    // Check prefix match (first 60% of chars)
    var minLen = Math.min(a.length, b.length);
    var checkLen = Math.ceil(minLen * 0.6);
    var prefixMatch = true;
    for (var i = 0; i < checkLen; i++) {
      if (a[i] !== b[i]) { prefixMatch = false; break; }
    }
    if (prefixMatch && Math.abs(a.length - b.length) <= 2) return true;
    // Check if one contains the other
    if (a.length > 3 && b.indexOf(a) >= 0) return true;
    if (b.length > 3 && a.indexOf(b) >= 0) return true;
    return false;
  },

  // Auth: Login - strict validation for deleted/disabled users
  login(account, password, isAdmin) {
    if (isAdmin === undefined) isAdmin = false;
    var users = this.getUsers();
    if (isAdmin) {
      if (account === 'admin' && password === this.getAdminPassword()) {
        this.currentUser = { empid: 'admin', name: '管理员', role: 'admin', group: '' };
        sessionStorage.setItem('hi_english_user', JSON.stringify(this.currentUser));
        return { success: true, user: this.currentUser };
      }
      return { success: false, message: '管理员账号或密码错误' };
    }
    // Student login: strict checks
    var user = users[account];
    if (!user) return { success: false, message: '账号不存在或已被删除' };
    // Only allow login if status is explicitly 'active'
    if (user.status !== 'active') return { success: false, message: '账号已被禁用，请联系管理员' };
    if (user.password !== password) return { success: false, message: '密码错误' };
    this.currentUser = Object.assign({}, user, { role: 'student' });
    sessionStorage.setItem('hi_english_user', JSON.stringify(this.currentUser));
    return { success: true, user: this.currentUser };
  },

  logout() {
    sessionStorage.removeItem('hi_english_user');
    this.currentUser = null;
    window.location.href = 'index.html';
  },

  getCurrentUser() {
    var stored = sessionStorage.getItem('hi_english_user');
    if (!stored) { this.currentUser = null; return null; }
    var sessionUser = JSON.parse(stored);

    // For admin, return session data directly
    if (sessionUser.empid === 'admin' || sessionUser.role === 'admin') {
      this.currentUser = sessionUser;
      return this.currentUser;
    }

    // For students: ALWAYS validate against latest localStorage data.
    // If the account was deleted or disabled by admin, return null (force re-login).
    var users = this.getUsers();
    var liveUser = users[sessionUser.empid];
    if (!liveUser) {
      // Account was deleted — clear session and return null
      sessionStorage.removeItem('hi_english_user');
      this.currentUser = null;
      return null;
    }
    if (liveUser.status !== 'active') {
      // Account was disabled — clear session and return null
      sessionStorage.removeItem('hi_english_user');
      this.currentUser = null;
      return null;
    }
    // Account is valid — refresh from localStorage to pick up admin changes
    // (group rename, name change, etc.)
    this.currentUser = Object.assign({}, liveUser, { role: 'student' });
    sessionStorage.setItem('hi_english_user', JSON.stringify(this.currentUser));
    return this.currentUser;
  },

  // Users management (localStorage)
  getUsers() {
    return JSON.parse(localStorage.getItem('hi_english_users') || '{}');
  },

  saveUsers(users) {
    localStorage.setItem('hi_english_users', JSON.stringify(users));
  },

  getAdminPassword() {
    return localStorage.getItem('hi_english_admin_pwd') || '1234.com';
  },

  setAdminPassword(pwd) {
    localStorage.setItem('hi_english_admin_pwd', pwd);
  },

  // Study data (localStorage, keyed by empid)
  getStudyData(empid) {
    var all = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
    if (!all[empid]) {
      all[empid] = {
        basic: { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, checkIns: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0 },
        business: { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, checkIns: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: false }
      };
      localStorage.setItem('hi_english_study', JSON.stringify(all));
    }
    return all[empid];
  },

  saveStudyData(empid, data) {
    var all = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
    all[empid] = data;
    localStorage.setItem('hi_english_study', JSON.stringify(all));
    // 异步推送到服务端（防抖2秒，跨终端同步）
    this.pushServerStudyData(empid, data);
  },

  // Groups
  getGroups() {
    return JSON.parse(localStorage.getItem('hi_english_groups') || '[]');
  },

  saveGroups(groups) {
    localStorage.setItem('hi_english_groups', JSON.stringify(groups));
    // 同步到服务端
    fetch(this.getServerUrl() + '/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: groups })
    }).catch(function(e) { console.log('[Sync] 分组同步失败:', e.message); });
  },

  // Messages (本地缓存，兼容旧代码)
  getMessages(empid) {
    var all = JSON.parse(localStorage.getItem('hi_english_messages') || '{}');
    return all[empid] || [];
  },

  saveMessages(empid, messages) {
    var all = JSON.parse(localStorage.getItem('hi_english_messages') || '{}');
    all[empid] = messages;
    localStorage.setItem('hi_english_messages', JSON.stringify(all));
  },

  // 从服务端拉取指定学员的站内信（真实接收时间，跨终端同步）
  async fetchServerMessages(empid) {
    try {
      var resp = await fetch(this.getServerUrl() + '/api/messages?empid=' + encodeURIComponent(empid));
      var data = await resp.json();
      if (data && data.success && Array.isArray(data.messages)) {
        // 同步到本地缓存
        this.saveMessages(empid, data.messages);
        return data.messages;
      }
    } catch (e) {
      console.log('[Msg] 拉取服务端消息失败:', e.message);
    }
    // 失败时回退本地缓存
    return this.getMessages(empid);
  },

  // 管理员发送站内信到服务端（服务端盖真实时间戳，跨终端即刻送达）
  async sendMessageToServer(targets, title, content, type) {
    try {
      var resp = await fetch(this.getServerUrl() + '/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targets: targets,
          title: title,
          content: content,
          type: type || 'reminder'
        })
      });
      var data = await resp.json();
      return data && data.success;
    } catch (e) {
      console.log('[Msg] 发送消息失败:', e.message);
      return false;
    }
  },

  // 标记消息已读（同步到服务端）
  markMessagesReadServer(empid, msgIds, all) {
    try {
      fetch(this.getServerUrl() + '/api/messages/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empid: empid, msgIds: msgIds || [], all: !!all })
      }).catch(function(e) { console.log('[Msg] 标记已读失败:', e.message); });
    } catch (e) {}
  },

  // 格式化消息时间戳为友好显示（今天/昨天/日期 HH:MM）
  formatMsgTime(ts) {
    if (!ts) return '';
    // 兼容旧的字符串时间（如"今天 09:00"）
    if (typeof ts === 'string' && !/^\d+$/.test(ts)) return ts;
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var pad = function(n) { return String(n).padStart(2, '0'); };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var sameDay = function(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    };
    if (sameDay(d, now)) return '今天 ' + hm;
    var yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (sameDay(d, yest)) return '昨天 ' + hm;
    if (d.getFullYear() === now.getFullYear()) {
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
  },

  // Utility: Format date
  formatDate(d) {
    var dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString().slice(0, 10);
  },

  // Utility: Get today's date string
  today() {
    return this.formatDate(new Date());
  },

  // Utility: Check if date is this week
  isThisWeek(dateStr) {
    var d = new Date(dateStr);
    var now = new Date();
    var dayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
    var monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek + 1);
    monday.setHours(0, 0, 0, 0);
    var sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return d >= monday && d <= sunday;
  },

  // Utility: Get week number
  getWeekKey(date) {
    var d = date instanceof Date ? date : new Date(date);
    var year = d.getFullYear();
    var onejan = new Date(year, 0, 1);
    var week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
    return year + '-W' + week;
  },

  // Utility: Get month key
  getMonthKey(date) {
    var d = date instanceof Date ? date : new Date(date);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  },

  // Get last week's date range (Saturday to Friday)
  getLastWeekRange() {
    var now = new Date();
    var dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    // Last Saturday
    var lastSaturday = new Date(now);
    lastSaturday.setDate(now.getDate() - dayOfWeek - 1);
    lastSaturday.setHours(0, 0, 0, 0);
    // This Friday
    var thisFriday = new Date(now);
    thisFriday.setDate(lastSaturday.getDate() + 6);
    thisFriday.setHours(23, 59, 59, 999);
    return { start: lastSaturday, end: thisFriday };
  },

  // Get last month's date range
  getLastMonthRange() {
    var now = new Date();
    var lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start: lastMonthStart, end: lastMonthEnd };
  },

  // Init default data — ONLY runs on very first visit (when hi_english_users key doesn't exist at all)
  // This prevents re-creating users after admin deletes them (even if all users are deleted, the key still exists as '{}')
  initDefaultData() {
    // Create default admin if not exists
    if (!localStorage.getItem('hi_english_admin_pwd')) {
      localStorage.setItem('hi_english_admin_pwd', '1234.com');
    }
    // Default DingTalk webhook for study reminders
    if (!localStorage.getItem('hi_english_dingtalk_webhook')) {
      localStorage.setItem('hi_english_dingtalk_webhook', 'https://oapi.dingtalk.com/robot/send?access_token=f8fa3d85742c4e037aa80717728d7acc335683e88e4b23c77169f749175bd1e6');
    }
    // Create default groups only if groups key doesn't exist
    if (localStorage.getItem('hi_english_groups') === null) {
      this.saveGroups(['A组', 'B组']);
    }
    // CRITICAL: Only create default users on the very first visit.
    // Check if the 'hi_english_users' key exists at all — NOT if the users object is empty.
    // When admin deletes all users, the key still exists as '{}' so we won't re-create.
    if (localStorage.getItem('hi_english_users') === null) {
      var users = {};
      users['100001'] = { empid: '100001', name: '张三', group: '冲压车间', status: 'active', password: '123@456.com' };
      users['100002'] = { empid: '100002', name: '李四', group: '焊装车间', status: 'active', password: '123@456.com' };
      users['100003'] = { empid: '100003', name: '王五', group: '研发部', status: 'active', password: '123@456.com' };
      this.saveUsers(users);
    }
    // Unlock business English for test account 100003 (only if user still exists and is active)
    var currentUsers = this.getUsers();
    if (currentUsers['100003'] && currentUsers['100003'].status === 'active') {
      var allStudy = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
      if (!allStudy['100003']) {
        allStudy['100003'] = {
          basic: { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, checkIns: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0 },
          business: { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, checkIns: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: true }
        };
      } else if (!allStudy['100003'].business) {
        allStudy['100003'].business = { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: {}, checkIns: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: true };
      } else {
        allStudy['100003'].business.unlocked = true;
      }
      localStorage.setItem('hi_english_study', JSON.stringify(allStudy));
    }
  },

  // ===== Excel Export (real .xls format) =====
  exportExcel(filename, headers, rows, sheetName) {
    sheetName = sheetName || 'Sheet1';
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
    html += '<head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>' + sheetName + '</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>';
    html += '<table border="1" style="border-collapse:collapse;font-family:Microsoft YaHei;font-size:12px;">';
    // Header row
    html += '<tr>';
    headers.forEach(function(h) {
      html += '<th style="background:#4A90D9;color:#fff;font-weight:bold;padding:6px 10px;text-align:center;border:1px solid #3A7BC8;">' + HiEnglish._escapeHtml(h) + '</th>';
    });
    html += '</tr>';
    // Data rows
    rows.forEach(function(row, rowIdx) {
      html += '<tr>';
      row.forEach(function(cell) {
        var bgColor = rowIdx % 2 === 0 ? '#fff' : '#F5F7FA';
        html += '<td style="padding:6px 10px;border:1px solid #E8E8E8;background:' + bgColor + ';">' + HiEnglish._escapeHtml(String(cell === null || cell === undefined ? '' : cell)) + '</td>';
      });
      html += '</tr>';
    });
    html += '</table></body></html>';

    var blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  },

  _escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // Legacy CSV export (kept for compatibility)
  exportCSV(filename, headers, rows) {
    this.exportExcel(filename.replace('.csv', '.xls'), headers, rows);
  },

  // Show toast
  toast(msg, type) {
    type = type || 'info';
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:8px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);background:' + (type === 'error' ? '#ff4d4f' : type === 'success' ? '#52c41a' : '#1677ff') + ';color:#fff;';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.remove(); }, 2500);
  },

  // Show modal
  showModal(title, contentHTML, actions) {
    actions = actions || [];
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = '<div class="modal-title">' + title + '</div><div class="modal-body">' + contentHTML + '</div>';
    if (actions.length) {
      var actionsDiv = document.createElement('div');
      actionsDiv.className = 'modal-actions';
      actions.forEach(function(a) {
        var btn = document.createElement('button');
        btn.className = 'btn ' + (a.class || 'btn-outline');
        btn.textContent = a.text;
        btn.onclick = function() { if (a.onClick) a.onClick(modal, overlay); };
        actionsDiv.appendChild(btn);
      });
      modal.appendChild(actionsDiv);
    } else {
      var closeBtn = document.createElement('div');
      closeBtn.className = 'modal-actions';
      closeBtn.innerHTML = '<button class="btn btn-primary" onclick="this.closest(\'.modal-overlay\').remove()">关闭</button>';
      modal.appendChild(closeBtn);
    }
    overlay.appendChild(modal);
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
    return { modal: modal, overlay: overlay };
  }
};

// Initialize voices for TTS
HiEnglish.initVoices();

// Init default data on load
HiEnglish.initDefaultData();

// PWA Service Worker 注册（所有页面通用）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('./service-worker.js').then(function(reg) {
      console.log('[PWA] SW registered');
    }).catch(function(err) {
      console.log('[PWA] SW registration failed:', err);
    });
  });
}
