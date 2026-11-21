"""音声要約サーバー（Mac mini で常駐させる）

- ブラウザから音声をアップロード（または録音）→ Mac mini 上の Whisper で文字起こし
- 文字起こし結果を画面で確認・修正してもらい、「送る」操作があってから
  そのテキストだけを Claude API に送って要約（会議=議事録 / 診察=SOAP）
- 音声ファイルは文字起こしが終わるまで一時ファイルとして置き、終わったらすぐ削除する
- 文字起こし・要約の結果はメモリ上にだけ持ち、ファイルには書かない
"""

import os
import secrets
import tempfile
import threading
import time
import uuid
from pathlib import Path

import anthropic
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from prompts import SYSTEM_PROMPTS

BASE_DIR = Path(__file__).resolve().parent
APP_USER = os.environ.get("APP_USER", "doctor")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "500"))
JOB_TTL_SEC = 6 * 60 * 60  # 結果は6時間でメモリから消える（ファイルには書かない）
MAX_TRANSCRIPT_CHARS = 400_000  # 確認画面から送り返される文字起こしの上限

# ログイン失敗の制限：FAIL_WINDOW 秒の間に FAIL_LIMIT 回失敗したら、LOCK_SEC 秒は
# 正しいパスワードでも入れなくする（総当たりでパスワードを当てられないようにするため）。
# Tailscale Funnel 等の経由では接続元を確かめられないため、接続元を区別せず全体で数える。
FAIL_LIMIT = int(os.environ.get("LOGIN_FAIL_LIMIT", "10"))
FAIL_WINDOW = 10 * 60
LOCK_SEC = int(os.environ.get("LOGIN_LOCK_MIN", "15")) * 60

if not APP_PASSWORD:
    raise SystemExit("APP_PASSWORD が未設定です。.env を確認してください。")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
security = HTTPBasic()
client = anthropic.Anthropic()  # ANTHROPIC_API_KEY を環境変数から読む

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
work_lock = threading.Lock()  # 文字起こしは重いので1件ずつ処理する


auth_lock = threading.Lock()
_fail_times: list[float] = []
_locked_until = 0.0


def require_auth(cred: HTTPBasicCredentials = Depends(security)) -> None:
    global _locked_until
    now = time.time()
    with auth_lock:
        if now < _locked_until:
            mins = int((_locked_until - now) // 60) + 1
            raise HTTPException(
                429, f"ログインの失敗が続いたため、あと約{mins}分ログインできません。"
            )
    ok_user = secrets.compare_digest(cred.username.encode(), APP_USER.encode())
    ok_pass = secrets.compare_digest(cred.password.encode(), APP_PASSWORD.encode())
    if ok_user and ok_pass:
        return
    with auth_lock:
        _fail_times[:] = [t for t in _fail_times if now - t < FAIL_WINDOW]
        _fail_times.append(now)
        if len(_fail_times) >= FAIL_LIMIT:
            _locked_until = now + LOCK_SEC
            _fail_times.clear()
            print(f"[auth] ログイン失敗が {FAIL_LIMIT} 回続いたため {LOCK_SEC // 60} 分ロックしました", flush=True)
    time.sleep(1)  # 失敗時は少し待たせる
    raise HTTPException(401, "認証に失敗しました", headers={"WWW-Authenticate": "Basic"})


# ---------- 文字起こし ----------

_whisper = None


def _load_whisper():
    """Apple Silicon なら mlx-whisper（高速）、それ以外は faster-whisper を使う。"""
    global _whisper
    if _whisper is not None:
        return _whisper
    try:
        import mlx_whisper  # noqa: F401

        repo = {
            "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
            "large-v3": "mlx-community/whisper-large-v3-mlx",
        }.get(WHISPER_MODEL, WHISPER_MODEL)
        _whisper = ("mlx", repo)
    except ImportError:
        from faster_whisper import WhisperModel

        _whisper = ("faster", WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8"))
    return _whisper


def _fmt(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def transcribe(path: str, hint: str) -> str:
    kind, model = _load_whisper()
    prompt = hint or None
    lines = []
    if kind == "mlx":
        import mlx_whisper

        result = mlx_whisper.transcribe(
            path, path_or_hf_repo=model, language="ja", initial_prompt=prompt
        )
        for seg in result.get("segments", []):
            lines.append(f"[{_fmt(seg['start'])}] {seg['text'].strip()}")
    else:
        segments, _ = model.transcribe(
            path, language="ja", vad_filter=True, initial_prompt=prompt
        )
        for seg in segments:
            lines.append(f"[{_fmt(seg.start)}] {seg.text.strip()}")
    return "\n".join(line for line in lines if line.split("] ", 1)[-1])


# ---------- 要約 ----------


def summarize(transcript: str, mode: str, note: str) -> str:
    user_text = f"<transcript>\n{transcript}\n</transcript>"
    if note:
        user_text += f"\n\n<note>\n{note}\n</note>"
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=32000,
        system=SYSTEM_PROMPTS[mode],
        output_config={"effort": "high"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": user_text}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        detail = getattr(msg, "stop_details", None)
        raise RuntimeError(f"要約が拒否されました（{getattr(detail, 'category', '不明')}）")
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    if msg.stop_reason == "max_tokens":
        text += "\n\n（※ 長さの上限で要約が途中で切れています）"
    return text


# ---------- ジョブ ----------


def _set(job_id: str, **kw) -> None:
    with jobs_lock:
        jobs[job_id].update(kw)


def run_transcribe(job_id: str, path: str, hint: str) -> None:
    """文字起こしだけを行う。Claude への送信は、利用者が確認画面で「送る」を押してから。"""
    try:
        _set(job_id, status="waiting", message="順番待ち中…")
        with work_lock:
            _set(job_id, status="transcribing", message="文字起こし中（録音時間の数分の1程度かかります）…")
            transcript = transcribe(path, hint)
        try:
            os.remove(path)  # 音声はすぐ削除
        except OSError:
            pass
        if not transcript.strip():
            raise RuntimeError("音声から文字を読み取れませんでした。")
        _set(job_id, transcript=transcript, status="transcribed",
             message="文字起こしが終わりました。内容を確認してください（まだ Claude には送っていません）。")
    except Exception as e:  # noqa: BLE001 — 画面にエラー内容を出すため
        _set(job_id, status="error", message=f"エラー: {e}")
    finally:
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass


def run_summarize(job_id: str, transcript: str, mode: str, note: str) -> None:
    try:
        summary = summarize(transcript, mode, note)
        _set(job_id, summary=summary, status="done", message="完了")
    except Exception as e:  # noqa: BLE001 — 画面にエラー内容を出すため
        _set(job_id, status="summarize_error", message=f"要約でエラー: {e}")


def _cleanup() -> None:
    now = time.time()
    with jobs_lock:
        for jid in [j for j, v in jobs.items() if now - v["created"] > JOB_TTL_SEC]:
            del jobs[jid]


# ---------- API ----------


@app.get("/", dependencies=[Depends(require_auth)])
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.post("/api/jobs", dependencies=[Depends(require_auth)])
async def create_job(
    audio: UploadFile = File(...),
    mode: str = Form("meeting"),
    hint: str = Form(""),
):
    if mode not in SYSTEM_PROMPTS:
        raise HTTPException(400, "mode が不正です")
    _cleanup()
    suffix = Path(audio.filename or "audio").suffix or ".webm"
    fd, path = tempfile.mkstemp(prefix="vs_", suffix=suffix)
    size = 0
    with os.fdopen(fd, "wb") as f:
        while chunk := await audio.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                f.close()
                os.remove(path)
                raise HTTPException(413, f"ファイルが大きすぎます（上限 {MAX_UPLOAD_MB}MB）")
            f.write(chunk)
    job_id = uuid.uuid4().hex
    with jobs_lock:
        jobs[job_id] = {
            "created": time.time(), "mode": mode, "status": "queued",
            "message": "受付済み", "transcript": "", "summary": "",
        }
    threading.Thread(target=run_transcribe, args=(job_id, path, hint[:500]), daemon=True).start()
    return {"id": job_id}


@app.post("/api/jobs/{job_id}/summarize", dependencies=[Depends(require_auth)])
def start_summarize(job_id: str, transcript: str = Form(...), note: str = Form("")):
    """確認画面で利用者が見て（必要なら直して）「送る」を押した文字起こしだけを Claude に送る。"""
    transcript = transcript.strip()
    if not transcript:
        raise HTTPException(400, "文字起こしが空です")
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        raise HTTPException(413, "文字起こしが長すぎます")
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "見つかりません（6時間経過したか、サーバーが再起動しました）")
        if job["status"] not in ("transcribed", "summarize_error", "done"):
            raise HTTPException(409, "まだ要約できる状態ではありません")
        job.update(transcript=transcript, summary="", status="summarizing", message="要約中…")
        mode = job["mode"]
    threading.Thread(target=run_summarize, args=(job_id, transcript, mode, note[:2000]), daemon=True).start()
    return {"ok": True}


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def get_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "見つかりません（6時間経過したか、サーバーが再起動しました）")
        return {k: v for k, v in job.items() if k != "created"}


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def delete_job(job_id: str):
    with jobs_lock:
        jobs.pop(job_id, None)
    return {"ok": True}
