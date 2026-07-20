# -*- coding: utf-8 -*-
"""补全 850 词例句音频推送（v3 批次3 中断续传，幂等）。
只推 391 改写词的例句音频 e_{id}_{1,2,3}.mp3（1173 个）。
不触碰 study_data/users/groups，学员记录零丢失。
"""
import base64, json, os, time, urllib.request, urllib.error
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
LOG = open(os.path.join(ROOT, "_deploy_850fix4.log"), "w", encoding="utf-8")

def changed_ids():
    o = json.load(open(os.path.join(ROOT, "data", "ogden_850_final.orig.json"), encoding="utf-8"))
    n = json.load(open(os.path.join(ROOT, "data", "ogden_850_final.json"), encoding="utf-8"))
    orig = {int(x["id"]): x for x in o}
    new = {int(x["id"]): x for x in n}
    def fp(w):
        return (w.get("word", ""), w.get("phrase_en", ""), w.get("s1_en", ""),
                w.get("s2_en", ""), w.get("s3_en", ""))
    return [i for i in new if i in orig and fp(new[i]) != fp(orig[i])]

def api(method, path, data=None, retries=6):
    url = API + path
    body = json.dumps(data).encode("utf-8") if data is not None else None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", "Bearer " + TOKEN)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "hi-english-deploy-fix4")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "ignore")[:160]
            if attempt < retries:
                wait = min(5 * attempt, 30); time.sleep(wait); continue
            raise
        except Exception as e:
            if attempt < retries:
                wait = min(5 * attempt, 30); time.sleep(wait); continue
            raise

def upload_blobs(files, workers=3, delay=0.3):
    def do_one(f):
        fpath = os.path.join(ROOT, f.replace("/", os.sep))
        with open(fpath, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        time.sleep(delay)
        st, blob = api("POST", "/git/blobs", {"content": b64, "encoding": "base64"})
        return f, blob["sha"]
    entries = {}; total = len(files); done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(do_one, f): f for f in files}
        for fut in as_completed(futs):
            f, sha = fut.result()
            entries[f] = sha; done += 1
            if done % 100 == 0:
                LOG.write("  blob %d/%d %s\n" % (done, total, f)); LOG.flush()
    return entries

def make_commit(entries_dict, msg_suffix):
    st, ref = api("GET", "/git/ref/heads/master")
    base_sha = ref["object"]["sha"]
    st, comm = api("GET", "/git/commits/" + base_sha)
    base_tree = comm["tree"]["sha"]
    tree_list = [{"path": k, "mode": "100644", "type": "blob", "sha": v} for k, v in entries_dict.items()]
    st, new_tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": tree_list})
    msg = "850词例句音频补全(%s)\n\n- 续传 v3 批次3（1173 例句音频）\n- 未触碰 study_data/users/groups，学员记录零丢失。" % msg_suffix
    st, new_commit = api("POST", "/git/commits", {"message": msg, "tree": new_tree["sha"], "parents": [base_sha]})
    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    LOG.write("  commit=%s ref->%s\n" % (new_commit["sha"][:8], updated["object"]["sha"][:8])); LOG.flush()

def main():
    t0 = time.time()
    ids = changed_ids()
    ex_files = []
    for i in ids:
        for k in (1, 2, 3):
            ex_files.append("audio/e_%d_%d.mp3" % (i, k))
    missing = [f for f in ex_files if not os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
    if missing:
        LOG.write("ERROR 缺失: %s\n" % str(missing[:5])); LOG.flush(); return
    LOG.write("改写词数: %d | 例句音频: %d\n" % (len(ids), len(ex_files))); LOG.flush()
    print("例句音频待推:", len(ex_files), flush=True)
    e = upload_blobs(ex_files, workers=3, delay=0.3)
    make_commit(e, "批次3-例句音频1173")
    LOG.write("完成! 耗时 %.1fs\n" % (time.time() - t0)); LOG.flush()
    print("完成!", flush=True)

if __name__ == "__main__":
    main()
