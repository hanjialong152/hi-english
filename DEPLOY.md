# Hi English - Render 部署指南

## 方式一：通过 GitHub 自动部署（推荐）

### 步骤 1：创建 GitHub 仓库

1. 访问 https://github.com/new
2. 仓库名：`hi-english`
3. 选择 **Public**
4. 点击 **Create repository**

### 步骤 2：推送代码到 GitHub

```bash
cd /workspace/hi-english-deploy
git remote add origin https://github.com/YOUR_USERNAME/hi-english.git
git push -u origin master
```

如果遇到认证问题，需要输入 GitHub Personal Access Token（不是密码）。

### 步骤 3：在 Render 上部署

1. 访问 https://dashboard.render.com/
2. 点击 **New +** → **Web Service**
3. 选择 **Connect a repository** → 选择 `hi-english` 仓库
4. 配置：
   - **Name**: `hi-english`
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `python server.py`
   - **Plan**: 选择免费版（Free）
5. 点击 **Create Web Service**

部署完成后，Render 会提供一个永久链接，如：`https://hi-english.onrender.com`

---

## 方式二：使用 Render CLI（需要 Render API Key）

```bash
# 安装 Render CLI
npm install -g @renderinc/cli

# 登录
render login

# 部署
cd /workspace/hi-english-deploy
render blueprint apply
```

---

## 重要注意事项

### 1. 音频文件（audio/）

当前 `audio/` 目录包含 4251 个音频文件（86MB），已包含在仓库中。
如果推送失败，可以：
- 从 `.gitignore` 中移除 `audio/` 的忽略
- 或者将音频文件放到云存储（如 AWS S3、七牛云），然后修改 `app.js` 中的音频路径

### 2. 数据持久化

**免费版 Render 没有持久化磁盘**，每次重新部署后 `data/` 目录中的数据会丢失。

**解决方案**：
1. **升级到付费版**（$7/月），挂载 Render Disk
2. **使用云数据库**（如 Supabase、Firebase）
3. **临时方案**：接受数据丢失（仅用于测试）

### 3. 语音识别功能

`/api/transcribe` 端点需要 `SpeechRecognition` 库，已包含在 `requirements.txt` 中。
如果使用 Google Web Speech API，需要确保服务器可以访问 Google 服务（国内服务器可能无法访问）。

---

## 默认账号

部署后，可以使用以下默认账号登录：

- **管理员**: 用户名 `admin`，密码 `123@456.com`
- **学员**: 需要先由管理员在后台添加

---

## 故障排查

### 部署失败

1. 检查 `requirements.txt` 是否正确
2. 检查 `render.yaml` 格式是否正确
3. 查看 Render 构建日志

### 音频文件无法播放

1. 检查 `audio/` 目录是否已正确提交到 Git
2. 检查 `server.py` 是否正确提供静态文件服务

### 数据丢失

这是免费版 Render 的限制。请参考上面的"数据持久化"解决方案。
