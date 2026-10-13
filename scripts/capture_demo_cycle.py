"""Record overlapping work and the next batch in a disposable local repository.

Agent-authored changes and approvals are replayed by this script. A fixture gate
barrier makes the overlap reproducible; measured times are not a speed claim.
No AI service is launched. No hosted repository is modified.
"""

import contextlib
import datetime
import io
import json
import shlex
import subprocess
import sys
import time

from capture_demo_repair import ROOT, Recording

import mergetrain
from mergetrain.demo import CommandResult, DemoSandbox


class ContinuousRecording(Recording):
    def __init__(self, sandbox):
        super().__init__(sandbox)
        self.epoch = time.monotonic()
        self.following = []
        self.overlap = {}

    def record(self, argv, result, start, **extra):
        super().record(argv, result, start, **extra)
        self.records[-1]["started_seconds"] = round(start - self.epoch, 6)
        self.records[-1]["finished_seconds"] = round(time.monotonic() - self.epoch, 6)

    def _write_demo_config(self):
        super()._write_demo_config()
        # The normal tests run first. Only the deliberately observed validation
        # waits at this fixture barrier, outside the product's queue/lock code.
        probe = self.sandbox.root / "capture-gate.py"
        probe.write_text(
            "import os, pathlib, subprocess, sys, time\n"
            "result = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests'])\n"
            "if result.returncode: sys.exit(result.returncode)\n"
            "if os.environ.get('MT_DEMO_GATE_READY'):\n"
            "    pathlib.Path(os.environ['MT_DEMO_GATE_READY']).write_text('tests passed; gate active')\n"
            "    deadline = time.monotonic() + 40\n"
            "    while not pathlib.Path(os.environ['MT_DEMO_GATE_RELEASE']).exists():\n"
            "        if time.monotonic() > deadline: raise TimeoutError('capture barrier')\n"
            "        time.sleep(0.02)\n",
            encoding="utf-8",
        )
        config = self.repo / ".mergetrain.yaml"
        command = shlex.join([sys.executable, str(probe)])
        lines = config.read_text().splitlines()
        gate_line = next(i for i, line in enumerate(lines) if "-m unittest discover" in line)
        lines[gate_line] = "    run: '" + command.replace("'", "''") + "'"
        config.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _cli(self, *args, expected=None):
        if args == ("validate",) and self.phase == "repaired_validation":
            return self.validate_while_work_continues()
        return super()._cli(*args, expected=expected)

    def make_next_branch(self, branch, files, base):
        worktree = self.agent_root / branch.removeprefix("agent/")
        self._git("worktree", "add", "-b", branch, str(worktree), base, cwd=self.repo)
        for filename, content in files.items():
            (worktree / filename).write_text(content, encoding="utf-8")
        self._git("add", ".", cwd=worktree)
        self._git("commit", "-m", branch, cwd=worktree)
        return worktree

    def validate_while_work_continues(self):
        ready = self.sandbox.root / "gate-ready"
        release = self.sandbox.root / "gate-release"
        argv = [sys.executable, "-m", "mergetrain", "--repo", str(self.repo), "validate"]
        env = {**self.env, "MT_DEMO_GATE_READY": str(ready), "MT_DEMO_GATE_RELEASE": str(release)}
        start = time.monotonic()
        proc = subprocess.Popen(argv, cwd=self.repo, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            while not ready.exists():
                if proc.poll() is not None or time.monotonic() - start > 40:
                    out, err = proc.communicate(timeout=10)
                    raise RuntimeError(f"Validation did not reach the fixture gate: {out}\n{err}")
                time.sleep(0.02)
            gate_active = time.monotonic() - self.epoch
            self.phase = "next_batch_work"
            base = self._git("--git-dir", str(self.remote), "rev-parse", "main").stdout.strip()
            plans = [
                (5, "agent/retry-backoff", "build backoff from the applied retry policy", {
                    "app/backoff.py": "from app.retries import MAX_RETRIES\n\ndef retry_delays():\n    return [2 ** attempt for attempt in range(MAX_RETRIES)]\n",
                    "tests/test_backoff.py": "import unittest\nfrom app.backoff import retry_delays\n\nclass BackoffTests(unittest.TestCase):\n    def test_delays_follow_retry_policy(self):\n        self.assertEqual(retry_delays(), [1, 2, 4])\n",
                }),
                (6, "agent/structured-log", "format entries using the applied logging setting", {
                    "app/log_entry.py": "from app.request_logging import LOG_REQUESTS\n\ndef request_entry(method, path):\n    return {'method': method, 'path': path} if LOG_REQUESTS else None\n",
                    "tests/test_log_entry.py": "import unittest\nfrom app.log_entry import request_entry\n\nclass LogEntryTests(unittest.TestCase):\n    def test_request_entry(self):\n        self.assertEqual(request_entry('GET', '/health'), {'method': 'GET', 'path': '/health'})\n",
                }),
            ]
            for item, branch, task, files in plans:
                worktree = self.make_next_branch(branch, files, base)
                self._git("merge-base", "--is-ancestor", base, "HEAD", cwd=worktree)
                self._run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"], cwd=worktree)
                self.records[-1]["branch"] = branch
                head = self._git("rev-parse", "HEAD", cwd=worktree).stdout.strip()
                assert self._git("status", "--porcelain", cwd=worktree).stdout == ""
                assert proc.poll() is None, "The gate must still be active while the next work is committed"
                self.following.append({"item": item, "branch": branch, "task": task,
                                       "worktree": worktree, "base": base, "during_validation_head": head})
            work_done = time.monotonic() - self.epoch
            self.overlap = {"fixture_barrier": True, "gate_active_seconds": gate_active,
                            "next_work_committed_seconds": work_done,
                            "validator_alive_after_commits": proc.poll() is None}
        finally:
            release.write_text("next work is committed", encoding="utf-8")
            self.phase = "repaired_validation"
            try:
                out, err = proc.communicate(timeout=60)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        result = CommandResult(proc.returncode, out, err)
        self.record(argv, result, start, fixture_barrier="Gate waits while next work is authored and committed")
        self.overlap["validation_finished_seconds"] = self.records[-1]["finished_seconds"]
        print(out, err)
        assert result.returncode == 0, out + err
        return result

    def capture(self):
        proof = super().capture()
        proof["repaired_main"] = proof.pop("final_main")
        proof.pop("final_state")
        proof.pop("final_remote_tests")
        self.phase = "next_batch_sync"
        for work in self.following:
            path = work["worktree"]
            self._git("fetch", "origin", cwd=path, show=True)
            self._git("rebase", "origin/main", cwd=path, show=True)
            self._git("merge-base", "--is-ancestor", proof["repaired_main"], "HEAD", cwd=path)
            self._run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"], cwd=path)
            self.records[-1]["branch"] = work["branch"]
            work["submitted_head"] = self._git("rev-parse", "HEAD", cwd=path).stdout.strip()
            assert work["submitted_head"] != work["during_validation_head"]
            assert self._git("status", "--porcelain", cwd=path).stdout == ""
        self.phase = "next_batch_submit"
        self._cli("status", "--json")
        for work in self.following:
            job = self._cli_json("enqueue", "--task", work["task"], "--branch", work["branch"], "--json")["job"]
            work["job_id"] = job["id"]
            assert job["head_sha"] == work["submitted_head"]
        self.phase = "next_batch_validation"
        self._cli("status", "--json")
        self._cli("validate")
        self.phase = "third_deploy"
        self._cli("status", "--json")
        self.deploy_local([w["branch"] for w in self.following])
        for work in self.following:
            job = self._cli_json("inspect", str(work["job_id"]), "--json")["job"]
            assert job["status"] == "deployed"
        self.phase = "cycle_remote_proof"
        final_main = self._git("--git-dir", str(self.remote), "rev-parse", "main").stdout.strip()
        assert len({proof["first_deploy_main"], proof["repaired_main"], final_main}) == 3
        for work in self.following:
            self._git("--git-dir", str(self.remote), "merge-base", "--is-ancestor", work["submitted_head"], "main")
        fresh = self.sandbox.root / "cycle-proof"
        self._git("clone", str(self.remote), str(fresh))
        result = self._run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"], cwd=fresh)
        assert "Ran 6 tests" in result.stderr and "OK" in result.stderr
        # The run finishes with real work in progress on the latest applied base.
        # These drafts are not enqueued or presented as deployed outcomes.
        self.phase = "following_work_started"
        drafts = []
        for item, branch, filename, content in [
            (7, "agent/capped-backoff", "app/backoff.py", "from app.retries import MAX_RETRIES\n\ndef retry_delays(cap=8):\n    return [min(2 ** attempt, cap) for attempt in range(MAX_RETRIES)]\n"),
            (8, "agent/log-request-id", "app/log_entry.py", "from app.request_logging import LOG_REQUESTS\n\ndef request_entry(method, path, request_id=None):\n    return {'method': method, 'path': path, 'request_id': request_id} if LOG_REQUESTS else None\n"),
            (9, "agent/health-response", "app/health.py", "from app.config import DEFAULT_TIMEOUT\n\nTIMEOUT_BUDGET = DEFAULT_TIMEOUT\n\ndef health_response():\n    return {'status': 'ok', 'timeout': TIMEOUT_BUDGET}\n"),
            (10, "agent/retry-summary", "app/retries.py", "MAX_RETRIES = 3\n\ndef retry_summary():\n    return f'Up to {MAX_RETRIES} retries'\n"),
        ]:
            path = self.agent_root / branch.removeprefix("agent/")
            self._git("worktree", "add", "-b", branch, str(path), final_main, cwd=self.repo)
            self._git("merge-base", "--is-ancestor", final_main, "HEAD", cwd=path)
            (path / filename).write_text(content, encoding="utf-8")
            diff = self._git("diff", "--", filename, cwd=path, show=True)
            assert diff.stdout
            drafts.append({"item": item, "branch": branch, "base": final_main,
                           "state": "draft; not submitted or validated"})
        status = self._cli_json("status", "--json")
        assert status["health"] == "healthy" and status["state"] == "idle"
        proof.update(final_main=final_main, final_remote_tests="6 passed", final_state=status,
                     overlap=self.overlap, following_drafts=drafts,
                     next_batch=[{k: v for k, v in w.items() if k != "worktree"} for w in self.following])
        return proof


def main():
    sandbox = DemoSandbox.create(None)
    run = ContinuousRecording(sandbox)
    stdout, stderr = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            proof = run.capture()
        evidence = {
            "version": mergetrain.__version__,
            "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "scope": "Disposable local Git repository and bare remote; no hosted production deployment.",
            "method": "Agent-authored changes and operator approvals are scripted. A fixture gate barrier proves next-batch commits occur during validation. Mergetrain does not launch an AI agent. The final four drafts are not submitted or claimed as validated.",
            "normalization": "Local paths become $DEMO, $PYTHON and $MERGETRAIN; PTY CRLF becomes LF. The readable transcript trims trailing whitespace; JSON output and measured timings are otherwise unchanged. Fixture wait time is not a performance benchmark.",
            "records": run.records, "proof": proof,
        }
        base = ROOT / "docs/media"
        (base / "cycle-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        transcript = run.normalize(stdout.getvalue() + stderr.getvalue())
        (base / "cycle-transcript.txt").write_text("\n".join(line.rstrip() for line in transcript.splitlines()) + "\n")
        print(json.dumps({"records": len(run.records), "overlap": proof["overlap"],
                          "next_batch": proof["next_batch"], "final_remote_tests": proof["final_remote_tests"]}, indent=2))
    except BaseException:
        print(run.normalize(stdout.getvalue() + stderr.getvalue()), file=sys.stderr)
        raise
    finally:
        sandbox.cleanup()


if __name__ == "__main__":
    main()
