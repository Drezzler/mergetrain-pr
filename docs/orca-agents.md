# Codex, Claude Code, and agy in Orca

Use each client's native mergetrain plugin in an Orca task terminal. The three
plugins provide the same queue protocol and launch the same pinned MCP
package. Start with the [Orca worktree setup](orca-worktrees.md): the control
checkout must already have landed configuration and project gates.

These examples cover CLI sessions in Orca terminals. Installing a plugin is
per execution host and user profile, not per task branch. A local install does
not install it on an SSH host or in WSL.

## Prepare the MCP runtime in the same terminal

The native plugins use `uvx`, independently of a Homebrew or globally installed
mergetrain CLI. Before starting the client, verify their pinned runtime:

```sh
uvx --from "mergetrain[mcp]==3.5.0" mergetrain --version
```

The first run may download the package. Mergetrain requires Python 3.10 or
newer. In the tested isolated Orca login shell, `uvx` selected macOS Python
3.9.6 and failed dependency resolution; plugin installation alone still
succeeded. Selecting an installed Python 3.12 fixed startup:

```sh
export UV_PYTHON="$(uv python find 3.12)"
uvx --from "mergetrain[mcp]==3.5.0" mergetrain --version
```

If `uv python find 3.12` reports no interpreter, install one with
`uv python install 3.12` first. Keep this selection in the shell that launches
the agent so its MCP child inherits it. An absolute interpreter path is also
accepted. On PowerShell, the equivalent selection is
`$env:UV_PYTHON = (uv python find 3.12)`; the local tests below ran on macOS.
See [installation](install.md) for `uv` and version upgrade guidance. The
MCP package version remains 3.5.0; choosing Python is not a version downgrade.

## Codex CLI

Install once on the execution host:

```sh
codex plugin marketplace add yongjip/mergetrain --ref main
codex plugin add mergetrain@mergetrain
codex plugin list --marketplace mergetrain
codex mcp list --json
```

The plugin row should say **installed, enabled**, with version **3.5.0**.
The MCP inventory should include enabled `mergetrain` with a stdio `uvx`
command. Codex **0.133.0** does not accept `--json` on `plugin list`; the JSON
option above belongs to `mcp list`.

Select the intended Orca task worktree, open its terminal, and start a fresh
`codex` session there. `/plugins` opens the plugin browser. A new session loads
the installed skills and tools. Follow [OpenAI's plugin guidance](https://learn.chatgpt.com/docs/plugins#plugin-browser-in-codex-cli)
and [marketplace setup](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli).

## Claude Code

Install once on the execution host:

```sh
claude plugin marketplace add yongjip/mergetrain
claude plugin install mergetrain@mergetrain
claude plugin list --json
claude plugin details mergetrain@mergetrain
claude mcp list
```

Check `enabled: true`, version **3.5.0**, and its mergetrain MCP configuration.
`plugin details` lists the `mergetrain` and `deploy` skills and one MCP server.
After preparing the runtime above, the native MCP health check reported
**Connected** in the local test.

Start `claude` from the task worktree's terminal. `/plugin` shows the installed
plugin; its task skill is `/mergetrain:mergetrain`. Use the task skill or the
shared prompt below for registration. Follow [Claude's plugin installation and
reload guidance](https://code.claude.com/docs/en/discover-plugins) if an existing
session has not loaded a new installation.

## agy / Antigravity CLI

Install the native plugin directly from the repository:

```sh
agy plugin install https://github.com/yongjip/mergetrain
agy plugin list --json
```

Check `name: mergetrain`, `enabled: true`, a `mergetrain` entry in `skills`, and
a `mergetrain` entry in `mcpServers`. Its `mcp_config.json` supplies the pinned
stdio server. A separate `agy mcp add` registration is not needed.

Start `agy` from the task worktree's terminal. `/plugin` or `/plugins` opens
its plugin manager. In tested **agy 1.3.5**, standalone `agy mcp list` printed
`No MCP servers configured` even though the native plugin inventory included
its MCP server. Use the plugin inventory and the session's actual tool
availability to check this plugin; that standalone message alone did not
establish a missing plugin. See [Antigravity's native plugin guide](https://www.agy.dev/docs/plugins?tab=cli).

## Give the task agent a bounded handoff

All three clients can use the same instruction, with your actual task and
worktree filled in:

```text
Use the installed mergetrain plugin for this Orca task worktree.
Implement the requested change, run the project checks, and commit a clean HEAD.
Read mergetrain_status and follow health, state, and next_action.
Enqueue this finished branch with mergetrain_enqueue using its task and actual
Git branch name. Report the job ID and pinned commit, then stop.
Do not validate, deploy, or start a daemon.
```

The MCP server is bound to its repository when it starts. The normal tool
inputs do not accept a per-call `repo` override. Start the session from the
intended worktree; when changing repositories, start a new session so the MCP
server is bound to that repository. Linked worktrees of one repository share
its control checkout's queue.

The five stable tools are `mergetrain_status`, `mergetrain_inspect`,
`mergetrain_enqueue`, `mergetrain_validate`, and `mergetrain_deploy`. Enqueue
requires only `task` and `branch`; it resolves the clean owning worktree and
captures exact commits. Plugin installation does not authorize the task agent
to validate or deploy.

For a separately authorized validation session, use an instruction such as:

```text
Validation is approved for the named queued jobs in this repository.
Read mergetrain_status and confirm the queue contains only the approved work.
If it does, call mergetrain_validate once, then read status and inspect the
resulting jobs. Report Ready and Attention results and the pinned commits.
Do not call deploy, start a daemon, or perform recovery.
```

For repair, follow the [worktree retry example](orca-worktrees.md#repair-a-failed-gate)
in the owning task terminal. If the plugin tools are unavailable, check the
client's plugin inventory, `uvx`, the selected Python, and the execution host;
the existing [terminal CLI workflow](orca-worktrees.md#register-committed-work-then-validate-when-authorized)
remains available for an explicitly chosen CLI session.

## What was tested

On **2026-10-14**, real Orca PTYs in an isolated macOS profile installed the
remote native plugins using Codex **0.133.0**, Claude Code **2.1.287**, and agy
**1.3.5**. All three clients recognized their plugins. Codex published its
stdio MCP configuration, Claude's native MCP connection succeeded, and agy
listed the skill and plugin MCP component.

A stdio test client then invoked each declared plugin MCP command from the same
Orca task worktree. The first registered and validated a committed branch;
all three servers exposed exactly five tools and read/inspected the same Ready
job with exact commit pins. `auto_deploy` remained false, `push_status` stayed
`not_run`, and local/remote main stayed unchanged. The native installation and
runtime-flow Electron test, 12 manifest/registry tests, and the published-package
Registry probe passed. See the [verification summary](evidence/orca-agents-2026-10-14.json).

This tested installation, discovery, native Claude connection, and the declared
MCP processes. It did not run LLM-driven editing or tool selection inside a
Codex, Claude, or agy conversation. Orca structured chats and Windows/WSL/SSH
client combinations were not exercised. The preceding [worktree guide](orca-worktrees.md#verification-and-host-limits)
records the separate terminal/UI queue and failure-repair tests.
