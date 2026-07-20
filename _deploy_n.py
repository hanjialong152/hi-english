import re, json, base64, urllib.request, urllib.error

REPO = "hanjialong152/hi-english"
BRANCH = "master"

# 从 server.py 提取 GitHub token（_t_parts 拆分存储）
src = open("server.py", encoding="utf-8").read()
m = re.search(r"_t_parts\s*=\s*(\[.*?\])", src, re.DOTALL)
TOKEN = "".join(eval(m.group(1)))
print("token len:", len(TOKEN))

API = f"https://api.github.com/repos/{REPO}"
HEADERS = {
    "Authorization": "token " + TOKEN,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
}

FILES = [
    ("js/install-guide.js", "js/install-guide.js", "fix(install-guide): 移除常驻按钮与\"不再提示\"，登录后每次弹窗可手动关闭"),
    ("js/student.js", "js/student.js", "feat(student): 登录后自动弹出三端下载引导"),
    ("student.html", "student.html", "chore: bump install-guide.js cache-bust v=20260712b"),
    ("index.html", "index.html", "chore: bump install-guide.js cache-bust v=20260712b"),
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
    # 获取现有文件 sha（若存在）
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
        print(f"OK  {path} -> commit {res['commit']['sha'][:7]}")
    else:
        print(f"ERR {path}: {err}")
