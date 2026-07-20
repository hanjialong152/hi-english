import base64, json, urllib.request
import _deploy_p012 as D

TOKEN = D.TOKEN
REPO = "hanjialong152/hi-english"
hdr = {"Accept": "application/vnd.github.v3+json", "Authorization": "Bearer " + TOKEN,
       "User-Agent": "deploy", "Content-Type": "application/json"}

def api(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request("https://api.github.com" + path, data=body, headers=hdr, method=method)
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

FILES = [
    "server.py",
    "js/common.js",
    "index.html",
    "student.html",
    "admin.html",
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
              {"message": "fix: 发版安全落盘 + 双向合并同步，根治部署丢数据", "tree": new_tree["sha"],
               "parents": [base_sha]})
api("PATCH", "/repos/%s/git/refs/heads/master" % REPO, {"sha": new_cmt["sha"]})
print("DEPLOYED commit", new_cmt["sha"][:9], "files:", FILES)
