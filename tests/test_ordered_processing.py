"""Ordered admission against real queue state and a disposable Git remote."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from pathlib import Path

from test_git_runner import SHELL_PYTHON, git, make_demo_repo

from mergetrain.cli import main
from mergetrain.config import load_config
from mergetrain.daemon import daemon_tick
from mergetrain.deploy_plan import deploy_destination_sha, deploy_execution_policy_sha
from mergetrain.errors import ConfigError, DuplicateActiveBranch, QueueError
from mergetrain.git_runner import GitRunner
from mergetrain.persistence.claims import claim_all_queued, claim_deploy_batch
from mergetrain.persistence.connection import connect
from mergetrain.persistence.jobs import (
    cancel_job,
    enqueue_job,
    get_job,
    mark_job,
    ordered_head,
    retry_job,
)
from mergetrain.persistence.leases import release_runner_lock
from mergetrain.persistence.schema import SCHEMA_VERSION
from mergetrain.snapshot import plan_next_action


class OrderedStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "queue.sqlite"
        self.conn = connect(self.db)
        self.addCleanup(self.conn.close)
        self.owner = f"ordered:{os.getpid()}"

    def enqueue(self, name: str, *, auto: bool = False):
        return enqueue_job(
            self.conn, task=name, branch=name, auto_deploy=auto,
            approval_destination_sha="destination", approval_execution_policy_sha="policy",
        )

    def claim(self, **kwargs):
        return claim_all_queued(
            self.conn, owner=self.owner, processing="ordered", **kwargs,
        )

    def release(self, job) -> None:
        release_runner_lock(self.conn, owner=self.owner, token=job.claim_token)

    def test_failed_head_and_repeated_retries_keep_the_original_position(self) -> None:
        first, second, third = [self.enqueue(name) for name in ("first", "second", "third")]
        claimed = self.claim()
        self.assertEqual([job.id for job in claimed], [first.id])
        mark_job(self.conn, first.id, status="failed")
        self.release(claimed[0])
        self.assertEqual(self.claim(), [])
        replacement = first
        for revision in ("repair-one", "repair-two"):
            _, replacement = retry_job(
                self.conn, replacement.id, base_sha="base", head_sha=revision,
                preserve_order=True,
            )
            self.assertEqual(replacement.queue_order, first.id)
            self.assertEqual(ordered_head(self.conn).id, replacement.id)
            (claimed_job,) = self.claim()
            self.assertEqual(claimed_job.id, replacement.id)
            mark_job(self.conn, replacement.id, status="failed")
            self.release(claimed_job)
        cancel_job(self.conn, replacement.id, note="operator explicitly resolves this submission")
        (claimed_job,) = self.claim()
        self.assertEqual(claimed_job.id, second.id)
        self.assertEqual(get_job(self.conn, third.id).status, "queued")
        self.release(claimed_job)

    def test_batch_retry_keeps_the_existing_back_of_queue_behavior(self) -> None:
        first, second = self.enqueue("first"), self.enqueue("second")
        mark_job(self.conn, first.id, status="failed")
        _, replacement = retry_job(self.conn, first.id, base_sha="base", head_sha="repair")
        self.assertEqual(replacement.queue_order, replacement.id)
        jobs = claim_all_queued(self.conn, owner=self.owner)
        self.assertEqual([job.id for job in jobs], [second.id, replacement.id])
        self.release(jobs[0])

    def test_separate_repair_branch_preserves_order_without_inheriting_auto_approval(self) -> None:
        first = self.enqueue("first", auto=True)
        self.enqueue("later", auto=True)
        mark_job(self.conn, first.id, status="failed")
        _, repair = retry_job(
            self.conn, first.id, base_sha="base", head_sha="repair",
            branch="repair/first", worktree_path="/repair", preserve_order=True,
            current_approval_destination_sha="destination",
            current_approval_execution_policy_sha="policy",
        )
        self.assertFalse(repair.auto_deploy)
        self.assertEqual(repair.queue_order, first.id)
        self.assertEqual(get_job(self.conn, first.id).branch, "first")
        self.assertEqual(self.claim(auto_only=True), [])
        mark_job(self.conn, repair.id, status="failed")
        _, renewed = retry_job(
            self.conn, repair.id, base_sha="base", head_sha="repair-two", preserve_order=True,
            renew_auto=True, current_approval_destination_sha="reviewed-destination",
            current_approval_execution_policy_sha="reviewed-policy",
        )
        self.assertTrue(renewed.auto_deploy)
        self.assertEqual(renewed.approval_destination_sha, "reviewed-destination")
        self.assertEqual(renewed.queue_order, first.id)

    def test_missing_renewed_approval_or_duplicate_repair_is_atomic(self) -> None:
        first = self.enqueue("first")
        mark_job(self.conn, first.id, status="failed")
        with self.assertRaisesRegex(QueueError, "requires its clean owning worktree"):
            retry_job(self.conn, first.id, base_sha="base", head_sha="repair", branch="repair")
        with self.assertRaisesRegex(QueueError, "current destination and policy"):
            retry_job(self.conn, first.id, base_sha="base", head_sha="repair", renew_auto=True)
        self.enqueue("occupied-repair")
        with self.assertRaises(DuplicateActiveBranch):
            retry_job(
                self.conn, first.id, base_sha="base", head_sha="repair",
                branch="occupied-repair", worktree_path="/repair",
            )
        self.assertEqual(get_job(self.conn, first.id).status, "failed")

    def test_auto_and_validation_runners_cannot_pass_an_unauthorized_head(self) -> None:
        for head_auto in (False, True):
            with self.subTest(head_auto=head_auto):
                self.conn.execute("DELETE FROM deploy_queue")
                self.conn.commit()
                first = self.enqueue("first", auto=head_auto)
                second = self.enqueue("second", auto=not head_auto)
                self.assertEqual(self.claim(auto_only=not head_auto, manual_only=head_auto), [])
                jobs = self.claim(auto_only=head_auto, manual_only=not head_auto)
                self.assertEqual([job.id for job in jobs], [first.id])
                self.assertEqual(get_job(self.conn, second.id).status, "queued")
                self.release(jobs[0])

    def test_failed_or_unknown_verification_holds_later_submissions(self) -> None:
        for verify in ("failed", "unknown"):
            with self.subTest(verify=verify):
                self.conn.execute("DELETE FROM deploy_queue")
                self.conn.commit()
                first, second = self.enqueue("first"), self.enqueue("second")
                mark_job(self.conn, first.id, status="deployed", verify_status=verify)
                self.assertEqual(self.claim(), [])
                self.assertEqual(claim_deploy_batch(
                    self.conn, owner=self.owner, processing="ordered",
                ), [])
                mark_job(self.conn, first.id, status="deployed", verify_status="succeeded")
                (claimed,) = self.claim()
                self.assertEqual(claimed.id, second.id)
                self.release(claimed)

    def test_policy_failure_does_not_allow_the_next_auto_job_to_pass(self) -> None:
        first, second = self.enqueue("first", auto=True), self.enqueue("second", auto=True)
        blocked = []
        self.assertEqual(self.claim(
            auto_only=True, approval_destination_sha="destination",
            approval_execution_policy_sha="changed", blocked=blocked,
        ), [])
        self.assertEqual([job.id for job in blocked], [first.id])
        self.assertEqual(get_job(self.conn, second.id).status, "queued")
        self.assertEqual(self.claim(auto_only=True), [])

    def test_migration_preserves_pending_work_and_fences_an_older_writer(self) -> None:
        first, second = self.enqueue("first"), self.enqueue("second")
        self.conn.execute("UPDATE deploy_queue SET queue_order = 0")
        self.conn.execute("PRAGMA user_version = 15")
        self.conn.commit()
        migrated = connect(self.db)
        self.addCleanup(migrated.close)
        self.assertEqual(migrated.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
        self.assertEqual(get_job(migrated, first.id).queue_order, first.id)
        self.assertEqual(get_job(migrated, second.id).status, "queued")
        from unittest.mock import patch

        with patch("mergetrain.persistence.schema.SCHEMA_VERSION", 15):
            with self.assertRaisesRegex(QueueError, "newer than supported"):
                connect(self.db)

    def test_status_guides_the_head_even_with_later_attention_and_mixed_approval(self) -> None:
        first = self.enqueue("manual")
        later = self.enqueue("later", auto=True)
        mark_job(self.conn, later.id, status="failed")
        action = plan_next_action(
            {"counts": {"queued": 1, "auto_queued": 1, "failed": 1}},
            attention_jobs=[get_job(self.conn, later.id)], ordered_job=first,
        )
        self.assertEqual(action.code, "validate_queued_jobs")
        self.assertEqual(action.target_job_id, first.id)

    def test_an_existing_ready_batch_cannot_be_reinterpreted_as_ordered(self) -> None:
        first, second = self.enqueue("first"), self.enqueue("second")
        for job in (first, second):
            mark_job(
                self.conn, job.id, status="validated", train_id="existing-batch", train_size=2,
                validated_at="2026-10-15T00:00:00Z",
                validation_sha="candidate", validation_base_sha="base", validated_head_sha="head",
            )
        with self.assertRaisesRegex(QueueError, "earliest unfinished job"):
            claim_deploy_batch(self.conn, owner=self.owner, processing="ordered")
        self.assertEqual(get_job(self.conn, first.id).status, "validated")
        self.assertEqual(get_job(self.conn, second.id).status, "validated")


class OrderedWorkflowTests(unittest.TestCase):
    def invoke(self, repo: Path, *args: str) -> tuple[int, dict]:
        stream = io.StringIO()
        with redirect_stdout(stream):
            result = main(["--repo", str(repo), *args, "--json"])
        return result, json.loads(stream.getvalue())

    def test_parallel_handoffs_repair_restart_and_individual_atomic_landings(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            # Like Darklang, compare candidates against the preceding landing.
            # The middle candidate fails deterministically until repaired.
            gate = (
                f'{SHELL_PYTHON} -c "from pathlib import Path; '
                "assert not Path('broken.txt').exists(), 'repair the middle submission'\""
            )
            repo, _marker = make_demo_repo(root, gate_command=gate)
            config_path = repo / ".mergetrain.yaml"
            config_path.write_text(config_path.read_text().replace(
                "queue:\n", "queue:\n  processing: ordered\n",
            ), encoding="utf-8")
            git(repo, "add", ".mergetrain.yaml")
            git(repo, "commit", "-m", "configure ordered integration")
            git(repo, "push", "origin", "main")
            branches = []
            for name in ("first", "middle", "last"):
                worktree = root / name
                git(repo, "worktree", "add", "-b", f"task/{name}", str(worktree), "main")
                (worktree / f"{name}.txt").write_text(name, encoding="utf-8")
                if name == "middle":
                    (worktree / "broken.txt").write_text("repair me", encoding="utf-8")
                git(worktree, "add", ".")
                git(worktree, "commit", "-m", name)
                code, result = self.invoke(repo, "enqueue", "--task", name,
                                           "--branch", f"task/{name}", "--auto")
                self.assertEqual(code, 0, result)
                branches.append((worktree, result["job"]))
            config = load_config(repo=repo)

            def tick():
                # Reopen both config and database, as after a process restart.
                current = load_config(repo=repo)
                owner = f"workflow:{os.getpid()}"
                return daemon_tick(
                    db_path=str(current.state.db), owner=owner, say=lambda _: None,
                    processing=current.queue.processing,
                    approval_destination_sha=deploy_destination_sha(current),
                    approval_execution_policy_sha=deploy_execution_policy_sha(current),
                    process_batch=lambda conn, jobs: GitRunner(current).process_batch(
                        conn, jobs, deploy=True, keep_worktree=False, owner=owner,
                    ),
                )

            self.assertEqual(tick(), "landed:1")
            first_sha = git(root / "remote.git", "rev-parse", "main")
            self.assertEqual(tick(), "no_landing:1")
            self.assertEqual(tick(), "idle")
            self.assertEqual(git(root / "remote.git", "rev-parse", "main"), first_sha)
            middle_worktree, middle = branches[1]
            original_head = git(middle_worktree, "rev-parse", "HEAD")
            repair = root / "repair"
            git(repo, "worktree", "add", "-b", "repair/middle", str(repair), "origin/main")
            git(repair, "cherry-pick", original_head)
            (repair / "broken.txt").unlink()
            git(repair, "add", ".")
            git(repair, "commit", "-m", "repair middle")
            code, retried = self.invoke(
                repo, "retry", str(middle["id"]), "--branch", "repair/middle", "--auto",
            )
            self.assertEqual(code, 0, retried)
            self.assertEqual(git(middle_worktree, "rev-parse", "HEAD"), original_head)
            self.assertEqual(git(middle_worktree, "status", "--porcelain"), "")
            self.assertGreater(retried["job"]["id"], branches[2][1]["id"])
            self.assertEqual(retried["job"]["queue_order"], middle["id"])
            self.assertEqual(tick(), "landed:1")
            middle_sha = git(root / "remote.git", "rev-parse", "main")
            self.assertNotEqual(middle_sha, first_sha)
            self.assertEqual(tick(), "landed:1")
            final_sha = git(root / "remote.git", "rev-parse", "main")
            self.assertNotEqual(final_sha, middle_sha)
            conn = connect(config.state.db)
            try:
                self.assertEqual(get_job(conn, middle["id"]).status, "canceled")
                self.assertEqual(get_job(conn, branches[2][1]["id"]).status, "deployed")
            finally:
                conn.close()
            for name in ("first", "middle", "last"):
                self.assertEqual(git(root / "remote.git", "show", f"main:{name}.txt"), name)

    def test_processing_is_optional_validated_and_bound_to_approval(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo, _ = make_demo_repo(Path(td), gate_command="exit 0")
            batch = load_config(repo=repo)
            self.assertEqual(batch.queue.processing, "batch")
            # Captured from the published 3.5.1 installation with this fixture.
            self.assertEqual(
                deploy_execution_policy_sha(batch),
                "b47a529aba97f026e65134cc34d47f8be9609b231e5fec839b6ea0725aa63f35",
            )
            ordered = replace(batch, queue=replace(batch.queue, processing="ordered"))
            self.assertNotEqual(deploy_execution_policy_sha(batch), deploy_execution_policy_sha(ordered))
            path = repo / ".mergetrain.yaml"
            original = path.read_text()
            for value in ("lifo", "true", "42", "null"):
                path.write_text(original.replace("queue:\n", f"queue:\n  processing: {value}\n"))
                with self.subTest(value=value), self.assertRaises(ConfigError):
                    load_config(repo=repo)

    def test_manual_validation_has_one_ready_job_and_keeps_the_default_recheck(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo, marker = make_demo_repo(Path(td))
            path = repo / ".mergetrain.yaml"
            path.write_text(path.read_text().replace("queue:\n", "queue:\n  processing: ordered\n"))
            git(repo, "add", ".mergetrain.yaml")
            git(repo, "commit", "-m", "ordered policy")
            git(repo, "push", "origin", "main")
            # The helper's feature branch needs an owning worktree for enqueue.
            git(repo, "worktree", "add", str(Path(td) / "first"), "feature/a")
            git(repo, "worktree", "add", "-b", "feature/b", str(Path(td) / "second"), "main")
            second = Path(td) / "second"
            (second / "b.txt").write_text("b", encoding="utf-8")
            git(second, "add", ".")
            git(second, "commit", "-m", "b")
            ids = []
            for branch in ("feature/a", "feature/b"):
                code, payload = self.invoke(repo, "enqueue", "--task", branch, "--branch", branch)
                self.assertEqual(code, 0, payload)
                ids.append(payload["job"]["id"])
            code, payload = self.invoke(repo, "validate")
            self.assertEqual(code, 0, payload)
            self.assertEqual(len(payload["jobs"]), 1)
            self.assertEqual(marker.read_text(), "x")
            _code, status = self.invoke(repo, "status")
            self.assertEqual(status["counts"]["ready"], 1)
            self.assertEqual(status["counts"]["waiting"], 1)
            code, plan = self.invoke(repo, "deploy")
            self.assertEqual(plan["result"], "confirmation_required")
            code, deployed = self.invoke(repo, "deploy", "--expected-plan", plan["deploy_plan_sha"])
            self.assertEqual(code, 0, deployed)
            self.assertEqual(marker.read_text(), "xx")
            self.assertEqual(deployed["jobs"][0]["id"], ids[0])
