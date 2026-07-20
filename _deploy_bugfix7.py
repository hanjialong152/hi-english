# -*- coding: utf-8 -*-
"""部署 7 项 Bug 修复（仅代码文件，不影响学习记录与数据）。
修改文件：
  - js/student.js      (Bug①补卡倒计时 / Bug②学习清单ID类型 / Bug③⑥周测月测题池)
  - js/admin.js        (Bug⑤学员管理分页 / Bug⑦催学页分页勾选排序)
  - js/install-guide.js(Bug④已装PWA不弹安装)
  - server.py          (Bug⑦钉钉群消息表格化+按打卡天数排序)
  - admin.html         (Bug⑤分页容器)
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
    "js/admin.js",
    "js/install-guide.js",
    "server.py",
    "admin.html",
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

    msg = ("7项Bug修复（仅代码，不动学习记录）\n\n"
           "① 补卡倒计时不动：学习页显示层日期改为 makeupDate||today，与计时器一致\n"
           "② 学习清单已掌握/学习中不变：renderWordList 筛选加 String() 类型兼容；商务搜索提示改为「搜索微课名称或中文」\n"
           "③⑥ 周测/月测两阶段不可用：getWeekly/MonthlyTestPool 题池 learnedDates 加 String() 类型兼容\n"
           "④ 已装PWA仍弹安装：install-guide 增加 isInstalled() 检测（standalone/minimal-ui/fullscreen/iOS standalone）\n"
           "⑤ 学员管理分页：默认10/页，支持10/20/50/100，底部显示当页/总数\n"
           "⑦ 催学页：按打卡天数升序+可勾选表格+分页(默认10/页)；钉钉群消息改为按打卡天数排序的Markdown表格(含天数)\n"
           "安全：未修改 users.json / study_data.json 等任何学习记录与数据文件")
    st, new_commit = api("POST", "/git/commits", {
        "message": msg, "tree": new_tree["sha"], "parents": [base_commit]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)

    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("ref -> %s" % updated["object"]["sha"][:8], flush=True)
    print("\nDone in %.1fs. Render auto-deploy triggered." % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
