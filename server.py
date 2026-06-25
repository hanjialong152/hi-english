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
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def save_json(filepath, data):
    tmp_path = filepath + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, filepath)

def init_data_files():
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

        if not audio_data or len(audio_data) < 100:
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
                with wave.open(wav_path, 'wb') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)  # 16-bit = 2 bytes
                    wf.setframerate(16000)
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
        recognizer.energy_threshold = 80
        recognizer.dynamic_energy_threshold = True
        recognizer.pause_threshold = 0.8
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


# ---- 启动入口 ----
if __name__ == '__main__':
    # 检查依赖
    try:
        import speech_recognition
        print('[OK] speech_recognition 库已安装', flush=True)
    except ImportError:
        print('[WARN] speech_recognition 未安装，/api/transcribe 将无法使用', flush=True)

    print(f'''
╔════════════════════════════════════════╗
║     🎤 Hi English 服务已启动          ║
║                                        ║
║   学员端: http://0.0.0.0:{PORT}      ║
║   管理端: http://0.0.0.0:{PORT}/admin.html ║
║                                        ║
║   语音识别API: /api/transcribe         ║
╚════════════════════════════════════════╝
''', flush=True)

    app.run(host='0.0.0.0', port=PORT, debug=False, use_reloader=False)
