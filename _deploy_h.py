import base64, json, re, urllib.request

# 从 server.py 提取拆分的 Token（避免 import 整个模块触发全量音频推送副作用）
src = open('server.py', encoding='utf-8').read()
m = re.search(r"_t_parts\s*=\s*\[([^\]]+)\]", src)
parts = eval('[' + m.group(1) + ']')
TOKEN = ''.join(parts)
REPO = "hanjialong152/hi-english"
hdr = {"Accept": "application/vnd.github.v3+json", "Authorization": "Bearer " + TOKEN,
       "User-Agent": "deploy", "Content-Type": "application/json"}

def api(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request("https://api.github.com" + path, data=body, headers=hdr, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

# 本次修复：跨终端同步失败(重试+延迟兜底+加载提示) + 短句文案简化
FILES = [
    "js/common.js",
    "js/student.js",
    "student.html",
    "service-worker.js",
]

ref = api("GET", "/repos/%s/git/ref/heads/master" % REPO)
base_sha = ref["object"]["sha"]
cmt = api("GET", "/repos/%s/git/commits/%s" % (REPO, base_sha))
tree_sha = cmt["tree"]["sha"]

entries = []
for f in FILES:
    raw = open(f, "rb").read()
    blob = api("POST", "/repos/%s/git/blobs" % REPO,
               {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
    entries.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})

new_tree = api("POST", "/repos/%s/git/trees" % REPO, {"base_tree": tree_sha, "tree": entries})
new_cmt = api("POST", "/repos/%s/git/commits" % REPO,
              {"message": "fix: 跨终端数据同步失败(3次重试+2秒延迟兜底+同步加载提示) + 短句通过文案简化",
               "tree": new_tree["sha"], "parents": [base_sha]})
api("PATCH", "/repos/%s/git/refs/heads/master" % REPO, {"sha": new_cmt["sha"]})
print("DEPLOYED commit", new_cmt["sha"][:9], "files:", FILES)
