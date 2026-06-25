#!/usr/bin/env python3
"""
Hi English - 语音识别API服务
提供 /api/transcribe 接口，接收音频文件并返回识别文本
使用 speech_recognition 库 + Google Web Speech API
"""

import http.server
import json
import os
import sys
import cgi
import tempfile
import urllib.request
import urllib.error
import ssl
import hashlib
import secrets
import threading
import time
from urllib.parse import urlparse, parse_qs

# 强制stdout不缓冲
sys.stdout.reconfigure(line_buffering=True)

PORT = int(os.environ.get('PORT', 8090))
WEB_ROOT = os.path.dirname(os.path.abspath(__file__))

# 数据存储
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


class HiEnglishHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    def end_headers(self):
        # CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

        # Service Worker 不能被 no-cache 覆盖，需要特殊处理
        if self.path and 'service-worker.js' in self.path:
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Service-Worker-Allowed', '/')
        elif self.path and ('manifest.json' in self.path):
            self.send_header('Cache-Control', 'no-cache')
        else:
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')

        super().end_headers()

    def guess_type(self, path):
        """添加 PWA 相关文件的 MIME 类型"""
        mimetype = super().guess_type(path)
        # manifest.json
        if path.endswith('.manifest') or path.endswith('manifest.json'):
            return 'application/manifest+json'
        # service-worker.js 确保正确的 MIME
        if path.endswith('service-worker.js'):
            return 'text/javascript'
        return mimetype

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/transcribe':
            self.handle_transcribe()
        elif self.path == '/api/login':
            self.handle_login()
        elif self.path == '/api/register':
            self.handle_register()
        elif self.path == '/api/import-students':
            self.handle_import_students()
        elif self.path == '/api/study-data':
            self.handle_save_study_data()
        elif self.path == '/api/change-password':
            self.handle_change_password()
        elif self.path == '/api/reset-password':
            self.handle_reset_password()
        elif self.path == '/api/admin-login':
            self.handle_admin_login()
        elif self.path == '/api/admin-change-password':
            self.handle_admin_change_password()
        elif self.path == '/api/admin/delete-user':
            self.handle_admin_delete_user()
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path.startswith('/api/study-data'):
            self.handle_get_study_data()
        elif self.path.startswith('/api/admin/users'):
            self.handle_admin_get_users()
        else:
            super().do_GET()

    def handle_transcribe(self):
        """接收音频文件，返回识别文本"""
        print(f'[Transcribe] 收到请求, Content-Length: {self.headers.get("Content-Length", 0)}', flush=True)
        try:
            # 解析 multipart form data
            content_type = self.headers.get('Content-Type', '')
            if 'multipart/form-data' not in content_type:
                self.send_json_response(400, {'error': '需要 multipart/form-data 格式'})
                return

            # 读取body
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            print(f'[Transcribe] Body size: {len(body)} bytes')

            # 解析边界
            boundary = content_type.split('boundary=')[1].encode()

            # 找到音频数据
            parts = body.split(b'--' + boundary)
            audio_data = None
            filename = None

            for part in parts:
                if b'filename=' in part:
                    # 提取文件数据（跳过headers）
                    header_end = part.find(b'\r\n\r\n')
                    if header_end > 0:
                        audio_data = part[header_end + 4:]
                        # 去掉最后的 \r\n--
                        if audio_data.endswith(b'\r\n'):
                            audio_data = audio_data[:-2]
                        break

            if not audio_data or len(audio_data) < 100:
                print(f'[Transcribe] 音频数据为空或太短: {len(audio_data) if audio_data else 0} bytes')
                self.send_json_response(400, {'error': '音频数据为空或太短'})
                return

            print(f'[Transcribe] 音频数据大小: {len(audio_data)} bytes')

            # 保存临时文件
            with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
                f.write(audio_data)
                temp_path = f.name

            try:
                # 转换为wav并检测音频能量
                wav_path, energy_info = self._convert_and_detect_energy(temp_path)
                print(f'[Transcribe] {energy_info}')

                # 方法1: 尝试用 speech_recognition 库
                text = self.transcribe_with_library(temp_path, wav_path)

                if not text:
                    # 方法2: 尝试 Google TTS 的语音识别接口
                    text = self.transcribe_with_google_api(wav_path or temp_path)

                if text:
                    print(f'[Transcribe] 成功识别: "{text}" ({len(audio_data)} bytes)')
                    self.send_json_response(200, {
                        'success': True,
                        'text': text,
                        'confidence': 0.9
                    })
                else:
                    # 根据能量信息给出更有用的错误提示
                    if 'silent' in energy_info.lower() or 'quiet' in energy_info.lower():
                        error_msg = '没有检测到声音，请按住麦克风大声朗读单词'
                    elif 'short' in energy_info.lower():
                        error_msg = '录音太短，请按住麦克风多说一会儿再松开'
                    else:
                        error_msg = '未能识别语音，请说话更清晰后重试'
                    print(f'[Transcribe] 识别失败: {error_msg}')
                    self.send_json_response(200, {
                        'success': False,
                        'text': '',
                        'error': error_msg
                    })
            finally:
                try:
                    os.unlink(temp_path)
                except:
                    pass
                # 清理转换的wav文件
                try:
                    wav_cleanup = temp_path.rsplit('.', 1)[0] + '.wav'
                    os.unlink(wav_cleanup)
                except:
                    pass

        except Exception as e:
            print(f'[Transcribe Error] {e}')
            import traceback
            traceback.print_exc()
            self.send_json_response(500, {'error': str(e)})

    def _convert_and_detect_energy(self, filepath):
        """将webm转换为wav并检测音频能量（判断是否有声音）"""
        import subprocess
        import wave
        import struct

        wav_path = filepath.rsplit('.', 1)[0] + '.wav'
        try:
            result = subprocess.run(
                ['ffmpeg', '-y', '-i', filepath, '-ar', '16000', '-ac', '1',
                 '-f', 'wav', wav_path],
                capture_output=True, timeout=15
            )
            if result.returncode != 0:
                print(f'[FFmpeg] 转换失败: {result.stderr.decode()[:200]}')
                return None, '音频转换失败'

            # 检测音频能量
            with wave.open(wav_path, 'rb') as wf:
                n_channels = wf.getnchannels()
                sample_width = wf.getsampwidth()
                framerate = wf.getframerate()
                n_frames = wf.getnframes()
                duration = n_frames / framerate if framerate > 0 else 0
                raw_data = wf.readframes(n_frames)

            # 计算RMS能量
            if sample_width == 2:
                fmt = '<' + ('h' * (len(raw_data) // 2))
                samples = struct.unpack(fmt, raw_data)
            else:
                samples = list(raw_data)

            if len(samples) > 0:
                rms = sum(s**2 for s in samples) / len(samples)
                rms = rms ** 0.5
                peak = max(abs(s) for s in samples)
                info = f'duration={duration:.2f}s, frames={n_frames}, RMS={rms:.1f}, peak={peak}'
            else:
                info = f'duration={duration:.2f}s, 无采样数据'
                rms = 0

            # 判断是否有足够声音（降低阈值，让小声也能通过）
            if duration < 0.3:
                info += ', [SHORT:录音太短]'
            elif rms < 50:
                info += ', [SILENT:太安静/无声音]'
            elif rms < 300:
                info += ', [QUIET:声音较小，但可以尝试识别]'
            else:
                info += ', [OK:有声音]'

            print(f'[Audio Energy] {info}')
            return wav_path, info

        except Exception as e:
            print(f'[Energy Detect] 错误: {e}')
            return None, str(e)

    def transcribe_with_library(self, filepath, wav_path=None):
        """用 speech_recognition 库识别（优先使用已转换的wav文件）"""
        import speech_recognition as sr

        # 优先使用已转换好的wav文件
        audio_to_use = wav_path or filepath

        try:
            recognizer = sr.Recognizer()
            # 降低能量阈值，提高对小声的敏感度
            recognizer.energy_threshold = 80
            recognizer.dynamic_energy_threshold = True  # 动态阈值，自动适应音量
            recognizer.pause_threshold = 0.8
            recognizer.operation_timeout = 5  # 防止卡住

            with sr.AudioFile(audio_to_use) as source:
                audio = recognizer.record(source)

            text = self._recognize_audio(recognizer, audio)
            return text

        except Exception as e:
            print(f'[SR] 库识别失败: {e}')
            import traceback
            traceback.print_exc()
            return None

    def _recognize_audio(self, recognizer, audio):
        """调用Google语音识别API"""
        import speech_recognition as sr
        # 尝试 Google Web Speech API (免费, 无需key)
        try:
            text = recognizer.recognize_google(audio, language='en-US')
            print(f'[Google SR] 识别成功: "{text}"')
            return text
        except sr.UnknownValueError:
            print('[Google SR] 无法识别音频内容')
            return ''
        except sr.RequestError as e:
            print(f'[Google SR] API请求错误: {e}')
            return ''

    def transcribe_with_google_api(self, filepath):
        """备用：直接用 Google Speech API v2 (免费有限额)"""
        try:
            # Google Chrome 使用的语音识别内部API
            url = "https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw&client=chromium"
            
            with open(filepath, 'rb') as f:
                audio_data = f.read()
            
            req = urllib.request.Request(url, data=audio_data, method='POST')
            req.add_header('Content-Type', 'audio/l16; rate=16000')
            
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            
            response = urllib.request.urlopen(req, timeout=10, context=ctx)
            result = response.read().decode('utf-8')
            
            # 解析结果
            lines = result.strip().split('\n')
            for line in reversed(lines):  # 最后一条是最准确的
                if line.startswith('{'):
                    data = json.loads(line)
                    if 'result' in data and len(data['result']) > 0:
                        alternatives = data['result'][0].get('alternative', [])
                        if alternatives:
                            return alternatives[0].get('transcript', '')
            return ''
            
        except Exception as e:
            print(f'[Google API] 备用识别失败: {e}')
            return ''

    # ---- 用户认证与数据 API ----
    def _read_json_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        return json.loads(body.decode('utf-8')) if body else {}

    def handle_login(self):
        body = self._read_json_body()
        empid = body.get('empid', '').strip()
        password = body.get('password', '')
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        user = users.get(empid)
        if not user:
            self.send_json_response(401, {'success': False, 'error': '该工号未注册，请联系管理员'})
            return
        if not verify_password(password, user['password_hash'], user['salt']):
            self.send_json_response(401, {'success': False, 'error': '密码错误'})
            return
        with data_lock:
            user['last_login'] = int(time.time() * 1000)
            user['login_count'] = user.get('login_count', 0) + 1
            save_json(os.path.join(DATA_DIR, 'users.json'), users)
        self.send_json_response(200, {
            'success': True,
            'user': {'empid': user['empid'], 'name': user['name'], 'must_change_password': user.get('must_change_password', False)}
        })

    def handle_register(self):
        body = self._read_json_body()
        empid = body.get('empid', '').strip()
        name = body.get('name', '').strip()
        if not empid or not name:
            self.send_json_response(400, {'success': False, 'error': '工号和姓名不能为空'})
            return
        with data_lock:
            users = load_json(os.path.join(DATA_DIR, 'users.json'))
            if empid in users:
                self.send_json_response(400, {'success': False, 'error': '该工号已存在'})
                return
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
        self.send_json_response(200, {'success': True, 'message': f'已添加学员 {name}，初始密码 {DEFAULT_PASSWORD}'})

    def handle_import_students(self):
        body = self._read_json_body()
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
        self.send_json_response(200, {
            'success': True, 'added': added, 'skipped': skipped,
            'message': f'成功导入 {added} 人' + (f'，跳过 {len(skipped)} 人' if skipped else '')
        })

    def handle_get_study_data(self):
        query = parse_qs(urlparse(self.path).query)
        empid = query.get('empid', [''])[0].strip()
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        data = study_data.get(empid)
        if not data:
            self.send_json_response(200, {'success': True, 'studyData': None})
            return
        self.send_json_response(200, {'success': True, 'studyData': data})

    def handle_save_study_data(self):
        body = self._read_json_body()
        empid = body.get('empid', '').strip()
        sd = body.get('studyData', {})
        with data_lock:
            all_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
            all_data[empid] = sd
            all_data[empid]['updatedAt'] = int(time.time() * 1000)
            save_json(os.path.join(DATA_DIR, 'study_data.json'), all_data)
        self.send_json_response(200, {'success': True})

    def handle_change_password(self):
        body = self._read_json_body()
        empid = body.get('empid', '').strip()
        old_password = body.get('oldPassword', '')
        new_password = body.get('newPassword', '')
        if len(new_password) < 6:
            self.send_json_response(400, {'success': False, 'error': '新密码至少6位'})
            return
        with data_lock:
            users = load_json(os.path.join(DATA_DIR, 'users.json'))
            user = users.get(empid)
            if not user:
                self.send_json_response(404, {'success': False, 'error': '用户不存在'})
                return
            if not verify_password(old_password, user['password_hash'], user['salt']):
                self.send_json_response(401, {'success': False, 'error': '原密码错误'})
                return
            hashed, salt = hash_password(new_password)
            user['password_hash'] = hashed
            user['salt'] = salt
            user['must_change_password'] = False
            save_json(os.path.join(DATA_DIR, 'users.json'), users)
        self.send_json_response(200, {'success': True, 'message': '密码修改成功'})

    def handle_reset_password(self):
        body = self._read_json_body()
        empid = body.get('empid', '').strip()
        with data_lock:
            users = load_json(os.path.join(DATA_DIR, 'users.json'))
            user = users.get(empid)
            if not user:
                self.send_json_response(404, {'success': False, 'error': '用户不存在'})
                return
            hashed, salt = hash_password(DEFAULT_PASSWORD)
            user['password_hash'] = hashed
            user['salt'] = salt
            user['must_change_password'] = True
            save_json(os.path.join(DATA_DIR, 'users.json'), users)
        self.send_json_response(200, {'success': True, 'message': f'已重置密码为 {DEFAULT_PASSWORD}'})

    def handle_admin_login(self):
        body = self._read_json_body()
        username = body.get('username', '').strip()
        password = body.get('password', '')
        admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
        admin_user = admin.get(username)
        if not admin_user or not verify_password(password, admin_user['password_hash'], admin_user['salt']):
            self.send_json_response(401, {'success': False, 'error': '用户名或密码错误'})
            return
        token = secrets.token_hex(16)
        with data_lock:
            admin_user['session_token'] = token
            admin_user['last_login'] = int(time.time() * 1000)
            save_json(os.path.join(DATA_DIR, 'admin.json'), admin)
        self.send_json_response(200, {'success': True, 'token': token})

    def handle_admin_change_password(self):
        body = self._read_json_body()
        username = body.get('username', 'admin').strip()
        old_password = body.get('oldPassword', '')
        new_password = body.get('newPassword', '')
        if len(new_password) < 6:
            self.send_json_response(400, {'success': False, 'error': '新密码至少6位'})
            return
        with data_lock:
            admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
            admin_user = admin.get(username)
            if not admin_user:
                self.send_json_response(404, {'success': False, 'error': '管理员不存在'})
                return
            if not verify_password(old_password, admin_user['password_hash'], admin_user['salt']):
                self.send_json_response(401, {'success': False, 'error': '原密码错误'})
                return
            hashed, salt = hash_password(new_password)
            admin_user['password_hash'] = hashed
            admin_user['salt'] = salt
            admin_user['last_password_change'] = int(time.time() * 1000)
            save_json(os.path.join(DATA_DIR, 'admin.json'), admin)
        self.send_json_response(200, {'success': True, 'message': '密码修改成功'})

    def handle_admin_get_users(self):
        query = parse_qs(urlparse(self.path).query)
        token = query.get('token', [''])[0]
        admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
        admin_user = admin.get('admin', {})
        if not token or token != admin_user.get('session_token', ''):
            self.send_json_response(401, {'success': False, 'error': '未授权'})
            return
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
        self.send_json_response(200, {'success': True, 'users': all_users})

    def handle_admin_delete_user(self):
        body = self._read_json_body()
        empid = body.get('empid', '').strip()
        token = body.get('token', '')
        admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
        if token != admin.get('admin', {}).get('session_token', ''):
            self.send_json_response(401, {'success': False, 'error': '未授权'})
            return
        with data_lock:
            users = load_json(os.path.join(DATA_DIR, 'users.json'))
            study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
            if empid in users:
                del users[empid]
            if empid in study_data:
                del study_data[empid]
            save_json(os.path.join(DATA_DIR, 'users.json'), users)
            save_json(os.path.join(DATA_DIR, 'study_data.json'), study_data)
        self.send_json_response(200, {'success': True, 'message': '已删除'})

    def send_json_response(self, status_code, data):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def log_message(self, format, *args):
        """简化日志输出"""
        print(f'[{self.log_date_time_string()}] {format % args}')


def main():
    # 检查依赖
    try:
        import speech_recognition
        print('[OK] speech_recognition 库已安装')
    except ImportError:
        print('[WARN] speech_recognition 未安装，/api/transcribe 将无法使用')
        print('[WARN] 请运行: pip install SpeechRecognition')

    server = http.server.HTTPServer(('0.0.0.0', PORT), HiEnglishHandler)
    print(f'''
╔════════════════════════════════════════╗
║     🎤 Hi English 语音服务已启动       ║
║                                        ║
║   学员端: http://0.0.0.0:{PORT}      ║
║   管理端: http://0.0.0.0:{PORT}/admin.html ║
║                                        ║
║   语音识别API: /api/transcribe         ║
║   Ctrl+C 停止服务                      ║
╚════════════════════════════════════════╝
''')
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[OK] 服务已停止')
        server.server_close()


if __name__ == '__main__':
    main()
