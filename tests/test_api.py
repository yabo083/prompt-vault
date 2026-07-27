import base64
import json
import sqlite3
from io import BytesIO
from pathlib import Path

import pytest

from app import create_app


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


@pytest.fixture
def client(tmp_path):
    application = create_app(tmp_path / "workspace", tmp_path / "missing.db", token="")
    application.config.update(TESTING=True)
    return application.test_client()


def create_theme(client, prompt="first prompt"):
    response = client.post("/api/themes", json={
        "title": "Homepage mascot",
        "prompt": prompt,
        "tags": ["krea2", "homepage"],
    })
    assert response.status_code == 201
    return response.get_json()


def commit(client, slug, message):
    response = client.post(f"/api/themes/{slug}/commits", json={"message": message})
    assert response.status_code == 201
    return response.get_json()


def test_root_template_renders(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"Prompt Vault" in response.data


def test_theme_starts_as_one_dirty_working_tree_without_history(client):
    theme = create_theme(client)
    assert theme["prompt"] == "first prompt"
    assert theme["can_create_root"] is True
    assert theme["dirty"] is True
    assert theme["version_count"] == 0
    assert theme["current_version"] is None
    assert theme["current_branch"] == "main"


def test_only_explicit_commit_creates_a_version(client):
    theme = create_theme(client)
    slug = theme["slug"]

    client.put(f"/api/themes/{slug}", json={"prompt": "second prompt", "model": "Krea 2"})
    client.post(f"/api/themes/{slug}/star")
    client.put(f"/api/themes/{slug}", json={"status": "active"})
    working = client.get(f"/api/themes/{slug}").get_json()
    assert working["version_count"] == 0
    assert working["dirty"] is True

    archived = commit(client, slug, "First usable direction")
    assert archived["version_count"] == 1
    assert archived["current_version"] == 1
    assert archived["dirty"] is False

    favorite = client.post(f"/api/themes/{slug}/star").get_json()
    assert favorite["version_count"] == 1
    assert favorite["dirty"] is False


def test_discard_working_restores_the_current_version_without_deleting_history(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Baseline")
    client.put(f"/api/themes/{slug}", json={"prompt": "bug", "negative": "temporary"})

    discarded = client.post(f"/api/themes/{slug}/discard")

    assert discarded.status_code == 200
    restored = discarded.get_json()
    assert restored["dirty"] is False
    assert restored["prompt"] == "first prompt"
    assert restored["negative"] == ""
    assert restored["version_count"] == 1


def test_discard_working_clears_an_uncommitted_initial_root(client):
    theme = create_theme(client)

    restored = client.post(f"/api/themes/{theme['slug']}/discard").get_json()

    assert restored["dirty"] is False
    assert restored["prompt"] == ""
    assert restored["version_count"] == 0
    assert restored["can_create_root"] is True


def test_discard_working_restores_version_assets(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "baseline.png")},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Baseline")
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "temporary.png")},
        content_type="multipart/form-data",
    )

    restored = client.post(f"/api/themes/{slug}/discard").get_json()

    assert restored["dirty"] is False
    assert [asset["name"] for asset in restored["assets"]["result"]] == ["baseline.png"]


def test_commits_link_to_parent_and_compare_content(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Initial direction")

    updated = client.put(f"/api/themes/{slug}", json={"prompt": "second prompt", "model": "Krea 2"}).get_json()
    assert updated["version_count"] == 1
    assert updated["dirty"] is True
    second = commit(client, slug, "Refined pose")
    assert second["versions"][0]["parent"] == 1

    comparison = client.get(f"/api/themes/{slug}/compare?left=1&right=2").get_json()
    assert comparison["left"]["prompt"] == "first prompt"
    assert comparison["right"]["prompt"] == "second prompt"
    assert "-first prompt" in comparison["diffs"]["prompt"]
    assert "+second prompt" in comparison["diffs"]["prompt"]
    assert comparison["metadata_changes"] == [{"field": "model", "left": "", "right": "Krea 2"}]


def test_direct_file_write_marks_dirty_without_creating_history(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Initial")
    Path(theme["workspace_path"]).joinpath("prompt.md").write_text("written by agent", encoding="utf-8")

    scanned = client.post("/api/agent/sync").get_json()
    refreshed = client.get(f"/api/themes/{slug}").get_json()
    assert scanned["dirty"] == [slug]
    assert refreshed["prompt"] == "written by agent"
    assert refreshed["dirty"] is True
    assert refreshed["version_count"] == 1


def test_upload_changes_working_tree_and_commit_preserves_asset(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Initial")
    upload = client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "reference", "files": (BytesIO(PNG), "reference.png")},
        content_type="multipart/form-data",
    )
    working = upload.get_json()
    assert working["version_count"] == 1
    assert working["dirty"] is True

    commit(client, slug, "Add reference")
    historical = client.get(f"/api/themes/{slug}/versions/2").get_json()
    image_url = historical["assets"]["reference"][0]["url"]
    assert client.get(image_url).data == PNG


def test_upload_batch_is_atomic_and_does_not_commit(client):
    theme = create_theme(client)
    slug = theme["slug"]
    response = client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": [(BytesIO(PNG), "one.png"), (BytesIO(PNG), "two.png")]},
        content_type="multipart/form-data",
    )
    assert response.status_code == 201
    assert response.get_json()["version_count"] == 0

    rejected = client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": [(BytesIO(PNG), "three.png"), (BytesIO(b"bad"), "bad.png")]},
        content_type="multipart/form-data",
    )
    assert rejected.status_code == 400
    current = client.get(f"/api/themes/{slug}").get_json()
    assert [item["name"] for item in current["assets"]["result"]] == ["one.png", "two.png"]


def test_overwrite_version_replaces_result_image(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "old.png")},
        content_type="multipart/form-data",
    )
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "reference", "files": (BytesIO(PNG), "reference.png")},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Initial image")

    response = client.put(
        f"/api/themes/{slug}/versions/1",
        data={
            "draft": json.dumps({
                "change_note": "Replaced image",
                "prompt": "updated prompt",
                "replace_result": True,
            }),
            "result_files": (BytesIO(PNG), "new.png"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    detail = client.get(f"/api/themes/{slug}/versions/1").get_json()
    assert detail["prompt"] == "updated prompt"
    assert [item["name"] for item in detail["assets"]["result"]] == ["new.png"]
    assert [item["name"] for item in detail["assets"]["reference"]] == ["reference.png"]
    assert client.get(f"/api/themes/{slug}/versions/1/files/result/new.png").data == PNG
    assert client.get(f"/api/themes/{slug}/versions/1/files/result/old.png").status_code == 404


def test_failed_version_image_replacement_keeps_original_node(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "old.png")},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Initial image")

    response = client.put(
        f"/api/themes/{slug}/versions/1",
        data={
            "draft": json.dumps({
                "change_note": "Broken replacement",
                "prompt": "must roll back",
                "replace_result": True,
            }),
            "result_files": (BytesIO(b"not an image"), "bad.png"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    detail = client.get(f"/api/themes/{slug}/versions/1").get_json()
    assert detail["prompt"] == "first prompt"
    assert [item["name"] for item in detail["assets"]["result"]] == ["old.png"]


def test_overwrite_version_can_clear_result_images(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "old.png")},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Initial image")

    response = client.put(
        f"/api/themes/{slug}/versions/1",
        data={"draft": json.dumps({
            "change_note": "Removed image",
            "replace_result": True,
        })},
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    assert client.get(f"/api/themes/{slug}/versions/1").get_json()["assets"]["result"] == []


def test_overwrite_version_can_append_remove_and_reorder_multiple_images(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": [(BytesIO(PNG), "one.png"), (BytesIO(PNG), "two.png")]},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Initial images")

    response = client.put(
        f"/api/themes/{slug}/versions/1",
        data={
            "draft": json.dumps({
                "change_note": "Curated images",
                "result_order": [
                    {"source": "upload", "index": 1},
                    {"source": "existing", "index": 1},
                    {"source": "upload", "index": 0},
                ],
            }),
            "result_files": [(BytesIO(PNG), "three.png"), (BytesIO(PNG), "four.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    detail = client.get(f"/api/themes/{slug}/versions/1").get_json()
    assert [item["name"] for item in detail["assets"]["result"]] == ["four.png", "two.png", "three.png"]


def test_invalid_multi_image_order_keeps_the_original_node(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "old.png")},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Initial image")

    response = client.put(
        f"/api/themes/{slug}/versions/1",
        data={"draft": json.dumps({"result_order": [{"source": "upload", "index": 9}]})},
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    detail = client.get(f"/api/themes/{slug}/versions/1").get_json()
    assert [item["name"] for item in detail["assets"]["result"]] == ["old.png"]


def test_overwrite_version_rolls_back_snapshot_when_clean_worktree_restore_fails(client, monkeypatch):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "old.png")},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Initial image")
    store = client.application.extensions["vault_store"]
    blob_root = Path(theme["workspace_path"]).parent / ".assets"
    before_blobs = {path for path in blob_root.rglob("*") if path.is_file()}

    def fail_restore(*_args, **_kwargs):
        raise OSError("restore failed")

    monkeypatch.setattr(store, "_restore_working_tree", fail_restore)
    with pytest.raises(OSError, match="restore failed"):
        store.update_version(
            slug,
            1,
            {"change_note": "Must roll back", "prompt": "replacement"},
            uploads={"result": []},
            replace_assets={"result"},
        )

    detail = store.get_version(slug, 1)
    assert detail["prompt"] == "first prompt"
    assert [item["name"] for item in detail["assets"]["result"]] == ["old.png"]
    assert store.get_theme(slug)["prompt"] == "first prompt"
    assert {path for path in blob_root.rglob("*") if path.is_file()} == before_blobs


def test_branch_commit_tree_and_checkout(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Main baseline")

    branched = client.post(f"/api/themes/{slug}/branches", json={"name": "cute-pose"})
    assert branched.status_code == 201
    assert branched.get_json()["current_branch"] == "cute-pose"
    client.put(f"/api/themes/{slug}", json={"prompt": "cute branch prompt"})
    branch_commit = commit(client, slug, "Try cute pose")
    assert branch_commit["current_version"] == 2
    assert branch_commit["versions"][0]["branch"] == "cute-pose"
    assert branch_commit["versions"][0]["parent"] == 1

    checked_out = client.post(f"/api/themes/{slug}/checkout", json={"branch": "main"})
    assert checked_out.status_code == 200
    assert checked_out.get_json()["prompt"] == "first prompt"
    assert checked_out.get_json()["current_version"] == 1

    client.put(f"/api/themes/{slug}", json={"prompt": "uncommitted"})
    refused = client.post(f"/api/themes/{slug}/checkout", json={"branch": "cute-pose"})
    assert refused.status_code == 400
    assert "uncommitted changes" in refused.get_json()["message"]


def test_arbitrary_commit_can_be_checked_out_edited_and_forked(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Base")
    client.put(f"/api/themes/{slug}", json={"prompt": "main second"})
    commit(client, slug, "Main second")

    checked_out = client.post(f"/api/themes/{slug}/versions/1/checkout").get_json()
    assert checked_out["working_base"] == 1
    assert checked_out["current_version"] == 1
    assert checked_out["prompt"] == "first prompt"
    assert {branch["name"]: branch["head"] for branch in checked_out["branches"]} == {"main": 2}

    client.put(f"/api/themes/{slug}", json={"prompt": "forked direction"})
    forked = commit(client, slug, "Explore from base")
    assert forked["current_branch"] == "fork-0001"
    assert forked["current_version"] == 3
    assert {branch["name"]: branch["head"] for branch in forked["branches"]} == {
        "main": 2,
        "fork-0001": 3,
    }
    third = next(version for version in forked["versions"] if version["version"] == 3)
    assert third["parent"] == 1


def test_commit_can_merge_multiple_parent_nodes_into_a_dag(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Root")

    client.put(f"/api/themes/{slug}", json={"prompt": "left direction"})
    commit(client, slug, "Left")
    client.post(f"/api/themes/{slug}/versions/1/checkout")
    client.put(f"/api/themes/{slug}", json={"prompt": "right direction"})
    right = commit(client, slug, "Right")
    assert right["current_version"] == 3

    client.put(f"/api/themes/{slug}", json={"prompt": "merged visual language"})
    merged = client.post(
        f"/api/themes/{slug}/commits",
        json={"message": "Merge left and right", "parents": [2, 3]},
    )
    assert merged.status_code == 201
    payload = merged.get_json()
    version = next(item for item in payload["versions"] if item["version"] == 4)
    assert version["parents"] == [2, 3]
    assert version["parent"] == 2

    snapshot = client.get(f"/api/themes/{slug}/versions/4").get_json()
    assert snapshot["parents"] == [2, 3]
    assert snapshot["prompt"] == "merged visual language"

    protected = client.delete(f"/api/themes/{slug}/versions/2")
    assert protected.status_code == 400
    assert "descendant" in protected.get_json()["message"]


def test_commit_parent_list_is_validated(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Root")
    client.put(f"/api/themes/{slug}", json={"prompt": "next"})

    invalid_type = client.post(
        f"/api/themes/{slug}/commits",
        json={"message": "Bad", "parents": "1,2"},
    )
    assert invalid_type.status_code == 400
    missing = client.post(
        f"/api/themes/{slug}/commits",
        json={"message": "Bad", "parents": [1, 99]},
    )
    assert missing.status_code == 404


def test_grow_is_atomic_inherits_primary_parent_assets_and_requires_force_for_dirty_work(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "reference", "files": (BytesIO(PNG), "source.png")},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Root")
    client.put(f"/api/themes/{slug}", json={"prompt": "unsaved live work"})
    draft = {
        "change_note": "Atomic child",
        "prompt": "grown prompt",
        "negative": "bad anatomy",
        "notes": "merged deliberately",
        "model": "Krea 2",
        "params": "16:9",
        "parents": [1],
    }

    refused = client.post(
        f"/api/themes/{slug}/grow",
        data={"draft": json.dumps(draft)},
        content_type="multipart/form-data",
    )
    assert refused.status_code == 400
    assert client.get(f"/api/themes/{slug}").get_json()["prompt"] == "unsaved live work"

    grown = client.post(
        f"/api/themes/{slug}/grow",
        data={"draft": json.dumps({**draft, "force": True})},
        content_type="multipart/form-data",
    )
    assert grown.status_code == 201
    snapshot = client.get(f"/api/themes/{slug}/versions/2").get_json()
    assert snapshot["prompt"] == "grown prompt"
    assert snapshot["parents"] == [1]
    assert snapshot["assets"]["reference"][0]["name"] == "source.png"


def test_grow_preserves_the_managed_multi_image_order(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": [(BytesIO(PNG), "one.png"), (BytesIO(PNG), "two.png")]},
        content_type="multipart/form-data",
    )
    commit(client, slug, "Parent")
    draft = {
        "change_note": "Ordered child",
        "prompt": "child",
        "parents": [1],
        "result_order": [
            {"source": "upload", "index": 1},
            {"source": "existing", "index": 1},
            {"source": "upload", "index": 0},
        ],
    }

    response = client.post(
        f"/api/themes/{slug}/grow",
        data={
            "draft": json.dumps(draft),
            "result_files": [(BytesIO(PNG), "three.png"), (BytesIO(PNG), "four.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 201
    detail = client.get(f"/api/themes/{slug}/versions/2").get_json()
    assert [item["name"] for item in detail["assets"]["result"]] == ["four.png", "two.png", "three.png"]


def test_initial_working_tree_can_grow_into_a_root_node(client):
    theme = create_theme(client)
    slug = theme["slug"]
    draft = {
        "change_note": "Initial root",
        "prompt": "published root prompt",
        "parents": [],
    }

    grown = client.post(
        f"/api/themes/{slug}/grow",
        data={
            "draft": json.dumps(draft),
            "result_files": (BytesIO(PNG), "root.png"),
        },
        content_type="multipart/form-data",
    )

    assert grown.status_code == 201
    snapshot = client.get(f"/api/themes/{slug}/versions/1").get_json()
    assert snapshot["prompt"] == "published root prompt"
    assert snapshot["parents"] == []
    assert snapshot["assets"]["result"][0]["name"] == "root.png"


def test_blank_node_names_use_the_six_character_content_digest(client):
    theme = create_theme(client)
    slug = theme["slug"]
    grown = client.post(
        f"/api/themes/{slug}/grow",
        data={"draft": json.dumps({"change_note": "", "prompt": "auto named node", "parents": []})},
        content_type="multipart/form-data",
    )

    assert grown.status_code == 201
    first = client.get(f"/api/themes/{slug}/versions/1").get_json()
    assert first["change_note"] == first["digest"][:6]
    assert len(first["change_note"]) == 6

    updated = client.put(
        f"/api/themes/{slug}/versions/1",
        json={"change_note": "", "prompt": "renamed from updated content"},
    )
    assert updated.status_code == 200
    latest = client.get(f"/api/themes/{slug}/versions/1").get_json()
    assert latest["change_note"] == latest["digest"][:6]


def test_failed_initial_root_growth_restores_the_working_tree(client):
    theme = create_theme(client, "keep this root draft")
    slug = theme["slug"]
    response = client.post(
        f"/api/themes/{slug}/grow",
        data={
            "draft": json.dumps({
                "change_note": "Broken root",
                "prompt": "replacement",
                "parents": [],
            }),
            "result_files": (BytesIO(b"not an image"), "bad.png"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    current = client.get(f"/api/themes/{slug}").get_json()
    assert current["prompt"] == "keep this root draft"
    assert current["version_count"] == 0


def test_failed_initial_root_refs_write_restores_assets_and_removes_blobs(client, monkeypatch):
    theme = create_theme(client, "keep this root draft")
    slug = theme["slug"]
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "keep.png")},
        content_type="multipart/form-data",
    )
    store = client.application.extensions["vault_store"]
    blob_root = Path(theme["workspace_path"]).parent / ".assets"
    before = {path for path in blob_root.rglob("*") if path.is_file()}

    def fail_refs(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_write_refs", fail_refs)
    with pytest.raises(OSError, match="disk full"):
        store.grow_theme(
            slug,
            "Broken root",
            [],
            {"prompt": "replacement", "parents": []},
        )

    current = store.get_theme(slug)
    assert current["prompt"] == "keep this root draft"
    assert current["version_count"] == 0
    assert current["assets"]["result"][0]["name"] == "keep.png"
    assert {path for path in blob_root.rglob("*") if path.is_file()} == before


def test_failed_grow_restores_the_original_working_tree(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Root")
    client.put(f"/api/themes/{slug}", json={"prompt": "keep this draft"})
    draft = {
        "change_note": "Should fail",
        "prompt": "replacement",
        "parents": [1],
        "force": True,
    }
    response = client.post(
        f"/api/themes/{slug}/grow",
        data={"draft": json.dumps(draft), "reference_files": (BytesIO(b"not an image"), "bad.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    current = client.get(f"/api/themes/{slug}").get_json()
    assert current["prompt"] == "keep this draft"
    assert current["version_count"] == 1


def test_failed_grow_removes_newly_created_blobs(client):
    theme = create_theme(client)
    slug = theme["slug"]
    client.post(f"/api/themes/{slug}/commits", json={"message": "Root", "tag": "v1.0.0"})
    blob_root = Path(theme["workspace_path"]).parent / ".assets"
    before = {path for path in blob_root.rglob("*") if path.is_file()}
    draft = {
        "change_note": "Duplicate tag failure",
        "prompt": "replacement",
        "parents": [1],
        "tag": "v1.0.0",
        "force": True,
    }
    response = client.post(
        f"/api/themes/{slug}/grow",
        data={"draft": json.dumps(draft), "reference_files": (BytesIO(PNG), "valid.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert {path for path in blob_root.rglob("*") if path.is_file()} == before


def test_grow_does_not_roll_back_a_published_commit(client, monkeypatch):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Root")
    client.put(f"/api/themes/{slug}", json={"prompt": "main child"})
    commit(client, slug, "Main child")
    store = client.application.extensions["vault_store"]
    commit_theme = store.commit_theme

    def publish_then_fail(*args, **kwargs):
        commit_theme(*args, **kwargs)
        raise RuntimeError("response failed after publication")

    monkeypatch.setattr(store, "commit_theme", publish_then_fail)
    with pytest.raises(RuntimeError, match="after publication"):
        store.grow_theme(
            slug,
            "Published child",
            [1],
            {"prompt": "published prompt", "parents": [1]},
        )

    current = store.get_theme(slug)
    assert current["current_version"] == 3
    assert current["version_count"] == 3
    assert current["current_branch"].startswith("fork-0001")
    assert current["prompt"] == "published prompt"


def test_legacy_single_parent_manifests_are_exposed_as_parent_arrays(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Root")
    client.put(f"/api/themes/{slug}", json={"prompt": "legacy child"})
    commit(client, slug, "Child")

    manifest_path = Path(theme["workspace_path"]) / "history" / "0002" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.pop("parents")
    texts = {
        key: manifest_path.with_name(filename).read_text(encoding="utf-8")
        for key, filename in {"prompt": "prompt.md", "negative": "negative.md", "notes": "notes.md"}.items()
    }
    store = client.application.extensions["vault_store"]
    manifest["integrity"] = store._manifest_integrity(manifest, texts)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    listed = client.get(f"/api/themes/{slug}/versions").get_json()
    child = next(item for item in listed if item["version"] == 2)
    assert child["parent"] == 1
    assert child["parents"] == [1]
    assert client.get(f"/api/themes/{slug}/versions/2").get_json()["parents"] == [1]


def test_checkout_arbitrary_commit_requires_clean_working_tree_or_force(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Base")
    client.put(f"/api/themes/{slug}", json={"prompt": "second"})
    commit(client, slug, "Second")
    client.put(f"/api/themes/{slug}", json={"prompt": "unsaved"})

    refused = client.post(f"/api/themes/{slug}/versions/1/checkout")
    assert refused.status_code == 400
    forced = client.post(f"/api/themes/{slug}/versions/1/checkout", json={"force": True}).get_json()
    assert forced["working_base"] == 1
    assert forced["prompt"] == "first prompt"


def test_semantic_version_tags_can_be_created_moved_and_deleted(client):
    theme = create_theme(client)
    slug = theme["slug"]
    committed = client.post(f"/api/themes/{slug}/commits", json={"message": "Public baseline", "tag": "1.2.0"})
    assert committed.status_code == 201
    assert committed.get_json()["versions"][0]["tags"] == ["v1.2.0"]

    client.put(f"/api/themes/{slug}", json={"prompt": "second"})
    commit(client, slug, "Second")
    tagged = client.post(f"/api/themes/{slug}/tags", json={"name": "v2.0.0", "version": 2})
    assert tagged.status_code == 201
    assert tagged.get_json()["release_tags"] == [{"name": "v1.2.0", "version": 1}, {"name": "v2.0.0", "version": 2}]

    duplicate = client.post(f"/api/themes/{slug}/tags", json={"name": "2.0.0", "version": 1})
    assert duplicate.status_code == 400
    invalid = client.post(f"/api/themes/{slug}/tags", json={"name": "latest", "version": 2})
    assert invalid.status_code == 400
    removed = client.delete(f"/api/themes/{slug}/tags/v1.2.0")
    assert removed.status_code == 200
    assert removed.get_json()["release_tags"] == [{"name": "v2.0.0", "version": 2}]


def test_branch_pointer_move_restores_current_tree_and_can_orphan_commits(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Main")
    client.post(f"/api/themes/{slug}/branches", json={"name": "feature"})
    client.put(f"/api/themes/{slug}", json={"prompt": "feature prompt"})
    commit(client, slug, "Feature")
    client.post(f"/api/themes/{slug}/checkout", json={"branch": "main"})

    moved = client.post(f"/api/themes/{slug}/branches/main/move", json={"version": 2})
    assert moved.status_code == 200
    assert moved.get_json()["prompt"] == "feature prompt"
    assert moved.get_json()["current_version"] == 2
    assert moved.get_json()["dirty"] is False

    client.put(f"/api/themes/{slug}", json={"prompt": "unsaved"})
    refused = client.post(f"/api/themes/{slug}/branches/main/move", json={"version": 1})
    assert refused.status_code == 400
    forced = client.post(f"/api/themes/{slug}/branches/main/move", json={"version": 1, "force": True})
    assert forced.status_code == 200
    assert forced.get_json()["prompt"] == "first prompt"

    deleted = client.delete(f"/api/themes/{slug}/branches/feature")
    assert deleted.status_code == 200
    payload = deleted.get_json()
    assert [branch["name"] for branch in payload["branches"]] == ["main"]
    version_two = next(version for version in payload["versions"] if version["version"] == 2)
    assert version_two["branch_head"] is None
    assert version_two["reachable"] is False


def test_branch_deletion_rejects_current_branch_and_tags_keep_commits_reachable(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Main")
    client.post(f"/api/themes/{slug}/branches", json={"name": "feature"})
    client.put(f"/api/themes/{slug}", json={"prompt": "feature"})
    commit(client, slug, "Feature")
    client.post(f"/api/themes/{slug}/tags", json={"name": "v0.2.0", "version": 2})

    current = client.delete(f"/api/themes/{slug}/branches/feature")
    assert current.status_code == 400
    client.post(f"/api/themes/{slug}/checkout", json={"branch": "main"})
    deleted = client.delete(f"/api/themes/{slug}/branches/feature").get_json()
    version_two = next(version for version in deleted["versions"] if version["version"] == 2)
    assert version_two["reachable"] is True
    assert version_two["tags"] == ["v0.2.0"]


def test_only_active_status_is_exposed_while_archive_is_separate(client):
    theme = client.post("/api/themes", json={"title": "Legacy stage", "prompt": "x", "status": "ready"}).get_json()
    assert theme["status"] == "active"
    rejected = client.put(f"/api/themes/{theme['slug']}", json={"status": "refining"})
    assert rejected.status_code == 400
    archived = client.post(f"/api/themes/{theme['slug']}/archive").get_json()
    assert archived["archived"] is True
    assert archived["status"] == "active"


def test_commit_nodes_can_be_featured_favorited_hidden_and_restored(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Strong result")

    marked = client.post(f"/api/themes/{slug}/versions/1/marks", json={
        "featured": True,
        "favorite": True,
        "hidden": True,
    })
    assert marked.status_code == 200
    version = marked.get_json()["versions"][0]
    assert version["featured"] is True
    assert version["favorite"] is True
    assert version["hidden"] is True
    assert marked.get_json()["representative_version"] == 1
    assert marked.get_json()["representative_versions"][0]["version"] == 1

    restored = client.post(f"/api/themes/{slug}/versions/1/marks", json={"hidden": False}).get_json()
    assert restored["versions"][0]["hidden"] is False
    invalid = client.post(f"/api/themes/{slug}/versions/1/marks", json={"favorite": "false"})
    assert invalid.status_code == 400


def test_commit_node_can_be_overwritten_without_changing_tree_identity(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Base")
    client.put(f"/api/themes/{slug}", json={"prompt": "child"})
    commit(client, slug, "Child")

    updated = client.put(f"/api/themes/{slug}/versions/1", json={
        "change_note": "Renamed base",
        "prompt": "overwritten base",
        "model": "Krea 2",
    })
    assert updated.status_code == 200
    payload = updated.get_json()
    first = client.get(f"/api/themes/{slug}/versions/1").get_json()
    second = client.get(f"/api/themes/{slug}/versions/2").get_json()
    assert first["prompt"] == "overwritten base"
    assert first["change_note"] == "Renamed base"
    assert second["parent"] == 1
    assert payload["version_count"] == 2


def test_overwriting_working_base_preserves_dirty_working_tree(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Base")
    client.put(f"/api/themes/{slug}", json={"prompt": "unsaved live work"})

    response = client.put(f"/api/themes/{slug}/versions/1", json={"prompt": "rewritten archive"})
    assert response.status_code == 200
    assert client.get(f"/api/themes/{slug}/versions/1").get_json()["prompt"] == "rewritten archive"
    current = client.get(f"/api/themes/{slug}").get_json()
    assert current["prompt"] == "unsaved live work"
    assert current["dirty"] is True


def test_leaf_commit_can_be_deleted_without_reusing_internal_id(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Base")
    client.put(f"/api/themes/{slug}", json={"prompt": "second"})
    client.post(f"/api/themes/{slug}/commits", json={"message": "Leaf", "tag": "v1.0.0"})
    client.post(f"/api/themes/{slug}/versions/2/marks", json={"featured": True, "favorite": True})

    refused = client.delete(f"/api/themes/{slug}/versions/1")
    assert refused.status_code == 400
    assert "descendant" in refused.get_json()["message"]

    deleted = client.delete(f"/api/themes/{slug}/versions/2")
    assert deleted.status_code == 200
    payload = deleted.get_json()
    assert payload["current_version"] == 1
    assert payload["prompt"] == "first prompt"
    assert payload["release_tags"] == []
    assert payload["representative_version"] is None
    assert [version["version"] for version in payload["versions"]] == [1]

    client.put(f"/api/themes/{slug}", json={"prompt": "third"})
    next_commit = commit(client, slug, "After deletion")
    assert next_commit["current_version"] == 3


def test_deleting_current_leaf_with_dirty_working_tree_requires_force(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Base")
    client.put(f"/api/themes/{slug}", json={"prompt": "unsaved"})
    refused = client.delete(f"/api/themes/{slug}/versions/1")
    assert refused.status_code == 400
    forced = client.delete(f"/api/themes/{slug}/versions/1?force=true")
    assert forced.status_code == 200
    assert forced.get_json()["current_version"] is None
    assert forced.get_json()["prompt"] == ""
    assert forced.get_json()["can_create_root"] is False


def test_new_branch_keeps_uncommitted_working_tree(client):
    theme = create_theme(client)
    slug = theme["slug"]
    branched = client.post(f"/api/themes/{slug}/branches", json={"name": "first-direction"}).get_json()
    assert branched["current_branch"] == "first-direction"
    assert branched["prompt"] == "first prompt"
    assert branched["dirty"] is True
    archived = commit(client, slug, "First direction")
    assert archived["versions"][0]["parent"] is None
    assert {item["name"]: item["head"] for item in archived["branches"]} == {"main": None, "first-direction": 1}


def test_checkout_boolean_values_must_be_real_json_booleans(client):
    theme = create_theme(client)
    response = client.post(f"/api/themes/{theme['slug']}/branches", json={"name": "bad", "checkout": "false"})
    assert response.status_code == 400
    assert response.get_json()["message"] == "checkout must be a boolean"
    response = client.post(f"/api/themes/{theme['slug']}/checkout", json={"branch": "main", "force": "false"})
    assert response.status_code == 400
    assert response.get_json()["message"] == "force must be a boolean"
    response = client.post(f"/api/themes/{theme['slug']}/branches", json={"name": "bad-version", "from_version": "1"})
    assert response.status_code == 400
    assert response.get_json()["message"] == "from_version must be a positive integer"


def test_failed_refs_write_removes_unpublished_commit(client, monkeypatch):
    theme = create_theme(client)
    store = client.application.extensions["vault_store"]

    def fail_refs(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_write_refs", fail_refs)
    with pytest.raises(OSError, match="disk full"):
        store.commit_theme(theme["slug"], "Should roll back")
    assert store.list_versions(theme["slug"]) == []
    assert store.get_theme(theme["slug"])["current_version"] is None


def test_failed_checkout_refs_write_restores_previous_tree(client, monkeypatch):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Main")
    client.post(f"/api/themes/{slug}/branches", json={"name": "feature"})
    client.put(f"/api/themes/{slug}", json={"prompt": "feature prompt"})
    commit(client, slug, "Feature")
    client.post(f"/api/themes/{slug}/checkout", json={"branch": "main"})
    store = client.application.extensions["vault_store"]

    def fail_refs(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_write_refs", fail_refs)
    with pytest.raises(OSError, match="disk full"):
        store.checkout_branch(slug, "feature")
    unchanged = store.get_theme(slug)
    assert unchanged["current_branch"] == "main"
    assert unchanged["current_version"] == 1
    assert unchanged["prompt"] == "first prompt"


def test_checkout_validates_all_assets_before_changing_working_tree(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Main")
    client.post(f"/api/themes/{slug}/branches", json={"name": "with-asset"})
    client.post(
        f"/api/themes/{slug}/assets",
        data={"kind": "reference", "files": (BytesIO(PNG), "reference.png")},
        content_type="multipart/form-data",
    )
    feature = commit(client, slug, "Add reference")
    record = feature["assets"]["reference"][0]
    client.post(f"/api/themes/{slug}/checkout", json={"branch": "main"})
    blob_dir = Path(feature["workspace_path"]).parent / ".assets" / record["sha256"][:2]
    next(blob_dir.glob(f"{record['sha256']}.*")).unlink()

    failed = client.post(f"/api/themes/{slug}/checkout", json={"branch": "with-asset"})
    assert failed.status_code == 404
    unchanged = client.get(f"/api/themes/{slug}").get_json()
    assert unchanged["current_branch"] == "main"
    assert unchanged["current_version"] == 1
    assert unchanged["assets"]["reference"] == []


def test_malformed_theme_metadata_is_reported_without_overwrite(client):
    theme = create_theme(client)
    metadata = Path(theme["workspace_path"]) / "theme.json"
    metadata.write_text('{"title":', encoding="utf-8")
    response = client.get(f"/api/themes/{theme['slug']}")
    assert response.status_code == 400
    assert metadata.read_text(encoding="utf-8") == '{"title":'


def test_one_invalid_theme_does_not_break_listing(client):
    broken = create_theme(client, "broken")
    valid = client.post("/api/themes", json={"title": "Valid", "prompt": "working"}).get_json()
    Path(broken["workspace_path"]).joinpath("theme.json").write_text("[]", encoding="utf-8")
    response = client.get("/api/themes")
    assert response.status_code == 200
    assert [item["slug"] for item in response.get_json()] == [valid["slug"]]


def test_history_provenance_is_integrity_checked(client):
    theme = create_theme(client)
    commit(client, theme["slug"], "Initial")
    manifest_path = Path(theme["workspace_path"]) / "history" / "0001" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["actor"] = "tampered"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    response = client.get(f"/api/themes/{theme['slug']}/versions/1")
    assert response.status_code == 400
    assert "provenance failed integrity verification" in response.get_json()["message"]


def test_legacy_database_migration_creates_one_initial_commit(tmp_path):
    legacy = tmp_path / "vault.db"
    db = sqlite3.connect(legacy)
    db.execute("""CREATE TABLE prompts (
        id INTEGER PRIMARY KEY, title TEXT, content TEXT, category TEXT, tags TEXT,
        notes TEXT, negative TEXT, image_url TEXT, model TEXT, params TEXT,
        starred INTEGER, created_at TEXT, updated_at TEXT
    )""")
    db.execute(
        "INSERT INTO prompts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (7, "Legacy", "old prompt", "海报", "old,poster", "note", "bad", "https://example.com/ref.png", "SDXL", "steps 30", 1, "2025-01-01", "2025-01-02"),
    )
    db.commit()
    db.close()
    workspace = tmp_path / "workspace"
    first = create_app(workspace, legacy, token="").test_client().get("/api/themes").get_json()
    second = create_app(workspace, legacy, token="").test_client().get("/api/themes").get_json()
    assert len(first) == len(second) == 1
    assert first[0]["version_count"] == 1
    assert first[0]["dirty"] is False
    assert first[0]["legacy"]["prompt_id"] == 7


def test_existing_history_without_refs_becomes_main_head(client):
    theme = create_theme(client)
    committed = commit(client, theme["slug"], "Initial")
    Path(committed["workspace_path"]).joinpath("refs.json").unlink()
    reopened = client.get(f"/api/themes/{theme['slug']}").get_json()
    assert reopened["current_branch"] == "main"
    assert reopened["current_version"] == 1
    assert reopened["dirty"] is False


def test_missing_refs_reconstructs_all_branch_heads(client):
    theme = create_theme(client)
    slug = theme["slug"]
    commit(client, slug, "Base")
    client.post(f"/api/themes/{slug}/branches", json={"name": "feature"})
    client.put(f"/api/themes/{slug}", json={"prompt": "feature prompt"})
    commit(client, slug, "Feature")
    client.post(f"/api/themes/{slug}/checkout", json={"branch": "main"})
    client.put(f"/api/themes/{slug}", json={"prompt": "main prompt"})
    committed = commit(client, slug, "Main follow-up")
    Path(committed["workspace_path"]).joinpath("refs.json").unlink()

    reopened = client.get(f"/api/themes/{slug}").get_json()
    assert reopened["current_branch"] == "main"
    assert {item["name"]: item["head"] for item in reopened["branches"]} == {"main": 3, "feature": 2}
    assert reopened["dirty"] is False


def test_theme_can_be_duplicated_archived_and_restored_without_commits(client):
    source = create_theme(client)
    client.post(
        f"/api/themes/{source['slug']}/assets",
        data={"kind": "reference", "files": (BytesIO(PNG), "mood.png")},
        content_type="multipart/form-data",
    )
    copy = client.post(f"/api/themes/{source['slug']}/duplicate").get_json()
    assert copy["title"] == "Homepage mascot 副本"
    assert copy["version_count"] == 0
    assert copy["dirty"] is True
    assert copy["assets"]["reference"][0]["name"] == "mood.png"
    archived = client.post(f"/api/themes/{copy['slug']}/archive").get_json()
    assert archived["archived"] is True
    assert archived["version_count"] == 0
    restored = client.post(f"/api/themes/{copy['slug']}/archive").get_json()
    assert restored["archived"] is False


def test_optional_token_protects_api(client):
    client.application.config["VAULT_TOKEN"] = "secret-token"
    assert client.get("/api/themes").status_code == 401
    assert client.get("/api/themes", headers={"X-Vault-Token": "secret-token"}).status_code == 200


def test_token_cookie_allows_browser_image_requests(client):
    theme = create_theme(client)
    upload = client.post(
        f"/api/themes/{theme['slug']}/assets",
        data={"kind": "result", "files": (BytesIO(PNG), "result.png")},
        content_type="multipart/form-data",
    ).get_json()
    image_url = upload["assets"]["result"][0]["url"]
    client.application.config["VAULT_TOKEN"] = "secret-token"
    assert client.get(image_url).status_code == 401
    client.set_cookie("prompt_vault_token", "secret-token")
    assert client.get(image_url).status_code == 200

    client.application.config["VAULT_TOKEN"] = "abc/def"
    client.set_cookie("prompt_vault_token", "abc%2Fdef")
    assert client.get(image_url).status_code == 200

    client.application.config["VAULT_TOKEN"] = "abc;def%ghi"
    client.set_cookie("prompt_vault_token", "abc%3Bdef%25ghi")
    assert client.get(image_url).status_code == 200


def test_empty_default_token_file_is_replaced(tmp_path, monkeypatch):
    token_file = tmp_path / ".vault-token"
    token_file.write_text("\n", encoding="utf-8")
    monkeypatch.delenv("PROMPT_VAULT_TOKEN", raising=False)
    monkeypatch.setenv("PROMPT_VAULT_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("PROMPT_VAULT_WORKSPACE", str(tmp_path / "workspace"))

    application = create_app()

    assert application.config["VAULT_TOKEN"]
    assert token_file.read_text(encoding="utf-8").strip() == application.config["VAULT_TOKEN"]


def test_malformed_json_is_rejected(client):
    response = client.post("/api/themes", data="{bad", content_type="application/json")
    assert response.status_code == 400


def test_agent_schema_requires_explicit_commit(client):
    payload = client.get("/api/agent/schema").get_json()
    assert payload["format"] == "prompt-vault/agent/v3"
    assert payload["endpoints"]["commit"].startswith("POST /api/themes")
    assert "/versions/{version}/checkout" in payload["endpoints"]["checkout_version"]
    assert payload["endpoints"]["discard_working"].startswith("POST /api/themes/{slug}/discard")
    assert "working_base" in payload["version_semantics"]["arbitrary_node_editing"]
    assert "only when the user explicitly asks" in payload["write_contract"][3]
