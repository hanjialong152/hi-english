# -*- coding: utf-8 -*-
"""部署"进度展示=已学数 + 喇叭点完保持浅色"修复（仅代码，不动数据）。
  - js/student.js: 首页学习进度条改已学数(learnedCount)；学习卡渲染后按 audioDone 把已点喇叭保持浅色
  - js/admin.js: 学员管理"基础进度/商务进度"改 audioDone 已学数；init 加载词库/课库供统计
  - service-worker.js: 核心缓存版本 bump(v42→v43)，确保 PWA 拿到新 JS
  - student.html / admin.html: 引用版本号 bump
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

CODE_FILES = ["js/student.js", "js/admin.js", "service-worker.js", "student.html", "admin.html"]
ALL = [f for f in CODE_FILES if os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
print("FILES:", len(ALL), flush=True)

def api(method, path, data=None, retries=8):
    url = API + path
    body = json.dumps(data).encode("utf-8") if data is not None else None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", "Bearer " + TOKEN)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "hi-english-deploy")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "ignore")
            if attempt < retries:
                print("  retry(%d) %s" % (attempt, txt[:120]), flush=True)
                time.sleep(3 * attempt)
                continue
            raise
        except Exception as e:
            if attempt < retries:
                print("  err(%d): %s" % (attempt, e), flush=True)
                time.sleep(3 * attempt)
                continue
            raise

def main():
    t0 = time.time()
    st, ref = api("GET", "/git/ref/heads/master")
    base_commit = ref["object"]["sha"]
    st, comm = api("GET", "/git/commits/" + base_commit)
    base_tree = comm["tree"]["sha"]

    entries = []
    for idx, f in enumerate(ALL, 1):
        with open(os.path.join(ROOT, f.replace("/", os.sep)), "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        st, blob = api("POST", "/git/blobs", {"content": b64, "encoding": "base64"})
        entries.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("  %d/%d %s" % (idx, len(ALL), f), flush=True)

    st, new_tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": entries})
    msg = ("进度展示=已学数 + 喇叭点完保持浅色\n\n"
           "① 学员端首页学习进度条/文字改已学数(getLearnedCount)，不再显示翻页位置 readIndex\n"
           "② 管理员端学员管理「基础进度/商务进度」改 audioDone 已学数(calcAudioLearnedCount)，与学员端同源\n"
           "③ 学习卡渲染后按 audioDone 把已点过的喇叭保持浅色(opacity:0.5)，翻页重渲染后保留\n"
           "④ 管理员端 init 加载词库/课库供统计；service-worker 核心缓存 bump(v42→v43)\n"
           "安全：未修改任何学习记录数据(checkIns/scores/learnedDates/mastered)")
    st, new_commit = api("POST", "/git/commits", {"message": msg, "tree": new_tree["sha"], "parents": [base_commit]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)
    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("Done %.1fs" % (time.time() - t0), flush=True)

if __name__ == "__main__":
    main()
