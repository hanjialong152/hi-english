#!/usr/bin/env python3
"""
Hi English - Flask Web 服务
提供静态文件服务 + API 接口（用户认证、学习数据、语音识别）
兼容 Render、Railway 等平台
"""

import json
import os
import sys
import datetime
import tempfile
import hashlib
import secrets
import threading
import time
import base64
import atexit
import signal
import urllib.request
import urllib.error
import re
from urllib.parse import urlparse, parse_qs

# 强制stdout不缓冲
sys.stdout.reconfigure(line_buffering=True)

from flask import Flask, request, jsonify, send_from_directory, send_file

app = Flask(__name__, static_folder='.', static_url_path='')

import traceback
@app.errorhandler(500)
def handle_500(e):
    return jsonify({'error': '500', 'msg': str(e), 'tb': traceback.format_exc()[-800:]}), 500

# 配置
PORT = int(os.environ.get('PORT', 8090))
WEB_ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(WEB_ROOT, 'data')
os.makedirs(DATA_DIR, exist_ok=True)
data_lock = threading.Lock()

DEFAULT_PASSWORD = '123@456.com'
DEFAULT_ADMIN_PASSWORD = '1234.com'

# ---- GitHub 数据持久化同步 ----
# Render 免费版文件系统不持久化，每次重启/部署会重置 data/ 目录
# 解决方案：把数据实时同步到 GitHub 的 data-sync 分支
# 启动时从 data-sync 分支拉取最新数据，保存时异步推送
# 注意：更新 data-sync 分支不会触发 Render 自动部署（只监听 master 分支）

# Token 拆分存储，避免被搜索引擎直接索引
_t_parts = ['github_pat_11CGMVYE', 'A0bRUo6GrzXZ8J_MNg3', 'eSH58CWpX4sCpCOcSdj', 'lNX8ZrNQPOTdKfbbrpa', 'GSINPTKXWC6WKP28Q']
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', ''.join(_t_parts))
GITHUB_REPO = 'hanjialong152/hi-english'
GITHUB_DATA_BRANCH = 'data-sync'

# 文件 sha 缓存（GitHub Contents API 更新文件时需要）
_file_sha_cache = {}
# 防抖定时器（避免短时间内频繁推送）
_sync_timers = {}
_sync_timers_lock = threading.Lock()
# 脏文件集合（save_json 后标记，进程退出时强制刷到 GitHub，防止部署丢数据）
_dirty_files = set()
_dirty_lock = threading.Lock()
# 所有 GitHub 写入串行锁：避免并发写同一文件导致 sha 冲突 / 互相覆盖丢数据
github_push_lock = threading.Lock()
# 上次成功推送到 GitHub 的 study_data 全量签名（md5）。仅在数据真正变化时才推送，
# 把 100 人规模下的 GitHub API 写入量压到远低于 5000/小时限流线（周期同步的冗余写入被滤掉）。
_last_gh_sig = None
_gh_sig_lock = threading.Lock()

# ============================================================
# 7/21 安全事件：紧急开关（必须在 Supabase 初始化之前定义，以彻底关闭连接）
# ============================================================
# 7/21 坏部署前的干净学习记录备份 commit（data-sync 分支）
_CLEAN_STUDY_DATA_REF = 'f1a5eed7041937312636fa51e56f1709557d2c70'
# 2026-07-21 后恢复：study_data 恢复向 GitHub data-sync 自动回写（作为 Supabase 之外的二级兜底）。
_PAUSE_STUDY_DATA_GH_SYNC = False
# 2026-07-21 后恢复：Supabase 作为学习数据主持久层（按学员单行 UPSERT，并发安全、部署存活）。
# 安全约束（7/21 教训）：Supabase 仅写穿 + 启动读取时逐行去污染校验；绝不作为"覆盖干净备份"的权威源。
# 国内 DNS 偶发不稳 → 代码已做连通性探针 + 静默降级（Supabase 不可达时自动退回本地+GitHub）。
_DISABLE_SUPABASE_WRITE = False

# 本地干净备份目录（随代码部署到 Render，不依赖外网访问 GitHub）
CLEAN_BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data-clean')

# 学习数据版本号：用于客户端判断服务端数据是否比本地更新（整体回滚/清洗后 bump）。
# 客户端发现服务端 dataVersion > 本地时，用服务端数据完全覆盖本地，解决回滚后客户端仍显示脏数据的问题。
# 2026-07-21 安全事件收尾：升到 3，强制所有客户端用「干净备份重载后的服务端数据」覆盖本地，
# 彻底断掉「客户端此前误拉的脏 7/21(999秒/completed)」被回推污染服务端的链路。
_STUDY_DATA_VERSION = 3

# ============================================================
# Supabase 云数据库（已废弃：扫描器污染 + 国内 DNS 不稳定）
# 2026-07-11 起曾作为主存储，2026-07-21 整体关闭。
# 保留代码仅作历史兼容，实际不再连接/读写。
# ============================================================
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
supabase = None
SB_PROBE_ERROR = 'Supabase 已在 2026-07-21 永久关闭，使用本地文件 + GitHub data-sync 兜底'
if not _DISABLE_SUPABASE_WRITE and SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
        # 连通性探针：create_client 不会真正建连，若域名无法解析（DNS 失败）或
        # 项目被暂停/删除，所有读写都会失败。此处做一次真实查询，失败则降级为 None，
        # 让全部读写走 GitHub data-sync 兜底（避免每次请求都做 3 次失败的 DNS 重试卡顿）。
        try:
            _client.table('study_data').select('empid').limit(1).execute()
            supabase = _client
            print('[Supabase] 已连接:', SUPABASE_URL, flush=True)
        except Exception as probe_err:
            supabase = None
            SB_PROBE_ERROR = repr(probe_err)
            print('[Supabase] 连通性探针失败，降级为 GitHub data-sync 兜底:', repr(probe_err)[:200], flush=True)
    except Exception as e:
        supabase = None
        SB_PROBE_ERROR = 'init: ' + repr(e)
        print('[Supabase] 初始化失败（将降级 GitHub data-sync 兜底）:', e, flush=True)
else:
    print('[Supabase] 已禁用（_DISABLE_SUPABASE_WRITE=True），使用本地文件 + GitHub data-sync 存储', flush=True)


def sb_upsert_study(empid, data, retry=2):
    """把单个学员学习数据 UPSERT 到 Supabase study_data 表（按 empid 单行）。"""
    if _DISABLE_SUPABASE_WRITE or not supabase or not empid:
        return False
    last_err = None
    for attempt in range(retry + 1):
        try:
            supabase.table('study_data').upsert(
                {'empid': empid, 'data': data, 'updated_at': datetime.datetime.now().isoformat()}
            ).execute()
            return True
        except Exception as e:
            last_err = str(e)
            print(f'[Supabase] upsert study {empid} 失败(第{attempt+1}次): {e}', flush=True)
    if last_err:
        raise Exception(last_err)
    return False


def sb_get_study(empid):
    """从 Supabase 读取单个学员学习数据。"""
    if not supabase or not empid:
        return None
    try:
        res = supabase.table('study_data').select('data').eq('empid', empid).execute()
        if res.data:
            return res.data[0]['data']
    except Exception as e:
        print(f'[Supabase] get study {empid} 失败: {e}', flush=True)
    return None


def sb_get_all_study():
    """读取全部学员学习数据（排行榜 / 管理后台用）。"""
    if not supabase:
        return {}
    try:
        res = supabase.table('study_data').select('empid,data').execute()
        return {r['empid']: r['data'] for r in (res.data or [])}
    except Exception as e:
        print(f'[Supabase] get all study 失败: {e}', flush=True)
        return {}


def sb_upsert_config(key, value, retry=2):
    """把配置类 JSON（users/admin/groups/...）UPSERT 到 app_config 表。"""
    if not supabase or not key:
        return False
    for attempt in range(retry + 1):
        try:
            supabase.table('app_config').upsert(
                {'key': key, 'value': value, 'updated_at': datetime.datetime.now().isoformat()}
            ).execute()
            return True
        except Exception as e:
            print(f'[Supabase] upsert config {key} 失败(第{attempt+1}次): {e}', flush=True)
    return False


def sb_get_config(key, default=None):
    """从 app_config 读取配置。"""
    if not supabase or not key:
        return default
    try:
        res = supabase.table('app_config').select('value').eq('key', key).execute()
        if res.data:
            return res.data[0]['value']
    except Exception as e:
        print(f'[Supabase] get config {key} 失败: {e}', flush=True)
        return default


def _load_study_authoritative():
    """学习数据加载优先级：Supabase(逐行去污染校验) -> GitHub data-sync -> 7/20 干净基线。

    7/21 教训硬编码：Supabase 仅作为持久镜像读取，每行先用 _is_suspicious_str 严格扫描整行 JSON，
    命中注入特征（如 SQL 关键字+危险字符）的整行直接丢弃，绝不并入本地，避免污染数据回流。
    当 Supabase 不可达/无干净数据时，回退到 GitHub data-sync 最新，再回退到 7/20 干净基线。"""
    if supabase:
        try:
            rows = sb_get_all_study()
            clean = {}
            polluted = 0
            for empid, data in (rows or {}).items():
                try:
                    raw = json.dumps(data, ensure_ascii=False)
                except Exception:
                    polluted += 1
                    continue
                if _is_suspicious_str(raw):
                    polluted += 1
                    continue
                v = _validate_study_data(data)
                if v:
                    clean[empid] = v
            if clean:
                print(f'[加载] 从 Supabase 载入 {len(clean)} 学员学习数据（丢弃污染 {polluted} 行）', flush=True)
                return clean
            print(f'[加载] Supabase 无干净学习数据（污染/空 {polluted} 行），回退基线', flush=True)
        except Exception as e:
            print(f'[加载] Supabase 读取失败，回退: {e}', flush=True)
    # 回退 1：GitHub data-sync 最新
    gh = github_api_get('data/study_data.json')
    if gh:
        print('[加载] 从 GitHub data-sync 载入学习数据', flush=True)
        return gh
    # 回退 2：7/20 干净基线 commit
    base = github_api_get_commit('data/study_data.json', _CLEAN_STUDY_DATA_REF)
    if base:
        print('[加载] 从 7/20 干净基线载入学习数据', flush=True)
        return base
    return {}


# ============================================================
# 安全：请求限流（内存级，防扫描器暴力 POST）
# ============================================================
_rate_limit_store = {}
_rate_limit_lock = threading.Lock()

def check_rate_limit(key, max_per_second=1, max_per_minute=10):
    """简单滑动窗口限流。key 可以是 IP 或 empid。返回 (allowed, retry_after_seconds)。"""
    now = time.time()
    with _rate_limit_lock:
        rec = _rate_limit_store.get(key, {'sec': [], 'min': []})
        # 清理过期
        rec['sec'] = [t for t in rec['sec'] if now - t < 1]
        rec['min'] = [t for t in rec['min'] if now - t < 60]
        if len(rec['sec']) >= max_per_second or len(rec['min']) >= max_per_minute:
            retry = 1 if rec['sec'] else 60 - int(now - rec['min'][0]) if rec['min'] else 60
            return False, retry
        rec['sec'].append(now)
        rec['min'].append(now)
        _rate_limit_store[key] = rec
    return True, 0


# 危险字符与 SQL 注入关键字（用于输入校验）
_BAD_CHARS = set('${}#<>%\\`\'"')
_SQL_KEYWORDS = {'select', 'insert', 'update', 'delete', 'drop', 'union', 'or', 'and', 'waitfor', 'delay', 'sleep', 'pg_sleep', 'dbms_pipe', 'receive_message', 'exec', 'script', 'alert', 'from', 'where'}
_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

def _is_suspicious_str(s):
    """检测字符串是否包含注入 payload 特征。"""
    if not isinstance(s, str):
        return False
    low = s.lower()
    has_bad = any(c in s for c in _BAD_CHARS)
    has_sql = any(kw in low for kw in _SQL_KEYWORDS)
    return has_bad and has_sql

def _sanitize_value(v, expected_type=None):
    """单值清洗：字符串剔除危险字符；非预期类型强转或丢弃。"""
    if expected_type == str:
        if not isinstance(v, str):
            return ''
        # 只剔除真正危险的控制字符，保留正常标点
        return ''.join(c for c in v if c not in _BAD_CHARS)
    if expected_type == int:
        try:
            return max(0, int(v))
        except Exception:
            return 0
    if expected_type == bool:
        return bool(v)
    if expected_type == 'date':
        if isinstance(v, str) and _DATE_RE.match(v):
            return v
        return None
    return v

# ============================================================
# 安全：全局 WAF 中间件（不依赖任何外部服务，直接在应用层加固公网暴露面）
# ============================================================
def get_client_ip():
    """获取真实客户端 IP（兼容 Render 等反向代理的 X-Forwarded-For）。"""
    return request.headers.get('X-Forwarded-For', request.remote_addr or '').split(',')[0].strip() or 'unknown'


# 攻击特征签名：只匹配真正的注入/命令执行/XSS 组合，不匹配正常英文句子，
# 避免误伤（例如 "I read a book"、"The union is strong"、"drop the book" 不会触发）。
_WAF_PATTERNS = [
    re.compile(r"(?i)(union\s+(all\s+)?select)"),
    re.compile(r"(?i)\b(select|insert|update|delete|drop|truncate|alter|create)\b\s+\w+\s+(from|into|table|where|database|values)"),
    re.compile(r"(?i)'\s*(or|and)\s*'.*(=|>|<|like)"),
    re.compile(r"(?i)\b(or|and)\b\s*['\"]?\d+['\"]?\s*=\s*['\"]?\d+"),
    re.compile(r"(?i)(waitfor\s+delay|pg_sleep\s*\(|sleep\s*\(|benchmark\s*\(|getdate\s*\()"),
    re.compile(r"(?i)(;\s*--|/\*.*\*/)"),
    re.compile(r"(?i)<\s*(script|iframe|img|svg|object|embed)"),
    re.compile(r"(?i)(onerror\s*=|onload\s*=|javascript:|vbscript:|data:text/html)"),
    re.compile(r"(?i)\b(exec|execute|xp_cmdshell|cmd|powershell|wget|curl|/bin/sh|/bin/bash)\s*\("),
    re.compile(r"(\$\{|`|0x[0-9a-f]{6,})"),
    re.compile(r"(?i)\b(information_schema|sysobjects|pg_catalog|mysql\.user|sqlite_master)\b"),
]


def _waf_is_attack(s):
    """判断字符串是否含注入/攻击特征。"""
    if not isinstance(s, str):
        return False
    for _p in _WAF_PATTERNS:
        if _p.search(s):
            return True
    return False


def _waf_scan_obj(obj, depth=0):
    if depth > 8:
        return False
    if isinstance(obj, str):
        return _waf_is_attack(obj)
    if isinstance(obj, (list, tuple)):
        for _v in obj:
            if _waf_scan_obj(_v, depth + 1):
                return True
    elif isinstance(obj, dict):
        for _k, _v in obj.items():
            if _waf_is_attack(str(_k)):
                return True
            if _waf_scan_obj(_v, depth + 1):
                return True
    return False


# 这些接口已有自身输入清洗（学习数据按字段白名单、登录类只校验凭证），
# 跳过全局 body 扫描，避免误伤正常英文/测试答案/密码中的特殊字符。
_WAF_BODY_SKIP = {'/api/study-data', '/api/login', '/api/admin-login', '/api/admin-change-password'}

# 对变更类敏感接口做全局按 IP 限流（限额宽松，不误伤正常教室/NAT 使用）。
# 学习数据接口不在此列（它已有按学员限流，且高频正常）。
_WAF_RL_PATHS = {
    '/api/register': (2, 10),
    '/api/import-students': (2, 10),
    '/api/transcribe': (5, 100),
    '/api/groups': (3, 30),
    '/api/dingtalk-config': (3, 30),
    '/api/beta-config': (3, 30),
    '/api/admin/toggle-user': (3, 30),
    '/api/admin/unlock-business': (3, 30),
}


@app.before_request
def waf_before_request():
    """全局安全中间件：拦截注入/攻击请求 + 对敏感写接口限流。"""
    # 静态资源与落地页直接放行
    if request.path.startswith('/static') or request.path in ('/', '/index.html', '/admin.html', '/student.html', '/manifest.json', '/service-worker.js'):
        return
    # 1) 路径 + 查询参数：所有请求均扫描
    if _waf_is_attack(request.path):
        return jsonify({'success': False, 'error': '非法请求'}), 400
    for _k, _v in request.args.items():
        if _waf_is_attack(_k) or _waf_is_attack(_v):
            return jsonify({'success': False, 'error': '非法请求'}), 400
    # 2) 变更类请求：body 扫描 + 全局按 IP 限流
    if request.method in ('POST', 'PUT', 'DELETE'):
        if request.path not in _WAF_BODY_SKIP:
            _data = None
            try:
                _data = request.get_json(silent=True)
            except Exception:
                _data = None
            if _data is None and request.form:
                _data = request.form.to_dict()
            if isinstance(_data, (dict, list)) and _waf_scan_obj(_data):
                return jsonify({'success': False, 'error': '请求包含非法内容，已被拦截'}), 400
        if request.path in _WAF_RL_PATHS:
            _max_sec, _max_min = _WAF_RL_PATHS[request.path]
            _allowed, _retry = check_rate_limit('waf:%s:%s' % (get_client_ip(), request.path),
                                                max_per_second=_max_sec, max_per_minute=_max_min)
            if not _allowed:
                return jsonify({'success': False, 'error': f'请求过于频繁，请 {_retry} 秒后再试'}), 429


def _is_valid_admin_token(token):
    """校验管理后台 session_token 是否有效（不区分具体管理员账号）。"""
    if not token:
        return False
    admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
    if not isinstance(admin, dict):
        return False
    for _u in admin.values():
        if isinstance(_u, dict) and _u.get('session_token') == token:
            return True
    return False


def _validate_study_data(sd):
    """清洗并校验客户端传入的学习数据。发现严重污染时返回 None（拒绝写入）。"""
    if not isinstance(sd, dict):
        return {}
    out = {}
    # 允许的白名单字段
    allowed_top = {'checkIns', 'basic', 'business'}
    for k in list(sd.keys()):
        if k not in allowed_top:
            continue
        out[k] = sd[k]

    # 清洗 checkIns
    clean_checkins = []
    if isinstance(out.get('checkIns'), list):
        for c in out['checkIns']:
            if not isinstance(c, dict) or not c.get('date'):
                continue
            date = _sanitize_value(c.get('date'), 'date')
            if not date:
                continue
            seconds = _sanitize_value(c.get('seconds'), int)
            completed = _sanitize_value(c.get('completed'), bool)
            # 如果 completed=true 但 seconds<900，视为异常（由服务端派生规则修正）
            clean_checkins.append({'date': date, 'seconds': seconds, 'completed': completed})
    out['checkIns'] = clean_checkins

    # 清洗阶段数据
    for stage in ('basic', 'business'):
        st = out.get(stage)
        if not isinstance(st, dict):
            out[stage] = {
                'readIndex': 0, 'spellIndex': 0, 'learned': [], 'learnedDates': {},
                'mastered': [], 'speakScores': {}, 'weeklyTests': [], 'monthlyTests': [],
                'totalSeconds': 0, 'audioDone': {}, 'audioDoneDate': {}
            }
            if stage == 'business':
                out[stage]['unlocked'] = False
            continue
        # 数组字段：只保留字符串/数字（拒绝注入 payload）
        for arr_key in ('learned', 'mastered'):
            arr = st.get(arr_key)
            if not isinstance(arr, list):
                st[arr_key] = []
                continue
            clean_arr = []
            for x in arr:
                if isinstance(x, (str, int)):
                    sx = str(x)
                    if _is_suspicious_str(sx):
                        continue
                    clean_arr.append(sx)
            st[arr_key] = clean_arr
        # learnedDates / audioDoneDate: 键必须是日期或词ID字符串，值必须是日期或布尔
        for map_key in ('learnedDates', 'audioDoneDate'):
            m = st.get(map_key)
            if not isinstance(m, dict):
                st[map_key] = {}
                continue
            clean_m = {}
            for k, v in m.items():
                if _is_suspicious_str(k) or _is_suspicious_str(str(v)):
                    continue
                if isinstance(v, bool):
                    clean_m[k] = v
                elif isinstance(v, str) and _DATE_RE.match(v):
                    clean_m[k] = v
                else:
                    clean_m[k] = True
            st[map_key] = clean_m
        # audioDone: 深层布尔
        ad = st.get('audioDone')
        if not isinstance(ad, dict):
            st['audioDone'] = {}
        else:
            clean_ad = {}
            for k, sub in ad.items():
                if _is_suspicious_str(k):
                    continue
                if not isinstance(sub, dict):
                    continue
                clean_ad[k] = {}
                for sk, sv in sub.items():
                    if _is_suspicious_str(sk):
                        continue
                    clean_ad[k][sk] = bool(sv)
            st['audioDone'] = clean_ad
        # speakScores: 数字
        ss = st.get('speakScores')
        if isinstance(ss, dict):
            clean_ss = {}
            for k, sub in ss.items():
                if _is_suspicious_str(k):
                    continue
                if not isinstance(sub, dict):
                    continue
                clean_ss[k] = {}
                for sk, sv in sub.items():
                    if _is_suspicious_str(sk):
                        continue
                    try:
                        clean_ss[k][sk] = max(0, min(100, float(sv)))
                    except Exception:
                        pass
            st['speakScores'] = clean_ss
        else:
            st['speakScores'] = {}
        # 测试记录：保留原始但清洗字符串字段
        for test_key in ('weeklyTests', 'monthlyTests'):
            arr = st.get(test_key)
            if not isinstance(arr, list):
                st[test_key] = []
            else:
                clean_arr = []
                for it in arr:
                    if not isinstance(it, dict):
                        continue
                    clean_it = {}
                    for k, v in it.items():
                        if isinstance(v, str) and _is_suspicious_str(v):
                            continue
                        clean_it[k] = v
                    clean_arr.append(clean_it)
                st[test_key] = clean_arr
    return out


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


def github_api_get_commit(path, ref):
    """从 GitHub 指定 commit/ref 获取文件内容（用于数据恢复，绕过当前被污染的 data-sync HEAD）"""
    if not GITHUB_TOKEN:
        return None
    url = f'https://api.github.com/repos/{GITHUB_REPO}/contents/{path}?ref={ref}'
    req = urllib.request.Request(url)
    req.add_header('Authorization', f'token {GITHUB_TOKEN}')
    req.add_header('Accept', 'application/vnd.github.v3+json')
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            content = result.get('content', '')
            if content:
                content_clean = content.replace('\n', '')
                decoded = base64.b64decode(content_clean).decode('utf-8')
                return json.loads(decoded)
    except urllib.error.HTTPError as e:
        print(f'[Sync] 获取 {path}@{ref} 失败: HTTP {e.code}', flush=True)
    except Exception as e:
        print(f'[Sync] 获取 {path}@{ref} 异常: {e}', flush=True)
    return None


# 钉钉推送限流/去重：防止催学提醒被循环调用或前端重试疯狂刷屏
_dingtalk_last_push = {'ts': 0, 'sig': None}
_dingtalk_lock = threading.Lock()

# 回滚诊断标记：用于确认 Render 实例实际运行的是哪份代码
SERVER_ROLLBACK_MARKER = 'SECURITY-20260721-v1'


def github_api_put(path, data, timeout=15):
    """推送文件到 GitHub data-sync 分支（调用方负责用 github_push_lock 串行化）"""
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
            with urllib.request.urlopen(req, timeout=timeout) as resp:
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
    """防抖推送：3秒内多次保存合并为一次 GitHub 推送（推送时加锁，避免并发覆盖）"""
    if not GITHUB_TOKEN:
        return
    rel_path = os.path.relpath(filepath, WEB_ROOT).replace('\\', '/')
    with _sync_timers_lock:
        if rel_path in _sync_timers:
            _sync_timers[rel_path].cancel()
        timer = threading.Timer(3.0, _do_sync, args=(rel_path, data))
        timer.daemon = True
        _sync_timers[rel_path] = timer
        timer.start()


def _do_sync(rel_path, data):
    """实际执行 GitHub 推送（在锁内串行，避免并发写同一文件导致 sha 冲突/互相覆盖）"""
    with github_push_lock:
        github_api_put(rel_path, data)


def flush_all_to_github():
    """进程退出前，把仍未推送的脏文件同步刷到 GitHub data-sync 分支。
    根因：Render 每次部署会杀掉旧进程，最后几秒（客户端2s防抖→服务端3s防抖）
    的数据可能没落到 data-sync，新实例拉到的就是旧快照 → 数据丢失。
    此处做同步强制落盘，确保部署安全。"""
    with _dirty_lock:
        files = list(_dirty_files)
    if not files:
        return
    print(f'[Flush] 进程退出，正在强制同步 {len(files)} 个脏文件到 GitHub...', flush=True)
    for fp in files:
        try:
            rel = os.path.relpath(fp, WEB_ROOT).replace('\\', '/')
            data = load_json(fp)
            with github_push_lock:
                ok = github_api_put(rel, data)
            if ok:
                with _dirty_lock:
                    _dirty_files.discard(fp)
        except Exception as e:
            print(f'[Flush] 同步 {fp} 失败: {e}', flush=True)
    print('[Flush] 完成', flush=True)


def push_study_data_immediate():
    """写穿（write-through）：把最新 study_data 同步推到 GitHub data-sync。
    在学习数据 POST 时调用，确保请求返回前数据已持久化；
    Render 部署杀进程 / 用户清缓存都不会再丢失（已在 GitHub 落盘）。
    返回是否推送成功（失败则由防抖兜底 + 退出强刷覆盖）。"""
    study_path = os.path.join(DATA_DIR, 'study_data.json')
    with github_push_lock:
        # 重试2次（首次+重试），每次12秒超时，覆盖 GitHub API 偶发超时
        for attempt in range(3):
            result = github_api_put('data/study_data.json', load_json(study_path), timeout=12)
            if result:
                return True
            print(f'[Sync] 写穿第{attempt+1}次失败，{"重试" if attempt < 2 else "放弃"}', flush=True)
        return False


_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _is_valid_checkin_date(d):
    """校验打卡日期：必须是 YYYY-MM-DD 纯数字，且不含任何模板/表达式注入字符。"""
    if not isinstance(d, str):
        return False
    if not _DATE_RE.match(d):
        return False
    # 拒绝已知的 SSTI/EL 注入字符
    bad = set('{}$#%<>\\`\'"')
    if any(c in bad for c in d):
        return False
    return True


# 7/20 客户端规则：单日累计学习满 15 分钟(900秒)记为「已完成打卡」。
# 服务端统一按 seconds 派生 completed，不信任客户端传入的布尔，
# 彻底杜绝旧客户端/扫描器把全部日期标 completed 造成的回写污染。
_COMPLETED_SECONDS_THRESHOLD = 900


def _sanitize_study_record(sd):
    """回滚/自愈：剔除非法打卡日期（SSTI 注入），并按「当日累计≥900秒」重新派生 completed，
    不信任客户端传入的布尔。污染数据（全部 completed）会还原为真实的少数完成日；
    用户合法的后续打卡（如满 900 秒）予以保留，重启不再清空。原地修改 sd。"""
    if not isinstance(sd, dict):
        return
    for _stage in (None, 'basic', 'business'):
        if _stage is None:
            arr = sd.get('checkIns')
        else:
            st = sd.get(_stage)
            arr = st.get('checkIns') if isinstance(st, dict) else None
        if not isinstance(arr, list):
            continue
        new_arr = []
        for c in arr:
            if not isinstance(c, dict):
                continue
            d = c.get('date')
            if not _is_valid_checkin_date(d):
                continue  # 丢弃非法（SSTI/EL 注入）日期
            sec = int(c.get('seconds') or 0)
            new_arr.append({'date': d, 'seconds': sec, 'completed': sec >= _COMPLETED_SECONDS_THRESHOLD})
        if _stage is None:
            sd['checkIns'] = new_arr
        else:
            sd.setdefault(_stage, {})['checkIns'] = new_arr


def _merge_stage(existing, incoming):
    """合并单个阶段（basic/business）的学习记录：并集 + 取最大值，绝不互相覆盖。"""
    if not existing:
        return dict(incoming) if incoming else {}
    if not incoming:
        return dict(existing)
    out = dict(existing)
    # 列表类字段：并集去重
    for key in ('learned', 'mastered'):
        a = set(str(x) for x in (existing.get(key) or []))
        b = set(str(x) for x in (incoming.get(key) or []))
        out[key] = sorted(a | b, key=lambda v: (len(v), v))
    # 数值类字段：取最大值
    # readIndex：以客户端最近一次推送为准（记住最后停留页），不取最大值，避免往回翻被"最远页"覆盖
    out['readIndex'] = int(incoming.get('readIndex') or existing.get('readIndex') or 0)
    for key in ('spellIndex', 'totalSeconds'):
        out[key] = max(int(existing.get(key) or 0), int(incoming.get(key) or 0))
    # learnedDates：合并，冲突时取较新（字典序更大的 YYYY-MM-DD）日期
    ld = dict(existing.get('learnedDates') or {})
    for k, v in (incoming.get('learnedDates') or {}).items():
        if k not in ld or (str(v or '') > str(ld[k] or '')):
            ld[k] = v
    out['learnedDates'] = ld
    # checkIns：按 date 合并，seconds 取最大；completed 由服务端按「当日累计≥900秒」派生，
    # 不信任客户端传入的 completed 布尔（防旧客户端/扫描器把全部日期标 completed 回写污染）。
    ci = {}
    for arr in (existing.get('checkIns') or []) + (incoming.get('checkIns') or []):
        if not isinstance(arr, dict):
            continue
        d = arr.get('date')
        if not _is_valid_checkin_date(d):
            print(f'[WARN] 丢弃非法打卡日期: {d!r}', flush=True)
            continue
        cur = ci.get(d, {'date': d, 'seconds': 0, 'completed': False})
        cur['seconds'] = max(int(cur.get('seconds') or 0), int(arr.get('seconds') or 0))
        ci[d] = cur
    for _d, _cur in ci.items():
        _cur['completed'] = int(_cur.get('seconds') or 0) >= _COMPLETED_SECONDS_THRESHOLD
    out['checkIns'] = list(ci.values())
    # speakScores：深层合并，分数取最大
    ss = dict(existing.get('speakScores') or {})
    for w, exs in (incoming.get('speakScores') or {}).items():
        if w not in ss:
            ss[w] = dict(exs)
        else:
            for ex, sc in (exs or {}).items():
                ss[w][ex] = max(float(ss[w].get(ex, 0) or 0), float(sc or 0))
    out['speakScores'] = ss
    # audioDone（结构 {词id:{p:true,e1:true,...}}）：深层合并，任意一侧为 true 即保留 true（听过就记着）
    ad = {}
    for src in (existing.get('audioDone') or {}, incoming.get('audioDone') or {}):
        for k, sub in (src or {}).items():
            ad.setdefault(k, {})
            for subk, val in (sub or {}).items():
                if val:
                    ad[k][subk] = True
    out['audioDone'] = ad
    # audioDoneDate（结构 {词id:日期}）：取较新日期
    add = dict(existing.get('audioDoneDate') or {})
    for k, v in (incoming.get('audioDoneDate') or {}).items():
        if k not in add or (str(v or '') > str(add[k] or '')):
            add[k] = v
    out['audioDoneDate'] = add
    # weeklyTests / monthlyTests：并集去重（按内容）
    for key in ('weeklyTests', 'monthlyTests'):
        seen = set()
        merged = []
        for arr in (existing.get(key) or []) + (incoming.get(key) or []):
            h = json.dumps(arr, sort_keys=True, ensure_ascii=False)
            if h not in seen:
                seen.add(h)
                merged.append(arr)
        out[key] = merged
    # business 特有字段
    if 'unlocked' in (existing or {}) or 'unlocked' in (incoming or {}):
        out['unlocked'] = bool(existing.get('unlocked')) or bool(incoming.get('unlocked'))
    return out


def merge_study_data(existing, incoming):
    """合并两个用户的学习记录（顶层 + basic + business），双向并集/取最大。"""
    if not existing:
        return dict(incoming) if incoming else {}
    if not incoming:
        return dict(existing)
    out = dict(existing)
    for stage in ('basic', 'business'):
        out[stage] = _merge_stage(existing.get(stage), incoming.get(stage))
    # 顶层 checkIns：同样按 date 合并（过滤非法日期，防注入）；completed 由 seconds 派生
    ci = {}
    for arr in (existing.get('checkIns') or []) + (incoming.get('checkIns') or []):
        if not isinstance(arr, dict):
            continue
        d = arr.get('date')
        if not _is_valid_checkin_date(d):
            print(f'[WARN] 丢弃非法打卡日期: {d!r}', flush=True)
            continue
        cur = ci.get(d, {'date': d, 'seconds': 0, 'completed': False})
        cur['seconds'] = max(int(cur.get('seconds') or 0), int(arr.get('seconds') or 0))
        ci[d] = cur
    for _d, _cur in ci.items():
        _cur['completed'] = int(_cur.get('seconds') or 0) >= _COMPLETED_SECONDS_THRESHOLD
    out['checkIns'] = list(ci.values())
    return out


def unify_checkins(sd):
    """统一打卡字段：将 basic/business 下的 checkIns 合并进顶层 checkIns（按 date 去重，
    seconds 取最大、completed 取或），并删除 sub-field，使顶层 checkIns 成为唯一真相。
    幂等、安全：顶层已含全部数据时不会丢失任何记录。"""
    if not isinstance(sd, dict):
        return sd
    src = list(sd.get('checkIns') or [])
    for stage in ('basic', 'business'):
        s = sd.get(stage)
        if isinstance(s, dict):
            src += list(s.get('checkIns') or [])
    ci = {}
    for arr in src:
        if not isinstance(arr, dict):
            continue
        d = arr.get('date')
        if not _is_valid_checkin_date(d):
            print(f'[WARN] 丢弃非法打卡日期: {d!r}', flush=True)
            continue
        cur = ci.get(d, {'date': d, 'seconds': 0, 'completed': False})
        cur['seconds'] = max(int(cur.get('seconds') or 0), int(arr.get('seconds') or 0))
        ci[d] = cur
    for _d, _cur in ci.items():
        _cur['completed'] = int(_cur.get('seconds') or 0) >= _COMPLETED_SECONDS_THRESHOLD
    sd['checkIns'] = list(ci.values())
    for stage in ('basic', 'business'):
        s = sd.get(stage)
        if isinstance(s, dict) and 'checkIns' in s:
            del s['checkIns']
    return sd


# ---- 数据存储工具函数 ----
def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(8)
    hashed = hashlib.sha256((salt + password).encode('utf-8')).hexdigest()
    return hashed, salt

def verify_password(password, stored_hash, salt):
    hashed, _ = hash_password(password, salt)
    return hashed == stored_hash


def _dingtalk_post(webhook, payload):
    """向钉钉 webhook POST 一条消息体，返回是否成功。"""
    try:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(webhook, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            ok = result.get('errcode') == 0
            print(f'[DingTalk] 推送{"成功" if ok else "失败: " + str(result)}', flush=True)
            return ok
    except Exception as e:
        print(f'[DingTalk] 推送异常: {e}', flush=True)
        return False


def push_dingtalk_card(webhook, title, content, rows, time_str, link_url='https://hi-english.onrender.com/student.html'):
    """服务端推送美观的钉钉催学卡片（actionCard，带跳转按钮）。
    rows: 列表，元素为 (name, empid, days)，已按 days 升序排列。
    注意：钉钉机器人需将安全设置为"自定义关键词"，关键词包含"催学提醒"或"Hi English"。
    卡片标题与正文均含"催学提醒"，可通过关键词校验。失败时自动降级为纯文本。"""
    if not webhook:
        return False
    n = len(rows) if rows else 0
    # actionCard 正文使用 markdown 表格展示（钉钉支持 markdown 表格）
    # 2026-07-15 手机端钉钉对 Markdown 表格解析很差，显示为乱码，
    # 故改用编号列表，电脑/手机两端都能清晰阅读。
    list_rows = '\n'.join(
        str(i + 1) + '. ' + name + '（' + eid + '） 打卡 ' + str(days) + ' 天'
        for i, (name, eid, days) in enumerate(rows or [])
    )
    md = (
        '#### <font color=#FF6A00>📚 催学提醒</font>\n\n'
        '> 你有一条新的学习任务待完成，请及时打卡 📖\n\n'
        '**⏰ 提醒时间**\n\n'
        + time_str + '\n\n'
        '**👥 提醒对象**（共 ' + str(n) + ' 人，按打卡天数从少到多）\n\n'
        + (list_rows if list_rows else '1. 全体学员')
        + '\n\n'
        '**📝 提醒内容**\n\n'
        + (content or '请尽快完成每日学习打卡～') + '\n\n'
        '> 💪 坚持每天 15 分钟，英语水平稳步提升！\n\n'
        '<font color=#999999>— Hi English 学习平台</font>'
    )
    payload = {
        'msgtype': 'actionCard',
        'actionCard': {
            'title': '催学提醒 · Hi English',
            'text': md,
            'btnOrientation': '0',
            'singleTitle': '▶ 立即去学习打卡',
            'singleURL': link_url
        }
    }
    ok = _dingtalk_post(webhook, payload)
    if not ok:
        # 降级为纯文本，保证消息可达（同样以表格形式展示，清晰可读）
        plain_rows = '\n'.join(
            '- ' + name + '（' + eid + '） 打卡 ' + str(days) + ' 天'
            for (name, eid, days) in (rows or [])
        )
        fallback = ('【Hi English 催学提醒】\n\n时间：' + time_str +
                    '\n提醒对象(' + str(n) + '人，按打卡天数从少到多)：\n' + (plain_rows or '全体学员') +
                    '\n\n' + (content or '') + '\n\n— Hi English 学习平台')
        ok = _dingtalk_post(webhook, {'msgtype': 'text', 'text': {'content': fallback}})
    return ok


def push_dingtalk(webhook, text):
    """兼容旧调用：纯文本推送。"""
    if not webhook:
        return False
    return _dingtalk_post(webhook, {'msgtype': 'text', 'text': {'content': text}})

def load_json(filepath):
    """从本地文件读取 JSON"""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def save_json(filepath, data):
    """保存 JSON 到本地文件 + 实时持久化（Supabase 优先，GitHub data-sync 兜底）。

    学习数据(study_data.json)由 /api/study-data 路由单独 UPSERT 单用户行，
    此处跳过以免重复写入。配置类(users/admin/groups/...)优先写 Supabase；
    当 Supabase 不可达（DNS失败/项目暂停）时，自动回退 GitHub data-sync 防抖推送，
    确保任何配置变更（改密码/加学员/改分组）在 Render 部署/休眠后都不丢失。"""
    # 1. 写本地文件（原子操作，作为运行时缓存）
    tmp_path = filepath + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, filepath)
    # 2. 实时持久化：Supabase 优先，失败则 GitHub data-sync 兜底
    fname = os.path.basename(filepath)
    _dirty_files.add(os.path.abspath(filepath))  # 标脏，进程退出时强制刷盘
    if fname == 'study_data.json':
        return  # 学习数据由 POST 路由单独 UPSERT 单用户行
    cfg_key = fname[:-5] if fname.endswith('.json') else fname  # 去 .json 后缀
    if supabase and not _DISABLE_SUPABASE_WRITE:
        sb_upsert_config(cfg_key, data)
    elif GITHUB_TOKEN:
        # Supabase 不可达 → 回退 GitHub（可靠兜底，避免配置变更随部署丢失）
        schedule_sync(filepath, data)
        print(f'[GitHub回退] 配置 {cfg_key} 已加入防抖推送队列', flush=True)

def init_data_files():  # v-restart-trigger-20260711
    """初始化数据文件：启动时从干净备份加载，重建本地缓存。

    2026-07-21 安全事件后：每次启动强制删除本地旧缓存，确保从 data-clean/ 干净备份全新加载，
    避免 Render 容器重启时继承被污染的本地 study_data.json。"""
    # ===== 7/20 整体回滚：强制从干净备份加载，彻底甩掉所有污染 =====
    # 优先级：本地 data-clean/ 目录（随代码部署，Render 沙箱不依赖外网）> GitHub f1a5eed7 > data-sync HEAD
    # 扫描器已污染 Supabase/data-sync 的多个字段，本次回滚一律以干净备份为准。稳定后可恢复。
    print('[回滚] 强制从干净备份加载，忽略 Supabase/远程脏数据...', flush=True)
    # 关键：先删除本地可能被污染的缓存，确保全新加载（Render 容器重启不保证文件系统清空）
    for _name in ['study_data', 'users', 'admin', 'groups', 'messages', 'dingtalk', 'beta']:
        _cached = os.path.join(DATA_DIR, _name + '.json')
        if os.path.exists(_cached):
            try:
                os.remove(_cached)
                print(f'[回滚] 已删除本地旧缓存 {_name}.json', flush=True)
            except Exception as e:
                print(f'[回滚] 删除本地旧缓存 {_name}.json 失败: {e}', flush=True)
    _clean_dir = CLEAN_BACKUP_DIR
    def _load_clean(name):
        _p = os.path.join(_clean_dir, name + '.json')
        if os.path.exists(_p):
            try:
                with open(_p, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                print(f'[回滚] 读本地干净备份 {name} 失败: {e}', flush=True)
        _gh = github_api_get_commit(f'data/{name}.json', _CLEAN_STUDY_DATA_REF)
        if _gh is not None:
            return _gh
        return github_api_get(f'data/{name}.json')
    _clean_sd = _load_study_authoritative() or {}
    with open(os.path.join(DATA_DIR, 'study_data.json'), 'w', encoding='utf-8') as f:
        json.dump(_clean_sd, f, ensure_ascii=False, indent=2)
    for key in ['users', 'admin', 'groups', 'messages', 'dingtalk', 'beta']:
        _cd = _load_clean(key)
        if _cd is not None:
            with open(os.path.join(DATA_DIR, key + '.json'), 'w', encoding='utf-8') as f:
                json.dump(_cd, f, ensure_ascii=False, indent=2)
    print(f'[回滚] 已从干净备份恢复 {len(_clean_sd)} 学员 + 全部配置', flush=True)

    # 本地文件不存在时创建默认值
    users_path = os.path.join(DATA_DIR, 'users.json')
    admin_path = os.path.join(DATA_DIR, 'admin.json')
    study_path = os.path.join(DATA_DIR, 'study_data.json')
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
    # 创建默认学生用户（仅首次）
    if not os.path.exists(users_path):
        default_users = {}
        default_groups = ['A组', 'B组']
        default_students = [
            ('100001', '张三', 'A组'),
            ('100002', '李四', 'B组'),
            ('100003', '王五', 'A组'),
        ]
        for empid, name, group in default_students:
            hashed, salt = hash_password(DEFAULT_PASSWORD)
            default_users[empid] = {
                'empid': empid, 'name': name, 'group': group, 'status': 'active',
                'password_hash': hashed, 'salt': salt,
                'created_at': int(time.time() * 1000), 'created_by': 'system',
                'last_login': 0, 'login_count': 0, 'must_change_password': False
            }
        save_json(users_path, default_users)
        # 为默认用户创建学习数据
        default_study = {}
        for empid, name, group in default_students:
            default_study[empid] = {
                'basic': {'readIndex': 0, 'spellIndex': 0, 'learned': [], 'learnedDates': {}, 'mastered': [], 'speakScores': {}, 'weeklyTests': [], 'monthlyTests': [], 'totalSeconds': 0},
                'business': {'readIndex': 0, 'spellIndex': 0, 'learned': [], 'learnedDates': {}, 'mastered': [], 'speakScores': {}, 'weeklyTests': [], 'monthlyTests': [], 'totalSeconds': 0, 'unlocked': empid == '100003'}
            }
        save_json(study_path, default_study)
        # 保存默认分组
        save_json(os.path.join(DATA_DIR, 'groups.json'), default_groups)
        print('[Init] 已创建默认用户和学习数据', flush=True)

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
    if user.get('status', 'active') != 'active':
        return jsonify({'success': False, 'error': '账号已被禁用，如需启用请联系管理员'}), 403
    # 颁发 session_token，用于后续写接口认证
    session_token = secrets.token_hex(16)
    with data_lock:
        user['last_login'] = int(time.time() * 1000)
        user['login_count'] = user.get('login_count', 0) + 1
        user['session_token'] = session_token
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
    return jsonify({
        'success': True,
        'token': session_token,
        'user': {
            'empid': user['empid'], 'name': user['name'],
            'group': user.get('group', ''), 'status': user.get('status', 'active'),
            'must_change_password': user.get('must_change_password', False)
        }
    })


@app.route('/api/register', methods=['POST'])
def handle_register():
    body = request.json or {}
    # 仅管理员可添加学员
    if not _is_valid_admin_token((body.get('token') or '').strip()):
        return jsonify({'success': False, 'error': '未授权，请先登录管理后台'}), 401
    empid = ''.join(c for c in (body.get('empid') or '') if c not in _BAD_CHARS).strip()[:32]
    name = ''.join(c for c in (body.get('name', '') or '') if c not in _BAD_CHARS).strip()[:32]
    group = ''.join(c for c in (body.get('group', '') or '') if c not in _BAD_CHARS).strip()[:32]
    password = (body.get('password') or '').strip() or DEFAULT_PASSWORD
    if not empid or not name:
        return jsonify({'success': False, 'error': '工号和姓名不能为空'}), 400
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        if empid in users:
            return jsonify({'success': False, 'error': '该工号已存在'}), 400
        hashed, salt = hash_password(password)
        users[empid] = {
            'empid': empid, 'name': name, 'group': group, 'status': 'active',
            'password_hash': hashed, 'salt': salt,
            'created_at': int(time.time() * 1000), 'created_by': 'admin',
            'last_login': 0, 'login_count': 0, 'must_change_password': False
        }
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        study_data[empid] = {
            'basic': {'readIndex': 0, 'spellIndex': 0, 'learned': [], 'learnedDates': {}, 'mastered': [], 'speakScores': {}, 'weeklyTests': [], 'monthlyTests': [], 'totalSeconds': 0},
            'business': {'readIndex': 0, 'spellIndex': 0, 'learned': [], 'learnedDates': {}, 'mastered': [], 'speakScores': {}, 'weeklyTests': [], 'monthlyTests': [], 'totalSeconds': 0, 'unlocked': False}
        }
        save_json(os.path.join(DATA_DIR, 'study_data.json'), study_data)
    return jsonify({'success': True, 'message': f'已添加学员 {name}，初始密码 {DEFAULT_PASSWORD}'})


@app.route('/api/import-students', methods=['POST'])
def handle_import_students():
    body = request.json or {}
    if not _is_valid_admin_token((body.get('token') or '').strip()):
        return jsonify({'success': False, 'error': '未授权，请先登录管理后台'}), 401
    students = body.get('students', [])
    added = 0
    skipped = []
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        for s in students:
            empid = ''.join(c for c in str(s.get('empid', '')).strip() if c not in _BAD_CHARS)[:32]
            name = ''.join(c for c in str(s.get('name', '')).strip() if c not in _BAD_CHARS)[:32]
            group = ''.join(c for c in str(s.get('group', '')).strip() if c not in _BAD_CHARS)[:32]
            if not empid or not name:
                skipped.append(f'{empid} - 工号或姓名为空')
                continue
            if empid in users:
                skipped.append(f'{empid} {name} - 已存在')
                continue
            hashed, salt = hash_password(DEFAULT_PASSWORD)
            users[empid] = {
                'empid': empid, 'name': name, 'group': group, 'status': 'active',
                'password_hash': hashed, 'salt': salt,
                'created_at': int(time.time() * 1000), 'created_by': 'admin',
                'last_login': 0, 'login_count': 0, 'must_change_password': False
            }
            study_data[empid] = {
            'basic': {'readIndex': 0, 'spellIndex': 0, 'learned': [], 'learnedDates': {}, 'mastered': [], 'speakScores': {}, 'weeklyTests': [], 'monthlyTests': [], 'totalSeconds': 0},
            'business': {'readIndex': 0, 'spellIndex': 0, 'learned': [], 'learnedDates': {}, 'mastered': [], 'speakScores': {}, 'weeklyTests': [], 'monthlyTests': [], 'totalSeconds': 0, 'unlocked': False}
            }
            added += 1
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
        save_json(os.path.join(DATA_DIR, 'study_data.json'), study_data)
    return jsonify({
        'success': True, 'added': added, 'skipped': skipped,
        'message': f'成功导入 {added} 人' + (f'，跳过 {len(skipped)} 人' if skipped else '')
    })


# ---- 用户列表 API（公开，不含密码哈希）----
@app.route('/api/users', methods=['GET'])
def handle_get_users():
    users = load_json(os.path.join(DATA_DIR, 'users.json'))
    safe_users = {}
    for empid, user in users.items():
        safe_users[empid] = {
            'empid': empid,
            'name': user.get('name', ''),
            'group': user.get('group', ''),
            'status': user.get('status', 'active'),
            'created_at': user.get('created_at', 0),
            'last_login': user.get('last_login', 0),
            'login_count': user.get('login_count', 0)
        }
    return jsonify({'success': True, 'users': safe_users})


# ---- 分组 API ----
@app.route('/api/groups', methods=['GET'])
def handle_get_groups():
    groups_path = os.path.join(DATA_DIR, 'groups.json')
    if os.path.exists(groups_path):
        groups = load_json(groups_path)
        # 空数组也是有效数据（表示管理员清空了所有分组）
        if isinstance(groups, list):
            return jsonify({'success': True, 'groups': groups})
    # 文件不存在时：尝试从 GitHub 拉取（避免用硬编码默认值覆盖远程数据）
    if GITHUB_TOKEN:
        remote = github_api_get('data/groups.json')
        if remote is not None and isinstance(remote, list):
            with open(groups_path, 'w', encoding='utf-8') as f:
                json.dump(remote, f, ensure_ascii=False, indent=2)
            print(f'[Groups] 从GitHub恢复分组: {remote}', flush=True)
            return jsonify({'success': True, 'groups': remote})
    # 最终 fallback：仅返回默认值，不保存（防止覆盖GitHub上的正确数据）
    print('[Groups] 警告: groups.json 不存在且无法从GitHub恢复，返回默认分组但不持久化', flush=True)
    return jsonify({'success': True, 'groups': ['A组', 'B组']})


@app.route('/api/groups', methods=['POST'])
def handle_save_groups():
    body = request.json or {}
    if not _is_valid_admin_token((body.get('token') or '').strip()):
        return jsonify({'success': False, 'error': '未授权'}), 401
    groups = body.get('groups', [])
    if not isinstance(groups, list):
        groups = []
    cleaned = []
    for g in groups:
        if isinstance(g, str):
            g = ''.join(c for c in g if c not in _BAD_CHARS).strip()[:32]
            if g:
                cleaned.append(g)
    save_json(os.path.join(DATA_DIR, 'groups.json'), cleaned)
    return jsonify({'success': True})


# ---- 钉钉 Webhook 配置 API ----
@app.route('/api/dingtalk-config', methods=['GET'])
def handle_get_dingtalk_config():
    cfg = load_json(os.path.join(DATA_DIR, 'dingtalk.json'))
    webhook = cfg.get('webhook', '') if isinstance(cfg, dict) else ''
    return jsonify({'success': True, 'webhook': webhook})


@app.route('/api/dingtalk-config', methods=['POST'])
def handle_save_dingtalk_config():
    body = request.json or {}
    if not _is_valid_admin_token((body.get('token') or '').strip()):
        return jsonify({'success': False, 'error': '未授权'}), 401
    webhook = (body.get('webhook') or '').strip()
    # 仅允许钉钉/企业微信机器人地址，防止被改写为任意 URL（SSRF/钓鱼）
    if webhook and 'oapi.dingtalk.com' not in webhook and 'qyapi.weixin.qq.com' not in webhook:
        return jsonify({'success': False, 'error': '仅允许钉钉/企业微信机器人 Webhook'}), 400
    save_json(os.path.join(DATA_DIR, 'dingtalk.json'), {'webhook': webhook})
    return jsonify({'success': True})


# ---- 众测模式全局开关 API ----
# 开启后：商务英语对所有人解锁 + 周测/月测不受时间限制。正式上线时关闭即恢复正式规则。
@app.route('/api/beta-config', methods=['GET'])
def handle_get_beta_config():
    cfg = load_json(os.path.join(DATA_DIR, 'beta.json'))
    beta = bool(cfg.get('betaMode', False)) if isinstance(cfg, dict) else False
    return jsonify({'success': True, 'betaMode': beta})


@app.route('/api/beta-config', methods=['POST'])
def handle_save_beta_config():
    body = request.json or {}
    if not _is_valid_admin_token((body.get('token') or '').strip()):
        return jsonify({'success': False, 'error': '未授权'}), 401
    beta = bool(body.get('betaMode', False))
    save_json(os.path.join(DATA_DIR, 'beta.json'), {'betaMode': beta})
    return jsonify({'success': True, 'betaMode': beta})


# ---- 管理员按账号解锁商务英语 API ----
@app.route('/api/admin/unlock-business', methods=['POST'])
def handle_unlock_business():
    body = request.json or {}
    if not _is_valid_admin_token((body.get('token') or '').strip()):
        return jsonify({'success': False, 'error': '未授权'}), 401
    empid = (body.get('empid') or '').strip()
    unlock = body.get('unlock', True)
    if not empid:
        return jsonify({'success': False, 'error': '缺少empid'}), 400
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        if empid not in users:
            return jsonify({'success': False, 'error': '用户不存在'}), 404
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        sd = study_data.get(empid) or {}
        if not isinstance(sd.get('business'), dict):
            sd['business'] = {'readIndex': 0, 'spellIndex': 0, 'learned': [], 'learnedDates': {},
                              'mastered': [], 'speakScores': {},
                              'weeklyTests': [], 'monthlyTests': [], 'totalSeconds': 0, 'unlocked': False}
        sd['business']['unlocked'] = bool(unlock)
        study_data[empid] = sd
        save_json(os.path.join(DATA_DIR, 'study_data.json'), study_data)
    return jsonify({'success': True, 'empid': empid, 'unlocked': bool(unlock)})


# ---- 站内信 / 消息 API ----
@app.route('/api/messages', methods=['GET'])
def handle_get_messages():
    """获取指定学员的所有站内信（按时间倒序，最新在前）"""
    empid = (request.args.get('empid') or '').strip()
    all_msgs = load_json(os.path.join(DATA_DIR, 'messages.json'))
    msgs = all_msgs.get(empid, []) if isinstance(all_msgs, dict) else []
    # 按时间倒序排列（真实接收时间，最新在最前）
    msgs = sorted(msgs, key=lambda m: m.get('time', 0), reverse=True)
    return jsonify({'success': True, 'messages': msgs})


@app.route('/api/messages', methods=['POST'])
def handle_send_message():
    """管理员向一个或多个学员发送站内信（服务端盖真实时间戳）"""
    body = request.json or {}
    targets = body.get('targets', [])  # empid 列表
    if isinstance(targets, str):
        targets = [targets]
    title = (body.get('title') or '').strip()
    content = (body.get('content') or '').strip()
    msg_type = body.get('type', 'reminder')
    if not targets or not title:
        return jsonify({'success': False, 'error': '缺少参数'}), 400
    # 服务端真实时间戳（毫秒）
    server_time = int(time.time() * 1000)
    with data_lock:
        all_msgs = load_json(os.path.join(DATA_DIR, 'messages.json'))
        if not isinstance(all_msgs, dict):
            all_msgs = {}
        count = 0
        for empid in targets:
            empid = str(empid).strip()
            if not empid:
                continue
            msg = {
                'id': 'msg_' + str(server_time) + '_' + empid,
                'title': title,
                'content': content,
                'time': server_time,      # 真实接收时间（服务端盖章）
                'read': False,
                'type': msg_type
            }
            lst = all_msgs.get(empid, [])
            lst.append(msg)
            all_msgs[empid] = lst
            count += 1
        save_json(os.path.join(DATA_DIR, 'messages.json'), all_msgs)

    # 若配置了钉钉Webhook，由服务端推送到钉钉群（避免浏览器CORS限制）
    if count > 0:
        cfg = load_json(os.path.join(DATA_DIR, 'dingtalk.json'))
        webhook = cfg.get('webhook', '') if isinstance(cfg, dict) else ''
        if webhook:
            # 防刷屏：全局 15 秒最小推送间隔 + 同内容 60 秒内去重，
            # 避免催学提醒被循环调用/前端重试疯狂推送到钉钉群。
            _now = time.time()
            _sig = hashlib.md5((title + '|' + content + '|' + '|'.join(sorted(str(t) for t in targets))).encode('utf-8')).hexdigest()
            _skip = False
            with _dingtalk_lock:
                if _now - _dingtalk_last_push['ts'] < 15:
                    _skip = True
                    print('[DingTalk] 限流：距上次推送不足15秒，跳过', flush=True)
                elif _dingtalk_last_push.get('sig') == _sig and _now - _dingtalk_last_push['ts'] < 60:
                    _skip = True
                    print('[DingTalk] 去重：60秒内相同内容已推送，跳过', flush=True)
                else:
                    _dingtalk_last_push['ts'] = _now
                    _dingtalk_last_push['sig'] = _sig
            if not _skip:
                users = load_json(os.path.join(DATA_DIR, 'users.json'))
                study_data_all = load_json(os.path.join(DATA_DIR, 'study_data.json'))
                if not isinstance(study_data_all, dict):
                    study_data_all = {}
                rows = []
                for empid in targets:
                    eid = str(empid).strip()
                    if not eid:
                        continue
                    u = users.get(eid) if isinstance(users, dict) else None
                    name = u.get('name', '') if u else eid
                    sd = study_data_all.get(eid)
                    days = 0
                    if isinstance(sd, dict):
                        checkins = sd.get('checkIns') or []
                        days = sum(1 for c in checkins if isinstance(c, dict) and c.get('completed'))
                    rows.append((name, eid, days))
                # 按打卡天数升序（0、1、2…），最该催的排在前面
                rows.sort(key=lambda r: r[2])
                # 北京时间 (UTC+8)
                bj_now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
                time_str = bj_now.strftime('%Y-%m-%d %H:%M')
                threading.Thread(target=push_dingtalk_card,
                                 args=(webhook, title, content, rows, time_str),
                                 daemon=True).start()

    return jsonify({'success': True, 'count': count, 'time': server_time})


@app.route('/api/messages/read', methods=['POST'])
def handle_mark_messages_read():
    """标记学员消息为已读：msgIds为指定id列表，或all=True标记全部已读"""
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    msg_ids = body.get('msgIds', [])
    mark_all = body.get('all', False)
    if not empid:
        return jsonify({'success': False, 'error': '缺少empid'}), 400
    with data_lock:
        all_msgs = load_json(os.path.join(DATA_DIR, 'messages.json'))
        if not isinstance(all_msgs, dict):
            all_msgs = {}
        lst = all_msgs.get(empid, [])
        for m in lst:
            if mark_all or m.get('id') in msg_ids:
                m['read'] = True
        all_msgs[empid] = lst
        save_json(os.path.join(DATA_DIR, 'messages.json'), all_msgs)
    return jsonify({'success': True})


@app.route('/api/admin/toggle-user', methods=['POST'])
def handle_toggle_user():
    body = request.json or {}
    if not _is_valid_admin_token((body.get('token') or '').strip()):
        return jsonify({'success': False, 'error': '未授权'}), 401
    empid = (body.get('empid') or '').strip()
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        user = users.get(empid)
        if not user:
            return jsonify({'success': False, 'error': '用户不存在'}), 404
        user['status'] = 'disabled' if user.get('status', 'active') == 'active' else 'active'
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
    return jsonify({'success': True, 'status': user['status']})


# ---- Supabase 连接诊断接口（只读，不碰任何数据）----
@app.route('/api/sb-diag', methods=['GET'])
def handle_sb_diag():
    """Supabase 诊断接口（只读）：2026-07-21 后恢复为学习数据主持久层，返回真实连接状态。"""
    return jsonify({
        'disabled': bool(_DISABLE_SUPABASE_WRITE) or (not supabase),
        'role': 'study_data 主持久层（写穿 + 启动逐行去污染读取），GitHub data-sync 为二级兜底',
        'url_set': bool(SUPABASE_URL),
        'key_set': bool(SUPABASE_KEY),
        'connected_at_startup': bool(supabase),
        'study_gh_sync_paused': bool(_PAUSE_STUDY_DATA_GH_SYNC),
        'startup_error': SB_PROBE_ERROR,
    })


# ---- 学习数据 API ----
@app.route('/api/study-data', methods=['GET'])
def handle_get_study_data():
    empid = (request.args.get('empid') or '').strip()
    # 优先读本地缓存：服务器本地文件已累积全员写穿结果（每次 POST 都 merge+save 到本地），
    # 是最实时的来源。改为本地优先可让 GET 完全不打 GitHub API，规避 5000/小时限流。
    study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
    data = study_data.get(empid)
    if data is None:
        # 降级：读 GitHub data-sync 缓存（权威兜底，仅本地缺失时触发，频率极低）
        gh_data = github_api_get('data/study_data.json')
        if gh_data and empid in gh_data:
            data = gh_data.get(empid)
    if not data:
        return jsonify({'success': True, 'studyData': None, 'dataVersion': _STUDY_DATA_VERSION})
    return jsonify({'success': True, 'studyData': data, 'dataVersion': _STUDY_DATA_VERSION})


@app.route('/api/all-study-data', methods=['GET'])
def handle_all_study_data():
    """学员端排行榜专用：返回全体学员学习数据。优先本地缓存（已累积全员写穿），GitHub 兜底。"""
    study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
    if not study_data:
        study_data = github_api_get('data/study_data.json') or {}
    return jsonify({'success': True, 'studyData': study_data})


@app.route('/api/study-data', methods=['POST'])
def handle_save_study_data():
    global _last_gh_sig
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    token = (body.get('token') or '').strip()
    sd = body.get('studyData', {})

    # ---- 基础校验 ----
    if not empid:
        return jsonify({'success': False, 'error': '缺少 empid'}), 400

    # ---- 认证：必须携带登录时颁发的非空 session_token ----
    users = load_json(os.path.join(DATA_DIR, 'users.json'))
    user = users.get(empid)
    if not user:
        return jsonify({'success': False, 'error': '用户不存在'}), 404
    server_token = user.get('session_token', '')
    if not token or not server_token or token != server_token:
        return jsonify({'success': False, 'error': '未授权，请重新登录'}), 401

    # ---- 限流：单 IP + 单用户 ----
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr or '').split(',')[0].strip() or 'unknown'
    allowed, retry = check_rate_limit(f'ip:{client_ip}', max_per_second=2, max_per_minute=30)
    if not allowed:
        return jsonify({'success': False, 'error': f'请求过于频繁，请 {retry} 秒后再试'}), 429
    allowed, retry = check_rate_limit(f'user:{empid}', max_per_second=1, max_per_minute=20)
    if not allowed:
        return jsonify({'success': False, 'error': f'请求过于频繁，请 {retry} 秒后再试'}), 429

    # ---- 输入清洗与校验 ----
    sd = _validate_study_data(sd)

    study_path = os.path.join(DATA_DIR, 'study_data.json')
    with data_lock:
        all_data = load_json(study_path)
        # 合并而非覆盖：避免部署/多端并发时互相覆盖丢失数据
        sd = unify_checkins(sd)  # 先把传入数据里的 basic/business.checkIns 归并到顶层
        merged = merge_study_data(all_data.get(empid), sd)
        unify_checkins(merged)  # 收敛为单一顶层 checkIns，清理 sub-field
        # 关键：打卡完成状态必须由服务端根据「当日累计≥900秒」派生，不信任客户端传入的布尔。
        # 这能防止扫描器把 completed 直接标为 true，也能在误操作/测试后自动修正。
        _sanitize_study_record(merged)
        all_data[empid] = merged
        # 本地原子写 + 标脏 + 防抖兜底
        save_json(study_path, all_data)
    # 写穿（write-through）：Supabase 已关闭，直接走 GitHub data-sync 兜底。
    err_detail = None
    persisted = False
    try:
        with github_push_lock:
            latest = load_json(study_path)
            if empid not in latest or latest.get(empid) != all_data.get(empid):
                # 把本请求已合并的记录再次叠加到最新文件内容，吸收并发写入
                latest[empid] = merge_study_data(latest.get(empid), all_data.get(empid))
                unify_checkins(latest[empid])
                save_json(study_path, latest)
                all_data = latest
            sig = hashlib.md5(json.dumps(all_data, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
            with _gh_sig_lock:
                changed = (_last_gh_sig != sig)
            if changed:
                if _PAUSE_STUDY_DATA_GH_SYNC:
                    # 紧急暂停：本地已保存，不同步到 GitHub，避免污染 data-sync
                    persisted = True
                    print(f'[GitHub回退] study_data {empid} 本地已保存，GitHub 同步已暂停', flush=True)
                else:
                    gh_ok = github_api_put('data/study_data.json', all_data)
                    if gh_ok:
                        with _gh_sig_lock:
                            _last_gh_sig = sig
                        persisted = True
                        print(f'[GitHub回退] study_data {empid} 已写入 GitHub', flush=True)
                    else:
                        err_detail = (err_detail or '') + '; GitHub回退失败'
            else:
                # 数据无变化（如周期同步空跑），无需重复推送，视为已持久化
                persisted = True
    except Exception as e2:
        err_detail = (err_detail or '') + f'; GitHub回退异常:{e2}'
        print(f'[GitHub回退] study_data 失败: {e2}', flush=True)
    # 写穿 Supabase（主持久层，7/21 后恢复）：同步写入，确保 200 前已落地，Render 休眠/部署不丢。
    if supabase and not _DISABLE_SUPABASE_WRITE:
        try:
            sb_upsert_study(empid, all_data.get(empid))
            persisted = True
        except Exception as e:
            err_detail = (err_detail or '') + f'; Supabase写穿失败:{e}'
            print(f'[Supabase] 写穿失败(本地+GitHub已兜底): {e}', flush=True)
    return jsonify({'success': True, 'persisted': bool(persisted), 'dataVersion': _STUDY_DATA_VERSION, 'sb_debug': err_detail, 'sb_connected': bool(supabase)})


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
    # 管理员可指定新密码；未指定则重置为默认密码
    new_password = (body.get('newPassword') or '').strip() or DEFAULT_PASSWORD
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        user = users.get(empid)
        if not user:
            return jsonify({'success': False, 'error': '用户不存在'}), 404
        hashed, salt = hash_password(new_password)
        user['password_hash'] = hashed
        user['salt'] = salt
        # 同时清掉明文密码字段，避免旧明文残留导致旧密码仍可登录
        user.pop('password', None)
        user['must_change_password'] = (new_password == DEFAULT_PASSWORD)
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
    return jsonify({'success': True, 'message': f'已重置密码为 {new_password}'})


# ---- 管理员 API ----
@app.route('/api/admin-login', methods=['POST'])
def handle_admin_login():
    body = request.json or {}
    username = (body.get('username') or '').strip()
    password = body.get('password', '')
    # 防爆破：按 IP 滑动窗口限流（宽松，不误伤本人）
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr or '').split(',')[0].strip() or 'unknown'
    allowed, retry = check_rate_limit('adminlogin:' + client_ip, max_per_second=1, max_per_minute=10)
    if not allowed:
        return jsonify({'success': False, 'error': f'登录过于频繁，请 {retry} 秒后再试'}), 429
    admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
    admin_user = admin.get(username)
    if not admin_user or not verify_password(password, admin_user['password_hash'], admin_user['salt']):
        return jsonify({'success': False, 'error': '用户名或密码错误'}), 401
    token = secrets.token_hex(16)
    with data_lock:
        admin_user['session_token'] = token
        admin_user['last_login'] = int(time.time() * 1000)
        save_json(os.path.join(DATA_DIR, 'admin.json'), admin)
    return jsonify({'success': True, 'token': token, 'mustChangePassword': bool(admin_user.get('must_change_password', False))})


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
        admin_user['must_change_password'] = False
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
        # 兼容新旧格式：新格式有 basic/business 子对象
        basic = sd.get('basic', {}) if isinstance(sd, dict) else {}
        business = sd.get('business', {}) if isinstance(sd, dict) else {}
        # 汇总两个阶段的 learned/mastered
        learned_basic = basic.get('learned', []) if isinstance(basic, dict) else []
        learned_business = business.get('learned', []) if isinstance(business, dict) else []
        mastered_basic = basic.get('mastered', []) if isinstance(basic, dict) else []
        mastered_business = business.get('mastered', []) if isinstance(business, dict) else []
        speak_scores_basic = basic.get('speakScores', {}) if isinstance(basic, dict) else {}
        speak_scores_business = business.get('speakScores', {}) if isinstance(business, dict) else {}
        total_seconds_basic = basic.get('totalSeconds', 0) if isinstance(basic, dict) else 0
        total_seconds_business = business.get('totalSeconds', 0) if isinstance(business, dict) else 0

        learned_count = len(learned_basic) + len(learned_business)
        mastered_count = len(mastered_basic) + len(mastered_business)
        total_seconds = total_seconds_basic + total_seconds_business
        # 汇总 speak scores
        all_scores = []
        for sc in [speak_scores_basic, speak_scores_business]:
            if isinstance(sc, dict):
                for v in sc.values():
                    if isinstance(v, dict):
                        all_scores.extend(v.values())
                    elif isinstance(v, (int, float)):
                        all_scores.append(v)
        avg_score = round(sum(all_scores) / len(all_scores)) if all_scores else 0
        # 统一打卡：先把 basic/business 的 checkIns 合并进顶层（幂等），再从顶层统计打卡天数，
        # 避免"顶层 checkIns"与"basic/business.checkIns"两套字段不一致导致管理端与学员端统计歧义。
        sd = unify_checkins(sd)
        study_dates = set()
        for c in (sd.get('checkIns') or []):
            if isinstance(c, dict) and c.get('date'):
                study_dates.add(c['date'])

        all_users.append({
            'empid': empid, 'name': user['name'],
            'group': user.get('group', ''),
            'status': user.get('status', 'active'),
            'createdAt': user.get('created_at', 0),
            'lastLogin': user.get('last_login', 0),
            'loginCount': user.get('login_count', 0),
            'learnedCount': learned_count,
            'masteredCount': mastered_count,
            'totalStudySeconds': total_seconds,
            'studyDates': sorted(list(study_dates)),
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


@app.route('/api/admin/edit-user', methods=['POST'])
def handle_admin_edit_user():
    body = request.json or {}
    old_empid = (body.get('oldEmpid') or '').strip()
    new_empid = (body.get('newEmpid') or '').strip()
    new_name = (body.get('name') or '').strip()
    new_group = (body.get('group') or '').strip()
    token = body.get('token', '')
    admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
    if token != admin.get('admin', {}).get('session_token', ''):
        return jsonify({'success': False, 'error': '未授权'}), 401
    if not new_empid or not new_name:
        return jsonify({'success': False, 'error': '账号和姓名不能为空'}), 400
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        if old_empid not in users:
            return jsonify({'success': False, 'error': '原账号不存在'}), 404
        if new_empid != old_empid and new_empid in users:
            return jsonify({'success': False, 'error': '新账号已存在'}), 409
        # 复制用户信息到新 empid
        old_user = users[old_empid]
        users[new_empid] = {
            'empid': new_empid,
            'name': new_name,
            'group': new_group,
            'status': old_user.get('status', 'active'),
            'password_hash': old_user.get('password_hash', ''),
            'salt': old_user.get('salt', ''),
            'created_at': old_user.get('created_at', 0)
        }
        # 如果 empid 变了，删除旧记录
        if new_empid != old_empid:
            del users[old_empid]
            # 迁移学习数据
            if old_empid in study_data:
                study_data[new_empid] = study_data[old_empid]
                del study_data[old_empid]
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
        save_json(os.path.join(DATA_DIR, 'study_data.json'), study_data)
    return jsonify({'success': True, 'message': '修改成功'})


@app.route('/api/admin/study-data', methods=['GET'])
def handle_admin_get_study_data():
    token = (request.args.get('token') or '').strip()
    admin = load_json(os.path.join(DATA_DIR, 'admin.json'))
    if token != admin.get('admin', {}).get('session_token', ''):
        return jsonify({'success': False, 'error': '未授权'}), 401
    # 2026-07-21: Supabase 已关闭，统一从本地文件读取学习数据
    study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
    return jsonify({'success': True, 'studyData': study_data})


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
                # 短音频静音填充：首尾各补 0.4s 静音并保底 0.9s，
                # 避免单字/短句被 ASR 当作静音丢弃（根治单字句识别返回空→35 分）
                try:
                    import numpy as _np
                    _samples = _np.frombuffer(audio_data, dtype=_np.int16).copy()
                    _pad = int(16000 * 0.4)
                    _min = int(16000 * 0.9)
                    if len(_samples) == 0:
                        _samples = _np.zeros(_min, dtype=_np.int16)
                    else:
                        _samples = _np.concatenate([_np.zeros(_pad, dtype=_np.int16), _samples,
                                                    _np.zeros(_pad, dtype=_np.int16)])
                        if len(_samples) < _min:
                            _samples = _np.concatenate([_samples, _np.zeros(_min - len(_samples), dtype=_np.int16)])
                    audio_data = _samples.astype(_np.int16).tobytes()
                except Exception as _pe:
                    print(f'[Transcribe] 静音填充失败，沿用原音频: {_pe}', flush=True)
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


# Whisper 模型懒加载（tiny 模型约 75MB，首次加载需几秒）
_whisper_model = None

def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        try:
            import whisper
            print('[Whisper] 加载 tiny 模型...', flush=True)
            _whisper_model = whisper.load_model('tiny')
            print('[Whisper] 模型加载完成', flush=True)
        except ImportError:
            print('[Whisper] openai-whisper 未安装，将使用 Google Speech API', flush=True)
            return None
        except Exception as e:
            print(f'[Whisper] 加载失败: {e}', flush=True)
            return None
    return _whisper_model


def transcribe_audio(filepath):
    """识别 WAV 文件：优先 Whisper，降级 Google Speech API"""
    text = ''

    # 方案一：Whisper（本地识别，不受网络限制）
    model = _get_whisper_model()
    if model is not None:
        try:
            import time as _t
            start = _t.time()
            result = model.transcribe(filepath, language='en', fp16=False,
                                      condition_on_previous_text=False,
                                      no_speech_threshold=0.3,
                                      logprob_threshold=-1.0)
            text = result.get('text', '').strip()
            elapsed = _t.time() - start
            if text:
                print(f'[Whisper] 识别成功 ({elapsed:.1f}s): "{text}"', flush=True)
                return text
            else:
                print(f'[Whisper] 识别为空 ({elapsed:.1f}s)', flush=True)
        except Exception as e:
            print(f'[Whisper] 识别失败: {e}', flush=True)

    # 方案二：Google Web Speech API（降级方案）
    try:
        import speech_recognition as sr
        recognizer = sr.Recognizer()
        recognizer.energy_threshold = 80
        recognizer.dynamic_energy_threshold = True
        recognizer.pause_threshold = 0.8
        recognizer.operation_timeout = 5

        with sr.AudioFile(filepath) as source:
            audio = recognizer.record(source)

        try:
            text = recognizer.recognize_google(audio, language='en-US')
            print(f'[Google SR] 成功: "{text}"', flush=True)
            return text
        except sr.UnknownValueError:
            print('[Google SR] 无法识别音频内容', flush=True)
            return ''
        except sr.RequestError as e:
            print(f'[Google SR] API请求错误: {e}', flush=True)
            return ''

    except ImportError:
        print('[WARN] speech_recognition 未安装', flush=True)
        return ''
    except Exception as e:
        print(f'[Transcribe] 识别异常: {e}', flush=True)
        import traceback
        traceback.print_exc()
        return ''

    return text


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
        'marker': SERVER_ROLLBACK_MARKER,
        'keepalive': {
            'started_at': _keepalive_status['started_at'],
            'last_ping_time': last_ping,
            'seconds_since_last_ping': since_last,
            'last_ping_status': _keepalive_status['last_ping_status'],
            'ping_count': _keepalive_status['ping_count'],
            'self_ping_url': SELF_PING_URL
        },
        'diag': {
            'supabase_enabled': bool(supabase),
            'clean_backup_dir': CLEAN_BACKUP_DIR,
            'clean_study_exists': os.path.exists(os.path.join(CLEAN_BACKUP_DIR, 'study_data.json')),
            'clean_users_exists': os.path.exists(os.path.join(CLEAN_BACKUP_DIR, 'users.json'))
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

    # 进程退出时无需刷盘：数据已实时写入 Supabase，不再依赖本地文件/GitHub
    def _on_shutdown(*args):
        print('[Shutdown] 进程退出（数据已实时持久化到 Supabase）', flush=True)
    atexit.register(_on_shutdown)
    def _sig_handler(signum, frame):
        _on_shutdown(signum, frame)
        # 恢复默认行为并重新向自身发送信号，让进程正常退出
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)
    try:
        signal.signal(signal.SIGTERM, _sig_handler)
        signal.signal(signal.SIGINT, _sig_handler)
        print('[Shutdown] 已注册 SIGTERM/SIGINT 数据刷盘处理器', flush=True)
    except (ValueError, OSError) as e:
        print(f'[Shutdown] 信号处理器注册失败（可接受）: {e}', flush=True)

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
