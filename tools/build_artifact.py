"""Markdownの問題集から、アーティファクト用の単一HTML（artifact/index.html）を生成する。"""
import glob, html, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CIRCLED = "①②③④"


def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    return s


def md(text):
    """問題集で使っている範囲（見出し・段落・箇条書き・番号付き・表・引用・太字）だけを変換する。"""
    lines = text.strip("\n").split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", c) for c in cells):
                    rows.append(cells)
                i += 1
            head, body = rows[0], rows[1:]
            t = "<div class=\"tbl\"><table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead><tbody>"
            t += "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body)
            out.append(t + "</tbody></table></div>")
            continue
        m = re.match(r"(#{2,3}) (.*)", line)
        if m:
            lvl = len(m.group(1)) + 1
            out.append(f"<h{lvl}>{inline(m.group(2))}</h{lvl}>")
            i += 1
            continue
        if line.startswith("> "):
            buf = []
            while i < len(lines) and lines[i].startswith(">"):
                buf.append(lines[i].lstrip("> "))
                i += 1
            out.append("<blockquote>" + "<br>".join(inline(b) for b in buf) + "</blockquote>")
            continue
        if re.match(r"\s*(- |\d+\. )", line):
            block = []
            while i < len(lines) and re.match(r"\s*(- |\d+\. )", lines[i]):
                block.append(lines[i])
                i += 1
            out.append(render_list(block))
            continue
        buf = []
        while i < len(lines) and lines[i].strip() and not re.match(r"\s*(- |\d+\. |\||#|> )", lines[i]):
            buf.append(lines[i])
            i += 1
        out.append("<p>" + "<br>".join(inline(b) for b in buf) + "</p>")
    return "\n".join(out)


def render_list(block):
    def indent(l):
        return len(l) - len(l.lstrip())
    base = indent(block[0])
    tag = "ol" if re.match(r"\s*\d+\. ", block[0]) else "ul"
    html_, i = [f"<{tag}>"], 0
    while i < len(block):
        item = re.sub(r"^\s*(- |\d+\. )", "", block[i])
        i += 1
        sub = []
        while i < len(block) and indent(block[i]) > base:
            sub.append(block[i])
            i += 1
        html_.append("<li>" + inline(item) + (render_list(sub) if sub else "") + "</li>")
    return "".join(html_) + f"</{tag}>"


def parse_chapter(path):
    text = open(path, encoding="utf-8").read()
    chap_title = re.search(r"^# (.+)$", text, re.M).group(1)
    num = int(re.match(r"第(\d+)章", chap_title).group(1))
    qs = []
    for sec in re.split(r"^## (?=問題)", text, flags=re.M)[1:]:
        header, rest = sec.split("\n", 1)
        m = re.match(r"問題(\d+-\d+) (.+?)（難易度 (★+☆*)）", header)
        qid, topic, stars = m.groups()
        body, det = rest.split("<details>", 1)
        body = body.strip()
        choices, stem_lines = [], []
        for l in body.split("\n"):
            if re.match(r"① .+　② ", l):
                choices = [c.strip() for c in re.split(r"[①②③④]", l) if c.strip()]
            elif l[:1] in CIRCLED and l[1:2] == " ":
                choices.append(l[2:].strip())
            else:
                stem_lines.append(l)
        det = det.split("</details>")[0]
        det = re.sub(r"<summary>.*?</summary>", "", det)
        ans = re.search(r"\*\*正解：([①②③④])", det).group(1)
        det = re.sub(r"\*\*正解：.*\*\*\n", "", det)
        expl, rel = (det.split("**関連知識**", 1) + [""])[:2]
        expl, example = (expl.split("**実例**", 1) + [""])[:2]
        point = ""
        if "**解説**" in expl:
            point, expl = expl.split("**解説**", 1)
            point = point.replace("**ポイント**", "").strip()
        qs.append({
            "id": qid, "chapter": num, "topic": topic, "level": stars.count("★"),
            "stem": md("\n".join(stem_lines)), "choices": [inline(c) for c in choices],
            "answer": CIRCLED.index(ans), "point": inline(point), "explanation": md(expl), "example": md(example), "related": md(rel),
        })
    return {"num": num, "title": re.sub(r"^第\d+章 ", "", chap_title), "questions": qs}


def parse_essay(path):
    text = open(path, encoding="utf-8").read()
    title = re.search(r"^# 論述問題\d+ (.+)$", text, re.M).group(1)
    prob = text.split("## 問題", 1)[1].split("\n---", 1)[0]
    dets = re.findall(r"<details>\s*<summary>(.*?)</summary>(.*?)</details>", text, re.S)
    return {"title": title, "problem": md(prob), "sections": [{"label": s, "html": md(b)} for s, b in dets]}


def main():
    chapters = [parse_chapter(p) for p in sorted(glob.glob(os.path.join(ROOT, "chapters", "0*.md")))]
    essays = [parse_essay(p) for p in sorted(glob.glob(os.path.join(ROOT, "ronjutsu", "0*.md")))]
    matome = open(os.path.join(ROOT, "matome.md"), encoding="utf-8").read()
    matome = matome.split("\n", 3)[3]  # 見出しと目次リンクを除く
    data = {"chapters": chapters, "essays": essays, "matome": md(matome)}
    tpl = open(os.path.join(ROOT, "tools", "template.html"), encoding="utf-8").read()
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    out = tpl.replace("/*__DATA__*/null", payload)
    open(os.path.join(ROOT, "artifact", "index.html"), "w", encoding="utf-8").write(out)
    print(sum(len(c["questions"]) for c in chapters), "questions,", len(essays), "essays")


if __name__ == "__main__":
    main()
