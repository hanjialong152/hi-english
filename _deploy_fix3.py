# -*- coding: utf-8 -*-
"""针对性部署：仅推送本次修复的 8 个文件到 master，触发 Render 自动部署。"""
import sys, os, base64, json, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _deploy_p012 import api, REPO  # 复用 api() 与 TOKEN（模块级）

ROOT = os.path.dirname(os.path.abspath(__file__))
FILES = [
    "data/business_lessons.json",
    "js/student.js",
    "admin.html",
    "student.html",
    "index.html",
    "service-worker.js",
    "audio/b_30_8.mp3",
    "audio/b_30_9.mp3",
]


def main():
    existing = [f for f in FILES if os.path.exists(os.path.join(ROOT, f.replace("/", os.sep)))]
    print("Pushing %d files: %s" % (len(existing), existing), flush=True)
    entries = []
    for idx, f in enumerate(existing, 1):
        fpath = os.path.join(ROOT, f.replace("/", os.sep))
        with open(fpath, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        st, blob = api("POST", "/git/blobs", {"content": b64, "encoding": "base64"})
        entries.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("  blob %d/%d %s" % (idx, len(existing), f), flush=True)

    st, ref = api("GET", "/git/ref/heads/master")
    base = ref["object"]["sha"]
    st, comm = api("GET", "/git/commits/" + base)
    tree = comm["tree"]["sha"]
    st, new_tree = api("POST", "/git/trees", {"base_tree": tree, "tree": entries})
    print("new_tree=%s" % new_tree["sha"][:8], flush=True)

    msg = ("fix: L30对话speaker错位修正+音频重生成；清理100003强制解锁脚手架\n\n"
           "- L30: 按原始transcript修正speaker错位(原The traffic/B的Maybe两句标反)并合并为10句\n"
           "- 生成 b_30_8.mp3(合并句) / b_30_9.mp3(B句)\n"
           "- student.js 移除 100003 强制解锁商务残留脚手架\n"
           "- admin.html 内容管理入口已标注（开发中）\n"
           "- 版本 ?v=20260711a SW v33/core-v32/audio-v30")
    st, new_commit = api("POST", "/git/commits", {"message": msg, "tree": new_tree["sha"], "parents": [base]})
    print("commit=%s" % new_commit["sha"][:8], flush=True)
    st, upd = api("PATCH", "/git/refs/heads/master", {"sha": new_commit["sha"]})
    print("ref -> %s" % upd["object"]["sha"][:8], flush=True)
    print("Done. Render auto-deploy triggered.", flush=True)


if __name__ == "__main__":
    main()
