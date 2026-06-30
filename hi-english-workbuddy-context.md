# Hi English 项目 — WorkBuddy 任务上下文（可导入电脑端）

> 本文件包含小程序端 WorkBuddy 开发 Hi English 系统的完整任务逻辑、计划、技术决策和历史记录。
> 在电脑端 WorkBuddy 中新建对话后，将本文件内容粘贴发送，即可加载全部上下文继续开发。

---

## 一、项目概述

**项目名称**：Hi English — 850 Basic English Words Learning App

**项目描述**：一个英语单词学习系统，学员通过工号+密码登录，学习 C.K. Ogden Basic English 850 个基础英语单词。包含学员端和管理员端，支持单词浏览、拼写练习、测试模式、录音跟读发音练习。已部署到 Render 平台。

**在线地址**：https://hi-english.onrender.com
**GitHub 仓库**：https://github.com/hanjialong152/hi-english
**管理员账号**：用户名 `admin`，密码 `123@456.com`
**学员初始密码**：`123@456.com`

---

## 二、技术架构

| 层 | 技术 | 文件 | 说明 |
|----|------|------|------|
| 前端 | 原生 HTML/CSS/JS | index.html, app.js, style.css | 无框架，纯原生 JavaScript |
| 管理端 | 原生 HTML/CSS/JS | admin.html, admin.js, admin.css | SheetJS 导出 Excel |
| 后端 | Python Flask | server.py | 单文件，含所有 API |
| 数据存储 | JSON 文件 + GitHub API 同步 | data/*.json | 启动时从 GitHub data-sync 分支拉取，保存时异步推送 |
| 单词数据 | JS 文件 | words_data.js | 850 个 Basic English 单词 |
| 音频 | 本地 MP3 文件 | audio/ | 4250 个文件，86MB |
| 语音识别 | SpeechRecognition + Google API | server.py /api/transcribe | 前端录音转 PCM，后端包装 WAV 后识别 |
| PWA | Service Worker + Manifest | service-worker.js, manifest.json | 可安装到手机桌面 |
| 部署 | Render + GitHub | render.yaml, Procfile, requirements.txt | 免费版 |
| 保活 | 服务内自 ping 线程 | server.py keepalive_loop() | 每 10 分钟 ping 自身公网 URL |

---

## 三、文件结构

```
hi-english/
├── server.py              # Flask 后端（认证/数据/语音识别/同步/保活）
├── app.js                 # 学员端逻辑
├── index.html             # 学员端页面
├── style.css              # 学员端样式
├── admin.js               # 管理端逻辑
├── admin.html             # 管理端页面
├── admin.css              # 管理端样式
├── words_data.js          # 850 个单词数据
├── service-worker.js      # PWA 离线缓存（v11）
├── manifest.json          # PWA 配置
├── audio/                 # 4250 个发音音频（86MB）
│   ├── w_{id}.mp3         # 单词发音（850 个）
│   ├── p_{id}.mp3         # 短语发音（850 个）
│   └── e_{id}_{1-3}.mp3   # 例句发音（2550 个）
├── data/                  # 运行时数据
│   ├── users.json         # 用户认证
│   ├── study_data.json    # 学习记录
│   └── admin.json         # 管理员认证
├── requirements.txt       # Flask, SpeechRecognition
├── Procfile               # web: python server.py
├── render.yaml            # Render 部署配置
├── .github/workflows/keep-alive.yml  # 备用保活（GitHub Actions）
├── .gitignore
├── DEPLOY.md              # Render 部署指南
└── README-LOCAL.md        # 本地运行指南
```

---

## 四、API 接口列表

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| POST | /api/login | 学员登录（工号+密码） | 无 |
| POST | /api/register | 管理员添加学员 | 无 |
| POST | /api/import-students | 批量导入学员 | 无 |
| GET  | /api/study-data?empid=xxx | 获取学习数据 | 无 |
| POST | /api/study-data | 保存学习数据 | 无 |
| POST | /api/change-password | 修改学员密码 | 无 |
| POST | /api/reset-password | 重置学员密码 | 无 |
| POST | /api/admin-login | 管理员登录 | 无 |
| POST | /api/admin-change-password | 修改管理员密码 | 无 |
| GET  | /api/admin/users?token=xxx | 获取所有用户信息 | admin token |
| POST | /api/admin/delete-user | 删除用户 | admin token |
| POST | /api/transcribe | 语音识别（PCM→WAV→Google API） | 无 |
| GET  | /api/keepalive | 保活状态检查 | 无 |

---

## 五、数据库设计（JSON 文件结构）

### users.json
```json
{
  "empid": {
    "empid": "10001",
    "name": "张三",
    "password_hash": "sha256hex",
    "salt": "hex8",
    "created_at": 1718000000000,
    "last_login": 1718000000000,
    "login_count": 5,
    "must_change_password": false
  }
}
```

### study_data.json
```json
{
  "empid": {
    "empid": "10001",
    "name": "张三",
    "learnedIds": [1, 2, 3],
    "masteredIds": [1],
    "favoriteIds": [],
    "speakScores": {"1": 85, "2": 90},
    "sessions": [],
    "studyDates": ["2026-06-19", "2026-06-20"],
    "lastIndex": 3,
    "totalStudySeconds": 1200,
    "createdAt": 1718000000000,
    "updatedAt": 1718000000000
  }
}
```

### admin.json
```json
{
  "admin": {
    "username": "admin",
    "password_hash": "sha256hex",
    "salt": "hex8",
    "session_token": "hex32",
    "created_at": 1718000000000
  }
}
```

---

## 六、核心功能逻辑

### 学员端功能
1. **登录**：工号+密码 → POST /api/login → 加载学习数据 → 进入主页
2. **单词学习**：卡片浏览，播放音频（w_/p_/e_），标记已学/已掌握，进度条
3. **拼写练习**：显示中文释义 → AudioContext 播放发音 → 输入英文 → 回车判断 → 正确自动下一题
4. **测试模式**：听力选择题（4选1），播放音频选中文释义
5. **跟读练习**：MediaRecorder 录音 → 前端转 PCM 16kHz → POST /api/transcribe → 后端包装 WAV → Google API 识别 → 评分
6. **学习报告**：已学/已掌握/学习天数/学习时长/平均分
7. **修改密码**：旧密码+新密码+确认 → POST /api/change-password

### 管理端功能
1. **管理员登录**：用户名+密码 → POST /api/admin-login → session token
2. **学员管理**：列表/新增/批量导入(xlsx)/重置密码/删除/查看详情
3. **数据导出**：
   - 全员报告 → xlsx（SheetJS）
   - 进度报告 → doc（HTML blob）
   - 排行榜 → xlsx
   - 催学名单 → xlsx
4. **修改管理员密码**

### 数据持久化机制
- **本地文件**：data/*.json（原子写入，tmp→replace）
- **GitHub 同步**：启动时从 data-sync 分支拉取，保存时防抖 3 秒推送
- **Token**：硬编码在 server.py 的 `_t_parts` 变量中
- **防抖**：3 秒内多次保存合并为一次 GitHub 推送

### 自保活机制
- **主方案**：server.py 内 `keepalive_loop()` 线程，每 10 分钟 ping `RENDER_EXTERNAL_URL/api/keepalive`
- **备用方案**：GitHub Actions cron（每 5 分钟，但不可靠）
- **状态查看**：GET /api/keepalive 返回 ping_count、last_ping_time 等

---

## 七、技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 前端框架 | 原生 JS | 无构建步骤，部署简单 |
| 后端框架 | Flask（从 http.server 迁移） | Render Python 环境兼容 |
| 数据库 | JSON 文件 + GitHub 同步 | 无需数据库，免费 |
| 语音识别 | Google Web Speech API（后端） | 免费，无需 API Key |
| 音频格式 | 前端 PCM 16kHz → 后端 WAV 包装 | SpeechRecognition 需要 WAV |
| PWA | Service Worker + Manifest | 安卓/iOS 都支持"添加到主屏幕" |
| 部署平台 | Render 免费版 | 支持 Python，永久 URL |
| 数据持久化 | GitHub data-sync 分支 | 解决 Render 文件系统重置问题 |
| 保活 | 服务内自 ping 线程 | GitHub Actions cron 不可靠 |
| 密码加密 | SHA256 + salt | 简单够用 |

---

## 八、完整任务历史（30 个任务）

### 阶段一：初始开发（任务 #1-#3）
- #1 ✅ 下载并解析 850 单词 PDF 文件
- #2 ✅ 构建英语学习 APP 前端界面
- #3 ✅ 构建后台管理系统

### 阶段二：Bug 修复（任务 #4-#6）
- #4 🔄 修复 APP 所有 bug（返回按钮、拖拽跟读区、麦克风反馈、单词数据完整）
- #5 ✅ 修复学习按钮点不动+麦克风+弹窗等全部问题
- #6 ✅ 实现基于 MediaRecorder+Whisper 的语音识别方案替代 SpeechRecognition

### 阶段三：PWA 改造（任务 #7-#15）
- #7 ✅ 生成 APP 图标
- #8 ✅ 创建 PWA 配置和 Service Worker
- #9 ✅ 修改 HTML 引入 PWA 配置
- #10 ✅ 修改 server.py 添加 MIME 类型
- #11 ✅ 测试并获取预览链接
- #12 ✅ 修复 Service Worker 缓存导致旧代码不更新
- #13 ✅ 验证修复并测试
- #14 ✅ 改进 PWA 安装引导，适配 iframe 预览环境
- #15 ✅ 增强麦克风录音稳定性，添加错误提示

### 阶段四：单词数据完善（任务 #16-#22）
- #16 🔄 修复 850 个单词的数据质量问题
- #17 🔄 Generate Basic English 850 words data file
- #18 🔄 编写 850 词完整数据生成脚本
- #19 ✅ Append THINGS_PICTURABLE (200 words) to gen_data.py
- #20 ⏳ Append QUALITIES_GENERAL (100 words) to gen_data.py
- #21 ⏳ Append QUALITIES_OPPOSITES (50 words) to gen_data.py
- #22 ⏳ Add generation code and execute script

### 阶段五：8 需求大改版（任务 #23-#27）
- #23 ✅ 部署到 GitHub + Render 获取固定 URL
- #24 ✅ 扩展 server.py 后端（9 个 API 端点）
- #25 ✅ 修改学员端 app.js + index.html
- #26 ✅ 修改管理员端 admin.js/html/css
- #27 ✅ 启动服务并验证所有需求

### 阶段六：Render 部署与修复（任务 #28-#30）
- #28 ✅ 创建 Render 部署文件
- #29 ⏳ 解决 Render 数据持久化问题（已用 GitHub 同步解决）
- #30 ✅ 部署到 Render 并获取永久链接

### 后续修复（未编号任务，通过对话完成）
- 修复 JS 语法错误（orphaned `syncToGlobalList` 代码行导致登录失败）
- 测试模式图标从 ✍️ 改为 📝
- 删除报告页学习记录 section 和 🔄 刷新按钮
- 拼写正确时隐藏"再听一遍"按钮
- 从 http.server 迁移到 Flask（Render 兼容）
- 修复音频文件未推送 GitHub 问题（4250 个文件 86MB）
- 修复 transcribe API：raw PCM → WAV 包装
- 修复数据持久化：GitHub data-sync 分支双向同步
- 修复保活：从 GitHub Actions cron 改为服务内自 ping 线程

---

## 九、现有用户数据

| 工号 | 姓名 |
|------|------|
| 10001 | 张三 |
| 10002 | 李四 |
| 10003 | 王五 |
| gw00147407 | 韩家龙 |
| GW0100256 | 刘海玲 |
| GW00058704 | 刘桂霄 |

---

## 十、当前状态与待办

### 已完成
- ✅ 850 单词数据 + 音频文件
- ✅ 学员端全部功能（学习/拼写/测试/跟读/报告）
- ✅ 管理端全部功能（学员管理/数据导出/认证）
- ✅ PWA 安装支持
- ✅ Render 部署 + 永久 URL
- ✅ 数据持久化（GitHub 同步）
- ✅ 自保活机制
- ✅ 跨设备学习记录同步

### 待办/可优化
- ⏳ 单词数据质量优化（#16-#22 部分未完成）
- ⏳ Render 免费版 15 分钟休眠限制（已用自 ping 缓解，但非完美）
- ⏳ GitHub Token 硬编码在 server.py 中（安全风险）
- ⏳ Google Web Speech API 在国内可能不稳定（可换百度 API）
- ⏳ 音频文件 86MB 较大（可考虑 CDN 或 TTS 替代）

---

## 十一、关键代码位置

| 功能 | 文件 | 关键函数/位置 |
|------|------|--------------|
| Flask 应用 | server.py | `app = Flask(...)` |
| GitHub 数据同步 | server.py | `github_api_get()`, `github_api_put()`, `schedule_sync()` |
| 保活线程 | server.py | `keepalive_loop()`, `/api/keepalive` |
| 密码哈希 | server.py | `hash_password()`, `verify_password()` |
| 语音识别 | server.py | `handle_transcribe()`, `transcribe_audio()` |
| 学员登录 | app.js | `doLogin()` |
| 学习数据同步 | app.js | `loadStudyDataFromServer()`, `saveStudyDataToServer()` |
| 拼写练习 | app.js | `renderSpellPage()`, `submitSpell()`, `nextSpell()` |
| 录音跟读 | app.js | `micDown()`, `uploadAndTranscribe()`, `convertToPcm16()` |
| 音频播放 | app.js | `playAudioDirect()`, 音频路径 `audio/w_${id}.mp3` |
| 管理员登录 | admin.js | `adminLogin()`, `adminLogout()` |
| 数据导出 | admin.js | `downloadXlsx()`, `downloadDoc()` |
| PWA 缓存 | service-worker.js | CACHE_NAME = 'hi-english-v11' |
