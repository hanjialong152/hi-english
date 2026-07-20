import base64, json, urllib.request
import _deploy_p012 as D

TOKEN = D.TOKEN
REPO = "hanjialong152/hi-english"
hdr = {"Accept": "application/vnd.github+json", "Authorization": "Bearer " + TOKEN,
       "User-Agent": "deploy", "Content-Type": "application/json"}

def api(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request("https://api.github.com" + path, data=body, headers=hdr, method=method)
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

content = open("admin.html", "rb").read()
ref = api("GET", "/repos/%s/git/ref/heads/master" % REPO)
base_sha = ref["object"]["sha"]
cmt = api("GET", "/repos/%s/git/commits/%s" % (REPO, base_sha))
tree_sha = cmt["tree"]["sha"]
entries = [{"path": "admin.html", "mode": "100644", "type": "blob", "content": content.decode("utf-8")}]
new_tree = api("POST", "/repos/%s/git/trees" % REPO, {"base_tree": tree_sha, "tree": entries})
new_cmt = api("POST", "/repos/%s/git/commits" % REPO,
              {"message": "style: 内容管理（开发中）字号缩小", "tree": new_tree["sha"], "parents": [base_sha]})
api("PATCH", "/repos/%s/git/refs/heads/master" % REPO, {"sha": new_cmt["sha"]})
print("DEPLOYED commit", new_cmt["sha"][:9])
