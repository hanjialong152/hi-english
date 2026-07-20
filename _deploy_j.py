import base64, json, re, urllib.request, ast

# 从 server.py 提取拆分的 Token
src = open('server.py', encoding='utf-8').read()
m = re.search(r"_t_parts\s*=\s*(\[.*?\])", src, re.DOTALL)
if not m: raise SystemExit("Cannot find _t_parts in server.py")
token = ''.join(ast.literal_eval(m.group(1)))
GH = {'Authorization': 'token ' + token, 'Content-Type': 'application/json'}

FILES = {
    'student.html': open('student.html', 'rb').read(),
    'js/common.js': open('js/common.js', 'rb').read(),
    'js/student.js': open('js/student.js', 'rb').read(),
    'js/install-guide.js': open('js/install-guide.js', 'rb').read(),
    'service-worker.js': open('service-worker.js', 'rb').read(),
}

# 1. Get current master commit SHA
r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/commits/master', headers=GH)
commit_info = json.loads(urllib.request.urlopen(r).read())
current_sha = commit_info['sha']
print(f'Master HEAD: {current_sha}')

# 2. Get current base tree (non-recursive, just root level)
r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/trees/' + current_sha, headers=GH)
tree_data = json.loads(urllib.request.urlopen(r).read())
base_tree_sha = tree_data['sha']
print(f'Base tree: {base_tree_sha[:8]} ({len(tree_data["tree"])} entries)')

# 3. Create blobs
blobs = {}
for path, content in FILES.items():
    b64 = base64.b64encode(content).decode()
    r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/blobs',
        data=json.dumps({'content': b64, 'encoding': 'base64'}).encode(), headers=GH, method='POST')
    blob = json.loads(urllib.request.urlopen(r).read())
    blobs[path] = blob['sha']
    print(f'  Blob: {path} ({len(content)} bytes) -> {blob["sha"][:8]}')

# 4. Build new tree: keep existing root entries, override changed ones
new_tree = []
for t in tree_data['tree']:
    if t['path'] in blobs:
        new_tree.append({'path': t['path'], 'mode': t['mode'], 'type': 'blob', 'sha': blobs[t['path']]})
    else:
        new_tree.append({'path': t['path'], 'mode': t['mode'], 'type': t['type'], 'sha': t['sha']})

r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/trees',
    data=json.dumps({'tree': new_tree}).encode(), headers=GH, method='POST')
commit_tree = json.loads(urllib.request.urlopen(r).read())
print(f'Tree: {commit_tree["sha"][:8]}')

# 5. Create commit
commit_msg = 'fix(j): cross-terminal sync defense + remove report install card\n\n- common.js: pushServerStudyDataImmediate() + startPeriodicSync(60s)\n- student.js: immediate push on checkin complete + periodic sync + 5s silent retry\n- student.html: removed install card from report page (keep popup only)\n- SW v40/core-v39'
r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/commits',
    data=json.dumps({'message': commit_msg, 'tree': commit_tree['sha'], 'parents': [current_sha]}).encode(), headers=GH, method='POST')
commit = json.loads(urllib.request.urlopen(r).read())
print(f'Commit: {commit["sha"][:8]}')

# 6. Update master ref
r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/refs/heads/master',
    data=json.dumps({'sha': commit['sha']}).encode(), headers=GH, method='PATCH')
urllib.request.urlopen(r).read()
print('Deploy OK: https://hi-english.onrender.com/ (Ctrl+Shift+R)')
