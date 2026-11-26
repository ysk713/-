// 過去の医務官配置表（氏名を含むので合言葉で暗号化。PBKDF2-SHA256 + AES-256-GCM）。
// geppou-app/tools/build_roster_pack.py で作る。合言葉はここにもアプリにも書かない。
window.ROSTER_PACK = null;
