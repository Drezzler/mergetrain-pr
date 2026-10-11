import contextlib
import datetime
import io
import json
import shlex
import subprocess
import sys
import time
from pathlib import Path

import mergetrain
from mergetrain.demo import DemoSandbox, DemoWalkthrough

base = Path(__file__).resolve().parents[1] / "docs" / "media"
base.mkdir(parents=True, exist_ok=True)
records = []


def normalize(value, sandbox_root):
    return (
        value.replace(str(sandbox_root), "$DEMO")
        .replace(sys.executable, "$PYTHON")
        .replace(str(Path(mergetrain.__file__).parent), "$MERGETRAIN")
    )


class Recording(DemoWalkthrough):
    def _run(self, argv, **kw):
        start = time.monotonic()
        r = super()._run(argv, **kw)
        root = str(self.sandbox.root)
        command = shlex.join(argv)
        if argv[:3] == [sys.executable, "-m", "mergetrain"]:
            command = shlex.join(["mergetrain", *argv[3:]])
        records.append(
            {
                "step": self._step_number,
                "command": normalize(command, root),
                "argv": [normalize(str(arg), root) for arg in argv],
                "returncode": r.returncode,
                "stdout": normalize(r.stdout, root),
                "stderr": normalize(r.stderr, root),
                "seconds": round(time.monotonic() - start, 3),
            }
        )
        return r

    def _make_agent_branches(self):
        branches = super()._make_agent_branches()
        for branch, _task, path in branches:
            r = self._run(
                [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"],
                cwd=path,
                show=False,
            )
            records[-1]["branch"] = branch
            assert r.returncode == 0
        return branches


sandbox = DemoSandbox.create(None)
recording = Recording(sandbox, brief=True, pause=False, delay=0)
stdout, stderr = io.StringIO(), io.StringIO()
try:
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        recording.run()
    assert len([r for r in records if "branch" in r]) == 4
    validate = next(r for r in records if r["command"].endswith(" validate"))
    assert (
        validate["returncode"] == 1
        and "#1 blocked:" in validate["stdout"]
        and "#4 validated:" in validate["stdout"]
    )
    deploy = next(r for r in records if " deploy --expected-plan " in r["command"])
    assert (
        "verify=succeeded" in deploy["stdout"]
        and "#3 deployed" in deploy["stdout"]
        and "#4 deployed" in deploy["stdout"]
    )
    evidence = {
        "version": mergetrain.__version__,
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "Disposable local Git repository and bare remote; no hosted production deployment.",
        "normalization": "Sandbox, Python executable, and installed package paths are replaced by $DEMO, $PYTHON, and $MERGETRAIN. The Python -m mergetrain prefix is displayed as mergetrain in command labels; argv preserves the normalized argument vector. Output, return codes, and recorded timings are otherwise unchanged.",
        "records": records,
        "transcript": normalize(stdout.getvalue(), sandbox.root),
        "gate_failure_logs": [],
    }
    for p in recording.repo.glob(".mergetrain/logs/**/*"):
        if p.is_file():
            content = p.read_text(errors="replace")
            if "AssertionError" in content:
                evidence["gate_failure_logs"].append(
                    {
                        "path": str(p.relative_to(recording.repo)),
                        "text": normalize(content, sandbox.root),
                    }
                )
    (base / "demo-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    (base / "demo-transcript.txt").write_text(
        normalize(stdout.getvalue() + stderr.getvalue(), sandbox.root)
    )
    print(
        json.dumps(
            {
                "version": mergetrain.__version__,
                "records": len(records),
                "individual_passes": 4,
                "combined_exit": validate["returncode"],
                "deploy_exit": deploy["returncode"],
                "gate_failure_logs": len(evidence["gate_failure_logs"]),
            }
        )
    )
finally:
    sandbox.cleanup()
