import re, json, base64, urllib.request, urllib.error

REPO = "hanjialong152/hi-english"
BRANCH = "master"

src = open("server.py", encoding="utf-8").read()
m = re.search(r"_t_parts\s*=\s*(\[.*?\])", src, re.DOTALL)
TOKEN = "".join(eval(m.group(1)))

API = f"https://api.github.com/repos/{REPO}"
HEADERS = {
    "Authorization": "token " + TOKEN,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
}

FILES = [
    ("js/install-guide.js", "js/install-guide.js", "fix(install-guide): 刷新不重复弹、仅重新登录才弹（sessionStorage 标记 + 登录清标记）"),
    ("index.html", "index.html", "chore: bump install-guide v=20260712c + 登录清空弹窗标记"),
    ("student.html", "student.html", "chore: bump install-guide v=20260712c"),
]

def api_request(method, url, data=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data else None, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        return None, (e.code, e.read().decode("utf-8")[:300])
    except Exception as e:
        return None, (0, str(e))

for path, local, msg in FILES:
    content = open(local, "rb").read()
    existing, err = api_request("GET", f"{API}/contents/{path}?ref={BRANCH}")
    sha = existing.get("sha") if existing else None
    payload = {
        "message": msg,
        "content": base64.b64encode(content).decode("utf-8"),
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha
    res, err = api_request("PUT", f"{API}/contents/{path}", payload)
    if res and "commit" in res:
        print(f"OK  {path} -> {res['commit']['sha'][:7]}")
    else:
        print(f"ERR {path}: {err}")
