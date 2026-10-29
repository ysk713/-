"""SQLite による月報データの保存。データはすべて手元の data/geppou.db に置かれる。"""
import os
import sqlite3
from contextlib import contextmanager

import pandas as pd

from . import icd

DB_PATH = os.environ.get("GEPPOU_DB", os.path.join(os.path.dirname(__file__), "..", "data", "geppou.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS reports(
  month TEXT, post TEXT, region TEXT, officer TEXT,
  staff INT, family INT, other INT, total INT,
  source TEXT, note TEXT, hei_text TEXT, summary TEXT,
  PRIMARY KEY(month, post));
CREATE TABLE IF NOT EXISTS diseases(month TEXT, post TEXT, name TEXT, count INT);
CREATE TABLE IF NOT EXISTS events(month TEXT, post TEXT, kind TEXT, keyword TEXT, snippet TEXT);
CREATE TABLE IF NOT EXISTS junkai(month TEXT, from_post TEXT, dest TEXT, period TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS roster(month TEXT, post TEXT, officer TEXT, kana TEXT, staffed INT, note TEXT);
CREATE TABLE IF NOT EXISTS category_overrides(name TEXT PRIMARY KEY, category TEXT);
"""


@contextmanager
def conn():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    try:
        c.executescript(SCHEMA)
        yield c
        c.commit()
    finally:
        c.close()


def load_overrides():
    with conn() as c:
        icd.OVERRIDES.clear()
        icd.OVERRIDES.update(dict(c.execute("SELECT name, category FROM category_overrides").fetchall()))


def set_override(name, category):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO category_overrides VALUES(?,?)", (name, category))
    icd.OVERRIDES[name] = category


def save_report(r):
    """取り込み画面で確認済みの1公館分を保存（同じ月・公館は上書き）。"""
    m, p = r["month"], r["post"]
    with conn() as c:
        c.execute("DELETE FROM reports WHERE month=? AND post=?", (m, p))
        c.execute("DELETE FROM diseases WHERE month=? AND post=?", (m, p))
        c.execute("DELETE FROM events WHERE month=? AND post=?", (m, p))
        c.execute("DELETE FROM junkai WHERE month=? AND (from_post=? OR dest=?) AND note LIKE ?",
                  (m, p, p, f"%[{p}]%"))
        c.execute("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                  (m, p, r["region"], r.get("officer"), r.get("staff"), r.get("family"), r.get("other"),
                   r.get("total"), r.get("filename"), r.get("note", ""), r.get("hei_text", ""), r.get("summary", "")))
        c.executemany("INSERT INTO diseases VALUES(?,?,?,?)",
                      [(m, p, d["name"], d["count"]) for d in r.get("diseases", [])])
        c.executemany("INSERT INTO events VALUES(?,?,?,?,?)",
                      [(m, p, e["kind"], e["keyword"], e["snippet"]) for e in r.get("events", [])])
        # 由来公館を note 末尾に [公館名] で残し、再取り込み時に重複しないようにする
        c.executemany("INSERT INTO junkai VALUES(?,?,?,?,?)",
                      [(m, j["from_post"], j["dest"], j["period"], f"{j['note']} [{p}]")
                       for j in r.get("junkai", [])])


def save_roster(month, rows):
    with conn() as c:
        c.execute("DELETE FROM roster WHERE month=?", (month,))
        c.executemany("INSERT INTO roster VALUES(?,?,?,?,?,?)",
                      [(month, r["post"], r["officer"], r["kana"], int(r["staffed"]), r["note"]) for r in rows])


def df(sql, params=()):
    with conn() as c:
        return pd.read_sql_query(sql, c, params=params)


def execute(sql, params=()):
    with conn() as c:
        c.execute(sql, params)


def months():
    return df("SELECT DISTINCT month FROM reports UNION SELECT DISTINCT month FROM roster ORDER BY 1")["month"].tolist()


def reports(month=None):
    if month:
        return df("SELECT * FROM reports WHERE month=? ORDER BY region, post", (month,))
    return df("SELECT * FROM reports ORDER BY month, region, post")


def diseases(month=None):
    q = "SELECT d.*, r.region FROM diseases d JOIN reports r USING(month, post)"
    d = df(q + (" WHERE d.month=?" if month else ""), (month,) if month else ())
    d["category"] = d["name"].map(icd.classify) if len(d) else []
    return d


def events(month=None):
    return df("SELECT * FROM events" + (" WHERE month=?" if month else ""), (month,) if month else ())


def junkai(month=None):
    return df("SELECT rowid AS id, * FROM junkai" + (" WHERE month=?" if month else "") + " ORDER BY month",
              (month,) if month else ())


def replace_junkai(month, rows):
    with conn() as c:
        c.execute("DELETE FROM junkai WHERE month=?", (month,))
        c.executemany("INSERT INTO junkai VALUES(?,?,?,?,?)",
                      [(month, r["from_post"], r["dest"], r["period"], r["note"]) for r in rows])


def roster(month=None):
    if month is None:
        return df("SELECT * FROM roster ORDER BY month")
    # 指定月以前で最新の配置表を使う
    ms = df("SELECT DISTINCT month FROM roster WHERE month<=? ORDER BY month DESC LIMIT 1", (month,))
    if ms.empty:
        ms = df("SELECT DISTINCT month FROM roster ORDER BY month LIMIT 1")
    if ms.empty:
        return pd.DataFrame(columns=["month", "post", "officer", "kana", "staffed", "note"])
    return df("SELECT * FROM roster WHERE month=?", (ms["month"][0],))


def update_summary(month, post, summary):
    execute("UPDATE reports SET summary=? WHERE month=? AND post=?", (summary, month, post))


def delete_month(month):
    with conn() as c:
        for t in ["reports", "diseases", "events", "junkai", "roster"]:
            c.execute(f"DELETE FROM {t} WHERE month=?", (month,))
