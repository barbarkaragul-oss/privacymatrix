# Contributing

Thanks for helping keep the matrix honest. The rules are simple: every non-unknown cell needs a verbatim quote from the vendor's own published documents, and CI checks that the quote really exists at the URL.

## Data files

### `data/apps.json`

```json
{
  "id": "example-assistant",
  "name": "Example Assistant",
  "vendor": "Example Inc.",
  "homepage": "https://assistant.example.com",
  "repo": null,
  "sources": [
    "https://example.com/legal/privacy-policy",
    "https://help.example.com/articles/how-we-use-your-conversations"
  ]
}
```

- `id`: lowercase, dashes only. Used in `matrix.json`.
- `sources`: the pages the weekly pipeline fetches for this app: the privacy policy, terms of use, and help-center or trust pages about training, retention, deletion, memory, advertising and data rights. Prefer URLs whose text is available to a plain HTTP request; test with `curl -sL -A "Mozilla/5.0 (compatible; privacymatrix-bot/0.1)" <url>` and confirm the policy text is in the output. Pages rendered only by JavaScript cannot be verified.
- `repo`: `null` unless the product is open source.

### `data/questions.json`

Each question has a `question` (what is being asked) and a `rubric` (how to decide yes / partial / no / unknown). Every question is phrased so that **yes is the more privacy-protective answer**. Rubrics must be decidable from the documents alone, for the consumer plan with default settings; regional and business-plan differences go in the notes. If two reasonable people would disagree about a cell, the fix is usually a sharper rubric, not a longer argument.

### `data/matrix.json`

One entry per app × question:

```json
{
  "app": "example-assistant",
  "question": "no_training_default",
  "value": "partial",
  "quote": "We may use your conversations to improve our models unless you turn off Improve the model for everyone in Settings.",
  "evidence_url": "https://help.example.com/articles/how-we-use-your-conversations",
  "notes": "Training is on by default and can be turned off in Settings; the setting does not cover files shared with support.",
  "confidence": "high",
  "verified": true,
  "verified_at": "2026-09-11"
}
```

- `quote`: 12 to 400 characters, one contiguous excerpt, copied exactly. Smart quotes and dashes, markdown emphasis, capitalisation and whitespace differences are tolerated; different wording or punctuation is not (a quote that matches only when punctuation is ignored is reported as `REQUOTE` and does not confirm its cell, because a cut at a comma can hide an exception that follows it). Some vendors serve a regional variant of the same page depending on the reader's IP address (Meta's policy says "Help Centers" to a US reader and "Help Centres" elsewhere). The weekly check runs from a GitHub runner in the United States, so quote the US variant or, better, a sentence that is identical in every variant; the `Debug fetch` workflow shows the text the runner receives.
- `evidence_url`: the page that contains the quote. Fragments (`#section`) are fine.
- `value: "unknown"` cells have an empty quote and `verified: false`. Silence in the documents is always *unknown*, never *no*.
- Leave `verified`, `verified_at`, `verified_via` and `manual_fingerprint` alone; `npm run check -- --fix` sets them. A re-quoted cell keeps its date until the next scheduled check re-dates it; do not edit `verified_at` by hand to match. The one exception is a maintainer's reading of a blocked page, described under [Evidence the checker cannot read](#evidence-the-checker-cannot-read).

## Workflow

```bash
npm install
# edit data/*.json
npm run check            # every quote must be found at its URL
npm run check -- --changed-since origin/main   # what CI runs on a pull request (see below)
npm run build            # regenerate README tables and docs/
npm test
```

Commit the regenerated `README.md` and `docs/` together with your data change; CI fails if they are out of sync.

## Evidence the checker cannot read

On a pull request, CI runs `npm run check -- --changed-since <base>` (locally, use `--changed-since origin/main` or `HEAD~1`; cmd.exe removes the caret from `HEAD^1`). Every cell whose value, quote, URL or verification fields the pull request adds or changes must have its quote found in that run, on the live page or in an Internet Archive capture. Removing or re-dating a cell's `quote_missing_since` flag counts as changing it: removing it claims the quote is back, so a capture or a reading by hand from before the flag does not confirm it; re-dating it moves the demotion clock. Adding a flag the way a run adds it (dated today or within the six days before) does not. For cells the pull request does not change, an unreadable page is only reported, and so is a quote missing from a page that was read once a run has flagged the cell, in the pull request or its base: otherwise the weekly pull request that carries the flag would fail on the quote it reports. A quote missing on an unchanged cell that no run has flagged yet still fails the check: either the vendor just changed the page (merge the pull request that flags it, or re-quote the cell, then re-run) or the pull request's code broke quote matching. A changed cell that is not confirmed is listed as `UNVERIFIED`, with the reason, and fails the check:

- The page was temporarily unavailable (a 5xx, a timeout): re-run the `quotes` job.
- The quote was not found: check it against the page. The text the runner receives can differ from what your browser shows; the `Debug fetch` workflow (below) shows it.
- The page cannot be read from the cloud at all (it is built by JavaScript, answers with no text, or shows a bot challenge): mark the app `blocked_from_cloud` in `data/apps.json` in a separate pull request, with the `Debug fetch` output as evidence, and have that reviewed first.

For an app that the base already marks `blocked_from_cloud`, a maintainer can vouch for a changed cell whose page the checker could not read: read the page in a browser, confirm the quote is on it exactly, and run `npm run attest -- <app> <question>`, then `npm run build`. That marks the cell verified today (UTC), `verified_via: "manual"`, and records `manual_fingerprint`, which ties the reading to the cell's value, quote, URL and date. CI lists such cells as `ATTESTED`, not confirmed, with the fingerprint's first characters, so the reviewer can weigh them. The reading counts only while:

- the fingerprint still matches the cell: change the value, quote, URL or date afterwards, in the same pull request or a later one, and the page has to be read and attested again;
- the pull request was opened by a maintainer of this repository (GitHub's author association OWNER, MEMBER or COLLABORATOR, which CI reads from GitHub, not from the data). A maintainer's commit on a contributor's pull request does not count; the maintainer opens a pull request of their own;
- it is at most 14 days old;
- the checker could not read the page. It does not cover a quote the checker read and found malformed or matching only with punctuation ignored; copy that one again.

A flag added in the same pull request does not count, and both lists also appear in the job summary. Two limits: a maintainer who runs `attest` without reading the page is trusted, which is why the `ATTESTED` line names whose word it is; and a pull request that changes `.github/` or `src/` can change the gate itself, so such changes are reviewed as code, not as data. A local run accepts a reading from whoever runs it.

Pull requests opened or updated by the weekly workflow can require approval before CI starts. Review the diff, select **Approve workflows to run** on the pull request, and check the `test` and `quotes` results for its current head before merging.

## The weekly run

The `weekly` workflow re-fetches every evidence URL and searches for every quote. When all quotes are still present it commits the refreshed verification dates, directly when `main` allows the bot to push, otherwise through a pull request from `bot/weekly-dates`. When a quote is not found, the cell is kept but flagged (`quote_missing_since`) and an issue labelled `needs-recheck` lists it; if the quote is still missing a week later the cell is demoted to *unknown*, the old quote, URL and value are kept in the notes, and a pull request is opened. The one-week grace exists because some vendors serve a different page to cloud IP ranges than to a browser; one odd fetch must not erase a verified cell. Fixing a flagged or demoted cell is a good first contribution: find the current wording in the policy (or confirm the practice changed), update the cell, run `npm run check`, and open a pull request.

To see exactly what the runner received for an app, start the manual `Debug fetch` workflow from the Actions tab with the app id; it uploads the text of every fetched page as an artifact. Locally, `npm run check -- --app <id> --dump <dir>` does the same.

If the repository has an `ANTHROPIC_API_KEY` secret, the same workflow re-derives every cell with Claude instead. As in the free mode, unchanged values are committed directly and changed values are opened as a pull request titled *matrix: weekly re-verification (N value changes)*; no issue is opened in this mode. Review each row in the description against its source. Merging is a human decision; if a change looks wrong, fix the rubric or the source list in the same PR so the next run agrees with you.

Two repository settings make this work, both under Settings → Actions → General → Workflow permissions: choose **Read and write permissions** and enable **Allow GitHub Actions to create and approve pull requests**. Without the second one the first run that finds a change fails with "GitHub Actions is not permitted to create or approve pull requests". If `main` is protected so that direct pushes are rejected, the workflow falls back to a pull request for the date refresh as well, on its own branch (`bot/weekly-dates`), so a week without value changes never rewrites an open demotion pull request on `bot/weekly-verification`. Merge that pull request each week, before the next weekly run: the first-miss flags are in it. A flag carries the date of the run that set it, and a demotion needs it on `main` at a later run at least six days after that date; a flag still unmerged at the next weekly run is set again from scratch, with that run's date. In a week with value changes the dates and flags travel in the demotion pull request instead, and the workflow closes an older dates pull request, which would otherwise bring back flags the newer run cleared. The `quotes` check on that pull request reports the quotes it flags instead of failing on them (see [Evidence the checker cannot read](#evidence-the-checker-cannot-read)). Its re-dated cells must still be confirmed when CI runs; if a vendor changes a page between the weekly fetch and the pull request's CI, re-quote the cell on that branch or run the weekly workflow again by hand. After a complete reading that finds every quote and demotes nothing, it also closes a demotion pull request left from an earlier week.

Since [11 June 2026](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/), `GITHUB_TOKEN`-created or updated pull requests can run CI with approval from someone with write access. This is workflow-execution approval, not permission to skip required checks. The weekly workflow also typechecks, tests and builds before publishing. Source outages may still prevent the PR's `quotes` check from confirming changed evidence.

The weekly job closes an old `needs-recheck` issue only after a full free-mode run has no value changes, missing flags, re-quotes or unreadable cells. A partial app run or an unreadable source never closes it as resolved.

## Evidence age and local operation

The site marks evidence at least 14 days old as freshness unconfirmed and at least 28 days old as stale; these are visibility thresholds, not automatic changes to the yes/partial/no claim. The JSON export adds `freshness_policy` and per-cell `freshness`, evaluated at the matrix's `generated_at`, or at the newest verification date if a reading by hand came after it; consumers such as MCP connectors should recalculate age from `verified_at` at request time. The browser does that on load. Re-reading an old archive capture does not give it today's date.

Node 22.19+ (22.x) or 24.6+ is required. The network commands use Node's system certificate store in addition to its bundled roots, so an authorised certificate installed in Windows is recognised without disabling TLS checks. A certificate error includes its code; do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Use `npm run dev` for the local site. `npm run check` reports against real sources without changing the matrix. `npm run test:no-git` omits the one integration test that creates temporary Git commits. A residential `--dry-run` uses that test command and does not publish anything.

For manual reading without any Git operation or project-data edit, use `npm run manual -- --state <folder> --local-only --all`. The folder needs `last-report.json` from a residential check. The page shows every unreadable source, oldest evidence first. Save writes a timestamped `manual-draft-*.json` in that folder with proposed cells and their original fingerprints; the full pasted page text is not saved. Review the draft and verify its original fingerprints still match before applying it. The expiry timer saves the same local draft. This mode works with uncommitted changes and does not change the installed task's reading clock. Without `--local-only`, Save retains its normal GitHub publication behavior.

The residential task schedules each source separately in its local `source-state.json`: a completed read is due after six days, an unreadable source the next UTC day, and changed evidence immediately. Missing quotes and quotes to re-quote accompany every run until resolved, so a partial run cannot overwrite an earlier pending demotion, and the issue that counts a re-quote also names it. Publication failure leaves a retry marker so a successful fetch cannot hide an unpublished result. Existing successful source readings do not defer failed sources. Sources that are not due in a run do not keep the issue or the demotion PR open by themselves: their unreadable pages and re-quotes are counted from `source-state.json`. A run whose due pages were all unreadable before, and still are, publishes nothing and exits normally; a run that reads nothing while readable pages were due fails, and leaves the stored schedule as it was. The reading page's saved report retains the latest result for each cell.

If main rejects a residential or manual update because it is protected, the update is pushed to a branch named by its commit and a PR is opened for review. No automatic merge occurs. Separate branches preserve earlier pending readings when later runs check different sources; review pending reading PRs regularly. Normal network errors and non-fast-forward races are not disguised as protection failures.

Archive lookup retries transient 429/502/503/504 responses or connection failures at most twice within a shared timeout, respecting Retry-After. Previously read capture addresses are cached; a cached capture is fetched and checked again before use. No quote text is trusted from the cache and no archive miss demotes a cell.

## Scope

- Consumer AI assistants only, on the consumer individual plan with default settings. Business, team and API plans appear in one question and in notes.
- Vendor-published documents only as evidence: the privacy policy, terms of use, and official help-center or trust pages. No news articles, blog posts or third-party summaries. Never cite an archived copy; the checker may only use the Internet Archive's capture of the vendor's own page to confirm a quote on a page that refuses it, and records that it did.
- The global or US policy version by default; regional differences in notes.
- Nothing here is legal advice, and no cell claims that a vendor follows its policy; it claims only what the policy says.
