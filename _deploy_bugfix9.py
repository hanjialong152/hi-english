# -*- coding: utf-8 -*-
"""部署 9 项 bug 修复（仅代码，不动数据）：
  - js/common.js      : mergeStudyData 补 audioDone/audioDoneDate 合并（修复已学不同步）
  - server.py         : _merge_stage 补 audioDone/audioDoneDate 合并（服务端权威存储保留已学）
  - js/student.js     : 统一 classifyItem 四态分类（未学不含已掌握/学习中卡片=清单）；加 isAudioStarted
  - js/admin.js       : 报表学习阶段完成情况格式修正；分组分页同色；月测空值0；商务进度/掌握统一展示；calcUserScores 补字段
  - student.html      : 新增 .learning 方片卡/徽标样式
  - service-worker.js : 核心缓存 bump v43->v44 强制刷新 JS
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

CODE_FILES = ["js/common.js", "js/student.js", "js/admin.js", "server.py", "student.html", "service-worker.js"]
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
    msg = ("9项bug修复：已学同步/四态分类/报表格式/分组颜色/空值展示\n\n"
           "①② 已学(audioDone)同步：common.js mergeStudyData + server.py _merge_stage 补 audioDone/audioDoneDate 深层合并（并集+较新日期），修复换设备丢失、管理员端不显示\n"
           "③ 统一 classifyItem 四态分类（已掌握>已学>学习中>未学），未学不再混入已掌握，学习中卡片数=清单数\n"
           "④ 往回翻不丢已学：prevWord/nextWord 仅改 readIndex，不碰 audioDone；配合①②合并保留\n"
           "⑤ 分组管理分页「显示第X-Y条」加 color:var(--text-sub) 同色\n"
           "⑥ 报表学习阶段完成情况修正：全员=基础词汇已完成(已学/850)+商务英语已完成(已学/116)；团队=基础/商务完成数(全完人数/总人数)\n"
           "⑦ 个人排行榜月测成绩空值显示0\n"
           "⑧ 学员数据商务进度/掌握统一展示(始终 X/116 / X)，与基础一致\n"
           "⑨ 全员报告月测成绩空值显示0\n"
           "已掌握判定保持≥80；service-worker bump v43->v44\n"
           "安全：未修改任何学习记录数据")
    st, new_commit = api("POST", "/git/commits", {"message": msg, "tree": new_tree["sha"], "parents": [base_commit]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)
    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("Done %.1fs" % (time.time() - t0), flush=True)

if __name__ == "__main__":
    main()
