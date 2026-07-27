import hashlib
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import unicodedata
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlsplit
from uuid import uuid4


TEXT_FILES = {"prompt": "prompt.md", "negative": "negative.md", "notes": "notes.md"}
ASSET_DIRS = {"reference": "references", "result": "outputs"}
ALLOWED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}
SAFE_SLUG = re.compile(r"^[\w\u4e00-\u9fff-]{1,64}$", flags=re.UNICODE)
SAFE_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$")
SEMVER_TAG = re.compile(r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$")
THEME_STATUSES = {"active"}


def timestamp():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def slugify(value):
    normalized = unicodedata.normalize("NFKC", value or "theme").strip().lower()
    slug = re.sub(r"[^\w\u4e00-\u9fff]+", "-", normalized, flags=re.UNICODE).strip("-_")
    return slug[:64] or "theme"


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_type(path):
    with path.open("rb") as handle:
        header = handle.read(16)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "webp"
    if len(header) >= 12 and header[4:12] in {b"ftypavif", b"ftypavis"}:
        return "avif"
    return None


class VaultStore:
    def __init__(self, root, legacy_db=None):
        self.root = Path(root)
        self.blobs = self.root / ".assets"
        self.trash = self.root / ".trash"
        self.lock = threading.RLock()
        self.scan_errors = {}
        self.root.mkdir(parents=True, exist_ok=True)
        self.blobs.mkdir(exist_ok=True)
        self.trash.mkdir(exist_ok=True)
        if legacy_db:
            self.migrate_legacy(Path(legacy_db))

    def _theme_dir(self, slug):
        if not slug or not SAFE_SLUG.fullmatch(slug):
            raise ValueError("invalid theme slug")
        path = (self.root / slug).resolve()
        if path.parent != self.root.resolve() or not path.is_dir():
            raise FileNotFoundError(slug)
        return path

    def _new_slug(self, title):
        base = slugify(title)
        candidate = base
        suffix = 2
        while (self.root / candidate).exists():
            candidate = f"{base}-{suffix}"
            suffix += 1
        return candidate

    def _read_json(self, path, default=None, strict=False):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return default if default is not None else {}
        except json.JSONDecodeError as error:
            if strict:
                raise ValueError(f"invalid JSON in {path}: {error.msg}") from error
            return default if default is not None else {}

    def _theme_meta(self, theme_dir):
        meta = self._read_json(theme_dir / "theme.json", {}, strict=True)
        if not isinstance(meta, dict):
            raise ValueError(f"theme.json must contain an object: {theme_dir / 'theme.json'}")
        return {
            **meta,
            "slug": theme_dir.name,
            "title": str(meta.get("title") or theme_dir.name),
            "description": str(meta.get("description") or ""),
            "category": str(meta.get("category") or "未分类"),
            "tags": self._tags(meta.get("tags", [])),
            "starred": bool(meta.get("starred", False)),
            "status": "active",
            "archived": bool(meta.get("archived", False)),
            "model": str(meta.get("model") or ""),
            "params": str(meta.get("params") or ""),
            "reference_urls": self._reference_urls(meta.get("reference_urls", [])),
            "legacy": meta.get("legacy") if isinstance(meta.get("legacy"), dict) else {},
        }

    def _read_texts(self, directory):
        return {
            key: (directory / filename).read_text(encoding="utf-8") if (directory / filename).exists() else ""
            for key, filename in TEXT_FILES.items()
        }

    def _asset_records(self, theme_dir, created_blobs=None):
        assets = {kind: [] for kind in ASSET_DIRS}
        for kind, dirname in ASSET_DIRS.items():
            directory = theme_dir / dirname
            directory.mkdir(exist_ok=True)
            for path in sorted(directory.iterdir(), key=lambda item: item.name.lower()):
                if path.is_symlink() or not path.is_file() or path.suffix.lower() not in ALLOWED_IMAGE_EXTENSIONS:
                    continue
                assets[kind].append(self._publish_blob(path, path.name, created_blobs))
        return assets

    def _publish_blob(self, path, name, created_blobs=None):
        digest = file_hash(path)
        blob_dir = self.blobs / digest[:2]
        blob_dir.mkdir(exist_ok=True)
        blob = blob_dir / f"{digest}{path.suffix.lower()}"
        if not blob.exists():
            temporary_blob = blob_dir / f".{blob.name}-{uuid4().hex}.tmp"
            try:
                shutil.copy2(path, temporary_blob)
                if file_hash(temporary_blob) != digest:
                    raise OSError(f"blob verification failed: {name}")
                try:
                    os.link(temporary_blob, blob)
                except FileExistsError:
                    pass
                else:
                    if created_blobs is not None:
                        created_blobs.add(blob.resolve())
            finally:
                temporary_blob.unlink(missing_ok=True)
        return {
            "name": name,
            "sha256": digest,
            "size": path.stat().st_size,
            "mime": mimetypes.guess_type(name)[0] or "application/octet-stream",
        }

    def _version_upload_records(self, theme_dir, storages, created_blobs):
        upload_dir = theme_dir / f".version-uploads-{uuid4().hex}"
        upload_dir.mkdir()
        records = []
        names = set()
        try:
            for storage in storages:
                original = Path(storage.filename or "image").name
                extension = Path(original).suffix.lower()
                if extension not in ALLOWED_IMAGE_EXTENSIONS:
                    raise ValueError(f"unsupported image type: {original}")
                safe_stem = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", Path(original).stem, flags=re.UNICODE).strip(".-") or "image"
                filename = f"{safe_stem[:80]}{extension}"
                if filename in names:
                    filename = f"{safe_stem[:70]}-{uuid4().hex[:8]}{extension}"
                names.add(filename)
                temporary = upload_dir / f"{uuid4().hex}{extension}"
                storage.save(temporary)
                detected = image_type(temporary)
                expected = "jpeg" if extension in {".jpg", ".jpeg"} else extension[1:]
                if detected != expected:
                    raise ValueError(f"file content is not a valid {expected} image: {original}")
                records.append(self._publish_blob(temporary, filename, created_blobs))
            return records
        finally:
            shutil.rmtree(upload_dir, ignore_errors=True)

    @staticmethod
    def _ordered_asset_records(existing, uploaded, order):
        if order is None:
            return uploaded
        if not isinstance(order, list):
            raise ValueError("asset order must be an array")
        records = []
        seen = set()
        sources = {"existing": existing, "upload": uploaded}
        for item in order:
            if not isinstance(item, dict) or item.get("source") not in sources:
                raise ValueError("asset order entries require an existing or upload source")
            index = item.get("index")
            if isinstance(index, bool) or not isinstance(index, int) or index < 0 or index >= len(sources[item["source"]]):
                raise ValueError("asset order index is out of range")
            key = (item["source"], index)
            if key in seen:
                raise ValueError("asset order entries must be unique")
            seen.add(key)
            records.append(dict(sources[item["source"]][index]))
        return records

    def _working_payload(self, theme_dir, created_blobs=None):
        meta = self._theme_meta(theme_dir)
        version_meta = {"model": meta["model"], "params": meta["params"]}
        texts = self._read_texts(theme_dir)
        assets = self._asset_records(theme_dir, created_blobs)
        digest = self._content_digest(version_meta, texts, assets)
        return version_meta, texts, assets, digest

    @staticmethod
    def _content_digest(meta, texts, assets):
        canonical = json.dumps(
            {"meta": meta, "texts": texts, "assets": assets},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @staticmethod
    def _manifest_integrity(manifest, texts):
        protected = {key: value for key, value in manifest.items() if key != "integrity"}
        canonical = json.dumps(
            {"manifest": protected, "texts": texts},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _commit_dirs(self, theme_dir):
        history = theme_dir / "history"
        history.mkdir(exist_ok=True)
        return sorted(
            [path for path in history.iterdir() if path.is_dir() and path.name.isdigit()],
            key=lambda path: int(path.name),
        )

    def _refs(self, theme_dir):
        path = theme_dir / "refs.json"
        if not path.exists():
            commits = self._commit_dirs(theme_dir)
            branches = {}
            records = []
            for commit_path in commits:
                manifest = self._read_json(commit_path / "manifest.json", {}, strict=True)
                version = int(manifest.get("version") or commit_path.name)
                branch = manifest.get("branch") or "main"
                branches[branch] = version
                records.append((version, branch, manifest, self._read_texts(commit_path)))
            if not branches:
                branches = {"main": None}
            current_branch = records[-1][1] if records else "main"
            if records:
                _, _, _, working_digest = self._working_payload(theme_dir)
                for version, branch, manifest, texts in reversed(records):
                    if branches.get(branch) == version and self._version_creative_digest(manifest, texts) == working_digest:
                        current_branch = branch
                        break
            next_version = max((record[0] for record in records), default=0) + 1
            refs = {
                "current_branch": current_branch,
                "branches": branches,
                "working_base": branches.get(current_branch),
                "tags": {},
                "featured_commits": [],
                "favorite_commits": [],
                "hidden_commits": [],
                "next_version": next_version,
            }
            atomic_write(path, json.dumps(refs, ensure_ascii=False, indent=2) + "\n")
        else:
            refs = self._read_json(path, {}, strict=True)
        if not isinstance(refs, dict) or not isinstance(refs.get("branches"), dict):
            raise ValueError(f"refs.json is invalid: {path}")
        if not isinstance(refs.get("tags", {}), dict):
            raise ValueError(f"refs.json tags are invalid: {path}")
        current = refs.get("current_branch") or "main"
        refs["current_branch"] = current
        refs["branches"].setdefault(current, None)
        working_base = refs.get("working_base", refs["branches"].get(current))
        if working_base is not None:
            if isinstance(working_base, bool) or not isinstance(working_base, int):
                raise ValueError(f"refs.json working_base is invalid: {path}")
            self._read_commit(theme_dir, working_base)
        refs["working_base"] = working_base
        refs.setdefault("tags", {})
        for key in ("featured_commits", "favorite_commits", "hidden_commits"):
            if not isinstance(refs.get(key, []), list):
                raise ValueError(f"refs.json {key} is invalid: {path}")
            refs.setdefault(key, [])
        max_version = max((int(path.name) for path in self._commit_dirs(theme_dir)), default=0)
        next_version = refs.get("next_version", max_version + 1)
        if isinstance(next_version, bool) or not isinstance(next_version, int) or next_version <= max_version:
            next_version = max_version + 1
        refs["next_version"] = next_version
        return refs

    def _write_refs(self, theme_dir, refs):
        atomic_write(theme_dir / "refs.json", json.dumps(refs, ensure_ascii=False, indent=2) + "\n")

    def _version_creative_digest(self, manifest, texts):
        meta = manifest.get("meta", {})
        creative_meta = {"model": str(meta.get("model") or ""), "params": str(meta.get("params") or "")}
        return self._content_digest(creative_meta, texts, manifest.get("assets", {}))

    def _is_dirty(self, theme_dir, refs, working_digest=None):
        if working_digest is None:
            _, _, _, working_digest = self._working_payload(theme_dir)
        base = refs.get("working_base")
        if base is None:
            meta, texts, assets, _ = self._working_payload(theme_dir)
            return bool(meta["model"] or meta["params"] or any(texts.values()) or any(assets.values()))
        commit = self._read_commit(theme_dir, base)
        return working_digest != self._version_creative_digest(commit["manifest"], commit["texts"])

    def _read_commit(self, theme_dir, version):
        path = theme_dir / "history" / f"{int(version):04d}"
        if not path.is_dir():
            raise FileNotFoundError(version)
        manifest = self._read_json(path / "manifest.json", {}, strict=True)
        texts = self._read_texts(path)
        expected = self._content_digest(manifest.get("meta", {}), texts, manifest.get("assets", {}))
        if expected != manifest.get("digest"):
            raise ValueError(f"history version {version} failed integrity verification")
        if self._manifest_integrity(manifest, texts) != manifest.get("integrity"):
            raise ValueError(f"history version {version} provenance failed integrity verification")
        return {"path": path, "manifest": manifest, "texts": texts}

    def create_theme(self, data, actor="user", initial_commit=False):
        with self.lock:
            title = str(data.get("title") or "未命名主题").strip()
            slug = self._new_slug(data.get("slug") or title)
            theme_dir = self.root / slug
            theme_dir.mkdir()
            for dirname in (*ASSET_DIRS.values(), "history"):
                (theme_dir / dirname).mkdir()
            now = timestamp()
            meta = {
                "slug": slug,
                "title": title,
                "description": str(data.get("description") or "").strip(),
                "category": str(data.get("category") or "未分类").strip(),
                "tags": self._tags(data.get("tags", [])),
                "starred": bool(data.get("starred", False)),
                "status": "active",
                "archived": bool(data.get("archived", False)),
                "model": str(data.get("model") or "").strip(),
                "params": str(data.get("params") or "").strip(),
                "reference_urls": self._reference_urls(data.get("reference_urls") or []),
                "legacy": data.get("legacy") if isinstance(data.get("legacy"), dict) else {},
                "created_at": data.get("created_at") or now,
                "updated_at": data.get("updated_at") or now,
                "last_actor": actor,
            }
            atomic_write(theme_dir / "theme.json", json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
            refs = {
                "current_branch": "main",
                "branches": {"main": None},
                "working_base": None,
                "tags": {},
                "featured_commits": [],
                "favorite_commits": [],
                "hidden_commits": [],
                "next_version": 1,
            }
            atomic_write(theme_dir / "refs.json", json.dumps(refs, indent=2) + "\n")
            for key, filename in TEXT_FILES.items():
                atomic_write(theme_dir / filename, str(data.get(key) or ""))
            if initial_commit:
                self.commit_theme(slug, data.get("change_note"), actor)
            return self.get_theme(slug)

    def update_theme(self, slug, data, actor="user"):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            meta = self._theme_meta(theme_dir)
            for key in ("title", "description", "category", "model", "params"):
                if key in data:
                    meta[key] = str(data.get(key) or "").strip()
            if "tags" in data:
                meta["tags"] = self._tags(data.get("tags"))
            if "starred" in data:
                meta["starred"] = bool(data.get("starred"))
            if "status" in data:
                if data.get("status") not in THEME_STATUSES:
                    raise ValueError("invalid theme status")
                meta["status"] = data["status"]
            if "archived" in data:
                meta["archived"] = bool(data.get("archived"))
            meta["updated_at"] = timestamp()
            meta["last_actor"] = actor
            text_updates = {
                key: str(data.get(key) or "")
                for key in TEXT_FILES
                if key in data
            }

            staging = theme_dir / f".update-{uuid4().hex}.tmp"
            backup = theme_dir / f".update-{uuid4().hex}.bak"
            staging.mkdir()
            backup.mkdir()
            names = ["theme.json", *(TEXT_FILES[key] for key in text_updates)]
            backed_up = []
            installed = []
            try:
                atomic_write(staging / "theme.json", json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
                for key, value in text_updates.items():
                    atomic_write(staging / TEXT_FILES[key], value)
                for name in names:
                    current = theme_dir / name
                    if current.exists():
                        current.replace(backup / name)
                        backed_up.append(name)
                for name in names:
                    (staging / name).replace(theme_dir / name)
                    installed.append(name)
            except Exception:
                for name in installed:
                    current = theme_dir / name
                    if current.exists():
                        current.unlink()
                for name in backed_up:
                    saved = backup / name
                    if saved.exists():
                        saved.replace(theme_dir / name)
                raise
            finally:
                shutil.rmtree(staging, ignore_errors=True)
                shutil.rmtree(backup, ignore_errors=True)
            return self.get_theme(slug)

    def commit_theme(self, slug, message, actor="user", tag=None, parents=None, created_blobs=None, asset_orders=None, uploaded_names=None):
        with self.lock:
            message = str(message or "").strip()
            theme_dir = self._theme_dir(slug)
            meta, texts, assets, digest = self._working_payload(theme_dir, created_blobs)
            for kind, order in (asset_orders or {}).items():
                names = (uploaded_names or {}).get(kind, [])
                by_name = {record["name"]: record for record in assets[kind]}
                uploaded = [by_name[name] for name in names if name in by_name]
                uploaded_set = set(names)
                existing = [record for record in assets[kind] if record["name"] not in uploaded_set]
                assets[kind] = self._ordered_asset_records(existing, uploaded, order)
            digest = self._content_digest(meta, texts, assets)
            if not message:
                message = digest[:6]
            refs = self._refs(theme_dir)
            if parents is None:
                parent_versions = [refs.get("working_base")] if refs.get("working_base") is not None else []
            else:
                if not isinstance(parents, list):
                    raise ValueError("parents must be an array of version numbers")
                parent_versions = []
                for value in parents:
                    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                        raise ValueError("parents must contain positive integers")
                    if value not in parent_versions:
                        parent_versions.append(value)
                for value in parent_versions:
                    self._read_commit(theme_dir, value)
            normalized_tag = self._normalize_semver(tag) if tag else None
            if normalized_tag and normalized_tag in refs["tags"]:
                raise ValueError("version tag already exists")
            parent = parent_versions[0] if parent_versions else None
            branch = refs["current_branch"]
            branches_at_parent = [name for name, head in refs["branches"].items() if head == parent]
            if refs["branches"].get(branch) != parent:
                if branches_at_parent:
                    branch = branches_at_parent[0]
                else:
                    base_name = f"fork-{parent:04d}" if parent is not None else "fork-root"
                    branch = base_name
                    suffix = 2
                    while branch in refs["branches"]:
                        branch = f"{base_name}-{suffix}"
                        suffix += 1
                    refs["branches"][branch] = parent
                refs["current_branch"] = branch
            if parent is not None:
                previous = self._read_commit(theme_dir, parent)
                if len(parent_versions) < 2 and digest == self._version_creative_digest(previous["manifest"], previous["texts"]):
                    raise ValueError("working tree is clean; nothing to commit")
            elif not self._is_dirty(theme_dir, refs, digest):
                raise ValueError("working tree is clean; nothing to commit")
            version = refs["next_version"]
            created_at = timestamp()
            theme_meta = self._theme_meta(theme_dir)
            theme_meta["updated_at"] = created_at
            theme_meta["last_actor"] = actor
            atomic_write(theme_dir / "theme.json", json.dumps(theme_meta, ensure_ascii=False, indent=2) + "\n")
            snapshot = theme_dir / "history" / f"{version:04d}"
            temporary = theme_dir / "history" / f".{version:04d}-{uuid4().hex}.tmp"
            temporary.mkdir(parents=True)
            manifest = {
                "version": version,
                "parent": parent,
                "parents": parent_versions,
                "branch": branch,
                "digest": digest,
                "created_at": created_at,
                "actor": actor,
                "change_note": message,
                "meta": meta,
                "assets": assets,
            }
            manifest["integrity"] = self._manifest_integrity(manifest, texts)
            try:
                atomic_write(temporary / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
                for key, filename in TEXT_FILES.items():
                    atomic_write(temporary / filename, texts[key])
                temporary.replace(snapshot)
            except Exception:
                shutil.rmtree(temporary, ignore_errors=True)
                raise
            refs["branches"][branch] = version
            refs["working_base"] = version
            refs["next_version"] = version + 1
            if normalized_tag:
                refs["tags"][normalized_tag] = version
            try:
                self._write_refs(theme_dir, refs)
            except Exception:
                shutil.rmtree(snapshot, ignore_errors=True)
                raise
            return self.get_theme(slug)

    def grow_theme(self, slug, message, parents, data, uploads=None, actor="user", tag=None, force=False):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            refs = self._refs(theme_dir)
            is_initial_root = parents == [] and refs.get("working_base") is None and refs.get("next_version") == 1
            if self._is_dirty(theme_dir, refs) and not force and not is_initial_root:
                raise ValueError("working tree has uncommitted changes")
            if not isinstance(parents, list) or (not parents and not is_initial_root):
                raise ValueError("parents must contain at least one version number")
            for version in parents:
                if isinstance(version, bool) or not isinstance(version, int) or version < 1:
                    raise ValueError("parents must contain positive integers")
                self._read_commit(theme_dir, version)

            created_blobs = set()
            uploaded_names = {kind: [] for kind in ASSET_DIRS}
            published_version = refs["next_version"]
            branch = refs["current_branch"]
            restore_transaction = (
                self._backup_working_tree(theme_dir)
                if is_initial_root
                else self._restore_working_tree(theme_dir, parents[0], retain_backup=True)
            )
            try:
                self.update_theme(slug, data, actor)
                for kind, files in (uploads or {}).items():
                    if files:
                        uploaded_names[kind] = self.save_uploads(slug, kind, files, return_theme=False)
                result = self.commit_theme(
                    slug,
                    message,
                    actor,
                    tag,
                    parents,
                    created_blobs,
                    {kind: data.get(f"{kind}_order") for kind in ASSET_DIRS if f"{kind}_order" in data},
                    uploaded_names,
                )
            except Exception:
                current_refs = self._refs(theme_dir)
                published = (
                    current_refs.get("working_base") == published_version
                    or current_refs.get("next_version", 0) > published_version
                    or published_version in current_refs.get("branches", {}).values()
                )
                if published:
                    self._finalize_restore(restore_transaction)
                    raise
                self._rollback_restore(theme_dir, restore_transaction)
                for path in created_blobs:
                    path.unlink(missing_ok=True)
                raise
            self._finalize_restore(restore_transaction)
            return result

    def create_tag(self, slug, name, version=None):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            refs = self._refs(theme_dir)
            name = self._normalize_semver(name)
            if name in refs["tags"]:
                raise ValueError("version tag already exists")
            target = version if version is not None else refs.get("working_base")
            if target is None:
                raise ValueError("cannot tag a theme without commits")
            self._read_commit(theme_dir, target)
            refs["tags"][name] = target
            self._write_refs(theme_dir, refs)
            return self.get_theme(slug)

    def delete_tag(self, slug, name):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            refs = self._refs(theme_dir)
            name = self._normalize_semver(name)
            if name not in refs["tags"]:
                raise FileNotFoundError(name)
            del refs["tags"][name]
            self._write_refs(theme_dir, refs)
            return self.get_theme(slug)

    def update_version_marks(self, slug, version, marks):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            self._read_commit(theme_dir, version)
            refs = self._refs(theme_dir)
            fields = {
                "featured": "featured_commits",
                "favorite": "favorite_commits",
                "hidden": "hidden_commits",
            }
            changed = False
            for field, ref_key in fields.items():
                if field not in marks:
                    continue
                value = marks[field]
                if not isinstance(value, bool):
                    raise ValueError(f"{field} must be a boolean")
                values = set(refs[ref_key])
                if value:
                    values.add(int(version))
                else:
                    values.discard(int(version))
                refs[ref_key] = sorted(values)
                changed = True
            if not changed:
                raise ValueError("at least one mark is required")
            self._write_refs(theme_dir, refs)
            return self.get_theme(slug)

    def update_version(self, slug, version, data, actor="user", uploads=None, replace_assets=None):
        with self.lock:
            version = int(version)
            theme_dir = self._theme_dir(slug)
            commit = self._read_commit(theme_dir, version)
            refs = self._refs(theme_dir)
            preserve_working_tree = refs.get("working_base") == version and self._is_dirty(theme_dir, refs)
            manifest = dict(commit["manifest"])
            texts = dict(commit["texts"])
            version_meta = dict(manifest.get("meta", {}))
            created_blobs = set()
            assets = {
                kind: [dict(record) for record in manifest.get("assets", {}).get(kind, [])]
                for kind in ASSET_DIRS
            }
            for key in ("model", "params"):
                if key in data:
                    version_meta[key] = str(data.get(key) or "").strip()
            for key in TEXT_FILES:
                if key in data:
                    texts[key] = str(data.get(key) or "")
            auto_name = False
            if "change_note" in data:
                change_note = str(data.get("change_note") or "").strip()
                auto_name = not change_note
                if change_note:
                    manifest["change_note"] = change_note
            try:
                for kind in replace_assets or set():
                    if kind not in ASSET_DIRS:
                        raise ValueError("asset kind must be reference or result")
                    uploaded = self._version_upload_records(
                        theme_dir,
                        (uploads or {}).get(kind, []),
                        created_blobs,
                    )
                    assets[kind] = self._ordered_asset_records(
                        assets[kind],
                        uploaded,
                        data.get(f"{kind}_order"),
                    )
            except Exception:
                for path in created_blobs:
                    path.unlink(missing_ok=True)
                raise
            manifest["meta"] = version_meta
            manifest["assets"] = assets
            manifest["actor"] = actor
            manifest["updated_at"] = timestamp()
            manifest["digest"] = self._content_digest(version_meta, texts, assets)
            if auto_name:
                manifest["change_note"] = manifest["digest"][:6]
            manifest["integrity"] = self._manifest_integrity(manifest, texts)

            snapshot = commit["path"]
            staging = snapshot.with_name(f".{snapshot.name}-{uuid4().hex}.tmp")
            backup = snapshot.with_name(f".{snapshot.name}-{uuid4().hex}.bak")
            staging.mkdir()
            restore_transaction = None
            try:
                atomic_write(staging / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
                for key, filename in TEXT_FILES.items():
                    atomic_write(staging / filename, texts[key])
                snapshot.replace(backup)
                staging.replace(snapshot)
                if refs.get("working_base") == version and not preserve_working_tree:
                    restore_transaction = self._restore_working_tree(theme_dir, version, retain_backup=True)
            except Exception:
                if restore_transaction:
                    self._rollback_restore(theme_dir, restore_transaction)
                if snapshot.exists():
                    shutil.rmtree(snapshot, ignore_errors=True)
                if backup.exists():
                    backup.replace(snapshot)
                for path in created_blobs:
                    path.unlink(missing_ok=True)
                raise
            finally:
                shutil.rmtree(staging, ignore_errors=True)
            if restore_transaction:
                self._finalize_restore(restore_transaction)
            shutil.rmtree(backup, ignore_errors=True)
            return self.get_theme(slug)

    def delete_version(self, slug, version, force=False):
        with self.lock:
            version = int(version)
            theme_dir = self._theme_dir(slug)
            commit = self._read_commit(theme_dir, version)
            refs = self._refs(theme_dir)
            versions = self.list_versions(slug)
            if any(version in item.get("parents", []) for item in versions):
                raise ValueError("cannot delete a commit with descendants")
            parents = commit["manifest"].get("parents")
            if not isinstance(parents, list):
                parent = commit["manifest"].get("parent")
                parents = [parent] if parent is not None else []
            parent = parents[0] if parents else None
            affects_current = refs.get("working_base") == version
            if affects_current and self._is_dirty(theme_dir, refs) and not force:
                raise ValueError("working tree has uncommitted changes")

            restore_transaction = None
            if affects_current:
                restore_transaction = self._restore_working_tree(theme_dir, parent, retain_backup=True)

            for branch, head in list(refs["branches"].items()):
                if head == version:
                    refs["branches"][branch] = parent
            if affects_current:
                refs["working_base"] = parent
            refs["tags"] = {name: target for name, target in refs["tags"].items() if target != version}
            for key in ("featured_commits", "favorite_commits", "hidden_commits"):
                refs[key] = [item for item in refs[key] if item != version]

            snapshot = commit["path"]
            quarantine = snapshot.with_name(f".deleted-{snapshot.name}-{uuid4().hex}")
            snapshot.replace(quarantine)
            try:
                self._write_refs(theme_dir, refs)
            except Exception:
                quarantine.replace(snapshot)
                if restore_transaction:
                    self._rollback_restore(theme_dir, restore_transaction)
                raise
            if restore_transaction:
                self._finalize_restore(restore_transaction)
            shutil.rmtree(quarantine, ignore_errors=True)
            return self.get_theme(slug)

    def create_branch(self, slug, name, from_version=None, checkout=True, force=False):
        with self.lock:
            name = str(name or "").strip()
            if not SAFE_BRANCH.fullmatch(name) or ".." in name or name.endswith("/"):
                raise ValueError("invalid branch name")
            if from_version is not None and (isinstance(from_version, bool) or not isinstance(from_version, int) or from_version < 1):
                raise ValueError("from_version must be a positive integer")
            theme_dir = self._theme_dir(slug)
            refs = self._refs(theme_dir)
            if name in refs["branches"]:
                raise ValueError("branch already exists")
            current_head = refs["branches"].get(refs["current_branch"])
            current_base = refs.get("working_base")
            source = from_version if from_version is not None else current_base
            if source is not None:
                self._read_commit(theme_dir, source)
            if checkout and source != current_base and self._is_dirty(theme_dir, refs) and not force:
                raise ValueError("working tree has uncommitted changes")
            refs["branches"][name] = source
            restore_transaction = None
            if checkout:
                if source != current_base:
                    restore_transaction = self._restore_working_tree(theme_dir, source, retain_backup=True)
                refs["current_branch"] = name
                refs["working_base"] = source
            try:
                self._write_refs(theme_dir, refs)
            except Exception:
                if restore_transaction:
                    self._rollback_restore(theme_dir, restore_transaction)
                raise
            if restore_transaction:
                self._finalize_restore(restore_transaction)
            return self.get_theme(slug)

    def checkout_branch(self, slug, name, force=False):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            refs = self._refs(theme_dir)
            if name not in refs["branches"]:
                raise FileNotFoundError(name)
            head = refs["branches"][name]
            if name == refs["current_branch"] and refs.get("working_base") == head:
                return self.get_theme(slug)
            if self._is_dirty(theme_dir, refs) and not force:
                raise ValueError("working tree has uncommitted changes")
            restore_transaction = self._restore_working_tree(theme_dir, head, retain_backup=True)
            refs["current_branch"] = name
            refs["working_base"] = head
            try:
                self._write_refs(theme_dir, refs)
            except Exception:
                self._rollback_restore(theme_dir, restore_transaction)
                raise
            self._finalize_restore(restore_transaction)
            return self.get_theme(slug)

    def move_branch(self, slug, name, version, force=False):
        with self.lock:
            if isinstance(version, bool) or not isinstance(version, int) or version < 1:
                raise ValueError("version must be a positive integer")
            theme_dir = self._theme_dir(slug)
            refs = self._refs(theme_dir)
            if name not in refs["branches"]:
                raise FileNotFoundError(name)
            self._read_commit(theme_dir, version)
            is_current = name == refs["current_branch"]
            if is_current and self._is_dirty(theme_dir, refs) and not force:
                raise ValueError("working tree has uncommitted changes")
            restore_transaction = None
            if is_current:
                restore_transaction = self._restore_working_tree(theme_dir, version, retain_backup=True)
            previous = refs["branches"][name]
            previous_base = refs.get("working_base")
            refs["branches"][name] = version
            if is_current:
                refs["working_base"] = version
            try:
                self._write_refs(theme_dir, refs)
            except Exception:
                refs["branches"][name] = previous
                refs["working_base"] = previous_base
                if restore_transaction:
                    self._rollback_restore(theme_dir, restore_transaction)
                raise
            if restore_transaction:
                self._finalize_restore(restore_transaction)
            return self.get_theme(slug)

    def checkout_version(self, slug, version, force=False):
        with self.lock:
            version = int(version)
            theme_dir = self._theme_dir(slug)
            self._read_commit(theme_dir, version)
            refs = self._refs(theme_dir)
            if refs.get("working_base") == version:
                return self.get_theme(slug)
            if self._is_dirty(theme_dir, refs) and not force:
                raise ValueError("working tree has uncommitted changes")

            restore_transaction = self._restore_working_tree(theme_dir, version, retain_backup=True)
            previous_branch = refs["current_branch"]
            previous_base = refs.get("working_base")
            branches_at_version = [name for name, head in refs["branches"].items() if head == version]
            if previous_branch not in branches_at_version and branches_at_version:
                refs["current_branch"] = branches_at_version[0]
            refs["working_base"] = version
            try:
                self._write_refs(theme_dir, refs)
            except Exception:
                refs["current_branch"] = previous_branch
                refs["working_base"] = previous_base
                self._rollback_restore(theme_dir, restore_transaction)
                raise
            self._finalize_restore(restore_transaction)
            return self.get_theme(slug)

    def discard_working(self, slug):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            refs = self._refs(theme_dir)
            if not self._is_dirty(theme_dir, refs):
                return self.get_theme(slug)
            restore_transaction = self._restore_working_tree(
                theme_dir,
                refs.get("working_base"),
                retain_backup=True,
            )
            self._finalize_restore(restore_transaction)
            return self.get_theme(slug)

    def delete_branch(self, slug, name):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            refs = self._refs(theme_dir)
            if name not in refs["branches"]:
                raise FileNotFoundError(name)
            if name == refs["current_branch"]:
                raise ValueError("cannot delete the current branch")
            if len(refs["branches"]) == 1:
                raise ValueError("cannot delete the last branch")
            del refs["branches"][name]
            self._write_refs(theme_dir, refs)
            return self.get_theme(slug)

    def _restore_working_tree(self, theme_dir, version, retain_backup=False):
        meta = self._theme_meta(theme_dir)
        if version is None:
            version_meta = {"model": "", "params": ""}
            texts = {key: "" for key in TEXT_FILES}
            assets = {kind: [] for kind in ASSET_DIRS}
        else:
            commit = self._read_commit(theme_dir, version)
            version_meta = commit["manifest"].get("meta", {})
            texts = commit["texts"]
            assets = commit["manifest"].get("assets", {})
        asset_sources = {}
        for kind in ASSET_DIRS:
            asset_sources[kind] = []
            for record in assets.get(kind, []):
                if Path(record.get("name", "")).name != record.get("name"):
                    raise ValueError("archived asset has an invalid filename")
                asset_sources[kind].append((record, self._blob_path(record)))
        meta["model"] = str(version_meta.get("model") or "")
        meta["params"] = str(version_meta.get("params") or "")
        meta["updated_at"] = timestamp()
        staging = theme_dir / f".checkout-{uuid4().hex}.tmp"
        backup = theme_dir / f".checkout-{uuid4().hex}.bak"
        staging.mkdir()
        backup.mkdir()
        targets = ["theme.json", *TEXT_FILES.values(), *ASSET_DIRS.values()]
        backed_up = []
        installed = []
        completed = False
        try:
            atomic_write(staging / "theme.json", json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
            for key, filename in TEXT_FILES.items():
                atomic_write(staging / filename, texts.get(key, ""))
            for kind, dirname in ASSET_DIRS.items():
                directory = staging / dirname
                directory.mkdir()
                for record, source in asset_sources[kind]:
                    shutil.copy2(source, directory / record["name"])
            for name in targets:
                current = theme_dir / name
                if current.exists():
                    current.replace(backup / name)
                    backed_up.append(name)
            for name in targets:
                (staging / name).replace(theme_dir / name)
                installed.append(name)
            completed = True
        except Exception:
            for name in installed:
                current = theme_dir / name
                if current.is_dir():
                    shutil.rmtree(current)
                elif current.exists():
                    current.unlink()
            for name in backed_up:
                current = theme_dir / name
                saved = backup / name
                if current.is_dir():
                    shutil.rmtree(current)
                elif current.exists():
                    current.unlink()
                if saved.exists():
                    saved.replace(current)
            raise
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            if not retain_backup or not completed:
                shutil.rmtree(backup, ignore_errors=True)
        if retain_backup:
            return {"backup": backup, "backed_up": backed_up, "installed": installed}
        return None

    @staticmethod
    def _backup_working_tree(theme_dir):
        backup = theme_dir / f".grow-{uuid4().hex}.bak"
        backup.mkdir()
        targets = ["theme.json", *TEXT_FILES.values(), *ASSET_DIRS.values()]
        backed_up = []
        try:
            for name in targets:
                source = theme_dir / name
                destination = backup / name
                if source.is_dir():
                    shutil.copytree(source, destination)
                elif source.exists():
                    shutil.copy2(source, destination)
                else:
                    continue
                backed_up.append(name)
        except Exception:
            shutil.rmtree(backup, ignore_errors=True)
            raise
        return {"backup": backup, "backed_up": backed_up, "installed": backed_up}

    @staticmethod
    def _rollback_restore(theme_dir, transaction):
        for name in transaction["installed"]:
            current = theme_dir / name
            if current.is_dir():
                shutil.rmtree(current)
            elif current.exists():
                current.unlink()
        for name in transaction["backed_up"]:
            saved = transaction["backup"] / name
            if saved.exists():
                saved.replace(theme_dir / name)
        shutil.rmtree(transaction["backup"], ignore_errors=True)

    @staticmethod
    def _finalize_restore(transaction):
        shutil.rmtree(transaction["backup"], ignore_errors=True)

    def duplicate_theme(self, slug, actor="user"):
        with self.lock:
            source = self.get_theme(slug)
            source_dir = self._theme_dir(slug)
            duplicate = self.create_theme({
                "title": f"{source['title']} 副本",
                "description": source["description"],
                "category": source["category"],
                "tags": source["tags"],
                "prompt": source["prompt"],
                "negative": source["negative"],
                "notes": source["notes"],
                "model": source["model"],
                "params": source["params"],
                "status": "active",
                "reference_urls": source["reference_urls"],
            }, actor=actor)
            duplicate_dir = self._theme_dir(duplicate["slug"])
            for dirname in ASSET_DIRS.values():
                for asset in (source_dir / dirname).iterdir():
                    if asset.is_file() and not asset.is_symlink():
                        shutil.copy2(asset, duplicate_dir / dirname / asset.name)
            return self.get_theme(duplicate["slug"])

    def delete_theme(self, slug):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            target = self.trash / f"{slug}-{datetime.now().strftime('%Y%m%d%H%M%S')}"
            shutil.move(str(theme_dir), target)

    def list_themes(self, query=""):
        query = query.strip().lower()
        themes = []
        errors = {}
        for path in self.root.iterdir():
            if not path.is_dir() or not SAFE_SLUG.fullmatch(path.name) or not (path / "theme.json").exists():
                continue
            try:
                theme = self.get_theme(path.name, include_versions=False)
            except (FileNotFoundError, ValueError) as error:
                errors[path.name] = str(error)
                continue
            haystack = " ".join([
                theme["title"], theme["description"], theme["prompt"], theme["category"],
                " ".join(theme["tags"]), theme["model"],
            ]).lower()
            if not query or query in haystack:
                themes.append(theme)
        self.scan_errors = errors
        return sorted(themes, key=lambda item: item["updated_at"], reverse=True)

    def get_theme(self, slug, include_versions=True):
        with self.lock:
            theme_dir = self._theme_dir(slug)
            meta = self._theme_meta(theme_dir)
            texts = self._read_texts(theme_dir)
            assets = self._asset_records(theme_dir)
            refs = self._refs(theme_dir)
            commits = self.list_versions(slug) if include_versions else []
            head = refs["branches"].get(refs["current_branch"])
            working_base = refs.get("working_base")
            representative = max(refs["featured_commits"], default=None)
            representative_versions = []
            for version in refs["featured_commits"]:
                try:
                    commit = self._read_commit(theme_dir, version)
                except FileNotFoundError:
                    continue
                version_assets = self._version_asset_urls(slug, version, commit["manifest"].get("assets", {}))
                preview = next(iter(version_assets.get("result", [])), None) or next(
                    iter(version_assets.get("reference", [])), None
                )
                representative_versions.append({
                    "version": version,
                    "change_note": commit["manifest"].get("change_note"),
                    "preview_url": preview.get("url") if preview else None,
                })
            _, _, _, digest = self._working_payload(theme_dir)
            return {
                **meta,
                **texts,
                "assets": self._asset_urls(slug, assets),
                "dirty": self._is_dirty(theme_dir, refs, digest),
                "current_branch": refs["current_branch"],
                "working_base": working_base,
                "branches": [{"name": name, "head": value} for name, value in refs["branches"].items()],
                "release_tags": [
                    {"name": name, "version": version}
                    for name, version in sorted(refs["tags"].items(), key=lambda item: self._semver_key(item[0]))
                ],
                "representative_version": representative,
                "representative_versions": representative_versions,
                "has_favorite_versions": bool(refs["favorite_commits"]),
                "version_count": len(self._commit_dirs(theme_dir)),
                "can_create_root": working_base is None and refs.get("next_version") == 1,
                "current_version": working_base,
                "versions": commits,
                "workspace_path": str(theme_dir),
            }

    def list_versions(self, slug):
        with self.lock:
            return self._list_versions(slug)

    def _list_versions(self, slug):
        theme_dir = self._theme_dir(slug)
        refs = self._refs(theme_dir)
        branch_heads = {}
        for name, head in refs["branches"].items():
            if head is not None:
                branch_heads.setdefault(head, []).append(name)
        tags_by_version = {}
        for name, version in refs["tags"].items():
            tags_by_version.setdefault(version, []).append(name)
        versions = []
        parent_map = {}
        previous = None
        for path in self._commit_dirs(theme_dir):
            manifest = self._read_json(path / "manifest.json", {}, strict=True)
            version = int(manifest.get("version") or path.name)
            parent = manifest.get("parent", previous)
            parents = manifest.get("parents")
            if not isinstance(parents, list):
                parents = [parent] if parent is not None else []
            branch = manifest.get("branch") or (branch_heads.get(version) or ["main"])[0]
            texts = self._read_texts(path)
            version_assets = self._version_asset_urls(slug, version, manifest.get("assets", {}))
            preview = next(iter(version_assets.get("result", [])), None) or next(
                iter(version_assets.get("reference", [])), None
            )
            parent_map[version] = parents
            versions.append({
                "version": version,
                "parent": parent,
                "parents": parents,
                "branch": branch,
                "branch_head": " · ".join(branch_heads.get(version, [])) or None,
                "tags": sorted(tags_by_version.get(version, []), key=self._semver_key),
                "featured": version in refs["featured_commits"],
                "favorite": version in refs["favorite_commits"],
                "hidden": version in refs["hidden_commits"],
                "created_at": manifest.get("created_at"),
                "actor": manifest.get("actor"),
                "change_note": manifest.get("change_note"),
                "digest": manifest.get("digest"),
                "prompt_excerpt": texts.get("prompt", "")[:180],
                "preview_url": preview.get("url") if preview else None,
            })
            previous = version
        reachable = set()
        pending = [value for value in [*refs["branches"].values(), *refs["tags"].values()] if value is not None]
        while pending:
            version = pending.pop()
            if version in reachable:
                continue
            reachable.add(version)
            pending.extend(parent_map.get(version, []))
        for item in versions:
            item["reachable"] = item["version"] in reachable
        return list(reversed(versions))

    def get_version(self, slug, version):
        with self.lock:
            return self._get_version(slug, version)

    def _get_version(self, slug, version):
        theme_dir = self._theme_dir(slug)
        commit = self._read_commit(theme_dir, version)
        manifest = commit["manifest"]
        parents = manifest.get("parents")
        if not isinstance(parents, list):
            parent = manifest.get("parent")
            parents = [parent] if parent is not None else []
        summary = next(item for item in self.list_versions(slug) if item["version"] == int(version))
        return {
            **manifest,
            **manifest.get("meta", {}),
            **commit["texts"],
            "parents": parents,
            "slug": slug,
            "tags": summary["tags"],
            "branch_head": summary["branch_head"],
            "reachable": summary["reachable"],
            "assets": self._version_asset_urls(slug, version, manifest.get("assets", {})),
        }

    def compare(self, slug, left, right):
        import difflib

        left_data = self.get_version(slug, left)
        right_data = self.get_version(slug, right)
        diffs = {}
        for key in TEXT_FILES:
            diffs[key] = "\n".join(difflib.unified_diff(
                left_data[key].splitlines(), right_data[key].splitlines(),
                fromfile=f"v{left} {key}", tofile=f"v{right} {key}", lineterm="",
            ))
        metadata_changes = []
        for key in ("model", "params"):
            if left_data.get(key) != right_data.get(key):
                metadata_changes.append({"field": key, "left": left_data.get(key), "right": right_data.get(key)})
        asset_changes = {}
        for kind in ASSET_DIRS:
            left_assets = {(item["name"], item["sha256"]) for item in left_data["assets"].get(kind, [])}
            right_assets = {(item["name"], item["sha256"]) for item in right_data["assets"].get(kind, [])}
            asset_changes[kind] = {
                "removed": [{"name": name, "sha256": digest} for name, digest in sorted(left_assets - right_assets)],
                "added": [{"name": name, "sha256": digest} for name, digest in sorted(right_assets - left_assets)],
            }
        return {"left": left_data, "right": right_data, "diffs": diffs, "metadata_changes": metadata_changes, "asset_changes": asset_changes}

    def save_uploads(self, slug, kind, storages, return_theme=True):
        if kind not in ASSET_DIRS:
            raise ValueError("kind must be reference or result")
        with self.lock:
            theme_dir = self._theme_dir(slug)
            upload_dir = theme_dir / f".uploads-{uuid4().hex}"
            upload_dir.mkdir()
            staged = []
            try:
                for storage in storages:
                    original = Path(storage.filename or "image").name
                    extension = Path(original).suffix.lower()
                    if extension not in ALLOWED_IMAGE_EXTENSIONS:
                        raise ValueError(f"unsupported image type: {original}")
                    safe_stem = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", Path(original).stem, flags=re.UNICODE).strip(".-") or "image"
                    temporary = upload_dir / f"{uuid4().hex}{extension}"
                    storage.save(temporary)
                    detected = image_type(temporary)
                    expected = "jpeg" if extension in {".jpg", ".jpeg"} else extension[1:]
                    if detected != expected:
                        raise ValueError(f"file content is not a valid {expected} image: {original}")
                    filename = f"{safe_stem[:80]}{extension}"
                    target = theme_dir / ASSET_DIRS[kind] / filename
                    if target.exists() or any(item[1].name == filename for item in staged):
                        filename = f"{safe_stem[:70]}-{uuid4().hex[:8]}{extension}"
                        target = target.with_name(filename)
                    staged.append((temporary, target))
                for temporary, target in staged:
                    temporary.replace(target)
                meta = self._theme_meta(theme_dir)
                meta["updated_at"] = timestamp()
                atomic_write(theme_dir / "theme.json", json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
                return self.get_theme(slug) if return_theme else [target.name for _, target in staged]
            except Exception:
                for _, target in staged:
                    if target.exists():
                        target.unlink()
                raise
            finally:
                shutil.rmtree(upload_dir, ignore_errors=True)

    def save_upload(self, slug, kind, storage):
        return self.save_uploads(slug, kind, [storage])

    def delete_asset(self, slug, kind, filename):
        with self.lock:
            if kind not in ASSET_DIRS or Path(filename).name != filename:
                raise ValueError("invalid asset")
            theme_dir = self._theme_dir(slug)
            path = theme_dir / ASSET_DIRS[kind] / filename
            if path.is_symlink() or not path.is_file():
                raise FileNotFoundError(filename)
            quarantine = path.with_name(f".{path.name}.{uuid4().hex}.deleted")
            path.replace(quarantine)
            meta = self._theme_meta(theme_dir)
            meta["updated_at"] = timestamp()
            try:
                atomic_write(theme_dir / "theme.json", json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
            except Exception:
                quarantine.replace(path)
                raise
            quarantine.unlink(missing_ok=True)

    def current_asset_path(self, slug, kind, filename):
        if kind not in ASSET_DIRS or Path(filename).name != filename:
            raise ValueError("invalid asset")
        path = self._theme_dir(slug) / ASSET_DIRS[kind] / filename
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(filename)
        return path

    def _blob_path(self, record):
        matches = list((self.blobs / record["sha256"][:2]).glob(f"{record['sha256']}.*"))
        if not matches:
            raise FileNotFoundError(record["name"])
        if file_hash(matches[0]) != record["sha256"]:
            raise ValueError(f"stored asset failed integrity verification: {record['name']}")
        return matches[0]

    def version_asset_path(self, slug, version, kind, filename):
        if kind not in ASSET_DIRS or Path(filename).name != filename:
            raise ValueError("invalid asset")
        data = self.get_version(slug, version)
        record = next((item for item in data["assets"].get(kind, []) if item["name"] == filename), None)
        if not record:
            raise FileNotFoundError(filename)
        return self._blob_path(record)

    def _asset_urls(self, slug, assets):
        return {
            kind: [{**item, "url": f"/api/themes/{quote(slug, safe='')}/files/{kind}/{quote(item['name'], safe='')}"} for item in records]
            for kind, records in assets.items()
        }

    def _version_asset_urls(self, slug, version, assets):
        return {
            kind: [{**item, "url": f"/api/themes/{quote(slug, safe='')}/versions/{version}/files/{kind}/{quote(item['name'], safe='')}"} for item in records]
            for kind, records in assets.items()
        }

    def scan_workspaces(self):
        dirty = []
        errors = {}
        for path in self.root.iterdir():
            if not path.is_dir() or not SAFE_SLUG.fullmatch(path.name) or not (path / "theme.json").exists():
                continue
            try:
                if self.get_theme(path.name, include_versions=False)["dirty"]:
                    dirty.append(path.name)
            except (FileNotFoundError, ValueError) as error:
                errors[path.name] = str(error)
        self.scan_errors = errors
        return dirty

    @staticmethod
    def _normalize_semver(value):
        value = str(value or "").strip()
        match = SEMVER_TAG.fullmatch(value)
        if not match:
            raise ValueError("version tag must use semantic versioning, for example v1.2.0")
        return f"v{match.group(1)}.{match.group(2)}.{match.group(3)}" + (f"-{match.group(4)}" if match.group(4) else "")

    @staticmethod
    def _semver_key(value):
        match = SEMVER_TAG.fullmatch(value)
        if not match:
            return (0, 0, 0, value)
        return (int(match.group(1)), int(match.group(2)), int(match.group(3)), match.group(4) or "")

    @staticmethod
    def _tags(value):
        if isinstance(value, str):
            value = value.split(",")
        elif not isinstance(value, (list, tuple, set)):
            value = [value]
        return [str(item).strip() for item in (value or []) if str(item).strip()]

    @staticmethod
    def _reference_urls(value):
        if isinstance(value, str):
            value = [value]
        elif not isinstance(value, (list, tuple, set)):
            value = []
        return [url for url in (str(item).strip() for item in value or []) if urlsplit(url).scheme in {"http", "https"}]

    def migrate_legacy(self, db_path):
        marker = self.root / ".legacy-migrated"
        if marker.exists() or not db_path.exists():
            return
        try:
            db = sqlite3.connect(db_path)
            db.row_factory = sqlite3.Row
            rows = db.execute("SELECT * FROM prompts ORDER BY id").fetchall()
        except sqlite3.Error as error:
            raise RuntimeError(f"legacy database migration failed: {error}") from error
        finally:
            if "db" in locals():
                db.close()
        imported_ids = set()
        for path in self.root.iterdir():
            if not path.is_dir() or path.name.startswith("."):
                continue
            meta = self._read_json(path / "theme.json", {})
            source_id = meta.get("legacy", {}).get("prompt_id") if isinstance(meta, dict) else None
            if source_id is not None:
                imported_ids.add(source_id)
        for row in rows:
            data = dict(row)
            if data["id"] in imported_ids:
                continue
            self.create_theme({
                "title": data.get("title") or f"Imported prompt {data['id']}",
                "description": "",
                "category": data.get("category") or "未分类",
                "tags": data.get("tags") or "",
                "prompt": data.get("content") or "",
                "negative": data.get("negative") or "",
                "notes": data.get("notes") or "",
                "model": data.get("model") or "",
                "params": data.get("params") or "",
                "starred": bool(data.get("starred")),
                "reference_urls": [data["image_url"]] if data.get("image_url") else [],
                "created_at": data.get("created_at"),
                "updated_at": data.get("updated_at"),
                "legacy": {"prompt_id": data["id"], "source": str(db_path), "record": data},
                "change_note": "Imported from legacy database",
            }, actor="migration", initial_commit=True)
        atomic_write(marker, f"Migrated {len(rows)} prompts at {timestamp()}\n")
