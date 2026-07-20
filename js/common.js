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
        // 服务端校验通过后，再校验账号是否被禁用（防止禁用账号进入学员端）
        if (data.user.status !== 'active') {
          return { success: false, message: '账号已被禁用，如需启用请联系管理员' };
        }
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
  // ===== 合并两个学习记录（与 server.py merge_study_data 语义一致）=====
  // 双向并集 / 取最大值，本地真相优先：谁持有更新的进度都不会被覆盖。
  mergeStudyData(a, b) {
    if (!a) return b ? JSON.parse(JSON.stringify(b)) : {};
    if (!b) return JSON.parse(JSON.stringify(a));
    function strset(arr){ return new Set((arr||[]).map(function(x){return String(x);})); }
    function mergeStage(e, i) {
      if (!e) return i ? JSON.parse(JSON.stringify(i)) : {};
      if (!i) return JSON.parse(JSON.stringify(e));
      var o = JSON.parse(JSON.stringify(e));
      ['learned','mastered'].forEach(function(k){
        o[k] = Array.from(strset(e[k]).union(strset(i[k]))).sort();
      });
      // readIndex：本地真相优先（不取最大值），记住最后停留页，避免往回翻被"最远页"覆盖
      o.readIndex = (typeof e.readIndex === 'number' && e.readIndex > 0) ? e.readIndex
                   : (parseInt(i.readIndex||0,10) || 0);
      ['spellIndex','totalSeconds'].forEach(function(k){
        o[k] = Math.max(parseInt(e[k]||0,10), parseInt(i[k]||0,10));
      });
      var ld = Object.assign({}, e.learnedDates||{});
      Object.keys(i.learnedDates||{}).forEach(function(k){
        if (!(k in ld) || String(i.learnedDates[k]||'') > String(ld[k]||'')) ld[k] = i.learnedDates[k];
      });
      o.learnedDates = ld;
      var ci = {};
      [e.checkIns||[], i.checkIns||[]].forEach(function(arr){
        (arr||[]).forEach(function(c){
          if (!c || !c.date) return;
          var cur = ci[c.date] || {date:c.date, seconds:0, completed:false};
          cur.seconds = Math.max(parseInt(cur.seconds||0,10), parseInt(c.seconds||0,10));
          if (c.completed) cur.completed = true;
          ci[c.date] = cur;
        });
      });
      o.checkIns = Object.keys(ci).map(function(k){return ci[k];});
      var ss = JSON.parse(JSON.stringify(e.speakScores||{}));
      Object.keys(i.speakScores||{}).forEach(function(w){
        if (!ss[w]) ss[w] = JSON.parse(JSON.stringify(i.speakScores[w]));
        else Object.keys(i.speakScores[w]||{}).forEach(function(ex){
          ss[w][ex] = Math.max(parseFloat(ss[w][ex]||0), parseFloat(i.speakScores[w][ex]||0));
        });
      });
      o.speakScores = ss;
      // audioDone（结构 {词id:{p:true,e1:true,...}}）：深层合并，任意一侧为 true 即保留 true（听过就记着）
      var ad = {};
      [e.audioDone||{}, i.audioDone||{}].forEach(function(src){
        Object.keys(src).forEach(function(k){
          ad[k] = ad[k] || {};
          var sub = src[k] || {};
          Object.keys(sub).forEach(function(subk){ if (sub[subk]) ad[k][subk] = true; });
        });
      });
      o.audioDone = ad;
      // audioDoneDate（结构 {词id:日期}）：取较新日期
      var add = Object.assign({}, e.audioDoneDate||{});
      Object.keys(i.audioDoneDate||{}).forEach(function(k){
        if (!(k in add) || String(i.audioDoneDate[k]||'') > String(add[k]||'')) add[k] = i.audioDoneDate[k];
      });
      o.audioDoneDate = add;
      ['weeklyTests','monthlyTests'].forEach(function(k){
        var seen = {}, m = [];
        [e[k]||[], i[k]||[]].forEach(function(arr){ (arr||[]).forEach(function(it){
          var h = JSON.stringify(it); if (!seen[h]) { seen[h]=1; m.push(it); }
        });});
        o[k] = m;
      });
      if ('unlocked' in (e||{}) || 'unlocked' in (i||{})) {
        o.unlocked = !!(e.unlocked) || !!(i.unlocked);
      }
      return o;
    }
    // 收敛：把 a/b 中 basic/business 下的 checkIns 先归并到各自顶层，避免双字段不一致
    function _promoteCI(o){ if(o&&typeof o==='object'){ ['basic','business'].forEach(function(s){ var st=o[s]; if(st&&Array.isArray(st.checkIns)&&st.checkIns.length){ o.checkIns=o.checkIns||[]; var m={}; (o.checkIns||[]).forEach(function(c){if(c&&c.date)m[c.date]=c;}); st.checkIns.forEach(function(c){ if(!c||!c.date)return; if(!m[c.date])m[c.date]={date:c.date,seconds:c.seconds||0,completed:!!c.completed}; else {var x=m[c.date]; x.seconds=Math.max(x.seconds||0,c.seconds||0); if(c.completed)x.completed=true;} }); o.checkIns=Object.keys(m).map(function(k){return m[k];}); delete st.checkIns; } }); } }
    _promoteCI(a); _promoteCI(b);
    var out = JSON.parse(JSON.stringify(a));
    ['basic','business'].forEach(function(s){ out[s] = mergeStage(a[s], b[s]); });
    var ci = {};
    [a.checkIns||[], b.checkIns||[]].forEach(function(arr){ (arr||[]).forEach(function(c){
      if (!c || !c.date) return;
      var cur = ci[c.date] || {date:c.date, seconds:0, completed:false};
      cur.seconds = Math.max(parseInt(cur.seconds||0,10), parseInt(c.seconds||0,10));
      if (c.completed) cur.completed = true;
      ci[c.date] = cur;
    });});
    out.checkIns = Object.keys(ci).map(function(k){return ci[k];});
    return out;
  },

  async fetchServerStudyData(empid, attempt) {
    attempt = attempt || 1;
    var MAX_RETRY = 3;
    try {
      var resp = await fetch(this.getServerUrl() + '/api/study-data?empid=' + encodeURIComponent(empid));
      var data = await resp.json();
      if (data.success && data.studyData) {
        // 与本地合并（本地真相优先），避免服务端旧快照覆盖客户端最新进度
        var all = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
        var local = all[empid] || {};
        var merged = this.mergeStudyData(local, data.studyData);
        all[empid] = merged;
        localStorage.setItem('hi_english_study', JSON.stringify(all));
        // 把合并后的真相回推服务端，确保服务端也拿到客户端持有的最新进度（自愈恢复）
        this.pushServerStudyData(empid, merged);
        console.log('[Sync] 从服务端拉取并与本地合并学习数据成功 (attempt ' + attempt + ')');
        return merged;
      }
      console.log('[Sync] 服务端无学习数据 (attempt ' + attempt + ')');
      // 服务端无记录但本地有进度：把本地真相推上去，避免部署清空后本地进度丢不上来
      var all = JSON.parse(localStorage.getItem('hi_english_study') || '{}');
      if (all[empid]) {
        this.pushServerStudyData(empid, all[empid]);
        return all[empid];
      }
      return null;
    } catch(e) {
      console.log('[Sync] 拉取学习数据失败 (attempt ' + attempt + '/' + MAX_RETRY + '):', e.message);
      if (attempt < MAX_RETRY) {
        // 退避重试：1s, 2s, 3s — 覆盖 Render 冷启动 / 网络抖动 / DNS 偶发失败
        await new Promise(function(resolve) { setTimeout(resolve, 1000 * attempt); });
        return this.fetchServerStudyData(empid, attempt + 1);
      }
      console.error('[Sync] 拉取学习数据最终失败，已重试' + MAX_RETRY + '次');
      return null;
    }
  },

  // ===== Fetch ALL students' study data (for student leaderboard) =====
  // 根因修复：学员端排行榜需要全体学习数据。过去仅从 localStorage 读取，
  // 手机端/清缓存后本地只有自己一条 → 排行榜其他人全为0、与管理员端不一致。
  // 返回 null 表示服务端不可达（调用方应降级用本地数据，切勿用空对象覆盖）。
  async fetchAllStudyData() {
    try {
      var resp = await fetch(this.getServerUrl() + '/api/all-study-data');
      var data = await resp.json();
      if (data.success && data.studyData && Object.keys(data.studyData).length > 0) {
        console.log('[Sync] 拉取全体学习数据成功，共', Object.keys(data.studyData).length, '人');
        return data.studyData;
      }
      return null;
    } catch(e) {
      console.log('[Sync] 拉取全体学习数据失败:', e.message);
      return null;
    }
  },

  // ===== Push study data to server (debounced) =====
  _syncTimer: null,
  _lastPushedData: null,
  _periodicTimer: null,
  pushServerStudyData(empid, data) {
    var self = this;
    this._lastPushedData = { empid: empid, data: data };
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(function() {
      self._doPush(empid, data);
    }, 400); // 400ms 防抖：尽快把进度推到服务端，缩短丢失窗口
  },

  // 立即推送（绕过防抖）：用于关键状态变化（打卡完成、学习完成等）
  // 确保这类事件零延迟落盘，避免跨终端竞态导致数据不一致
  pushServerStudyDataImmediate(empid, data) {
    this._lastPushedData = { empid: empid, data: data };
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
    this._doPush(empid, data);
  },

  // 周期性同步：每60秒静默推一次当前状态，兜底防止单次推送失败
  startPeriodicSync(empid, getData) {
    var self = this;
    this.stopPeriodicSync();
    this._periodicTimer = setInterval(function() {
      try {
        var data = typeof getData === 'function' ? getData() : self._lastPushedData && self._lastPushedData.data;
        if (data && empid) {
          console.log('[Sync] 周期性同步：静默推送学习数据');
          self._doPush(empid, data);
        }
      } catch(e) { console.warn('[Sync] 周期性同步跳过:', e.message); }
    }, 30000); // 每30秒（更频繁，加速恢复）
  },

  stopPeriodicSync() {
    if (this._periodicTimer) { clearInterval(this._periodicTimer); this._periodicTimer = null; }
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

  _doPush(empid, data, attempt) {
    attempt = attempt || 1;
    var self = this;
    fetch(self.getServerUrl() + '/api/study-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empid: empid, studyData: data })
    }).then(function(resp) {
      console.log('[Sync] 学习数据已推送到服务端');
    }).catch(function(e) {
      // 退避重试，确保网络抖动时也能可靠送达（最多4次）
      if (attempt < 4) {
        setTimeout(function() { self._doPush(empid, data, attempt + 1); }, 800 * attempt);
        console.log('[Sync] 推送失败，第' + attempt + '次重试:', e.message);
      } else {
        console.log('[Sync] 推送失败，将在下次保存/打开App时由服务端自愈合并:', e.message);
      }
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
      const DATA_VER = '?v=20260712d';
      if (this.words850) return this.words850;
      try {
        const res = await fetch('data/ogden_850_final.json' + DATA_VER);
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
        checkIns: [],
        basic: { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0, audioDone: {}, audioDoneDate: {} },
        business: { readIndex: 0, spellIndex: 0, learned: [], learnedDates: {}, mastered: [], speakScores: [], weeklyTests: [], monthlyTests: [], totalSeconds: 0, unlocked: false, audioDone: {}, audioDoneDate: {} }
      };
      localStorage.setItem('hi_english_study', JSON.stringify(all));
    }
    // 自愈：去重 learned/mastered 数组（修复 ID 类型不一致导致的重复累积）；确保 audioDone 字段存在
    var sd = all[empid];
    ['basic', 'business'].forEach(function(stage) {
      if (sd[stage]) {
        if (!sd[stage].audioDone) sd[stage].audioDone = {};
        if (!sd[stage].audioDoneDate) sd[stage].audioDoneDate = {};
        if (sd[stage].learned && sd[stage].learned.length > 1) {
          sd[stage].learned = Array.from(new Set(sd[stage].learned.map(function(x) { return String(x); })));
        }
        if (sd[stage].mastered && sd[stage].mastered.length > 1) {
          sd[stage].mastered = Array.from(new Set(sd[stage].mastered.map(function(x) { return String(x); })));
        }
      }
    });
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

  // Utility: Format date (LOCAL timezone — not UTC)
  formatDate(d) {
    var dt = d instanceof Date ? d : new Date(d);
    var y = dt.getFullYear();
    var m = ('0' + (dt.getMonth() + 1)).slice(-2);
    var day = ('0' + dt.getDate()).slice(-2);
    return y + '-' + m + '-' + day;
  },

  // Utility: Get today's date string
  today() {
    return this.formatDate(new Date());
  },

  // 当月自然天数（year/month 为本地时区，month 0-based）
  getDaysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  },

  // 周测归属月：上周六~本周五所在月（取该周周五的月份作为归属月）
  weeklyTestMonthKey(dateStr) {
    var d = new Date(String(dateStr).replace(/-/g, '/'));
    if (isNaN(d.getTime())) return '';
    var dow = d.getDay(); // 0=Sun..6=Sat
    var fridayOffset = (5 - dow + 7) % 7; // 到本周五的天数
    d.setDate(d.getDate() + fridayOffset);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
  },

  // 月测归属月：次月1~5日归上月，否则归当月
  monthlyTestMonthKey(dateStr) {
    var d = new Date(String(dateStr).replace(/-/g, '/'));
    if (isNaN(d.getTime())) return '';
    if (d.getDate() <= 5) {
      d.setDate(0); // 回退到上月最后一天
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    }
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
  },

  // 计算个人当月总成绩（合并 basic+business 两阶段的周测/月测；打卡用顶层统一 checkIns）
  // 公式：当月打卡占比×100×30% + 当月周测均分×30% + 当月月测均分×40%
  // 月测：当月多条（含两阶段）取最高分（业务规则：每月只算一次，取 1~5 日多次考试的最高分）；两端（学员端报告/排行榜、管理员端总览）共用此函数保证一致
  calcMonthlyScore(sd, curMonth) {
    sd = sd || {};
    curMonth = curMonth || this.today().slice(0, 7);
    var self = this;
    var y = parseInt(curMonth.slice(0, 4), 10);
    var m = parseInt(curMonth.slice(5, 7), 10) - 1;
    var daysInMonth = this.getDaysInMonth(y, m);
    // 打卡项：当月完成打卡天数 / 当月自然天数 × 100 × 0.3
    var checkIns = sd.checkIns || [];
    var monthCheckinDays = checkIns.filter(function(c){ return c.completed && (c.date || '').slice(0, 7) === curMonth; }).length;
    var chk = (daysInMonth > 0 ? (monthCheckinDays / daysInMonth) * 100 : 0) * 0.3;
    // 周测项：合并两阶段，当月归属月过滤；每个自然周取多次考试的最高分，再按月对各周最高分求平均 × 0.3
    var allWeekly = [].concat((sd.basic && sd.basic.weeklyTests) || [], (sd.business && sd.business.weeklyTests) || []);
    var wt = allWeekly.filter(function(t){ return self.weeklyTestMonthKey(t.date) === curMonth; });
    var wAvg = 0;
    if (wt.length > 0) {
      var weekMax = {};
      wt.forEach(function(t){
        var wk = self.getWeekKey(t.date);
        var sc = t.avgScore || 0;
        if (!(wk in weekMax) || sc > weekMax[wk]) weekMax[wk] = sc;
      });
      var weekVals = Object.keys(weekMax).map(function(k){ return weekMax[k]; });
      wAvg = weekVals.reduce(function(s, v){ return s + v; }, 0) / weekVals.length;
    }
    // 月测项：合并两阶段，当月归属月过滤（1~5日归属上月），取当月多次考试的最高分 × 0.4
    var allMonthly = [].concat((sd.basic && sd.basic.monthlyTests) || [], (sd.business && sd.business.monthlyTests) || []);
    var mt = allMonthly.filter(function(t){ return self.monthlyTestMonthKey(t.date) === curMonth; });
    var mMax = mt.length > 0 ? Math.max.apply(null, mt.map(function(t){ return t.avgScore || 0; })) : 0;
    var checkinScore = Math.round(chk * 10) / 10;
    var weeklyScore = Math.round(wAvg * 0.3 * 10) / 10;
    var monthlyScore = Math.round(mMax * 0.4 * 10) / 10;
    var total = Math.round((checkinScore + weeklyScore + monthlyScore) * 10) / 10;
    return {
      total: total,
      checkinScore: checkinScore,
      weeklyScore: weeklyScore,
      monthlyScore: monthlyScore,
      monthCheckinDays: monthCheckinDays,
      weeklyAvg: Math.round(wAvg),
      monthlyAvg: Math.round(mMax)
    };
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
    // DingTalk webhook is managed server-side (data/dingtalk.json); no frontend hardcoded token.
    // Create default groups only if groups key doesn't exist
    if (localStorage.getItem('hi_english_groups') === null) {
      this.saveGroups(['A组', 'B组']);
    }
    // CRITICAL: Only create default users on the very first visit.
    // Check if the 'hi_english_users' key exists at all — NOT if the users object is empty.
    // When admin deletes all users, the key still exists as '{}' so we won't re-create.
    if (localStorage.getItem('hi_english_users') === null) {
      var users = {};
      // Default sample users removed — admin creates real users via the management UI.
      this.saveUsers(users);
    }
    // Test-account 100003 business unlock removed.
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
