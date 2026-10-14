from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from mergetrain.cli import main
from mergetrain.contract import CONTRACT_VERSION


class CliArgumentTests(unittest.TestCase):
    def test_json_parse_failures_are_structured_and_never_dispatch(self) -> None:
        cases = (
            (["status", "--limit", "invalid", "--json"], "invalid int value"),
            (["enqueue", "--task", "example", "--json"], "--branch"),
            (["status", "--unknown", "--json"], "unrecognized arguments"),
            (["unknown", "--json"], "invalid choice"),
            (["hub", "status", "--limit", "invalid", "--json"], "unrecognized arguments"),
            (["hub", "remove", "--json"], "path"),
        )
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            for argv, message in cases:
                with self.subTest(argv=argv):
                    out, err = io.StringIO(), io.StringIO()
                    with (
                        patch("mergetrain.cli.cmd_status") as status,
                        patch("mergetrain.cli.cmd_enqueue") as enqueue,
                        redirect_stdout(out),
                        redirect_stderr(err),
                    ):
                        code = main(["--repo", str(repo), *argv])
                    payload = json.loads(out.getvalue())
                    self.assertEqual(code, 2)
                    self.assertEqual(payload["contract_version"], CONTRACT_VERSION)
                    self.assertFalse(payload["ok"])
                    self.assertEqual(payload["error"]["code"], "queue_error")
                    self.assertFalse(payload["error"]["retryable"])
                    self.assertIn(message, payload["error"]["message"])
                    self.assertEqual(err.getvalue(), "")
                    status.assert_not_called()
                    enqueue.assert_not_called()
                    self.assertEqual(list(repo.iterdir()), [])

    def test_json_unknown_command_lists_only_core_commands(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main(["unknown", "--json"]), 2)
        message = json.loads(out.getvalue())["error"]["message"]
        self.assertIn("'enqueue'", message)
        self.assertNotIn("'daemon'", message)
        self.assertNotIn("'supersede'", message)

    def test_json_parse_errors_redact_credentials(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main(["status", "--token=example-secret", "--json"]), 2)
        payload = json.loads(out.getvalue())
        self.assertNotIn("example-secret", out.getvalue())
        self.assertIn("[redacted]", payload["error"]["message"])

    def test_jsonl_parse_failure_starts_and_ends_the_stream(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out, err = io.StringIO(), io.StringIO()
            with (
                patch("mergetrain.cli.cmd_events") as events,
                redirect_stdout(out),
                redirect_stderr(err),
            ):
                code = main(["--repo", td, "events", "--limit", "invalid", "--jsonl"])
            frames = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertEqual(code, 2)
            self.assertEqual([frame["type"] for frame in frames], ["stream_start", "stream_end"])
            self.assertEqual(frames[0]["contract_version"], CONTRACT_VERSION)
            self.assertEqual(frames[1]["exit_code"], 2)
            self.assertEqual(frames[1]["error"]["code"], "queue_error")
            self.assertFalse(frames[1]["ok"])
            self.assertEqual(err.getvalue(), "")
            events.assert_not_called()
            self.assertEqual(list(Path(td).iterdir()), [])

    def test_human_parse_errors_keep_usage_and_exit_two(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), self.assertRaises(SystemExit) as raised:
            main(["status", "--limit", "invalid"])
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("usage: mergetrain status", err.getvalue())

    def test_option_terminator_does_not_enable_machine_output(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), self.assertRaises(SystemExit) as raised:
            main(["status", "--", "--json"])
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("usage:", err.getvalue())


if __name__ == "__main__":
    unittest.main()
