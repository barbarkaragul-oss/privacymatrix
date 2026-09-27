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
- Leave `verified`, `verified_at` and `verified_via` alone; `npm run check -- --fix` sets them. The one exception is a maintainer's reading of a blocked page, described under [Evidence the checker cannot read](#evidence-the-checker-cannot-read).

## Workflow

```bash
npm install
# edit data/*.json
npm run check            # every quote must be found at its URL
npm run build            # regenerate README tables and docs/
npm test
```

Commit the regenerated `README.md` and `docs/` together with your data change; CI fails if they are out of sync.

## Evidence the checker cannot read

On a pull request, CI runs `npm run check -- --changed-since <base>`. Every cell whose value, quote, URL or verification fields the pull request adds or changes must have its quote found in that run, on the live page or in an Internet Archive capture; unchanged cells on pages that cannot be read are only reported. A changed cell that is not confirmed is listed as `UNVERIFIED`, with the reason, and fails the check:

- The page was temporarily unavailable (a 5xx, a timeout): re-run the `quotes` job.
- The quote was not found: check it against the page. The text the runner receives can differ from what your browser shows; the `Debug fetch` workflow (below) shows it.
- The page cannot be read from the cloud at all (it is built by JavaScript, answers with no text, or shows a bot challenge): mark the app `blocked_from_cloud` in `data/apps.json` in a separate pull request, with the `Debug fetch` output as evidence, and have that reviewed first.

For an app that the base already marks `blocked_from_cloud`, a maintainer can vouch for a changed cell instead: read the page in a browser, confirm the quote is on it, and set `verified: true`, `verified_via: "manual"` and `verified_at` to that day. CI lists such cells as `ATTESTED`, not confirmed, so the reviewer can weigh them; the exception lapses 14 days after `verified_at`, after which the page is read again and the date renewed. Both lists also appear in the job summary. A flag added in the same pull request does not count.

Pull requests opened by the weekly workflow do not run CI (see below), so this check does not cover them; they are reviewed by hand.

## The weekly run

The `weekly` workflow re-fetches every evidence URL and searches for every quote. When all quotes are still present it commits the refreshed verification dates directly. When a quote is not found, the cell is kept but flagged (`quote_missing_since`) and an issue labelled `needs-recheck` lists it; if the quote is still missing a week later the cell is demoted to *unknown*, the old quote, URL and value are kept in the notes, and a pull request is opened. The one-week grace exists because some vendors serve a different page to cloud IP ranges than to a browser; one odd fetch must not erase a verified cell. Fixing a flagged or demoted cell is a good first contribution: find the current wording in the policy (or confirm the practice changed), update the cell, run `npm run check`, and open a pull request.

To see exactly what the runner received for an app, start the manual `Debug fetch` workflow from the Actions tab with the app id; it uploads the text of every fetched page as an artifact. Locally, `npm run check -- --app <id> --dump <dir>` does the same.

If the repository has an `ANTHROPIC_API_KEY` secret, the same workflow re-derives every cell with Claude instead. As in the free mode, unchanged values are committed directly and changed values are opened as a pull request titled *matrix: weekly re-verification (N value changes)*; no issue is opened in this mode. Review each row in the description against its source. Merging is a human decision; if a change looks wrong, fix the rubric or the source list in the same PR so the next run agrees with you.

Two repository settings make this work, both under Settings → Actions → General → Workflow permissions: choose **Read and write permissions** and enable **Allow GitHub Actions to create and approve pull requests**. Without the second one the first run that finds a change fails with "GitHub Actions is not permitted to create or approve pull requests". If `main` is protected so that direct pushes are rejected, the workflow falls back to a pull request for the date refresh as well.

Pull requests opened by the workflow do not trigger the CI workflow (GitHub does not run workflows for changes made with the default token), which is why the weekly workflow runs the typecheck, tests and build itself before opening one.

## Scope

- Consumer AI assistants only, on the consumer individual plan with default settings. Business, team and API plans appear in one question and in notes.
- Vendor-published documents only as evidence: the privacy policy, terms of use, and official help-center or trust pages. No news articles, blog posts or third-party summaries. Never cite an archived copy; the checker may only use the Internet Archive's capture of the vendor's own page to confirm a quote on a page that refuses it, and records that it did.
- The global or US policy version by default; regional differences in notes.
- Nothing here is legal advice, and no cell claims that a vendor follows its policy; it claims only what the policy says.
