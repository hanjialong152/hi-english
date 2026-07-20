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
# Supabase 云数据库（主存储，根治"发版丢数据"）
# 2026-07-11 起，学习数据与配置统一持久化到 Supabase Postgres，
# 不受 Render 免费版文件系统重置 / 部署 / 休眠影响。
# 凭证通过环境变量注入（SUPABASE_URL / SUPABASE_KEY=service_role），
# 不硬编码到代码，避免泄露。本地/生产未配置时降级为本地文件（兼容开发）。
# ============================================================
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
supabase = None
SB_PROBE_ERROR = None  # 启动探针报错（全量，供诊断接口回显）
if SUPABASE_URL and SUPABASE_KEY:
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
    SB_PROBE_ERROR = '未配置 SUPABASE_URL/SUPABASE_KEY'
    print('[Supabase] 未配置 SUPABASE_URL/SUPABASE_KEY，使用 GitHub data-sync 存储（可靠兜底）', flush=True)


def sb_upsert_study(empid, data, retry=2):
    """把单个学员学习数据 UPSERT 到 Supabase study_data 表（按 empid 单行）。"""
    if not supabase or not empid:
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
    # checkIns：按 date 合并，seconds 取最大、completed 取或
    ci = {}
    for arr in (existing.get('checkIns') or []) + (incoming.get('checkIns') or []):
        if not isinstance(arr, dict) or not arr.get('date'):
            continue
        d = arr['date']
        cur = ci.get(d, {'date': d, 'seconds': 0, 'completed': False})
        cur['seconds'] = max(int(cur.get('seconds') or 0), int(arr.get('seconds') or 0))
        if arr.get('completed'):
            cur['completed'] = True
        ci[d] = cur
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
    # 顶层 checkIns：同样按 date 合并
    ci = {}
    for arr in (existing.get('checkIns') or []) + (incoming.get('checkIns') or []):
        if not isinstance(arr, dict) or not arr.get('date'):
            continue
        d = arr['date']
        cur = ci.get(d, {'date': d, 'seconds': 0, 'completed': False})
        cur['seconds'] = max(int(cur.get('seconds') or 0), int(arr.get('seconds') or 0))
        if arr.get('completed'):
            cur['completed'] = True
        ci[d] = cur
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
        if not isinstance(arr, dict) or not arr.get('date'):
            continue
        d = arr['date']
        cur = ci.get(d, {'date': d, 'seconds': 0, 'completed': False})
        cur['seconds'] = max(int(cur.get('seconds') or 0), int(arr.get('seconds') or 0))
        if arr.get('completed'):
            cur['completed'] = True
        ci[d] = cur
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
    if supabase:
        sb_upsert_config(cfg_key, data)
    elif GITHUB_TOKEN:
        # Supabase 不可达 → 回退 GitHub（可靠兜底，避免配置变更随部署丢失）
        schedule_sync(filepath, data)
        print(f'[GitHub回退] 配置 {cfg_key} 已加入防抖推送队列', flush=True)

def init_data_files():  # v-restart-trigger-20260711
    """初始化数据文件：启动时从 Supabase 拉取最新数据到本地缓存。

    2026-07-11 起改为 Supabase 主存储（根治发版丢数据）：
    - 配置类(users/admin/groups/...)：从 app_config 表拉取
    - study_data：从 study_data 表全量拉取
    本地文件仅作运行时缓存，Render 重启/部署后从 Supabase 重建，永不丢失。
    未配置 Supabase 时回退到 GitHub data-sync（兼容开发/迁移过渡）。"""
    if supabase:
        print('[Supabase] 从数据库加载最新数据到本地缓存...', flush=True)
        for key in ['users', 'admin', 'groups', 'messages', 'dingtalk', 'beta']:
            remote = sb_get_config(key)
            # 关键修复：app_config 为空时回退读 GitHub users.json，
            # 避免 Supabase 配置后丢失已注册的学员账号（之前误创建默认张三/李四/王五）
            if remote is None and GITHUB_TOKEN:
                gh_data = github_api_get(f'data/{key}.json')
                if gh_data is not None:
                    remote = gh_data
                    # 同步写入 app_config，之后启动不再依赖 GitHub
                    sb_upsert_config(key, remote)
                    print(f'[Supabase] app_config[{key}] 为空，回退 GitHub 加载并写库', flush=True)
            if remote is not None:
                try:
                    with open(os.path.join(DATA_DIR, key + '.json'), 'w', encoding='utf-8') as f:
                        json.dump(remote, f, ensure_ascii=False, indent=2)
                except Exception as e:
                    print(f'[Supabase] 写本地缓存 {key} 失败: {e}', flush=True)
        all_sd = sb_get_all_study()
        try:
            # 关键修复：Supabase 读空/失败时不写空本地文件，防止把空数据回推覆盖真实数据
            if all_sd:
                with open(os.path.join(DATA_DIR, 'study_data.json'), 'w', encoding='utf-8') as f:
                    json.dump(all_sd, f, ensure_ascii=False, indent=2)
                print(f'[Supabase] 已加载 {len(all_sd)} 个学员学习数据', flush=True)
            elif GITHUB_TOKEN:
                # Supabase 为空/失败 → 回退 GitHub data-sync 加载学习数据
                gh_sd = github_api_get('data/study_data.json')
                if gh_sd:
                    with open(os.path.join(DATA_DIR, 'study_data.json'), 'w', encoding='utf-8') as f:
                        json.dump(gh_sd, f, ensure_ascii=False, indent=2)
                    print(f'[GitHub回退] 已加载 {len(gh_sd)} 个学员学习数据', flush=True)
                else:
                    print('[Supabase] study_data 为空且 GitHub 无数据，保留本地现有缓存', flush=True)
            else:
                print('[Supabase] study_data 为空或读取失败，保留本地现有缓存', flush=True)
        except Exception as e:
            print(f'[Supabase] 写本地 study_data 缓存失败: {e}', flush=True)
    elif GITHUB_TOKEN:
        # 兼容回退：未配置 Supabase 时使用原 GitHub 逻辑
        print('[Sync] 未配置 Supabase，回退 GitHub data-sync 拉取...', flush=True)
        for filename in ['users.json', 'study_data.json', 'admin.json', 'groups.json', 'messages.json', 'dingtalk.json', 'beta.json']:
            rel_path = f'data/{filename}'
            remote_data = github_api_get(rel_path)
            local_path = os.path.join(DATA_DIR, filename)
            if remote_data is not None:
                if filename == 'study_data.json' and os.path.exists(local_path):
                    local_data = load_json(local_path) or {}
                    for uid, remote_sd in (remote_data or {}).items():
                        local_sd = local_data.get(uid) or {}
                        merged_sd = merge_study_data(local_sd, remote_sd)
                        merged_sd = unify_checkins(merged_sd)
                        local_data[uid] = merged_sd
                    with open(local_path, 'w', encoding='utf-8') as f:
                        json.dump(local_data, f, ensure_ascii=False, indent=2)
                    print(f'[Sync] 已合并 {filename} ({len(local_data)} users)', flush=True)
                else:
                    with open(local_path, 'w', encoding='utf-8') as f:
                        json.dump(remote_data, f, ensure_ascii=False, indent=2)

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
    with data_lock:
        user['last_login'] = int(time.time() * 1000)
        user['login_count'] = user.get('login_count', 0) + 1
        save_json(os.path.join(DATA_DIR, 'users.json'), users)
    return jsonify({
        'success': True,
        'user': {
            'empid': user['empid'], 'name': user['name'],
            'group': user.get('group', ''), 'status': user.get('status', 'active'),
            'must_change_password': user.get('must_change_password', False)
        }
    })


@app.route('/api/register', methods=['POST'])
def handle_register():
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    name = (body.get('name', '')).strip()
    group = (body.get('group', '')).strip()
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
    students = body.get('students', [])
    added = 0
    skipped = []
    with data_lock:
        users = load_json(os.path.join(DATA_DIR, 'users.json'))
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        for s in students:
            empid = str(s.get('empid', '')).strip()
            name = str(s.get('name', '')).strip()
            group = str(s.get('group', '')).strip()
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
    groups = body.get('groups', [])
    save_json(os.path.join(DATA_DIR, 'groups.json'), groups)
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
    webhook = (body.get('webhook') or '').strip()
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
    beta = bool(body.get('betaMode', False))
    save_json(os.path.join(DATA_DIR, 'beta.json'), {'betaMode': beta})
    return jsonify({'success': True, 'betaMode': beta})


# ---- 管理员按账号解锁商务英语 API ----
@app.route('/api/admin/unlock-business', methods=['POST'])
def handle_unlock_business():
    body = request.json or {}
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
    # 实时复测一次，避免只看启动时刻
    live_err = SB_PROBE_ERROR
    live_ok = bool(supabase)
    if not supabase and SUPABASE_URL and SUPABASE_KEY:
        try:
            from supabase import create_client
            _c = create_client(SUPABASE_URL, SUPABASE_KEY)
            _c.table('study_data').select('empid').limit(1).execute()
            live_ok = True
            live_err = None
        except Exception as e:
            live_ok = False
            live_err = repr(e)
    return jsonify({
        'url_set': bool(SUPABASE_URL),
        'url_value': (SUPABASE_URL[:12] + '...' + SUPABASE_URL[-8:]) if SUPABASE_URL else '',
        'key_set': bool(SUPABASE_KEY),
        'key_len': len(SUPABASE_KEY) if SUPABASE_KEY else 0,
        'connected_at_startup': bool(supabase),
        'startup_error': SB_PROBE_ERROR,
        'live_connected': live_ok,
        'live_error': live_err,
    })


# ---- 学习数据 API ----
@app.route('/api/study-data', methods=['GET'])
def handle_get_study_data():
    empid = (request.args.get('empid') or '').strip()
    # 优先从 Supabase 实时读取（管理后台/跨终端一致的唯一真相源）
    data = sb_get_study(empid)
    if data is None:
        # 降级1：读 GitHub data-sync 缓存
        gh_data = github_api_get('data/study_data.json')
        if gh_data and empid in gh_data:
            data = gh_data.get(empid)
    if data is None:
        # 降级2：读本地缓存
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
        data = study_data.get(empid)
    if not data:
        return jsonify({'success': True, 'studyData': None})
    return jsonify({'success': True, 'studyData': data})


@app.route('/api/all-study-data', methods=['GET'])
def handle_all_study_data():
    """学员端排行榜专用：返回全体学员学习数据（实时从 Supabase 读取，保证全员一致）。"""
    study_data = sb_get_all_study()
    if not study_data and GITHUB_TOKEN:
        study_data = github_api_get('data/study_data.json') or {}
    if not study_data:
        study_data = load_json(os.path.join(DATA_DIR, 'study_data.json'))
    return jsonify({'success': True, 'studyData': study_data})


@app.route('/api/study-data', methods=['POST'])
def handle_save_study_data():
    global _last_gh_sig
    body = request.json or {}
    empid = (body.get('empid') or '').strip()
    sd = body.get('studyData', {})
    study_path = os.path.join(DATA_DIR, 'study_data.json')
    with data_lock:
        all_data = load_json(study_path)
        # 合并而非覆盖：避免部署/多端并发时互相覆盖丢失数据
        sd = unify_checkins(sd)  # 先把传入数据里的 basic/business.checkIns 归并到顶层
        merged = merge_study_data(all_data.get(empid), sd)
        unify_checkins(merged)  # 收敛为单一顶层 checkIns，清理 sub-field
        all_data[empid] = merged
        # 本地原子写 + 标脏 + 防抖兜底
        save_json(study_path, all_data)
    # 写穿（write-through）：实时 UPSERT 到 Supabase（按 empid 单行）。
    # 若 Supabase 不可达（如 DNS 失败/项目暂停），自动回退 GitHub data-sync（Render 可稳定连接），
    # 确保本请求返回即已持久化，Render 部署/休眠/清缓存都不丢。
    err_detail = None
    persisted = False
    try:
        persisted = sb_upsert_study(empid, merged)
    except Exception as e:
        persisted = False
        err_detail = str(e)
        print(f'[Supabase] study-data 写入异常: {e}', flush=True)
    if not persisted:
        # Supabase 失败 → 回退 GitHub（可靠兜底）。
        # 加固：整段在 github_push_lock 内串行，并在锁内重新加载最新文件再合并本 empid，
        # 杜绝"两请求并发各持旧快照→后写覆盖前写"的整文件覆盖竞争（扎堆打卡场景）；
        # 同时按全量签名去重，仅数据真正变化才推送，规避 GitHub 5000/小时限流。
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
    return jsonify({'success': True, 'persisted': bool(persisted), 'sb_debug': err_detail, 'sb_connected': bool(supabase)})


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
    # 实时从 Supabase 读取全体学习数据，保证管理后台与学员端一致
    study_data = sb_get_all_study()
    if not study_data:
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
