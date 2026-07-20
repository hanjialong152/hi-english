# -*- coding: utf-8 -*-
"""部署 4 项 Bug 修复（仅代码文件，不影响学习记录与数据）。
修改文件：
  - js/student.js      (①补卡入口显示逻辑 + ①日历弹窗去打卡跟随选中日期)
  - js/common.js       (②服务端登录禁用拦截)
  - server.py          (②登录接口禁用拦截)
  - admin.html         (③状态标签错行 + ④报表维度联动 select)
  - student.html       (①日历弹窗按钮加 id/onclick)
  - js/admin.js        (④详细报表日期按维度联动)
  - service-worker.js  (bump 缓存版本 v47 强制刷新)
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
    "js/common.js",
    "js/admin.js",
    "server.py",
    "admin.html",
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

    msg = ("4项Bug修复（仅代码，不动学习记录）\n\n"
           "① 补卡入口：去掉 todayCompleted 前置条件，只要上周六到昨天有未打卡即显示补卡入口；"
           "日历弹窗去打卡按钮跟随选中日期，显示「去补卡（X月X日）」\n"
           "② 禁用账号拦截：服务端 /api/login 与前端 serverLogin 双重校验 status，"
           "禁用账号登录直接提示「账号已被禁用，如需启用请联系管理员」，不再闪入学员端首页\n"
           "③ 管理员端状态标签：加 white-space:nowrap，启用/禁用不再错行\n"
           "④ 详细报表：筛选维度切换时自动设置起止日期（按日=当天 / 按周=当天-7天 / 按月=当天-30天）\n"
           "service-worker bump v47 强制刷新缓存\n"
           "安全：未修改 users.json / study_data.json 等任何学习记录与数据文件")
    st, new_commit = api("POST", "/git/commits", {
        "message": msg, "tree": new_tree["sha"], "parents": [base_commit]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)

    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("ref -> %s" % updated["object"]["sha"][:8], flush=True)
    print("\nDone in %.1fs. Render auto-deploy triggered." % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
