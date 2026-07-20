import base64, json, re, urllib.request, urllib.error, sys, time

# 读取 server.py 里的拆分 token
src = open('server.py', encoding='utf-8').read()
m = re.search(r'_t_parts\s*=\s*(\[.*?\])', src, re.DOTALL)
if not m:
    raise SystemExit('Cannot find _t_parts in server.py')
token = ''.join(eval(m.group(1)))
GH = {'Authorization': 'token ' + token, 'Content-Type': 'application/json',
       'Accept': 'application/vnd.github.v3+json'}
REPO = 'hanjialong152/hi-english'

def api(method, path, data=None, branch=None):
    url = f'https://api.github.com/repos/{REPO}/contents/{path}'
    params = []
    if branch:
        params.append('ref=' + branch)
    if params:
        url += '?' + '&'.join(params)
    body = json.dumps(data).encode('utf-8') if data is not None else None
    req = urllib.request.Request(url, data=body, headers=GH, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8')), None
    except urllib.error.HTTPError as e:
        return None, (e.code, e.read().decode('utf-8')[:300])
    except Exception as e:
        return None, (0, str(e))

def put_file(local_path, repo_path, branch, label):
    content = open(local_path, 'rb').read()
    b64 = base64.b64encode(content).decode()
    existing, err = api('GET', repo_path, branch=branch)
    sha = existing.get('sha') if existing else None
    payload = {
        'message': f'feat: 三端下载渠道弹窗(安卓/苹果/鸿蒙) {time.strftime("%m-%d %H:%M:%S")}',
        'content': b64,
        'branch': branch,
    }
    if sha:
        payload['sha'] = sha
    res, err = api('PUT', repo_path, payload)
    if res and 'content' in res:
        print(f'[OK] {label} -> {repo_path} (sha={res["content"]["sha"][:10]})')
        return True
    else:
        print(f'[FAIL] {label} -> {repo_path}: {err}')
        return False

ok = True
# 推到 master 触发 Render 自动部署
ok &= put_file('js/install-guide.js', 'js/install-guide.js', 'master', 'install-guide.js')
ok &= put_file('js/student.js', 'js/student.js', 'master', 'student.js')
ok &= put_file('index.html', 'index.html', 'master', 'index.html')
ok &= put_file('student.html', 'student.html', 'master', 'student.html')

print('\n=== 结果 ===')
print('全部成功，Render 将自动重建' if ok else '存在失败，见上方 [FAIL]')
sys.exit(0 if ok else 1)
