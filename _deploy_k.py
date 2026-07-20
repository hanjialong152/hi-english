import base64, json, re, urllib.request, ast

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

r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/commits/master', headers=GH)
commit_info = json.loads(urllib.request.urlopen(r).read())
current_sha = commit_info['sha']
print(f'Master HEAD: {current_sha}')

r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/trees/' + current_sha, headers=GH)
tree_data = json.loads(urllib.request.urlopen(r).read())

blobs = {}
for path, content in FILES.items():
    import hashlib
    blob_header = f'blob {len(content)}\0'.encode()
    expected_sha = hashlib.sha1(blob_header + content).hexdigest()
    b64 = base64.b64encode(content).decode()
    r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/blobs',
        data=json.dumps({'content': b64, 'encoding': 'base64'}).encode(), headers=GH, method='POST')
    blob = json.loads(urllib.request.urlopen(r).read())
    blobs[path] = blob['sha']
    print(f'  Blob: {path} ({len(content)} bytes) expected={expected_sha[:12]} got={blob["sha"][:12]} match={expected_sha==blob["sha"]}')

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

commit_msg = '''fix(k): 强制同步机制——从根本上解决客户端不推送问题

1. 新增「🔄 同步」按钮：手动立即推送本地真相+拉取服务端最新
2. init()完成后强制推送一次（500ms延迟）+ 30秒周期同步（原60秒）
3. 页面回到前台(visibilitychange visible)立即推送+拉取
4. SW v41/core-v40强制刷新缓存
5. 清理了测试数据，data-sync分支已重置为干净状态

根因总结：之前客户端仅在"学习计时中"才触发saveStudyData→push；
打卡完成后计时器提前return，不再推送。若完成瞬间的推送失败/未加载新代码，
数据永久滞留本地。现在多触发点+手动按钮确保必达。'''
r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/commits',
    data=json.dumps({'message': commit_msg, 'tree': commit_tree['sha'], 'parents': [current_sha]}).encode(), headers=GH, method='POST')
commit = json.loads(urllib.request.urlopen(r).read())
print(f'Commit: {commit["sha"][:8]}')

r = urllib.request.Request('https://api.github.com/repos/hanjialong152/hi-english/git/refs/heads/master',
    data=json.dumps({'sha': commit['sha']}).encode(), headers=GH, method='PATCH')
urllib.request.urlopen(r).read()
print('Deploy OK: https://hi-english.onrender.com/ (Ctrl+Shift+R)')
