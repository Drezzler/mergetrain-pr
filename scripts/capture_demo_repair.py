"""Record the repair loop in a disposable repository (POSIX capture tooling).

The author supplies the repair. This script repeats it and scripts the operator's
approval of the two local-only deployments. It does not launch an AI agent.
"""

import contextlib
import datetime
import errno
import io
import json
import os
import pty
import select
import shlex
import subprocess
import sys
import time
from pathlib import Path

import mergetrain
from mergetrain.demo import CommandResult, DemoSandbox, DemoWalkthrough

ROOT = Path(__file__).resolve().parents[1]


class Recording(DemoWalkthrough):
    def __init__(self, sandbox):
        super().__init__(sandbox, brief=False, pause=False, delay=0)
        self.records = []
        self.phase = "setup"

    def normalize(self, value):
        return (value.replace(str(self.sandbox.root), "$DEMO")
                .replace(sys.executable, "$PYTHON")
                .replace(str(Path(mergetrain.__file__).parent), "$MERGETRAIN"))

    def record(self, argv, result, start, **extra):
        shown = ["mergetrain", *argv[3:]] if argv[:3] == [sys.executable, "-m", "mergetrain"] else argv
        self.records.append({
            "phase": self.phase, "command": self.normalize(shlex.join(shown)),
            "argv": [self.normalize(str(a)) for a in argv],
            "returncode": result.returncode, "stdout": self.normalize(result.stdout),
            "stderr": self.normalize(result.stderr),
            "seconds": round(time.monotonic() - start, 3), **extra,
        })

    def _run(self, argv, **kwargs):
        start = time.monotonic()
        result = super()._run(argv, **kwargs)
        self.record(argv, result, start)
        return result

    def deploy_local(self, branches):
        """Accept only a displayed plan for these branches and this bare remote."""
        argv = [sys.executable, "-m", "mergetrain", "--repo", str(self.repo), "deploy"]
        start = time.monotonic()
        master, slave = pty.openpty()
        proc = subprocess.Popen(argv, cwd=self.repo, env=self.env,
                                stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = bytearray()
        accepted = False
        try:
            while True:
                if time.monotonic() - start > 180:
                    raise RuntimeError("Local demo deployment timed out")
                ready, _, _ = select.select([master], [], [], 1)
                if not ready:
                    continue
                try:
                    chunk = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                output.extend(chunk)
                text = output.decode(errors="replace")
                if not accepted and "Deploy this exact plan? [y/N] " in text:
                    assert f"Destination: {self.remote} (main)" in text, text
                    assert f"Ready to deploy {len(branches)} job(s):" in text, text
                    assert all(f"({branch})" in text for branch in branches), text
                    os.write(master, b"y\n")
                    accepted = True
            proc.wait(timeout=10)
        finally:
            os.close(master)
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        text = output.decode().replace("\r\n", "\n")
        result = CommandResult(proc.returncode, text, "")
        self.record(argv, result, start, approval="scripted y after local destination and branch checks")
        print(text)
        assert accepted and proc.returncode == 0, text
        assert text.count("push=succeeded, verify=succeeded") == len(branches), text

    def capture(self):
        self._bootstrap()
        self._cli("init", "--project", "demo", "--write")
        self._commit_seed()
        branches = self._make_agent_branches()
        self.phase = "individual_checks"
        for branch, _, worktree in branches:
            self._run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"], cwd=worktree)
            self.records[-1]["branch"] = branch
        self._cli("status", "--json")
        self.phase = "submit"
        for branch, task, _ in branches:
            self._cli("enqueue", "--task", task, "--branch", branch)
        self.phase = "combined_failure"
        self._cli("status", "--json")
        self._cli("validate", expected={1})
        original = [self._cli_json("inspect", str(i), "--json")["job"] for i in range(1, 5)]
        assert [j["status"] for j in original] == ["blocked", "blocked", "validated", "validated"]
        assert str(original[0]["conflict_with"]) == "2"
        assert str(original[1]["conflict_with"]) == "1"

        self.phase = "first_deploy"
        self._cli("status", "--json")
        self.deploy_local([b[0] for b in branches[2:]])
        first_main = self._git("--git-dir", str(self.remote), "rev-parse", "main").stdout.strip()
        for i in (1, 2):
            assert self._cli_json("inspect", str(i), "--json")["job"]["status"] == "blocked"
        for i in (3, 4):
            assert self._cli_json("inspect", str(i), "--json")["job"]["status"] == "deployed"

        self.phase = "agent_repair"
        revisions = []
        for index, (branch, _, worktree) in enumerate(branches[:2]):
            before = self._git("rev-parse", "HEAD", cwd=worktree).stdout.strip()
            self._git("fetch", "origin", cwd=worktree, show=True)
            self._git("rebase", "origin/main", cwd=worktree, show=True)
            if index == 1:
                (worktree / "app/health.py").write_text(
                    "from app.config import DEFAULT_TIMEOUT\n\nTIMEOUT_BUDGET = DEFAULT_TIMEOUT\n",
                    encoding="utf-8",
                )
                self._git("diff", "--", "app/health.py", cwd=worktree, show=True)
                self._git("add", "app/health.py", cwd=worktree)
                self._git("commit", "-m", "fix: derive health budget from current timeout", cwd=worktree, show=True)
            self._run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"], cwd=worktree)
            self.records[-1]["branch"] = branch
            after = self._git("rev-parse", "HEAD", cwd=worktree).stdout.strip()
            assert before != after
            assert self._git("status", "--porcelain", cwd=worktree).stdout == ""
            revisions.append({"item": index + 1, "branch": branch, "before": before, "after": after})

        self.phase = "resubmit"
        self._cli("status", "--json")
        for i in (1, 2):
            job = self._cli_json("retry", str(i), "--json")["job"]
            revisions[i - 1]["replacement_job_id"] = job["id"]
            assert job["status"] == "queued"
            assert job["head_sha"] == revisions[i - 1]["after"]
        self.phase = "repaired_validation"
        self._cli("status", "--json")
        self._cli("validate")
        self.phase = "second_deploy"
        self._cli("status", "--json")
        self.deploy_local([b[0] for b in branches[:2]])
        for revision in revisions:
            job = self._cli_json("inspect", str(revision["replacement_job_id"]), "--json")["job"]
            assert job["status"] == "deployed"

        self.phase = "remote_proof"
        final_main = self._git("--git-dir", str(self.remote), "rev-parse", "main").stdout.strip()
        assert first_main != final_main
        for revision in revisions:
            self._git("--git-dir", str(self.remote), "merge-base", "--is-ancestor", revision["after"], "main")
        for filename in ("config.py", "health.py", "retries.py", "request_logging.py"):
            self._git("--git-dir", str(self.remote), "show", f"main:app/{filename}", show=True)
        proof = self.sandbox.root / "remote-proof"
        self._git("clone", str(self.remote), str(proof))
        self._run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"], cwd=proof)
        final_status = self._cli_json("status", "--json")
        assert final_status["health"] == "healthy" and final_status["state"] == "idle"
        self._cli("status", "--limit", "10")
        return {"first_deploy_main": first_main, "final_main": final_main, "revisions": revisions,
                "final_remote_tests": "4 passed", "final_state": final_status}


def main():
    sandbox = DemoSandbox.create(None)
    run = Recording(sandbox)
    stdout, stderr = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            proof = run.capture()
        evidence = {
            "version": mergetrain.__version__,
            "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "scope": "Disposable local Git repository and bare remote; no hosted production deployment.",
            "method": "The agent-authored repair and operator approvals are scripted for reproduction; mergetrain does not launch or repair with an AI agent.",
            "normalization": "Sandbox, Python and package paths become $DEMO, $PYTHON and $MERGETRAIN; PTY CRLF becomes LF. Other output and measured timings are unchanged.",
            "records": run.records, "proof": proof,
        }
        base = ROOT / "docs/media"
        (base / "repair-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        (base / "repair-transcript.txt").write_text(run.normalize(stdout.getvalue() + stderr.getvalue()))
        print(json.dumps({"records": len(run.records), "proof": proof["revisions"], "final_remote_tests": proof["final_remote_tests"]}, indent=2))
    except BaseException:
        print(run.normalize(stdout.getvalue() + stderr.getvalue()), file=sys.stderr)
        raise
    finally:
        sandbox.cleanup()


if __name__ == "__main__":
    main()
