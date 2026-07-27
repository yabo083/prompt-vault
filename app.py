#!/usr/bin/env python3
"""Prompt Vault: file-first prompt themes with explicit immutable commits."""

import os
import secrets
import json
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

from flask import Flask, jsonify, redirect, render_template, request, send_file, url_for

from vault_store import VaultStore


BASE_DIR = Path(__file__).resolve().parent
AUTO_TOKEN = object()


def load_or_create_token(token_file):
    token_file.parent.mkdir(parents=True, exist_ok=True)
    if token_file.exists():
        token = token_file.read_text(encoding="utf-8").strip()
        if token:
            return token
    lock_file = token_file.with_name(f"{token_file.name}.lock")
    lock_fd = None
    for _ in range(1200):
        try:
            lock_fd = os.open(lock_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            try:
                if time.time() - lock_file.stat().st_mtime > 10:
                    lock_file.unlink()
                    continue
            except FileNotFoundError:
                continue
            time.sleep(0.01)
    if lock_fd is None:
        raise RuntimeError(f"could not acquire token lock: {lock_file}")
    try:
        if token_file.exists():
            token = token_file.read_text(encoding="utf-8").strip()
            if token:
                return token
        token = secrets.token_urlsafe(32)
        temporary = token_file.with_name(f".{token_file.name}-{secrets.token_hex(8)}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                stream.write(token + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, token_file)
        finally:
            temporary.unlink(missing_ok=True)
        return token
    finally:
        os.close(lock_fd)
        lock_file.unlink(missing_ok=True)


def json_boolean(data, key, default=False):
    if key not in data:
        return default
    value = data[key]
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be a boolean")
    return value


def json_optional_version(data, key):
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{key} must be a positive integer")
    return value


def query_boolean(name, default=False):
    value = request.args.get(name)
    if value is None:
        return default
    if value.lower() not in {"true", "false"}:
        raise ValueError(f"{name} must be true or false")
    return value.lower() == "true"


def request_json_object():
    if not request.data:
        return {}
    data = request.get_json()
    if not isinstance(data, dict):
        raise ValueError("request JSON must contain an object")
    return data


def create_app(workspace=None, legacy_db=None, token=AUTO_TOKEN):
    app = Flask(__name__, template_folder="templates")
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024
    token_file = Path(os.environ.get("PROMPT_VAULT_TOKEN_FILE", BASE_DIR / ".vault-token"))
    if token is AUTO_TOKEN:
        token = os.environ.get("PROMPT_VAULT_TOKEN", "") or load_or_create_token(token_file)
    app.config["VAULT_TOKEN"] = token
    workspace = Path(workspace or os.environ.get("PROMPT_VAULT_WORKSPACE", BASE_DIR / "workspace"))
    legacy_db = Path(legacy_db or os.environ.get("PROMPT_VAULT_LEGACY_DB", BASE_DIR / "vault.db"))
    store = VaultStore(workspace, legacy_db)
    app.extensions["vault_store"] = store

    @app.before_request
    def protect_api():
        if not request.path.startswith("/api/"):
            return None
        token = app.config["VAULT_TOKEN"]
        if token:
            supplied = request.headers.get("X-Vault-Token", "") or unquote(request.cookies.get("prompt_vault_token", ""))
            authorization = request.headers.get("Authorization", "")
            if authorization.startswith("Bearer "):
                supplied = authorization[7:]
            if not supplied or not secrets.compare_digest(supplied, token):
                return jsonify({"error": "unauthorized", "message": "A valid vault token is required"}), 401
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("Origin")
            if origin:
                parsed = urlsplit(origin)
                origin_host = f"{parsed.scheme}://{parsed.netloc}"
                if origin_host != request.host_url.rstrip("/"):
                    return jsonify({"error": "forbidden_origin", "message": "Cross-origin writes are not allowed"}), 403
        return None

    @app.errorhandler(FileNotFoundError)
    def not_found(error):
        return jsonify({"error": "not_found", "message": str(error)}), 404

    @app.errorhandler(ValueError)
    def invalid_request(error):
        return jsonify({"error": "invalid_request", "message": str(error)}), 400

    @app.errorhandler(413)
    def upload_too_large(error):
        return jsonify({"error": "upload_too_large", "message": "Upload limit is 64 MB"}), 413

    @app.get("/")
    def index():
        manifest_path = BASE_DIR / "static" / "dist" / ".vite" / "manifest.json"
        entry = {}
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            entry = manifest.get("index.html", {})
        return render_template(
            "index.html",
            frontend_script=entry.get("file", "assets/prompt-vault.js"),
            frontend_styles=entry.get("css", ["assets/index.css"]),
        )

    @app.get("/assets/<path:filename>")
    def frontend_dynamic_asset(filename):
        # The G6 React extension resolves its React 18 fallback chunks from /assets.
        return redirect(url_for("static", filename=f"dist/assets/{filename}"))

    @app.get("/api/themes")
    def list_themes():
        return jsonify(store.list_themes(request.args.get("q", "")))

    @app.post("/api/themes")
    def create_theme():
        data = request_json_object()
        return jsonify(store.create_theme(data, actor=data.get("actor", "user"))), 201

    @app.get("/api/themes/<slug>")
    def get_theme(slug):
        return jsonify(store.get_theme(slug))

    @app.put("/api/themes/<slug>")
    def update_theme(slug):
        data = request_json_object()
        return jsonify(store.update_theme(slug, data, actor=data.get("actor", "user")))

    @app.delete("/api/themes/<slug>")
    def delete_theme(slug):
        store.delete_theme(slug)
        return "", 204

    @app.post("/api/themes/<slug>/star")
    def toggle_star(slug):
        theme = store.get_theme(slug)
        return jsonify(store.update_theme(
            slug,
            {"starred": not theme.get("starred"), "change_note": "Updated favorite status"},
        ))

    @app.post("/api/themes/<slug>/duplicate")
    def duplicate_theme(slug):
        return jsonify(store.duplicate_theme(slug)), 201

    @app.post("/api/themes/<slug>/archive")
    def toggle_archive(slug):
        theme = store.get_theme(slug)
        archived = not theme.get("archived", False)
        return jsonify(store.update_theme(slug, {
            "archived": archived,
            "change_note": "Archived theme" if archived else "Restored theme",
        }))

    @app.post("/api/themes/<slug>/commits")
    def commit_theme(slug):
        data = request_json_object()
        return jsonify(store.commit_theme(
            slug,
            data.get("message"),
            data.get("actor", "user"),
            data.get("tag"),
            data.get("parents") if "parents" in data else None,
        )), 201

    @app.post("/api/themes/<slug>/grow")
    def grow_theme(slug):
        try:
            data = json.loads(request.form.get("draft", ""))
        except json.JSONDecodeError as error:
            raise ValueError("draft must contain valid JSON") from error
        if not isinstance(data, dict):
            raise ValueError("draft must contain an object")
        return jsonify(store.grow_theme(
            slug,
            data.get("change_note"),
            data.get("parents"),
            data,
            {
                "reference": [item for item in request.files.getlist("reference_files") if item.filename],
                "result": [item for item in request.files.getlist("result_files") if item.filename],
            },
            data.get("actor", "user"),
            data.get("tag"),
            json_boolean(data, "force"),
        )), 201

    @app.post("/api/themes/<slug>/branches")
    def create_branch(slug):
        data = request_json_object()
        return jsonify(store.create_branch(
            slug,
            data.get("name"),
            json_optional_version(data, "from_version"),
            json_boolean(data, "checkout", True),
            json_boolean(data, "force"),
        )), 201

    @app.post("/api/themes/<slug>/branches/<path:branch>/move")
    def move_branch(slug, branch):
        data = request_json_object()
        version = json_optional_version(data, "version")
        if version is None:
            raise ValueError("version is required")
        return jsonify(store.move_branch(slug, branch, version, json_boolean(data, "force")))

    @app.delete("/api/themes/<slug>/branches/<path:branch>")
    def delete_branch(slug, branch):
        return jsonify(store.delete_branch(slug, branch))

    @app.post("/api/themes/<slug>/checkout")
    def checkout_branch(slug):
        data = request_json_object()
        return jsonify(store.checkout_branch(slug, data.get("branch"), json_boolean(data, "force")))

    @app.post("/api/themes/<slug>/discard")
    def discard_working(slug):
        return jsonify(store.discard_working(slug))

    @app.post("/api/themes/<slug>/versions/<int:version>/checkout")
    def checkout_version(slug, version):
        data = request_json_object()
        return jsonify(store.checkout_version(slug, version, json_boolean(data, "force")))

    @app.post("/api/themes/<slug>/tags")
    def create_tag(slug):
        data = request_json_object()
        return jsonify(store.create_tag(slug, data.get("name"), json_optional_version(data, "version"))), 201

    @app.delete("/api/themes/<slug>/tags/<path:name>")
    def delete_tag(slug, name):
        return jsonify(store.delete_tag(slug, name))

    @app.post("/api/themes/<slug>/assets")
    def upload_asset(slug):
        kind = request.form.get("kind", "reference")
        files = request.files.getlist("files") or request.files.getlist("file")
        if not files or not files[0].filename:
            raise ValueError("at least one image file is required")
        return jsonify(store.save_uploads(slug, kind, [item for item in files if item.filename])), 201

    @app.delete("/api/themes/<slug>/assets/<kind>/<path:filename>")
    def delete_asset(slug, kind, filename):
        store.delete_asset(slug, kind, filename)
        return "", 204

    @app.get("/api/themes/<slug>/files/<kind>/<path:filename>")
    def current_asset(slug, kind, filename):
        return send_file(store.current_asset_path(slug, kind, filename), conditional=True)

    @app.get("/api/themes/<slug>/versions")
    def list_versions(slug):
        return jsonify(store.list_versions(slug))

    @app.get("/api/themes/<slug>/versions/<int:version>")
    def get_version(slug, version):
        return jsonify(store.get_version(slug, version))

    @app.post("/api/themes/<slug>/versions/<int:version>/marks")
    def update_version_marks(slug, version):
        return jsonify(store.update_version_marks(slug, version, request_json_object()))

    @app.put("/api/themes/<slug>/versions/<int:version>")
    def update_version(slug, version):
        if request.mimetype and request.mimetype.startswith("multipart/form-data"):
            try:
                data = json.loads(request.form.get("draft", ""))
            except json.JSONDecodeError as error:
                raise ValueError("draft must contain valid JSON") from error
            if not isinstance(data, dict):
                raise ValueError("draft must contain an object")
            uploads = {
                "reference": [item for item in request.files.getlist("reference_files") if item.filename],
                "result": [item for item in request.files.getlist("result_files") if item.filename],
            }
            replace_assets = {
                kind for kind in uploads
                if uploads[kind] or json_boolean(data, f"replace_{kind}") or f"{kind}_order" in data
            }
            return jsonify(store.update_version(
                slug,
                version,
                data,
                data.get("actor", "user"),
                uploads,
                replace_assets,
            ))
        data = request_json_object()
        return jsonify(store.update_version(slug, version, data, data.get("actor", "user")))

    @app.delete("/api/themes/<slug>/versions/<int:version>")
    def delete_version(slug, version):
        return jsonify(store.delete_version(slug, version, query_boolean("force")))

    @app.get("/api/themes/<slug>/versions/<int:version>/files/<kind>/<path:filename>")
    def version_asset(slug, version, kind, filename):
        return send_file(store.version_asset_path(slug, version, kind, filename), conditional=True)

    @app.get("/api/themes/<slug>/compare")
    def compare_versions(slug):
        left = request.args.get("left", type=int)
        right = request.args.get("right", type=int)
        if left is None or right is None or left == right:
            raise ValueError("left and right must be two different version numbers")
        return jsonify(store.compare(slug, left, right))

    @app.get("/api/stats")
    def stats():
        themes = store.list_themes()
        return jsonify({
            "themes": len(themes),
            "active": sum(1 for item in themes if not item.get("archived")),
            "archived": sum(1 for item in themes if item.get("archived")),
            "starred": sum(1 for item in themes if item.get("starred") or item.get("has_favorite_versions")),
            "versions": sum(item.get("version_count", 0) for item in themes),
            "references": sum(len(item["assets"]["reference"]) for item in themes),
            "results": sum(len(item["assets"]["result"]) for item in themes),
        })

    @app.get("/api/export")
    def export_all():
        return jsonify({
            "format": "prompt-vault/themes/v1",
            "themes": store.list_themes(),
        })

    @app.get("/api/agent/schema")
    def agent_schema():
        return jsonify({
            "format": "prompt-vault/agent/v3",
            "workspace": str(store.root),
            "theme_layout": {
                "theme.json": "global theme metadata plus the current branch's model and params",
                "prompt.md": "current positive prompt; write this file directly",
                "negative.md": "current negative prompt",
                "notes.md": "working notes and decisions",
                "references/": "prompt reference images",
                "outputs/": "generated result images",
                "refs.json": "branches, editable working_base, SemVer tags, node marks, hidden nodes, and the monotonic internal id counter; managed by Prompt Vault",
                "history/": "immutable explicit commits managed by Prompt Vault",
            },
            "version_semantics": {
                "global_metadata": "title, description, category, theme tags, starred, archived, and reference_urls are shared across branches and never create commits",
                "branch_content": "prompt, negative prompt, notes, model, params, references, and outputs are committed and restored per branch",
                "legacy_import": "a migrated legacy database record receives one baseline commit because it was already a saved record before migration",
                "labels": "internal node numbers are stable locators; user-facing releases use optional vX.Y.Z tags",
                "arbitrary_node_editing": "working_base identifies the commit loaded into the editable working tree; committing from a non-head base creates a unique fork-* branch automatically",
                "multi_parent_nodes": "parents is an ordered array of source node numbers; parent remains the first source for legacy clients",
            },
            "write_contract": [
                "Create themes with POST /api/themes or create the documented files in a new folder.",
                "Edit current Markdown files and copy images into references/ or outputs/. These edits only change the working tree.",
                "Never edit history/ or .assets/.",
                "Use POST /api/themes/{slug}/grow for an atomic parent-based edit with optional image uploads; use /commits only when the user explicitly asks to archive the current working tree.",
                "Use hidden=true for routine cleanup; permanently delete only leaf commits after checking descendants and refs.",
            ],
            "endpoints": {
                "list_themes": "GET /api/themes?q=optional",
                "get_theme": "GET /api/themes/{slug}",
                "create_theme": "POST /api/themes",
                "update_theme": "PUT /api/themes/{slug}",
                "star_theme": "POST /api/themes/{slug}/star",
                "archive_theme": "POST /api/themes/{slug}/archive",
                "duplicate_theme": "POST /api/themes/{slug}/duplicate",
                "upload": "POST multipart /api/themes/{slug}/assets; kind=reference|result; files=@image",
                "commit": "POST /api/themes/{slug}/commits with {message, actor, tag?, parents?: number[]}",
                "grow": "POST multipart /api/themes/{slug}/grow with draft JSON plus reference_files/result_files; rejects dirty work unless force=true",
                "branch": "POST /api/themes/{slug}/branches with {name, from_version?, checkout?}",
                "checkout": "POST /api/themes/{slug}/checkout with {branch, force?}",
                "checkout_version": "POST /api/themes/{slug}/versions/{version}/checkout with {force?}",
                "discard_working": "POST /api/themes/{slug}/discard restores the working tree to working_base without deleting history",
                "move_branch": "POST /api/themes/{slug}/branches/{branch}/move with {version, force?}",
                "delete_branch": "DELETE /api/themes/{slug}/branches/{branch}",
                "tag": "POST /api/themes/{slug}/tags with {name, version?}",
                "delete_tag": "DELETE /api/themes/{slug}/tags/{name}",
                "mark_commit": "POST /api/themes/{slug}/versions/{version}/marks with featured/favorite/hidden booleans",
                "update_commit": "PUT /api/themes/{slug}/versions/{version} with change_note/prompt/negative/notes/model/params",
                "delete_leaf_commit": "DELETE /api/themes/{slug}/versions/{version}?force=false",
                "versions": "GET /api/themes/{slug}/versions",
                "get_version": "GET /api/themes/{slug}/versions/{version}",
                "compare": "GET /api/themes/{slug}/compare?left=1&right=2",
                "scan": "POST /api/agent/sync returns dirty working trees without committing them",
            },
        })

    @app.post("/api/agent/sync")
    def agent_sync():
        dirty = store.scan_workspaces()
        return jsonify({"dirty": dirty, "count": len(dirty), "errors": store.scan_errors})

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8767, debug=False)
