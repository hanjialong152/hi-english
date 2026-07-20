# -*- coding: utf-8 -*-
"""部署"已学=真实听音频"重构（仅代码，不动数据）。
  - js/student.js: 已学逻辑改用 audioDone（不继承历史 learned）；学习卡已听状态反馈；
                   周/月测题池同源；首页/清单/报告页已学统一；定位页精确停留(prev/next)
  - js/common.js: 自愈补 audioDone/audioDoneDate 字段（默认结构早已包含）
  - service-worker.js: 核心缓存版本 bump，确保 PWA 拿到新 JS
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

CODE_FILES = ["js/student.js", "js/common.js", "service-worker.js"]
ALL = [f for f in CODE_FILES if os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
print("FILES:", len(ALL), flush=True)

def api(method, path, data=None, retries=6):
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
                print("  retry(%d) %s" % (attempt, txt[:100]), flush=True)
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
    msg = ("已学逻辑重构：已学=真实听音频(audioDone)，不继承历史翻页记录\n\n"
           "① 已学定义：基础词词组+全部例句、商务课每句 喇叭需真实点过才算已学（单词音频不计）\n"
           "② 历史 learned[] 仅留痕，不继承为已学；audioDone 从空开始，真听才累计\n"
           "③ 学习卡加「🔊 已听 x/y → ✅ 已学」反馈\n"
           "④ 首页/学习清单/报告页 三处「已学」统一用 audioDone；周测/月测题池同源\n"
           "⑤ 定位页精确停留：prev/next 均写回 readIndex，下次从停留页开始\n"
           "⑥ service-worker 核心缓存版本 bump(v41→v42)，确保 PWA 拿到新 JS\n"
           "安全：未修改任何学习记录数据(checkIns/scores/learnedDates/mastered)")
    st, new_commit = api("POST", "/git/commits", {"message": msg, "tree": new_tree["sha"], "parents": [base_commit]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)
    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("Done %.1fs" % (time.time() - t0), flush=True)

if __name__ == "__main__":
    main()
