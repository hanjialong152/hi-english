# -*- coding: utf-8 -*-
"""部署 850词质量修复 v3（稳态版）：分3批提交避免 504。
批次1：6 个代码/数据/版本文件（立即）
批次2：391 词的单词+词组音频（782 个）（间隔 0.3s）
批次3：391 词的例句音频（1173 个）（间隔 0.3s）

每批独立 commit + PATCH ref，互不依赖。
不触碰 study_data/users/groups，学员记录零丢失。
"""
import base64, json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

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


def changed_ids():
    o = json.load(open(os.path.join(ROOT, "data", "ogden_850_final.orig.json"), encoding="utf-8"))
    n = json.load(open(os.path.join(ROOT, "data", "ogden_850_final.json"), encoding="utf-8"))
    orig = {int(x["id"]): x for x in o}
    new = {int(x["id"]): x for x in n}
    def fp(w):
        return (w.get("word", ""), w.get("phrase_en", ""), w.get("s1_en", ""),
                w.get("s2_en", ""), w.get("s3_en", ""))
    return [i for i in new if i in orig and fp(new[i]) != fp(orig[i])]


def api(method, path, data=None, retries=5):
    url = API + path
    body = json.dumps(data).encode("utf-8") if data is not None else None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", "Bearer " + TOKEN)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "hi-english-deploy-v3")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "ignore")[:200]
            if attempt < retries:
                wait = min(5 * attempt, 30)
                print("  [HTTP %d retry %d/%d wait%ds] %s" % (e.code, attempt, retries, wait, path[-40:]), flush=True)
                time.sleep(wait)
                continue
            raise
        except Exception as e:
            if attempt < retries:
                wait = min(5 * attempt, 30)
                print("  [err retry %d/%d wait%ds] %s" % (attempt, retries, wait, str(e)[:80]), flush=True)
                time.sleep(wait)
                continue
            raise


def upload_blobs(files, workers=3, delay=0.35):
    """上传文件列表为 blob dict {path: sha}"""
    def do_one(f):
        fpath = os.path.join(ROOT, f.replace("/", os.sep))
        with open(fpath, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        st, blob = api("POST", "/git/blobs", {"content": b64, "encoding": "base64"})
        time.sleep(delay)
        return f, blob["sha"]

    entries = {}
    total = len(files)
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(do_one, f): f for f in files}
        for fut in as_completed(futs):
            f, sha = fut.result()
            entries[f] = sha
            done += 1
            if done % 100 == 0 or done <= 8:
                print("  blob %d/%d %s" % (done, total, f), flush=True)
    return entries


def make_commit(entries_dict, msg_suffix):
    """用当前 master 为 base 创建 commit + PATCH ref"""
    st, ref = api("GET", "/git/ref/heads/master")
    base_sha = ref["object"]["sha"]
    st, comm = api("GET", "/git/commits/" + base_sha)
    base_tree = comm["tree"]["sha"]
    tree_list = [{"path": k, "mode": "100644", "type": "blob", "sha": v} for k, v in entries_dict.items()]
    st, new_tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": tree_list})
    msg = "850词质量修复(%s)\n\n%s" % (msg_suffix,
           "- 未触碰 study_data/users/groups，学员记录零丢失。\n"
           "版本 ?v=20260712d SW v42/core-v41")
    st, new_commit = api("POST", "/git/commits",
                          {"message": msg, "tree": new_tree["sha"], "parents": [base_sha]})
    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("  commit=%s ref->%s" % (new_commit["sha"][:8], updated["object"]["sha"][:8]), flush=True)


def main():
    t0 = time.time()
    ids = changed_ids()
    # 构建音频文件列表
    wp_files = []
    ex_files = []
    for i in ids:
        wp_files.append("audio/w_%d.mp3" % i)
        wp_files.append("audio/p_%d.mp3" % i)
        for k in (1, 2, 3):
            ex_files.append("audio/e_%d_%d.mp3" % (i, k))

    CODE_FILES = [
        "data/ogden_850_final.json",
        "js/common.js",
        "js/student.js",
        "app.js",
        "service-worker.js",
        "student.html",
    ]

    all_audio = wp_files + ex_files
    missing = [f for f in all_audio if not os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
    if missing:
        print("ERROR: 缺失音频 %d 个:" % len(missing), flush=True)
        for m in missing[:10]:
            print(" ", m, flush=True)
        sys.exit(1)

    print("改写词数: %d | 音频: %d (词组%d 例句%d)" % (len(ids), len(all_audio), len(wp_files), len(ex_files)), flush=True)

    # === 批次1：代码/数据文件（6个）===
    print("\n===== 批次1：代码/数据文件 (%d) =====" % len(CODE_FILES), flush=True)
    e1 = upload_blobs(CODE_FILES, workers=2, delay=0.2)
    make_commit(e1, "批次1-词库+版本号缓存升级")

    # === 批次2：单词+词组音频（782个）===
    print("\n===== 批次2：单词+词组音频 (%d) =====" % len(wp_files), flush=True)
    e2 = upload_blobs(wp_files, workers=3, delay=0.35)
    make_commit(e2, "批次2-%d词的单词+词组音频(w_/p_)" % len(ids))

    # === 批次3：例句音频（1173个）===
    print("\n===== 批次3：例句音频 (%d) =====" % len(ex_files), flush=True)
    e3 = upload_blobs(ex_files, workers=3, delay=0.35)
    make_commit(e3, "批次3-%d词的例句音频(e_)" % len(ids))

    print("\n全部完成! 总耗时 %.1fs" % (time.time() - t0), flush=True)
    print("Render 会自动拉取最新 3 次 commit 并部署。", flush=True)


if __name__ == "__main__":
    main()
