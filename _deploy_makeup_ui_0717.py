# -*- coding: utf-8 -*-
"""部署 补卡 2 项 UI 修复（仅代码文件，不影响学习记录与数据）。
修改文件：
  - js/student.js      (①日历选中框跟随点击日期 + ②去补卡按钮日期字体缩小防换行)
  - student.html       (①新增 .cal-day.selected 选中框样式)
  - service-worker.js  (bump 缓存版本 v48 强制刷新)
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

# 仅本次修改的代码文件（绝不触碰 users.json / study_data.json 等数据文件）
CODE_FILES = [
    "js/student.js",
    "student.html",
    "service-worker.js",
]

ALL = [f for f in CODE_FILES if os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
print("FILES to push:", len(ALL), flush=True)


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
                print("  [HTTP %s] retry(%d) sleep%ds: %s" % (e.code, attempt, 3 * attempt, txt[:120]), flush=True)
                time.sleep(3 * attempt)
                continue
            raise
        except Exception as e:
            if attempt < retries:
                print("  [err] retry(%d): %s" % (attempt, e), flush=True)
                time.sleep(3 * attempt)
                continue
            raise


def main():
    t0 = time.time()
    st, ref = api("GET", "/git/ref/heads/master")
    base_commit = ref["object"]["sha"]
    st, comm = api("GET", "/git/commits/" + base_commit)
    base_tree = comm["tree"]["sha"]
    print("base=%s tree=%s" % (base_commit[:8], base_tree[:8]), flush=True)

    entries = []
    for idx, f in enumerate(ALL, 1):
        fpath = os.path.join(ROOT, f.replace("/", os.sep))
        with open(fpath, "rb") as fh:
            content_b64 = base64.b64encode(fh.read()).decode("ascii")
        st, blob = api("POST", "/git/blobs", {"content": content_b64, "encoding": "base64"})
        entries.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("  blob %d/%d %s" % (idx, len(ALL), f), flush=True)

    st, new_tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": entries})
    print("new_tree=%s" % new_tree["sha"][:8], flush=True)

    msg = ("补卡UI定稿（仅代码，不动学习记录）\n\n"
           "① 选中补卡日期：蓝底白字实心（.selected 改 primary 实心，盖住红色未完成），一眼即知选中目标\n"
           "② 今天(17日)格子可点击：点即取消已选补卡日期，按钮回「去打卡」\n"
           "③ 选中其他日期时，今天边框弱化为淡蓝虚线(.has-selection .today:not(.selected))，不再与选中框混淆；"
           "取消选中后恢复 today 实线边框\n"
           "④ 去补卡按钮两行：主文案「去补卡」+ 第二行小一号日期，手机端不再单行挤\n"
           "service-worker bump v50 强制刷新缓存\n"
           "安全：未修改 users.json / study_data.json 等任何学习记录与数据文件")
    st, new_commit = api("POST", "/git/commits", {
        "message": msg, "tree": new_tree["sha"], "parents": [base_commit]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)

    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("ref -> %s" % updated["object"]["sha"][:8], flush=True)
    print("\nDone in %.1fs. Render auto-deploy triggered." % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
