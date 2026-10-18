"""Real handoff, partial validation, recovery, and approval boundaries."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from test_git_runner import SHELL_PYTHON, git, make_demo_repo

from mergetrain.cli import main
from mergetrain.config import load_config
from mergetrain.persistence.connection import connect
from mergetrain.persistence.jobs import enqueue_job, get_job, mark_job


class AgentProcedureTests(unittest.TestCase):
    def invoke(self, repo: Path, *args: str) -> tuple[int, dict]:
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(["--repo", str(repo), *args, "--json"])
        return code, json.loads(out.getvalue())

    def test_batch_survivor_lands_before_repair_and_retry_keeps_approval_manual(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            gate = f'''{SHELL_PYTHON} -c "from pathlib import Path; assert not Path('bad.txt').exists()"'''
            repo, _ = make_demo_repo(root, gate_command=gate)
            git(repo, "add", ".mergetrain.yaml")
            git(repo, "commit", "-m", "project gate")
            git(repo, "push", "origin", "main")
            base = git(root / "remote.git", "rev-parse", "main")
            jobs = []
            for name in ("bad", "good"):
                worktree = root / name
                git(repo, "worktree", "add", "-b", f"task/{name}", str(worktree), "main")
                (worktree / f"{name}.txt").write_text(name)
                git(worktree, "add", ".")
                git(worktree, "commit", "-m", name)
                code, queued = self.invoke(repo, "enqueue", "--task", name, "--branch", f"task/{name}")
                self.assertEqual(code, 0, queued)
                jobs.append(queued["job"])
            code, validated = self.invoke(repo, "validate")
            self.assertEqual(code, 1, validated)
            self.assertEqual(validated["result"], "partial")
            _, status = self.invoke(repo, "status")
            self.assertEqual(status["counts"]["attention"], 1)
            self.assertEqual(status["counts"]["ready"], 1)
            self.assertEqual(status["next_action"]["code"], "deploy_when_approved")
            self.assertEqual(status["next_action"]["requires_approval"], "deploy")
            _, inspected = self.invoke(repo, "inspect", str(jobs[0]["id"]))
            self.assertEqual(inspected["retry_command"], f"mergetrain retry {jobs[0]['id']}")
            _, plan = self.invoke(repo, "deploy")
            self.assertEqual(plan["result"], "confirmation_required")
            self.assertEqual([job["id"] for job in plan["jobs"]], [jobs[1]["id"]])
            self.assertEqual(git(root / "remote.git", "rev-parse", "main"), base)
            code, deployed = self.invoke(repo, "deploy", "--expected-plan", plan["deploy_plan_sha"])
            self.assertEqual(code, 0, deployed)
            self.assertEqual(git(root / "remote.git", "show", "main:good.txt"), "good")
            self.assertNotIn("bad.txt", git(root / "remote.git", "ls-tree", "--name-only", "main"))
            (root / "bad" / "bad.txt").unlink()
            git(root / "bad", "add", ".")
            git(root / "bad", "commit", "-m", "repair failed work")
            code, retry = self.invoke(repo, "retry", str(jobs[0]["id"]))
            self.assertEqual(code, 0, retry)
            self.assertFalse(retry["job"]["auto_deploy"])
            repaired_id = retry["job"]["id"]
            repaired_head = git(root / "remote.git", "rev-parse", "main")
            with redirect_stdout(io.StringIO()):
                main(["--repo", str(repo), "daemon", "--once"])
            self.assertEqual(git(root / "remote.git", "rev-parse", "main"), repaired_head)
            code, validated = self.invoke(repo, "validate")
            self.assertEqual(code, 0, validated)
            _, plan = self.invoke(repo, "deploy")
            self.assertEqual(plan["result"], "confirmation_required")
            code, deployed = self.invoke(repo, "deploy", "--expected-plan", plan["deploy_plan_sha"])
            self.assertEqual(code, 0, deployed)
            conn = connect(load_config(repo=repo).state.db)
            try:
                self.assertEqual(get_job(conn, jobs[0]["id"]).status, "canceled")
                self.assertEqual(get_job(conn, repaired_id).status, "deployed")
            finally:
                conn.close()

    def test_duplicate_reports_existing_job_outside_recent_history(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo, _ = make_demo_repo(Path(td))
            git(repo, "add", ".mergetrain.yaml")
            git(repo, "commit", "-m", "project gate")
            git(repo, "switch", "feature/a")
            git(repo, "rebase", "main")
            _, original = self.invoke(repo, "enqueue", "--task", "first", "--branch", "feature/a")
            conn = connect(load_config(repo=repo).state.db)
            try:
                for index in range(21):
                    enqueue_job(conn, task=str(index), branch=f"later/{index}")
            finally:
                conn.close()
            code, repeated = self.invoke(repo, "enqueue", "--task", "repeat", "--branch", "feature/a")
            self.assertEqual(code, 1)
            self.assertEqual(repeated["error"]["code"], "duplicate_active_branch")
            self.assertEqual(repeated["existing_job_id"], original["job"]["id"])
            _, status = self.invoke(repo, "status")
            self.assertNotIn(original["job"]["id"], [job["id"] for job in status["recent_jobs"]])
            _, inspected = self.invoke(repo, "inspect", str(repeated["existing_job_id"]))
            self.assertEqual(inspected["job"]["head_sha"], original["job"]["head_sha"])
            self.assertNotIn("retry_command", inspected)

    def test_retry_hint_excludes_uncertain_push_and_deployed_verification(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo, _ = make_demo_repo(Path(td))
            conn = connect(load_config(repo=repo).state.db)
            try:
                for status in ("blocked", "failed", "needs_reconcile", "deployed"):
                    job = enqueue_job(conn, task=status, branch=status)
                    mark_job(conn, job.id, status=status)
                    conn.execute("UPDATE deploy_queue SET pending_deploy_sha = ? WHERE id = ?",
                                 ("uncertain", job.id))
                    conn.commit()
                    _, inspected = self.invoke(repo, "inspect", str(job.id))
                    self.assertNotIn("retry_command", inspected)
            finally:
                conn.close()
