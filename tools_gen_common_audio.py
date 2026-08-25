#!/usr/bin/env python3
# 生成"全词点读"所需数据：common_vocab.json + audio/cw_{slug}.mp3
# 读取源：ogden_850_final.json(基础词汇, 含 id/word/ipa/pos/cn/phrase_en/s1-3_en)
#         business_lessons.json(商务句子)
#         car_vocab.json(汽车/商务专有词, 已有 car_*.mp3, 不重复生成)
# 规则：基础词汇目标词复用现有 w_{id}.mp3(不在 cw_ 生成)；其余可点词生成 cw_{slug}.mp3(统一音色)。
import json, re, os, asyncio, edge_tts

REPO = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(REPO, "data")
AUDIO = os.path.join(REPO, "audio")
os.makedirs(AUDIO, exist_ok=True)

# 本地化正式系统文本为唯一真相源（文本改过多次，Render/V6.7 旧文本不可信）
BASE = r"D:\Mario.H OFFICE\2026年\workbuddy 项目资料（Hienglish）\WorkBuddy_旧_20260801\Claw_旧_20260801（Hi English）\baseline_V6.9\data"

VOICE = "en-US-AriaNeural"
WORD_RE = re.compile(r"[A-Za-z][A-Za-z'*\-]*")

def slug(w):
    return re.sub(r"[^a-z0-9]", "_", w.lower())

def toks(s):
    return [w.lower() for w in WORD_RE.findall(s or "") if len(w) >= 2 and not w.isdigit()]

# ---- 读源 ----
# 基础词汇/商务英语文本：以本地化正式系统(baseline_V6.9)为准
ogden = json.load(open(os.path.join(BASE, "ogden_850_final.json"), encoding="utf-8"))
biz = json.load(open(os.path.join(BASE, "business_lessons.json"), encoding="utf-8"))
# 汽车/商务专有词：功能自带数据(新功能, 不在正式文本改动范围)
car = json.load(open(os.path.join(DATA, "car_vocab.json"), encoding="utf-8"))

# 汽车/商务专有词 map（小写键），这些用 car_*.mp3，不生成 cw_
car_map = {}
for it in car:
    if it and it.get("word"):
        car_map[it["word"].lower()] = it

# ogden 词 -> {id, word, ipa, pos, cn}（用于 common_vocab 完整释义 + 复用 w_*.mp3）
ogden_map = {}
for e in ogden:
    w = (e.get("word") or "").strip()
    if not w:
        continue
    ogden_map[w.lower()] = {
        "id": e.get("id"),
        "word": w,
        "ipa": e.get("ipa") or "",
        "pos": e.get("pos") or "",
        "cn": e.get("cn") or "",
    }

# ---- 收集"可点词"封闭并集 ----
union = {}  # lower -> original display word（取首个出现形态）
def add(word):
    if not word:
        return
    lw = word.lower()
    if lw not in union:
        union[lw] = word

# 1) ogden：目标词 + 词组 + 3 例句 里的所有英文词
for e in ogden:
    for f in ("word", "phrase_en", "s1_en", "s2_en", "s3_en"):
        for t in toks(e.get(f, "")):
            add(t)
# 2) business：递归所有英文字符串里的词
def walk(o):
    if isinstance(o, str):
        for t in toks(o):
            add(t)
    elif isinstance(o, dict):
        for v in o.values():
            walk(v)
    elif isinstance(o, (list, tuple)):
        for v in o:
            walk(v)
walk(biz)
# 3) car 专有词（已在 car_map）
for lw in car_map:
    add(car_map[lw]["word"])

print(f"[统计] 可点词封闭并集(去重): {len(union)}")

# ---- 生成 common_vocab.json ----
# 每个词一条：有 ogden 数据用完整；否则 ipa/pos/cn 留空（卡片仍显示单词+发声）
common = []
for lw, disp in union.items():
    og = ogden_map.get(lw)
    if og:
        common.append({"word": og["word"], "ipa": og["ipa"], "pos": og["pos"], "cn": og["cn"]})
    else:
        common.append({"word": disp, "ipa": "", "pos": "", "cn": ""})
common.sort(key=lambda x: x["word"].lower())
with open(os.path.join(DATA, "common_vocab.json"), "w", encoding="utf-8") as f:
    json.dump(common, f, ensure_ascii=False, indent=1)
print(f"[common_vocab.json] 写出 {len(common)} 条")

# ---- 生成 cw_*.mp3 ----
# 仅给"非汽车专有词 且 非基础词汇目标词(复用 w_*.mp3)"的词生成 cw_ 音频
# 说明：基础词汇目标词已有 w_{{id}}.mp3，播放时由 playCarWord 优先用 w_；
#       为保证"句子里出现的同词"也有音，且避免重复，这里对 ogden 目标词也生成 cw_ 一份统一命名，
#       但为节省，仅生成"不在 ogden_map(作为目标词) 且 不在 car_map"的词。
gen_words = []
for lw, disp in union.items():
    if lw in car_map:
        continue
    # 基础词汇目标词也生成 cw_（统一音色命名，playCarWord 统一走 cw_）
    gen_words.append(disp)
print(f"[音频] 需新生成 cw_*.mp3 的词数: {len(gen_words)}")

sem = asyncio.Semaphore(30)
ok = 0
skip = 0
fail = []

async def gen_one(word):
    global ok, skip
    s = slug(word)
    out = os.path.join(AUDIO, f"cw_{s}.mp3")
    if os.path.exists(out) and os.path.getsize(out) > 500:
        skip += 1
        return
    for attempt in range(3):
        try:
            comm = edge_tts.Communicate(text=word, voice=VOICE)
            await comm.save(out)
            if os.path.getsize(out) > 500:
                ok += 1
                return
        except Exception as e:
            if attempt == 2:
                fail.append((word, str(e)[:80]))
            await asyncio.sleep(0.5)

async def main():
    tasks = [gen_one(w) for w in gen_words]
    # 分批 gather 避免一次性创建过多协程
    for i in range(0, len(tasks), 200):
        await asyncio.gather(*tasks[i:i+200])

asyncio.run(main())
print(f"[音频] 生成成功={ok} 跳过(已存在)={skip} 失败={len(fail)}")
if fail:
    print("[失败样例]", fail[:10])
# 体积统计
total = sum(os.path.getsize(os.path.join(AUDIO, f)) for f in os.listdir(AUDIO) if f.startswith("cw_"))
print(f"[音频] cw_ 总文件数={sum(1 for f in os.listdir(AUDIO) if f.startswith('cw_'))} 体积≈{total/1024/1024:.1f} MB")
