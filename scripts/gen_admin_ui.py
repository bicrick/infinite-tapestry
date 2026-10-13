"""Pack web/admin_src into web/api/_admin_ui.json. The admin UI ships only from /api/admin after the server confirms the admin."""
import json, pathlib
R = pathlib.Path(__file__).resolve().parents[1] / "web"
def pack():
    s = R / "admin_src"
    return {k: (s / f"admin.{k}").read_text() for k in ("html", "css", "js")}
if __name__ == "__main__":
    (R / "api/_admin_ui.json").write_text(json.dumps(pack()) + "\n"); print("wrote web/api/_admin_ui.json")
