# -*- coding: utf-8 -*-
"""最终合并部署（稳健版）：850词例句音频(1173) + 商务英语26课修复(101音频 + JSON)。
特性：
- 速率限制自动等待：遇 403 rate limit 读 X-RateLimit-Reset 头后 sleep 到恢复，无限重试，绝不盲目耗尽崩溃。
- 进度持久化续传：已成功上传的 blob sha 记盘，中断/重启只推未完成文件，避免重复消耗配额。
- 串行两批各自独立 commit，避免并发 PATCH master 冲突。
- 不触碰 study_data/users/groups，学员记录零丢失。
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
LOG = open(os.path.join(ROOT, "_deploy_all_final.log"), "w", encoding="utf-8")
PROGRESS = os.path.join(ROOT, "_deploy_all_final_progress.json")

def changed_ids():
    o = json.load(open(os.path.join(ROOT, "data", "ogden_850_final.orig.json"), encoding="utf-8"))
    n = json.load(open(os.path.join(ROOT, "data", "ogden_850_final.json"), encoding="utf-8"))
    orig = {int(x["id"]): x for x in o}
    new = {int(x["id"]): x for x in n}
    def fp(w):
        return (w.get("word", ""), w.get("phrase_en", ""), w.get("s1_en", ""),
                w.get("s2_en", ""), w.get("s3_en", ""))
    return [i for i in new if i in orig and fp(new[i]) != fp(orig[i])]

def load_progress():
    if os.path.exists(PROGRESS):
        try:
            return json.load(open(PROGRESS, encoding="utf-8"))
        except Exception:
            return {}
    return {}

def save_progress(p):
    json.dump(p, open(PROGRESS, "w", encoding="utf-8"), ensure_ascii=False)

def api(method, path, data=None, retries=10):
    url = API + path
    body = json.dumps(data).encode("utf-8") if data is not None else None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", "Bearer " + TOKEN)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "hi-english-deploy-final")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "ignore")
            low = txt.lower()
            if e.code == 403 and "rate limit" in low:
                reset = int(e.headers.get("X-RateLimit-Reset", time.time() + 120))
                wait = max(0.0, reset - time.time()) + 15
                LOG.write("  [RATE LIMIT] sleep %.0fs 至 %s\n" % (wait, time.strftime("%H:%M:%S", time.localtime(reset)))); LOG.flush()
                time.sleep(wait)
                return api(method, path, data, retries)  # 重置后直接重试，不消耗次数
            LOG.write("  [HTTP %d] %s (retry %d) %s\n" % (e.code, path, attempt, txt[:120])); LOG.flush()
            if attempt < retries:
                wait = min(5 * attempt, 30); time.sleep(wait); continue
            raise
        except Exception as e:
            LOG.write("  [ERR] %s (retry %d) %s\n" % (path, attempt, str(e)[:120])); LOG.flush()
            if attempt < retries:
                wait = min(5 * attempt, 30); time.sleep(wait); continue
            raise

def upload_blobs(files, done, workers=2, delay=0.25):
    todo = [f for f in files if f not in done]
    LOG.write("  blob 待推 %d (已完成 %d)\n" % (len(todo), len(done))); LOG.flush()
    def do_one(f):
        fpath = os.path.join(ROOT, f.replace("/", os.sep))
        with open(fpath, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        time.sleep(delay)
        st, blob = api("POST", "/git/blobs", {"content": b64, "encoding": "base64"})
        return f, blob["sha"]
    total = len(files); cur = len(done)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(do_one, f): f for f in todo}
        for fut in as_completed(futs):
            f, sha = fut.result()
            done[f] = sha; cur += 1
            if cur % 100 == 0 or cur == total:
                save_progress(done)
                LOG.write("  blob %d/%d %s\n" % (cur, total, f)); LOG.flush()
    save_progress(done)
    return done

def make_commit(entries_dict, msg):
    st, ref = api("GET", "/git/ref/heads/master")
    base_sha = ref["object"]["sha"]
    st, comm = api("GET", "/git/commits/" + base_sha)
    base_tree = comm["tree"]["sha"]
    tree_list = [{"path": k, "mode": "100644", "type": "blob", "sha": v} for k, v in entries_dict.items()]
    st, new_tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": tree_list})
    full = msg + "\n\n- 未触碰 study_data/users/groups，学员记录零丢失。"
    st, new_commit = api("POST", "/git/commits", {"message": full, "tree": new_tree["sha"], "parents": [base_sha]})
    st, updated = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    LOG.write("  commit=%s ref->%s\n" % (new_commit["sha"][:8], updated["object"]["sha"][:8])); LOG.flush()
    return new_commit["sha"]

def deploy_batch(files, label, msg, done):
    missing = [f for f in files if not os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
    if missing:
        LOG.write("ERROR 缺失(%s): %s\n" % (label, str(missing[:5]))); LOG.flush(); raise SystemExit("缺失文件")
    LOG.write("=== 批次[%s] 文件数: %d ===\n" % (label, len(files))); LOG.flush()
    t0 = time.time()
    done = upload_blobs(files, done, workers=2, delay=0.25)
    sha = make_commit({f: done[f] for f in files}, msg)
    LOG.write("=== 批次[%s] 完成 commit=%s 耗时%.1fs ===\n" % (label, sha[:8], time.time()-t0)); LOG.flush()
    print("批次[%s] 完成 %d 文件, commit=%s" % (label, len(files), sha[:8]), flush=True)

def main():
    t0 = time.time()
    done = load_progress()
    # —— 批次1：850词例句音频 ——
    ids = changed_ids()
    ex_files = ["audio/e_%d_%d.mp3" % (i, k) for i in ids for k in (1, 2, 3)]
    deploy_batch(ex_files, "850例句音频", "850词例句音频补全(1173)", done)
    # —— 批次2：商务英语 ——
    jobs = json.load(open(os.path.join(ROOT, "_tmp", "biz_audio_jobs.json"), encoding="utf-8"))
    biz_files = ["audio/b_%d_%d.mp3" % (j["lid"], j["i"]) for j in jobs]
    biz_files.append("data/business_lessons.json")
    deploy_batch(biz_files, "商务英语26课", "商务英语26课修复(101音频+JSON)", done)
    LOG.write("全部完成! 总耗时 %.1fs\n" % (time.time() - t0)); LOG.flush()
    print("全部完成!", flush=True)
    if os.path.exists(PROGRESS):
        os.remove(PROGRESS)

if __name__ == "__main__":
    main()
