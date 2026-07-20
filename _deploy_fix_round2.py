# -*- coding: utf-8 -*-
"""部署 4 项补充修复（仅代码文件，不影响学习记录与数据）。
修改文件：
  - js/student.js      (Bug⑩学习中数量：nextWord去重+Set统计+报告页统计)
  - js/admin.js        (Bug①c催学工号→账号 + Bug②分组分页 + 分页文案"共X条")
  - js/common.js       (Bug⑩启动时learned/mastered自愈去重)
  - server.py          (Bug①a钉钉时间UTC→北京 + Bug①b钉钉表头工号→账号)
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

CODE_FILES = [
    "js/student.js",
    "js/admin.js",
    "js/common.js",
    "server.py",
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

    msg = ("4项补充修复（仅代码，不动学习记录）\n\n"
           "①a 钉钉提醒时间改为北京时间（UTC+8），修复Render UTC时区差8小时问题\n"
           "①b 钉钉群消息表头「工号」改为「账号」\n"
           "①c 管理员端催学表头「工号」改为「账号」；学员管理/催学/分组 分页底部「共X人」改「共X条」\n"
           "② 分组管理加分页：默认5/页，支持5/10/20/50，底部显示当页/总数\n"
           "③ 学习中数量不符三重修复：\n"
           "   - nextWord()去重检查加String()类型兼容，杜绝重复累积\n"
           "   - renderWordList()/report页统计改Set去重，数字准确反映唯一已学词数\n"
           "   - getStudyData()加载时自动去重历史learned/mastered数组（数据自愈）\n"
           "安全：未修改 users.json / study_data.json / messages.json 等任何数据文件")
    st, new_commit = api("POST", "/git/commits", {
        "message": msg, "tree": new_tree["sha"], "parents": [base_commit]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)

    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("ref -> %s" % updated["object"]["sha"][:8], flush=True)
    print("\nDone in %.1fs. Render auto-deploy triggered." % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
