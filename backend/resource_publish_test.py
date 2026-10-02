"""Exercise resource publication against disposable Git repositories and local origins."""
import os
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from flitfancy_resources import ResourceService


def git(directory, *args):
    return subprocess.run(
        ["git", *args], cwd=directory, check=True, capture_output=True,
        encoding="utf-8", errors="replace", timeout=30,
    ).stdout.strip()


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix="flit-resource-publish-") as directory, mock.patch.dict(
        os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    ):
        root = Path(directory)
        repo = root / "repo"
        repo.mkdir()
        remote = root / "remote.git"
        git(repo, "init", "-b", "main")
        git(repo, "config", "user.email", "fixture@example.invalid")
        git(repo, "config", "user.name", "Fixture")
        git(repo, "config", "core.autocrlf", "false")
        resources = repo / "docs" / "resources"
        resources.mkdir(parents=True)
        (resources / "manifest.json").write_text("[]\n", encoding="utf-8")
        (resources / "old.txt").write_text("old download\n", encoding="utf-8")
        (repo / "unrelated.txt").write_text("original\n", encoding="utf-8")
        (repo / "other.txt").write_text("original\n", encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-m", "Initial fixture")
        git(repo, "init", "--bare", str(remote))
        git(repo, "remote", "add", "origin", str(remote))
        git(repo, "push", "origin", "main")
        yield repo, remote, resources, ResourceService(str(repo / "docs"), lambda: "fixture")


def stage_unrelated(repo):
    (repo / "unrelated.txt").write_text("staged change\n", encoding="utf-8")
    git(repo, "add", "unrelated.txt")
    (repo / "unrelated.txt").write_text("different unstaged change\n", encoding="utf-8")
    (repo / "other.txt").write_text("unstaged other\n", encoding="utf-8")
    (repo / "untracked.txt").write_text("untracked\n", encoding="utf-8")
    return git(repo, "diff", "--cached", "--binary", "--", "unrelated.txt")


def assert_unrelated_preserved(repo, staged):
    assert git(repo, "diff", "--cached", "--binary", "--", "unrelated.txt") == staged
    assert (repo / "unrelated.txt").read_text(encoding="utf-8") == "different unstaged change\n"
    assert (repo / "other.txt").read_text(encoding="utf-8") == "unstaged other\n"
    assert (repo / "untracked.txt").read_text(encoding="utf-8") == "untracked\n"


def test_scoped_commit():
    with fixture() as (repo, remote, resources, service):
        staged = stage_unrelated(repo)
        (resources / "manifest.json").write_text('[{"title":"edited"}]\n', encoding="utf-8")
        (resources / "new.txt").write_text("new download\n", encoding="utf-8")
        (resources / "old.txt").unlink()
        ok, note = service.publish()
        assert ok, note
        changed = set(git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").splitlines())
        assert changed == {"docs/resources/manifest.json", "docs/resources/new.txt", "docs/resources/old.txt"}
        assert git(remote, "rev-parse", "main") == git(repo, "rev-parse", "HEAD")
        assert git(remote, "show", "main:unrelated.txt") == "original"
        assert_unrelated_preserved(repo, staged)


def test_failed_push_retry():
    with fixture() as (repo, remote, resources, service):
        staged = stage_unrelated(repo)
        baseline = git(remote, "rev-parse", "main")
        hook = remote / "hooks" / "pre-receive"
        hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8", newline="\n")
        hook.chmod(0o755)
        (resources / "manifest.json").write_text('[{"title":"retry"}]\n', encoding="utf-8")
        ok, note = service.publish()
        assert not ok and "推送失败" in note, note
        committed = git(repo, "rev-parse", "HEAD")
        assert committed != baseline
        assert git(remote, "rev-parse", "main") == baseline
        assert_unrelated_preserved(repo, staged)
        hook.unlink()
        ok, note = service.publish()
        assert ok, note
        assert git(repo, "rev-parse", "HEAD") == committed, "retry must reuse the resource commit"
        assert git(remote, "rev-parse", "main") == committed
        assert_unrelated_preserved(repo, staged)


def test_unrelated_history(reverted=False):
    with fixture() as (repo, remote, resources, service):
        baseline = git(remote, "rev-parse", "main")
        (repo / "unrelated.txt").write_text("unpublished code\n", encoding="utf-8")
        git(repo, "add", "unrelated.txt")
        git(repo, "commit", "-m", "Unpublished unrelated code")
        if reverted:
            git(repo, "revert", "--no-edit", "HEAD")
        before = git(repo, "rev-parse", "HEAD")
        staged = stage_unrelated(repo)
        index = git(repo, "write-tree")
        (resources / "manifest.json").write_text('[{"title":"retained"}]\n', encoding="utf-8")
        ok, note = service.publish()
        assert not ok and "其他代码提交" in note, note
        assert git(repo, "rev-parse", "HEAD") == before
        assert git(repo, "write-tree") == index, "rejected publication must not stage resources"
        assert git(remote, "rev-parse", "main") == baseline
        assert (resources / "manifest.json").read_text(encoding="utf-8") == '[{"title":"retained"}]\n'
        assert_unrelated_preserved(repo, staged)


def test_merge_and_detached_head():
    with fixture() as (repo, remote, resources, service):
        baseline = git(remote, "rev-parse", "main")
        git(repo, "checkout", "-b", "resource-side")
        (resources / "side.txt").write_text("side\n", encoding="utf-8")
        git(repo, "add", "docs/resources")
        git(repo, "commit", "-m", "Resource side branch")
        git(repo, "checkout", "main")
        git(repo, "merge", "--no-ff", "resource-side", "-m", "Merge resources")
        before = git(repo, "rev-parse", "HEAD")
        ok, note = service.publish()
        assert not ok and "合并提交" in note, note
        assert git(remote, "rev-parse", "main") == baseline
        assert git(repo, "rev-parse", "HEAD") == before
        git(repo, "checkout", "--detach", "HEAD")
        ok, note = service.publish()
        assert not ok and "不在可发布分支" in note, note
        assert git(remote, "rev-parse", "main") == baseline


def test_remote_advance():
    with fixture() as (repo, remote, resources, service):
        baseline = git(repo, "rev-parse", "HEAD")
        sibling = repo.parent / "sibling"
        git(repo, "clone", "-b", "main", str(remote), str(sibling))
        git(sibling, "config", "user.email", "fixture@example.invalid")
        git(sibling, "config", "user.name", "Fixture")
        (sibling / "other.txt").write_text("remote advance\n", encoding="utf-8")
        git(sibling, "add", "other.txt")
        git(sibling, "commit", "-m", "Advance remote")
        git(sibling, "push", "origin", "main")
        advanced = git(remote, "rev-parse", "main")
        (resources / "manifest.json").write_text('[{"title":"retained"}]\n', encoding="utf-8")
        index = git(repo, "write-tree")
        ok, note = service.publish()
        assert not ok and "本地分支与远端不一致" in note, note
        assert git(repo, "rev-parse", "HEAD") == baseline
        assert git(repo, "write-tree") == index
        assert git(remote, "rev-parse", "main") == advanced


def run():
    test_scoped_commit()
    test_failed_push_retry()
    test_unrelated_history()
    test_unrelated_history(reverted=True)
    test_merge_and_detached_head()
    test_remote_advance()
    print("Resource publication: scoped commits, preserved index/worktree, push retry, outgoing history and branch guards passed")


if __name__ == "__main__":
    run()
