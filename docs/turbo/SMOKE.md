# Isolated Turbo smoke verification

Verified on Windows on 2026-11-06, using Node 26.13.0 and the public DSH 0.2.2-rc.1 npm installation. This exercised a real DSH host, authenticated web HTML, the Bot HTTP API, the DSH tool execution path, and a real stdio MCP server. Model responses came from this repository's deterministic mock Messages API.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Host startup | Passed | Authenticated web response was HTTP 200 and contained `__DSH_BOOT__`; mock model endpoint returned HTTP 200. |
| Existing smoke suite | All 52 steps passed | Bot creation and updates, messaging and delegation, groups, views, memory isolation, compaction and earlier parts, long replies, work-folder changes, duplication, preferences, MCP and skill attachment. |
| Turbo runtime controls | All 11 checks passed | Native and MCP execution policies, malformed-input atomicity, group policy, duplication and fixed-model persistence. |
| Actual host restart | Passed | Saved allow list and `modelFallback: false` survived; allowed `list_bots` ran and excluded `recall` was refused. |
| Missing fixed model | Passed | A second host configuration removed the pinned model while leaving another usable mock-backed model. The turn recorded the fixed-model-unavailable diagnostic, sent zero new model requests, and preserved both selected and applied model. |

The focused execution checks covered:

1. A saved native allow list permits a real tool call.
2. An explicit deny takes precedence over a native wildcard allow.
3. An empty allow list refuses a real native call.
4. Invalid selectors and a non-boolean fallback value are rejected without partially changing the Bot.
5. Clearing Tool access restores normal execution.
6. Allowing an unattached MCP server does not attach or grant its tools.
7. Attaching and allowing the echo MCP server results in an observed `tools/call` invocation.
8. Denying that MCP tool prevents a forced model tool call from reaching the server.
9. The same Bot policy applies to group turns, with both allowed and refused calls verified.
10. Duplicating a Bot preserves its tool policy, fixed-model policy and selected model.
11. The selected and applied fixed model stay unchanged across private and group requests.

For native and group denial checks the mock attempted the tool and received the host's actual `Tool ... is disabled for ...` response. For the MCP check, an instrumented copy of the repository's echo fixture recorded real JSON-RPC `tools/call` messages. That generated fixture exists only inside the ignored test directory; the original fixture and DSH were not modified.

The missing-model test observed this diagnostic from a failed turn:

```text
The fixed model connection deepseek-official/deepseek-v4-pro is unavailable. Restore it or select another model in Bot settings.
```

The send endpoint acknowledges queued messages before execution. The negative test therefore waits for the resulting turn diagnostic rather than expecting the HTTP send request itself to fail.

## What Tool access guarantees

Tool access is enforced at execution time. The real model request still contains tool schemas and SDK descriptions. This test does not claim schema removal or provider-request filtering. It proves that disallowed calls are refused by the host, including an attempted MCP call that never reaches its server. The implementation preserves DSH's recorded model request and prepared adapter contract.

The fixed-model test covers loss of the selected model from the available catalog. It does not use a real provider key, test live Magpie inference, or cover every possible provider transport failure.

## Browser verification

The rebuilt plugin was also opened in a separate automated Chromium session against this isolated host. The Magpie form showed the local default URL, Responses protocol and an empty key field; the Add button stayed disabled until model discovery. Pointing discovery at the local mock endpoint displayed both returned model IDs. In Bot settings, the tool allow/deny lists were saved, the fixed-connection switch was enabled, and reopening the Bot page retained all values. Screenshots were visually inspected and kept outside the implementation branch. These are settings-interface checks against mock-backed data, not footage of live Magpie inference.

## Reproduce on Windows

Run commands from the repository root. Install the pinned test harness and build the plugin using the repository's usual setup first. The runner requires that pinned npm harness and does not need a full DSH source checkout.

```powershell
node ds-bot/dev/turbo-smoke.mjs prepare
```

Start each server as a separate **managed background job**, retaining its job ID. The runner itself stays in the foreground and does not daemonize.

```powershell
node ds-bot/dev/turbo-smoke.mjs mock
node ds-bot/dev/turbo-smoke.mjs host
```

Then run:

```powershell
node ds-bot/dev/turbo-smoke.mjs ready
node ds-bot/dev/turbo-smoke.mjs baseline
node ds-bot/dev/turbo-smoke.mjs controls
```

The baseline requires a fresh team. `prepare` preserves existing state. To start another baseline run, stop both servers, verify that both managed jobs exited, then use `reset`; it archives only this bench's previous data inside its own `history` directory. It refuses to reset while either bench port is occupied.

To verify persistence, stop only the host, collect its managed job output, start a new `host` job, and run:

```powershell
node ds-bot/dev/turbo-smoke.mjs stop-host
# Collect the old host job; start a new managed `host` job.
node ds-bot/dev/turbo-smoke.mjs ready
node ds-bot/dev/turbo-smoke.mjs verify
```

To verify the missing-model case, stop and collect the host job again, then start `host-unavailable` as a new managed background job:

```powershell
node ds-bot/dev/turbo-smoke.mjs host-unavailable
node ds-bot/dev/turbo-smoke.mjs ready
node ds-bot/dev/turbo-smoke.mjs verify-unavailable
```

Restore the regular `host` afterward for browser testing. To finish, signal both wrappers and collect their managed job outputs:

```powershell
node ds-bot/dev/turbo-smoke.mjs stop
```

Use this stop command before terminating a shell wrapper. On Windows, killing only the wrapper can leave its Node child listening on the test port. Successful managed shutdowns were verified with exit code 0.

## Isolation and local artifacts

The web server binds to `127.0.0.1:3096`; the mock binds to `127.0.0.1:8796`. The user's existing GUI port is not used.

The runner keeps all generated profiles, junctions, sessions, mock logs and scratch data under the ignored `.dsh-test-turbo/` directory. Actual `DSH_HOME` is `.dsh-test-turbo/runtime`; scratch folders are outside that runtime home so the normal work-folder protection remains effective. The runner removes inherited DSH/provider environment overrides, supplies only the mock credential, isolates user-profile directories, and narrows `PATH` to prevent installed local-agent CLIs from entering the test model picker. The baseline also checks that every available model is mock-backed before it starts.

Local evidence is deliberately uncommitted:

- `.dsh-test-turbo/smoke-transcript.json`: normalized output of the existing 52-step suite.
- `.dsh-test-turbo/turbo-controls-results.json`: focused check names and retained probe identifier.
- `.dsh-test-turbo/turbo-restart-results.json`: persistence checks.
- `.dsh-test-turbo/turbo-unavailable-results.json`: missing-model refusal and unchanged selection checks.
- `.dsh-test-turbo/echo-calls.jsonl`: actual echo MCP invocations.
- `.dsh-test-turbo/mock.jsonl`: mock request and response metadata used for assertions.

The host log contains an ephemeral login URL. Test automation reads it in memory for authentication. Do not copy the URL, cookies, raw host log, runtime home, or session files into reports or commits.

Early setup attempts exposed Windows bench assumptions: `--import` needs a file URL, the default local CLI discovery must be isolated, and scratch work folders must sit outside the runtime home. Those setup issues were corrected in the new runner before the successful full run. The original POSIX bench, existing smoke suite and product source were not modified by this verifier.
