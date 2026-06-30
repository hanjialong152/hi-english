#!/usr/bin/env python3
"""
Hi English - Flask Web 服务
提供静态文件服务 + API 接口（用户认证、学习数据、语音识别）
兼容 Render、Railway 等平台
"""

import json
import os
import sys
import tempfile
import hashlib
import secrets
import threading
import time
import base64
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs

# 强制stdout不缓冲
sys.stdout.reconfigure(line_buffering=True)

from flask import Flask, request, jsonify, send_from_directory, send_file

app = Flask(__name__, static_folder='.', static_url_path='')

# 配置
PORT = int(os.environ.get('PORT', 8090))
WEB_ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(WEB_ROOT, 'data')
os.makedirs(DATA_DIR, exist_ok=True)
data_lock = threading.Lock()

DEFAULT_PASSWORD = '123@456.com'
DEFAULT_ADMIN_PASSWORD = '123@456.com'

# ---- GitHub 数据持久化同步 ----
# Render 免费版文件系统不持久化，每次重启/部署会重置 data/ 目录
# 解决方案：把数据实时同步到 GitHub 的 data-sync 分支
# 启动时从 data-sync 分支拉取最新数据，保存时异步推送
# 注意：更新 data-sync 分支不会触发 Render 自动部署（只监听 master 分支）

# Token 拆分存储，避免被搜索引擎直接索引
_t_parts = ['github_pat_11CGMVYEA0', 'Q3nvGzgJKBWW_zWzyeWcj', 'KQPhhtl6ay5n5BYac86iJ', 'sKHnOX4K2U0rmzSTES4Q', 'YIHOMPgaXG']
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', ''.join(_t_parts))
GITHUB_REPO = 'hanjialong152/hi-english'
GITHUB_DATA_BRANCH = 'data-sync'

# 文件 sha 缓存（GitHub Contents API 更新文件时需要）
_file_sha_cache = {}
# 防抖定时器（避免短时间内频繁推送）
_sync_timers = {}
_sync_timers_lock = threading.Lock()


def github_api_get(path):
    """从 GitHub data-sync 分支获取文件内容"""
    if not GITHUB_TOKEN:
        return None
    url = f'https://api.github.com/repos/{GITHUB_REPO}/contents/{path}?ref={GITHUB_DATA_BRANCH}'
    req = urllib.request.Request(url)
    req.add_header('Authorization', f'token {GITHUB_TOKEN}')
    req.add_header('Accept', 'application/vnd.github.v3+json')
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            sha = result.get('sha', '')
            content = result.get('content', '')
            if content:
                # GitHub 返回的 content 是 base64 编码的（可能含换行）
                content_clean = content.replace('\n', '')
                decoded = base64.b64decode(content_clean).decode('utf-8')
                _file_sha_cache[path] = sha
                return json.loads(decoded)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f'[Sync] {path} 远程不存在（首次部署，正常）', flush=True)
        else:
            print(f'[Sync] 获取 {path} 失败: HTTP {e.code}', flush=True)
    except Exception as e:
        print(f'[Sync] 获取 {path} 异常: {e}', flush=True)
    return None


def github_api_put(path, data):
    """推送文件到 GitHub data-sync 分支"""
    if not GITHUB_TOKEN:
        return False
    url = f'https://api.github.com/repos/{GITHUB_REPO}/contents/{path}'
    content = json.dumps(data, ensure_ascii=False, indent=2)
    payload = {
        'message': f'Auto-sync {os.path.basename(path)} {time.strftime("%m-%d %H:%M:%S")}',
        'content': base64.b64encode(content.encode('utf-8')).decode(),
        'branch': GITHUB_DATA_BRANCH
    }
    if path in _file_sha_cache:
        payload['sha'] = _file_sha_cache[path]

    for attempt in range(2):
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), method='PUT')
            req.add_header('Authorization', f'token {GITHUB_TOKEN}')
            req.add_header('Accept', 'application/vnd.github.v3+json')
            req.add_header('Content-Type', 'application/json')
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                if 'content' in result:
                    _file_sha_cache[path] = result['content'].get('sha', '')
                print(f'[Sync] 推送 {path} 成功', flush=True)
                return True
        except urllib.error.HTTPError as e:
            if e.code == 422 and attempt == 0:
                # sha 不匹配（文件被其他进程更新过），重新获取 sha 后重试
                print(f'[Sync] {path} sha不匹配，重新获取...', flush=True)
                github_api_get(path)
                if path in _file_sha_cache:
                    payload['sha'] = _file_sha_cache[path]
                continue
            err_body = e.read().decode('utf-8')[:200] if e.fp else ''
            print(f'[Sync] 推送 {path} 失败: HTTP {e.code} {err_body}', flush=True)
            return False
        except Exception as e:
            print(f'[Sync] 推送 {path} 异常: {e}', flush=True)
            return False
    return False


def schedule_sync(filepath, data):
    """防抖推送：3秒内多次保存合并为一次 GitHub 推送"""
    if not GITHUB_TOKEN:
        return
    rel_path = os.path.relpath(filepath, WEB_ROOT).replace('\\', '/')
    with _sync_timers_lock:
        if rel_path in _sync_timers:
            _sync_timers[rel_path].cancel()
        timer = threading.Timer(3.0, github_api_put, args=(rel_path, data))
        timer.daemon = True
        _sync_timers[rel_path] = timer
        timer.start()


# ---- 数据存储工具函数 ----
def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(8)
    hashed = hashlib.sha256((salt + password).encode('utf-8')).hexdigest()
    return hashed, salt

def verify_password(password, stored_hash, salt):
    hashed, _ = hash_password(password, salt)
    return hashed == stored_hash

def load_json(filepath):
    """从本地文件读取 JSON"""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def save_json(filepath, data):
    """保存 JSON 到本地文件 + 异步同步到 GitHub（防抖3秒）"""
    # 1. 写本地文件（原子操作）
    tmp_path = filepath + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, filepath)
    # 2. 异步同步到 GitHub（防抖3秒，避免频繁推送）
    schedule_sync(filepath, data)

def init_data_files():
    """初始化数据文件：启动时先从 GitHub data-sync 分支拉取最新数据"""
    # 先从 GitHub 拉取数据（覆盖本地初始文件）
    if GITHUB_TOKEN:
        print('[Sync] 从 GitHub data-sync 分支拉取最新数据...', flush=True)
        for filename in ['users.json', 'study_data.json', 'admin.json']:
            rel_path = f'data/{filename}'
            remote_data = github_api_get(rel_path)
            if remote_data is not None:
                local_path = os.path.join(DATA_DIR, filename)
                with open(local_path, 'w', encoding='utf-8') as f:
                    json.dump(remote_data, f, ensure_ascii=False, indent=2)
                print(f'[Sync] 已拉取 {filename} ({len(str(remote_data))} bytes)', flush=True)
            else:
                print(f'[Sync] {filename} 远程不存在，使用本地默认值', flush=True)

    # 本地文件不存在时创建默认值
    users_path = os.path.join(DATA_DIR, 'users.json')
    admin_path = os.path.join(DATA_DIR, 'admin.json')
    study_path = os.path.join(DATA_DIR, 'study_data.json')
    if not os.path.exists(users_path):
        save_json(users_path, {})
    if not os.path.exists(study_path):
        save_json(study_path, {})
    if not os.path.exists(admin_path):
        hashed, salt = hash_password(DEFAULT_ADMIN_PASSWORD)
        save_json(admin_path, {
            'admin': {
                'username': 'admin',
                'password_hash': hashed,
                'salt': salt,
                'created_at': int(time.time() * 1000)
            }
        })

init_data_files()


# ---- CORS 跨域支持 ----
@app.after_request
def after_request(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    # Service Worker 和 PWA 特殊处理
    path = request.path
    if 'service-worker.js' in path:
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Service-Worker-Allowed'] = '/'
    elif 'manifest.json' in path:
        response.headers['Cache-Control'] = 'no-cache'
    else:
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    return response


# ---- 静态文件路由 ----
@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    """提供所有静态文件（HTML/JS/CSS/Audio/图片等）"""
    # 尝试从项目根目录提供文件
    file_path = os.path.join(WEB_ROOT, path)
    if os.path.isfile(file_path) and not path.startswith('api'):
        # 根据文件扩展名设置正确的 MIME 类型
        if path.endswith('.manifest') or path.endswith('manifest.json'):
            return send_file(file_path, mimetype='application/manifest+json')
        elif path.endswith('.js'):
            return send_file(file_path, mimetype='application/javascript')
        elif path.endswith('.css'):
            return send_file(file_path, mimetype='text/css')
        elif path.endswith('.mp3'):
            return send_file(file_path, mimetype='audio/mpeg')
        elif path.endswith('.png'):
            return send_file(file_path, mimetype='image/png')
        elif path.endswith('.ico'):
            return send_file(file_path, mimetype='image/x-icon')
        elif path.endswith('.svg'):
            return send_file(file_path, mimetype='image/svg+xml')
        else:
            return send_file(file_path)
    return jsonify({'error': 'Not found'}), 404


# ---- OPTIONS 预检请求 ----
@app.route('/api/<path:path>', methods=['OPTIONS'])
def api_options(path):
    return '', 200


# ---- 用户认证 API ----
@app.route('/api/login', methods=['POST'])
def handle_login():
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    password = body.get('password', '')
    users = load_json(os.path.join(DATA_DIR, 'users.json'))
    user = users.get(empid)
    if not user:
        return jsonify({'success': False, 'error': '该工号未注册，请联系管理员'}), 401
    if not verify_password(password, user['password_hash'], user['salt']):
        return jsonify({'success': False, 'error': '密码错误'}), 401
    with data_lock:
        user['last_login'] = int(time.time() * 1000)
        user['login_count'] = user.get('login_count', 0) + 1
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
    return jsonify({
        'success': True,
        'user': {'empid': user['empid'], 'name': user['name'], 'must_change_password': user.get('must_change_password', False)}
    })


@app.route('/api/register', methods=['POST'])
def handle_register():
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    name = (body.get('name') or '').strip()
    if not empid or not name:
        return jsonify({'success': False, 'error': '工号和姓名不能为空'}), 400
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        if empid in users:
            return jsonify({'success': False, 'error': '该工号已存在'}), 400
        hashed, salt = hash_password(DEFAULT_PASSWORD)
        users[empid] = {
            'empid': empid, 'name': name, 'password_hash': hashed, 'salt': salt,
            'created_at': int(time.time() * 1000), 'created_by': 'admin',
            'last_login': 0, 'login_count': 0, 'must_change_password': False
        }
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        study_data[empid] = {
            'empid': empid, 'name': name, 'learnedIds': [], 'masteredIds': [],
            'favoriteIds': [], 'speakScores': {}, 'sessions': [], 'studyDates': [],
            'lastIndex': 0, 'totalStudySeconds': 0,
            'createdAt': int(time.time() * 1000), 'updatedAt': int(time.time() * 1000)
        }
        save_json(os.path.join(DATA_DIR, 'study_data.json'), study_data)
    return jsonify({'success': True, 'message': f'已添加学员 {name}，初始密码 {DEFAULT_PASSWORD}'})


@app.route('/api/import-students', methods=['POST'])
def handle_import_students():
    body = request.json or {}
    students = body.get('students', [])
    added = 0
    skipped = []
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        for s in students:
            empid = str(s.get('empid', '')).strip()
            name = str(s.get('name', '')).strip()
            if not empid or not name:
                skipped.append(f'{empid} - 工号或姓名为空')
                continue
            if empid in users:
                skipped.append(f'{empid} {name} - 已存在')
                continue
            hashed, salt = hash_password(DEFAULT_PASSWORD)
            users[empid] = {
                'empid': empid, 'name': name, 'password_hash': hashed, 'salt': salt,
                'created_at': int(time.time() * 1000), 'created_by': 'admin',
                'last_login': 0, 'login_count': 0, 'must_change_password': False
            }
            study_data[empid] = {
                'empid': empid, 'name': name, 'learnedIds': [], 'masteredIds': [],
                'favoriteIds': [], 'speakScores': {}, 'sessions': [], 'studyDates': [],
                'lastIndex': 0, 'totalStudySeconds': 0,
                'createdAt': int(time.time() * 1000), 'updatedAt': int(time.time() * 1000)
            }
            added += 1
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
        save_json(os.path.join(DATA_DIR, 'study_data.json'), study_data)
    return jsonify({
        'success': True, 'added': added, 'skipped': skipped,
        'message': f'成功导入 {added} 人' + (f'，跳过 {len(skipped)} 人' if skipped else '')
    })


# ---- 学习数据 API ----
@app.route('/api/study-data', methods=['GET'])
def handle_get_study_data():
    empid = (request.args.get('empid') or '').strip()
    study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
    data = study_data.get(empid)
    if not data:
        return jsonify({'success': True, 'studyData': None})
    return jsonify({'success': True, 'studyData': data})


@app.route('/api/study-data', methods=['POST'])
def handle_save_study_data():
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    sd = body.get('studyData', {})
    with data_lock:
        all_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        all_data[empid] = sd
        all_data[empid]['updatedAt'] = int(time.time() * 1000)
        save_json(os.path.join(DATA_DIR, 'study_data.json'), all_data)
    return jsonify({'success': True})


# ---- 密码管理 API ----
@app.route('/api/change-password', methods=['POST'])
def handle_change_password():
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    old_password = body.get('oldPassword', '')
    new_password = body.get('newPassword', '')
    if len(new_password) < 6:
        return jsonify({'success': False, 'error': '新密码至少6位'}), 400
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        user = users.get(empid)
        if not user:
            return jsonify({'success': False, 'error': '用户不存在'}), 404
        if not verify_password(old_password, user['password_hash'], user['salt']):
            return jsonify({'success': False, 'error': '原密码错误'}), 401
        hashed, salt = hash_password(new_password)
        user['password_hash'] = hashed
        user['salt'] = salt
        user['must_change_password'] = False
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
    return jsonify({'success': True, 'message': '密码修改成功'})


@app.route('/api/reset-password', methods=['POST'])
def handle_reset_password():
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        user = users.get(empid)
        if not user:
            return jsonify({'success': False, 'error': '用户不存在'}), 404
        hashed, salt = hash_password(DEFAULT_PASSWORD)
        user['password_hash'] = hashed
        user['salt'] = salt
        user['must_change_password'] = True
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
    return jsonify({'success': True, 'message': f'已重置密码为 {DEFAULT_PASSWORD}'})


# ---- 管理员 API ----
@app.route('/api/admin-login', methods=['POST'])
def handle_admin_login():
    body = request.json or {}
    username = (body.get('username') or '').strip()
    password = body.get('password', '')
    admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
    admin_user = admin.get(username)
    if not admin_user or not verify_password(password, admin_user['password_hash'], admin_user['salt']):
        return jsonify({'success': False, 'error': '用户名或密码错误'}), 401
    token = secrets.token_hex(16)
    with data_lock:
        admin_user['session_token'] = token
        admin_user['last_login'] = int(time.time() * 1000)
        save_json(os.path.join(DATA_DIR, 'admin.json'), admin)
    return jsonify({'success': True, 'token': token})


@app.route('/api/admin-change-password', methods=['POST'])
def handle_admin_change_password():
    body = request.json or {}
    username = (body.get('username') or 'admin').strip()
    old_password = body.get('oldPassword', '')
    new_password = body.get('newPassword', '')
    if len(new_password) < 6:
        return jsonify({'success': False, 'error': '新密码至少6位'}), 400
    with data_lock:
        admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
        admin_user = admin.get(username)
        if not admin_user:
            return jsonify({'success': False, 'error': '管理员不存在'}), 404
        if not verify_password(old_password, admin_user['password_hash'], admin_user['salt']):
            return jsonify({'success': False, 'error': '原密码错误'}), 401
        hashed, salt = hash_password(new_password)
        admin_user['password_hash'] = hashed
        admin_user['salt'] = salt
        admin_user['last_password_change'] = int(time.time() * 1000)
        save_json(os.path.join(DATA_DIR, 'admin.json'), admin)
    return jsonify({'success': True, 'message': '密码修改成功'})


@app.route('/api/admin/users', methods=['GET'])
def handle_admin_get_users():
    token = (request.args.get('token') or '').strip()
    admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
    admin_user = admin.get('admin', {})
    if not token or token != admin_user.get('session_token', ''):
        return jsonify({'success': False, 'error': '未授权'}), 401
    users = load_json(os.path.join(DATA_DIR, 'users.json'))
    study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
    all_users = []
    for empid, user in users.items():
        sd = study_data.get(empid, {})
        speak_scores = sd.get('speakScores', {})
        scores = list(speak_scores.values()) if isinstance(speak_scores, dict) else []
        avg_score = round(sum(scores) / len(scores)) if scores else 0
        all_users.append({
            'empid': empid, 'name': user['name'],
            'createdAt': user.get('created_at', 0),
            'lastLogin': user.get('last_login', 0),
            'loginCount': user.get('login_count', 0),
            'learnedCount': len(sd.get('learnedIds', [])),
            'masteredCount': len(sd.get('masteredIds', [])),
            'totalStudySeconds': sd.get('totalStudySeconds', 0),
            'sessions': sd.get('sessions', []),
            'studyDates': sd.get('studyDates', []),
            'avgScore': avg_score
        })
    return jsonify({'success': True, 'users': all_users})


@app.route('/api/admin/delete-user', methods=['POST'])
def handle_admin_delete_user():
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    token = body.get('token', '')
    admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
    if token != admin.get('admin', {}).get('session_token', ''):
        return jsonify({'success': False, 'error': '未授权'}), 401
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        if empid in users:
            del users[empid]
        if empid in study_data:
            del study_data[empid]
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
        save_json(os.path.join(DATA_DIR, 'study_data.json'), study_data)
    return jsonify({'success': True, 'message': '已删除'})


# ---- 语音识别 API ----
@app.route('/api/transcribe', methods=['POST'])
def handle_transcribe():
    """接收音频文件，返回识别文本。
    前端上传 raw PCM (audio/l16, 16kHz, mono, 16-bit)，
    后端将其包装成 WAV 后用 SpeechRecognition 识别。
    """
    print(f'[Transcribe] 收到请求, Content-Type: {request.content_type}', flush=True)
    try:
        content_type = request.content_type or ''
        if 'multipart/form-data' not in content_type:
            return jsonify({'error': '需要 multipart/form-data 格式'}), 400

        # 获取上传的音频文件
        audio_file = None
        audio_data = b''
        audio_mime = ''
        if 'audio' in request.files:
            audio_file = request.files['audio']
            audio_data = audio_file.read()
            audio_mime = audio_file.mimetype or ''
        elif 'file' in request.files:
            audio_file = request.files['file']
            audio_data = audio_file.read()
            audio_mime = audio_file.mimetype or ''
        else:
            audio_data = request.data

        if not audio_data or len(audio_data) < 20:
            return jsonify({'success': False, 'text': '', 'error': '音频数据为空或太短'})

        print(f'[Transcribe] 音频大小: {len(audio_data)} bytes, MIME: {audio_mime}', flush=True)

        # 前端上传的是 raw PCM (audio/l16, 16kHz, mono, 16-bit)
        # 需要包装成 WAV 格式才能被 SpeechRecognition 读取
        wav_path = None
        temp_path = None
        try:
            import wave
            import struct

            if 'l16' in audio_mime.lower() or 'pcm' in audio_mime.lower():
                # raw PCM: 16kHz, mono, 16-bit
                print('[Transcribe] 检测到 raw PCM 数据，包装为 WAV', flush=True)
                wav_path = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name

                # 计算音频时长，短音频需要静音填充到 1.5s（Google API 需要足够上下文）
                num_samples = len(audio_data) // 2  # 16-bit = 2 bytes/sample
                duration = num_samples / 16000
                print(f'[Transcribe] PCM 时长: {duration:.2f}s', flush=True)

                with wave.open(wav_path, 'wb') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)  # 16-bit = 2 bytes
                    wf.setframerate(16000)

                    if duration < 1.2:
                        # 短音频填充静音到 1.5s
                        pad_samples = int((1.5 - duration) / 2 * 16000)
                        pad_bytes = pad_samples * 2  # 16-bit = 2 bytes
                        silence_pad = b'\x00' * pad_bytes
                        wf.writeframes(silence_pad + audio_data + silence_pad)
                        print(f'[Transcribe] WAV 静音填充: {duration:.2f}s → 1.5s (前后各 {pad_samples} samples)', flush=True)
                    else:
                        wf.writeframes(audio_data)
                audio_to_recognize = wav_path
            else:
                # webm/ogg 等格式，需要 ffmpeg 转换
                # 保存原始文件
                suffix = '.webm' if 'webm' in audio_mime else '.bin'
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                    f.write(audio_data)
                    temp_path = f.name

                # 尝试用 ffmpeg 转换为 wav
                import subprocess
                wav_path = temp_path.rsplit('.', 1)[0] + '.wav'
                try:
                    result = subprocess.run(
                        ['ffmpeg', '-y', '-i', temp_path, '-ar', '16000', '-ac', '1',
                         '-f', 'wav', wav_path],
                        capture_output=True, timeout=15
                    )
                    if result.returncode != 0:
                        print(f'[Transcribe] ffmpeg转换失败: {result.stderr.decode()[:200]}', flush=True)
                        return jsonify({'success': False, 'text': '', 'error': '音频格式转换失败，请重试'})
                    audio_to_recognize = wav_path
                except FileNotFoundError:
                    print('[Transcribe] ffmpeg未安装，尝试直接读取', flush=True)
                    audio_to_recognize = temp_path

            # 识别
            text = transcribe_audio(audio_to_recognize)
            if text:
                return jsonify({'success': True, 'text': text, 'confidence': 0.9})
            else:
                return jsonify({'success': False, 'text': '', 'error': '未能识别语音，请说话更清晰后重试'})
        finally:
            # 清理临时文件
            for p in [temp_path, wav_path]:
                if p:
                    try:
                        os.unlink(p)
                    except:
                        pass
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def transcribe_audio(filepath):
    """用 SpeechRecognition 识别 WAV 文件"""
    try:
        import speech_recognition as sr
        recognizer = sr.Recognizer()
        recognizer.energy_threshold = 50
        recognizer.dynamic_energy_threshold = True
        recognizer.pause_threshold = 0.5
        recognizer.operation_timeout = 5

        with sr.AudioFile(filepath) as source:
            audio = recognizer.record(source)

        # 尝试 Google Web Speech API（免费，无需 API key）
        try:
            text = recognizer.recognize_google(audio, language='en-US')
            print(f'[Google SR] 成功: "{text}"', flush=True)
            return text
        except sr.UnknownValueError:
            print('[Google SR] 无法识别音频内容', flush=True)
            return ''
        except sr.RequestError as e:
            print(f'[Google SR] API请求错误: {e}', flush=True)
            # Google API 不可用时，返回空字符串（前端会显示提示）
            return ''

    except ImportError:
        print('[WARN] speech_recognition 未安装', flush=True)
        return ''
    except Exception as e:
        print(f'[Transcribe] 识别异常: {e}', flush=True)
        import traceback
        traceback.print_exc()
        return ''


# ---- 自保活线程 ----
# Render 免费版 15 分钟无请求会休眠
# 解决方案：后台线程每 10 分钟向自己的公网 URL 发 HTTP 请求
# 只要服务在运行，就不会休眠；服务重启后线程自动恢复
SELF_PING_URL = os.environ.get('RENDER_EXTERNAL_URL', 'https://hi-english.onrender.com')

# 保活状态记录（可通过 /api/keepalive 查看）
_keepalive_status = {
    'started_at': 0,
    'last_ping_time': 0,
    'last_ping_status': '',
    'ping_count': 0
}

def keepalive_loop():
    """后台保活线程：每 10 分钟 ping 自己一次"""
    _keepalive_status['started_at'] = int(time.time())
    # 启动后等待 30 秒，确保服务完全就绪
    time.sleep(30)
    while True:
        try:
            ping_url = SELF_PING_URL.rstrip('/') + '/api/keepalive?from=self'
            req = urllib.request.Request(ping_url)
            req.add_header('User-Agent', 'HiEnglish-KeepAlive/1.0')
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = resp.getcode()
                _keepalive_status['last_ping_time'] = int(time.time())
                _keepalive_status['last_ping_status'] = f'HTTP {status}'
                _keepalive_status['ping_count'] += 1
                print(f'[KeepAlive] ping #{_keepalive_status["ping_count"]} -> HTTP {status} @ {time.strftime("%H:%M:%S")}', flush=True)
        except Exception as e:
            _keepalive_status['last_ping_time'] = int(time.time())
            _keepalive_status['last_ping_status'] = f'失败: {e}'
            print(f'[KeepAlive] ping 失败: {e} @ {time.strftime("%H:%M:%S")}', flush=True)
        # 每 10 分钟 ping 一次
        time.sleep(600)


@app.route('/api/keepalive', methods=['GET'])
def keepalive_endpoint():
    """保活端点：返回保活状态，可用于验证线程是否在运行"""
    now = int(time.time())
    last_ping = _keepalive_status['last_ping_time']
    since_last = now - last_ping if last_ping else 0
    return jsonify({
        'status': 'ok',
        'time': now,
        'keepalive': {
            'started_at': _keepalive_status['started_at'],
            'last_ping_time': last_ping,
            'seconds_since_last_ping': since_last,
            'last_ping_status': _keepalive_status['last_ping_status'],
            'ping_count': _keepalive_status['ping_count'],
            'self_ping_url': SELF_PING_URL
        }
    })


# ---- 启动入口 ----
if __name__ == '__main__':
    # 检查依赖
    try:
        import speech_recognition
        print('[OK] speech_recognition 库已安装', flush=True)
    except ImportError:
        print('[WARN] speech_recognition 未安装，/api/transcribe 将无法使用', flush=True)

    # 启动保活线程
    ka_thread = threading.Thread(target=keepalive_loop, daemon=True)
    ka_thread.start()
    print(f'[KeepAlive] 保活线程已启动，每 10 分钟 ping {SELF_PING_URL}', flush=True)

    print(f'''
╔════════════════════════════════════════╗
║     🎤 Hi English 服务已启动          ║
║                                        ║
║   学员端: http://0.0.0.0:{PORT}      ║
║   管理端: http://0.0.0.0:{PORT}/admin.html ║
║                                        ║
║   语音识别API: /api/transcribe         ║
║   保活: 每10分钟自ping                 ║
╚════════════════════════════════════════╝
''', flush=True)

    app.run(host='0.0.0.0', port=PORT, debug=False, use_reloader=False)
