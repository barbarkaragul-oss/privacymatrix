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

- `quote`: 12 to 400 characters, one contiguous excerpt, copied exactly. Smart quotes, markdown emphasis, capitalisation, punctuation and whitespace differences are tolerated; different wording is not.
- `evidence_url`: the page that contains the quote. Fragments (`#section`) are fine.
- `value: "unknown"` cells have an empty quote and `verified: false`. Silence in the documents is always *unknown*, never *no*.
- Leave `verified` and `verified_at` alone; `npm run check -- --fix` sets them.

## Workflow

```bash
npm install
# edit data/*.json
npm run check            # every quote must be found at its URL
npm run build            # regenerate README tables and docs/
npm test
```

Commit the regenerated `README.md` and `docs/` together with your data change; CI fails if they are out of sync.

## The weekly run

The `weekly` workflow re-fetches every evidence URL and searches for every quote. When all quotes are still present it commits the refreshed verification dates directly. When a quote has disappeared it demotes the cell to *unknown*, keeps the old quote, URL and value in the notes, and opens both a pull request and an issue labelled `needs-recheck`. Fixing such a cell is a good first contribution: find the current wording in the policy (or confirm the practice changed), update the cell, run `npm run check`, and open a pull request.

If the repository has an `ANTHROPIC_API_KEY` secret, the same workflow re-derives every cell with Claude instead. As in the free mode, unchanged values are committed directly and changed values are opened as a pull request titled *matrix: weekly re-verification (N value changes)*; no issue is opened in this mode. Review each row in the description against its source. Merging is a human decision; if a change looks wrong, fix the rubric or the source list in the same PR so the next run agrees with you.

Two repository settings make this work, both under Settings → Actions → General → Workflow permissions: choose **Read and write permissions** and enable **Allow GitHub Actions to create and approve pull requests**. Without the second one the first run that finds a change fails with "GitHub Actions is not permitted to create or approve pull requests". If `main` is protected so that direct pushes are rejected, the workflow falls back to a pull request for the date refresh as well.

Pull requests opened by the workflow do not trigger the CI workflow (GitHub does not run workflows for changes made with the default token), which is why the weekly workflow runs the typecheck, tests and build itself before opening one.

## Scope

- Consumer AI assistants only, on the consumer individual plan with default settings. Business, team and API plans appear in one question and in notes.
- Vendor-published documents only as evidence: the privacy policy, terms of use, and official help-center or trust pages. No news articles, blog posts, third-party summaries or archived copies.
- The global or US policy version by default; regional differences in notes.
- Nothing here is legal advice, and no cell claims that a vendor follows its policy; it claims only what the policy says.
