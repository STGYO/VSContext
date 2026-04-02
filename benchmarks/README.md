# VSContext Workspace Size Benchmarks

<!-- markdownlint-disable MD060 -->

This benchmark set tracks how VSContext behaves at three practical workspace sizes:

- 100 supported source files
- 1,000 supported source files
- 5,000+ supported source files

## Metrics To Capture

- Initial scan duration
- Initial graph build duration
- Indexed symbol count
- Skipped-file count from `maxIndexedFiles`
- Code graph render latency
- Chat query response latency for `/summary`, `/trace`, and `/impact`

## Procedure

1. Open a workspace fixture that approximates the target size.
2. Keep `vscontext.debugSymbolDetection` disabled unless you are measuring diagnostic overhead.
3. Set `vscontext.maxIndexedFiles` high enough to avoid truncation for the 100 and 1,000 file cases.
4. For the 5,000+ file case, record both the capped result and the warning surfaced by VSContext.
5. Run `VSContext: View Code Graph`, `VSContext: Trace Path`, and `VSContext: Impact` after the initial index completes.
6. Capture the timestamps and counts from the VSContext output channel.

## Result Template

| Workspace Size | Scanned Files | Indexed Symbols | Skipped By Limit | Initial Build Time | Notes |
| --- | --- | --- | --- | --- | --- |
| 100 |  |  |  |  |  |
| 1,000 |  |  |  |  |  |
| 5,000+ |  |  |  |  |  |

## Interpretation

- If scan or build time grows sharply between 1,000 and 5,000+ files, lower the default worker counts or reconsider the indexing limit.
- If the skipped-file count is high in the 5,000+ case, the workspace is intentionally being degraded and the user should be warned rather than surprised.
- Record the benchmark snapshot whenever indexing, graph traversal, or persistence logic changes.
