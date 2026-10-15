#!/usr/bin/env python3
"""Replay a pinned public consumer in disposable repositories; never run its AI repair loop.

Provide the public source snapshot with --snapshot. No code is fetched or
changed upstream. The output patch is a reviewed contract-4/5 migration,
not a protocol relabel or permission to accept future contracts.
"""

from __future__ import annotations

import argparse
import copy
import difflib
import hashlib
import io
import json
import os
import shlex
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]

SOURCE_COMMIT = "096c7d42d1ece1dd63e51077d53e0f701822e676"
SOURCE_BLOBS = {
    "land": "9e5867b2b92a9bbef541c70f9c56394a5d18765d",
    "scripts/mergetrain_fifo.py": "d57432df8d010cbb1604023071c3f08af9706c3d",
    "scripts/render_mergetrain_status.py": "e4c66aef65683cf292611fb22304a49e6b083e44",
    "scripts/run-mergetrain-integrator.sh": "39d9da3552343c7e5c96e632c3da27cdc58ad96d",
}


def source_text(snapshot: Path, name: str) -> str:
    path = snapshot / name
    if not path.is_file():
        path = snapshot / ("darklang-" + name.replace("/", "__"))
    raw = path.read_bytes()
    for candidate in (raw, raw.removesuffix(b"\n")):
        header = f"blob {len(candidate)}\0".encode()
        if hashlib.sha1(header + candidate).hexdigest() == SOURCE_BLOBS[name]:
            return candidate.decode("utf-8")
    raise ValueError(f"source does not match pinned public blob: {name}")


def adapt(source: str) -> str:
    for variable in ("snapshot", "inspection", "payload"):
        source = source.replace(
            f'{variable}.get("contract_version") != 4',
            f'{variable}.get("contract_version") not in {{4, 5}}',
        )
    source = source.replace(
        '[[ "$contract_version" != "4" ]]',
        '[[ "$contract_version" != "4" && "$contract_version" != "5" ]]',
    ).replace(
        '[[ "$live_contract_version" == "4" ]]',
        '[[ "$live_contract_version" == "4" || "$live_contract_version" == "5" ]]',
    )
    pre = '$(json_value contract_version <<<"$pre_snapshot")'
    return source.replace(
        f'[[ "{pre}" == "4" ]]',
        f'[[ "{pre}" == "4" || "{pre}" == "5" ]]',
    )


def module_from(source: str, name: str) -> types.ModuleType:
    module = types.ModuleType(name)
    sys.modules[name] = module
    exec(compile(source, name, "exec"), module.__dict__)
    return module


def cli(repo: Path, *args: str) -> tuple[int, dict]:
    from mergetrain.cli import main as cli_main

    output = io.StringIO()
    with redirect_stdout(output):
        code = cli_main(["--repo", str(repo), *args, "--json"])
    return code, json.loads(output.getvalue())


def verify(snapshot: Path, output: Path) -> dict:
    from test_git_runner import git, make_demo_repo
    from test_ordered_processing import OrderedWorkflowTests

    sources = {name: source_text(snapshot, name) for name in SOURCE_BLOBS}
    adapted = {name: adapt(text) for name, text in sources.items()}
    patch_text = "".join(
        "".join(difflib.unified_diff(
            sources[name].splitlines(keepends=True), adapted[name].splitlines(keepends=True),
            fromfile=f"a/{name}", tofile=f"b/{name}",
            n=0,
        )) for name in sources
    )
    output.mkdir(parents=True, exist_ok=True)
    (output / "darklang-contract-5.patch").write_text(patch_text, encoding="utf-8")
    legacy = module_from(sources["scripts/mergetrain_fifo.py"], "darklang_legacy_fifo")
    fifo = module_from(adapted["scripts/mergetrain_fifo.py"], "darklang_reviewed_fifo")
    sys.modules["mergetrain_fifo"] = fifo
    renderer = module_from(adapted["scripts/render_mergetrain_status.py"], "darklang_reviewed_status")
    result = {
        "source_repository": "https://github.com/pbiggar/darklang-compiler",
        "source_commit": SOURCE_COMMIT,
        "verified_git_blobs": SOURCE_BLOBS,
        "native_contract": 5,
        "scope": "Pinned consumer replay and native workflow on disposable Git remotes; "
        "no external compiler, hosted service, or coding model was executed.",
    }
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        repo, _ = make_demo_repo(root, gate_command="exit 1")
        cli(repo, "gc")  # Create only this disposable queue before read-only status.
        shim = root / "bin"
        shim.mkdir()
        launcher = shim / "mergetrain"
        launcher.write_text(
            f"#!/bin/sh\nexec {shlex.quote(sys.executable)} -m mergetrain \"$@\"\n",
            encoding="utf-8",
        )
        launcher.chmod(0o755)
        env = {**os.environ, "PATH": str(shim) + os.pathsep + os.environ.get("PATH", ""),
               "PYTHONPATH": str(ROOT / "src")}
        with patch.dict(os.environ, env, clear=True):
            try:
                legacy.prepare(repo)
            except legacy.DispatchError as error:
                assert "unsupported mergetrain contract version" in str(error)
                result["original_consumer"] = "rejected native contract 5 before admission"
            else:
                raise AssertionError("legacy contract guard unexpectedly accepted version 5")
            fifo.prepare(repo)
            git(repo, "worktree", "add", str(root / "first"), "feature/a")
            code, enqueued = cli(repo, "enqueue", "--task", "compiler change", "--branch", "feature/a")
            assert code == 0, enqueued
            state = fifo.prepare(repo)
            assert state["head"]["native_id"] == enqueued["job"]["id"]
            _, waiting = cli(repo, "status")
            assert "health:" in renderer.render(waiting, repo, color=False)
            code, failed = cli(repo, "validate")
            assert code == 1 and failed["result"] == "failed", failed
            fifo.prepare(repo)
            _, attention = cli(repo, "status")
            assert attention["state"] == "attention"
            assert "ATTENTION" in renderer.render(attention, repo, color=False)
            result["native_consumer_states"] = ["idle", "waiting", "attention"]
            original_train = fifo.train
            for contract in (4, 6):
                fixture = copy.deepcopy(attention)
                fixture["contract_version"] = contract
                with patch.object(fifo, "train", side_effect=lambda r, *a, status_fixture=fixture: (
                    status_fixture if a[0] == "status" else original_train(r, *a)
                )):
                    if contract == 4:
                        fifo.prepare(repo)
                        assert "ATTENTION" in renderer.render(fixture, repo, color=False)
                    else:
                        with unittest.TestCase().assertRaises(fifo.DispatchError):
                            fifo.prepare(repo)
                        with unittest.TestCase().assertRaises(ValueError):
                            renderer.render(fixture, repo, color=False)
            result["contract_4_fixture"] = "accepted with the same reviewed status/inspect fields"
            result["future_contract_6_fixture"] = "refused by dispatcher and renderer"
        for name in ("land", "scripts/run-mergetrain-integrator.sh"):
            script = root / Path(name).name
            script.write_text(adapted[name], encoding="utf-8")
            subprocess.run(["bash", "-n", str(script)], check=True)
    replay = unittest.TestResult()
    for name in (
        "test_parallel_handoffs_repair_restart_and_individual_atomic_landings",
        "test_manual_validation_has_one_ready_job_and_keeps_the_default_recheck",
    ):
        OrderedWorkflowTests(name).run(replay)
    assert replay.wasSuccessful(), replay.errors + replay.failures
    result["native_ordered_replay"] = {
        "tests_passed": replay.testsRun,
        "landings": 3,
        "preserved_original_repair_checkout": True,
        "retry_kept_original_order": True,
        "separate_arrival_ledger_required": False,
        "manual_confirmation_and_default_recheck": True,
    }
    (output / "darklang-compatibility.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8",
    )
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.snapshot, args.output), indent=2))
