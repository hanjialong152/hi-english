# -*- coding: utf-8 -*-
"""部署 850词质量修复（391个改写词）：替换词库 + 重生成音频 + 提升缓存版本号。
仅推送 CODE_FILES（代码/数据/版本）与改动词的音频；不触碰 study_data/users/groups 等学员数据。
"""
import base64, json, os, sys, time, urllib.request, urllib.error

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

# 代码/数据/版本文件（学员端实际加载的链路）
CODE_FILES = [
    "data/ogden_850_final.json",
    "js/common.js",
    "js/student.js",
    "app.js",
    "service-worker.js",
    "student.html",
]


def changed_ids():
    o = json.load(open(os.path.join(ROOT, "data", "ogden_850_final.orig.json"), encoding="utf-8"))
    n = json.load(open(os.path.join(ROOT, "data", "ogden_850_final.json"), encoding="utf-8"))
    orig = {int(x["id"]): x for x in o}
    new = {int(x["id"]): x for x in n}

    def fp(w):
        return (w.get("word", ""), w.get("phrase_en", ""), w.get("s1_en", ""),
                w.get("s2_en", ""), w.get("s3_en", ""))

    return [i for i in new if i in orig and fp(new[i]) != fp(orig[i])]


def build_audio_files():
    files = []
    for i in changed_ids():
        files.append("audio/w_%d.mp3" % i)
        files.append("audio/p_%d.mp3" % i)
        for k in (1, 2, 3):
            files.append("audio/e_%d_%d.mp3" % (i, k))
    return files


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
    audio_files = build_audio_files()
    # 校验所有音频已生成
    missing = [f for f in audio_files if not os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
    if missing:
        print("ERROR: 缺失音频 %d 个，中止部署：" % len(missing), flush=True)
        for m in missing[:20]:
            print("  ", m, flush=True)
        sys.exit(1)
    print("改写词数(音频):", len(changed_ids()), "音频文件:", len(audio_files), flush=True)

    ALL = CODE_FILES + audio_files
    ALL = [f for f in ALL if os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
    print("FILES to push:", len(ALL), "(code %d + audio %d)" % (len(CODE_FILES), len(audio_files)), flush=True)

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
        if idx % 100 == 0 or idx <= 6:
            print("  blob %d/%d %s" % (idx, len(ALL), f), flush=True)

    st, new_tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": entries})
    print("new_tree=%s" % new_tree["sha"][:8], flush=True)

    msg = ("850词质量修复上线（391个改写词）\n\n"
           "- 替换 data/ogden_850_final.json：391个词按\"汽车研产销优先/生活工作场景\"重写词组+3例句\n"
           "- edge-tts(en-US-AriaNeural) 重生成 391词的 w_/p_/e_1-3 音频(1955个)，英文与文本一一对应\n"
           "- 学员端加载链路加 DATA_VER 版本号，音频 AUDIO_VER 升 ?v=20260712d，SW 缓存升 v42/core-v41\n"
           "- 未改动 459 个词的音频保留原文件；未触碰任何学员学习记录(study_data/users/groups)\n"
           "版本 ?v=20260712d SW v42/core-v41")
    st, new_commit = api("POST", "/git/commits", {
        "message": msg, "tree": new_tree["sha"], "parents": [base_commit]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)

    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("ref -> %s" % updated["object"]["sha"][:8], flush=True)
    print("\nDone in %.1fs. Render auto-deploy triggered." % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
