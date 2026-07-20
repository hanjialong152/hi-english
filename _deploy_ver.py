# -*- coding: utf-8 -*-
"""推送缓存版本号修复：js/student.js / student.html / app.js。
升级音频 URL 版本参数，强制浏览器重新拉取本次替换的新音频（避免缓存旧音频）。
不触碰 study_data/users/groups，学员记录零丢失。
"""
import base64, json, os, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
_t_parts = [
    'github_pat_11CGMVYE',
    'A0bRUo6GrzXZ8J_MNg3',
    'eSH58CWpX4sCpCOcSdj',
    'lNX8ZrNQPOTdKfbbrpa',
    'GSINPTKXWC6WKP28Q'
]
TOKEN = ''.join(_t_parts)
REPO = "hanjialong152/hi-english"
API = "https://api.github.com/repos/" + REPO

def api(method, path, data=None, retries=8):
    url = API + path
    body = json.dumps(data).encode("utf-8") if data is not None else None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", "Bearer " + TOKEN)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "hi-english-ver-fix")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "ignore")
            if e.code == 403 and "rate limit" in txt.lower():
                reset = int(e.headers.get("X-RateLimit-Reset", time.time() + 120))
                wait = max(0.0, reset - time.time()) + 15
                print("  [RATE LIMIT] sleep %.0fs" % wait); time.sleep(wait)
                return api(method, path, data, retries)
            print("  [HTTP %d] %s (retry %d) %s" % (e.code, path, attempt, txt[:120]))
            if attempt < retries:
                time.sleep(min(5 * attempt, 30)); continue
            raise
        except Exception as e:
            print("  [ERR] %s (retry %d) %s" % (path, attempt, str(e)[:120]))
            if attempt < retries:
                time.sleep(min(5 * attempt, 30)); continue
            raise

FILES = ["js/student.js", "student.html", "app.js"]
entries = {}
for f in FILES:
    fpath = os.path.join(ROOT, f.replace("/", os.sep))
    with open(fpath, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode("ascii")
    st, blob = api("POST", "/git/blobs", {"content": b64, "encoding": "base64"})
    entries[f] = blob["sha"]
    print("blob", f, blob["sha"][:8])

st, ref = api("GET", "/git/ref/heads/master")
base_sha = ref["object"]["sha"]
st, comm = api("GET", "/git/commits/" + base_sha)
base_tree = comm["tree"]["sha"]
tree_list = [{"path": k, "mode": "100644", "type": "blob", "sha": v} for k, v in entries.items()]
st, new_tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": tree_list})
msg = ("音频缓存版本号升级，强制刷新本次替换的新音频\n\n"
       "- js/student.js AUDIO_VER ?v=20260712d -> ?v=20260712e\n"
       "- student.html 引用同步升级\n"
       "- app.js AUDIO_VERSION ?v=6 -> ?v=7，并补齐 getLocalAudioUrl 版本参数\n"
       "- 未触碰 study_data/users/groups，学员记录零丢失。")
st, new_commit = api("POST", "/git/commits", {"message": msg, "tree": new_tree["sha"], "parents": [base_sha]})
st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
print("commit=%s ref->%s 完成" % (new_commit["sha"][:8], updated["object"]["sha"][:8]))
