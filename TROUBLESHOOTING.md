# VSContext Troubleshooting

Use this guide when the graph, chat participant, or workspace indexing does not behave as expected.

## Common Recovery Steps

1. Open the VSContext output channel and look for the most recent warning or error.
2. Save the active file and wait for indexing to finish before retrying graph actions.
3. Reopen the workspace if the graph looks stale after major file moves or deletes.
4. Confirm the workspace contains supported source files and is not being filtered out by settings.
5. Increase `vscontext.maxIndexedFiles` if the workspace is larger than the current limit.

## Graph Is Empty Or Sparse

- Confirm the workspace has supported files such as TypeScript, JavaScript, Python, Go, Java, Rust, C-family, C#, PHP, Ruby, Kotlin, or Swift.
- Verify `vscontext.maxIndexedFiles` is high enough for the repository size.
- Check whether the workspace is still indexing; the graph will stay incomplete until the initial pass finishes.

## Indexing Is Slow

- Lower `vscontext.workerBatchSize` only if worker batches are too large for your machine.
- Adjust `vscontext.workerCount` to match available CPU cores.
- Leave `vscontext.debugSymbolDetection` disabled unless you need verbose diagnostics.

## Symbols Do Not Open

- Save the file, then rerun the command so the graph can refresh the current location.
- If the symbol was deleted or renamed, refresh the graph and select a new symbol from the tree view.

## Chat Requests Fail Or Fall Back

- Open the VSContext output channel for the full request log.
- Make sure the selected model is available and the request is not cancelled.
- Retry the request after indexing finishes if the graph was still building.

## Large Workspace Limits

- Increase `vscontext.maxIndexedFiles` if you need broader coverage.
- Narrow the workspace if the current limit is intentionally protecting performance.
- Review the benchmark guidance in [benchmarks/README.md](benchmarks/README.md) before raising limits in shared repositories.
