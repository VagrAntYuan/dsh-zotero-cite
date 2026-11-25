# dsh-zotero-cite

DeepSeek Harness plugin that turns a folder of PDFs into a Word document whose citations and
bibliography are **native Zotero fields** — the ones Zotero's Word tab recognises, renumbers, and
refreshes. It also writes a citation review report so each citation can be checked against its
source.

It talks to the Zotero instance you already run on this machine (`http://localhost:23119`). No
account, no cloud sync, no Python, no third-party npm dependency.

## Requirements

- Zotero Desktop running, with its local API on the default port (`23119`).
- Word with the Zotero word-processor plugin installed, to refresh the fields after injection.
- Zotero 9.1 or later for automatic duplicate merging. Earlier versions can only report duplicates,
  because their local `/api/` is read-only; importing still works through the connector API.
- The CSL style you inject must already be installed in Zotero. The default is
  `http://www.zotero.org/styles/ieee`.

## Install

From the plugin marketplace, which installs the repository directly:

```sh
dsh plugin add github:VagrAntYuan/dsh-zotero-cite
```

From a checkout, point the plugin manager at the folder that holds `package.json`:

```
plugin_manager action=install_bundle target=<absolute path of this folder>
```

Then check that the seven `zotero_*` / `docx_*` tools appear in the tool list.

## Workflow

The tools follow the order of the work; each one is safe to run on its own.

| Step | Tool | What it does |
| --- | --- | --- |
| 1 | `zotero_status` | Confirms Zotero answers, counts items and attachments, reports whether the local write API is authorized. |
| 2 | `zotero_import_pdfs` | Matches the folder's PDFs to existing items by attachment filename, first-author surname, and year; imports only the confident matches. Writes `import_map.json`. Dry run by default. |
| 3 | `zotero_find_duplicates` | Groups items sharing a DOI or a normalized title with the same type, ranks which copy to keep, and (Zotero 9.1+) merges the rest. Writes `duplicates_merge_instructions.json` / `.md`. |
| 4 | `zotero_fetch_csl` | Exports complete CSL JSON for the cited keys and writes `csl_items.json`. |
| 5 | `docx_inject_citations` | Replaces `{{Z1}}` / `{{BIB}}` placeholders with `ZOTERO_ITEM` and `ZOTERO_BIBL` fields and records the style in `ZOTERO_PREF`. Writes a new file. |
| 6 | `docx_check_citations` | Verifies the result: field counts, balanced `fldChar`, no leftover placeholders, `ZOTERO_PREF` present. |
| 7 | `docx_citation_report` | Writes `citation_review_report.md`: every citation with its section and citing sentence, ready to be marked 合理 / 存疑 / 不合理. |

A typical session:

> Import the PDFs in `D:\papers` into Zotero, then cite them in `draft.docx`. Use `{{Z1}}`…`{{Z5}}`
> where I wrote the placeholders and put `{{BIB}}` where the bibliography belongs.

The model then runs `zotero_import_pdfs` (dry run first), resolves the `needs-review` files with
you, fetches CSL, injects fields, verifies, and finally writes the review report.

### Placeholder convention

Write placeholders in the draft, each alone in its own run (no bold/italic split, no adjacent text
inside the same run):

| Placeholder | Result |
| --- | --- |
| `{{Z1}}` | One citation field for item `Z1`, displayed as `[1]`. |
| `{{Z3,4}}` | One citation field citing two items, displayed as `[3], [4]`. |
| `{{BIB}}` | The bibliography field. When the marker is absent the bibliography is appended before the final section break. |

Reuse the same `{{Zn}}` everywhere one reference is cited; do not map one item key to two numbers,
or Zotero will number it twice.

## Files written

All artifacts land in the work directory you pass (default: the process working directory):

- `import_map.json` — PDF file → item key, with `existing` / `matched` / `needs-review` /
  `unmatched` / `imported` status and candidates for anything ambiguous.
- `csl_items.json` — local user key plus the full CSL record of every cited item.
- `duplicates_merge_instructions.json` / `.md` — duplicate groups, the copy to keep, and what happened.
- `citation_review_report.md` — the review table.

## Safety

- Nothing is written to your library until you pass `dryRun=false` to `zotero_import_pdfs` or
  `merge=true` to `zotero_find_duplicates`.
- `docx_inject_citations` never edits its input; it writes a new `.docx`.
- The only network endpoint is the Zotero server origin you pass (default `http://localhost:23119`).
  No telemetry, no remote calls, no credentials stored.

## Limitations

- Duplicate merging on Zotero 9.0.x is report-only; the `.md` file lists the groups to merge by hand.
- Matching is filename- and author-based, not full-text; anything ambiguous is reported for review
  rather than imported.
- The review report is a template. Deciding whether a citation supports a sentence needs the source
  PDF and a reader — the plugin only assembles the table.
- Fields are written for the Zotero Word plugin. LibreOffice's Zotero plugin uses the same field
  format but is not tested here.

## License

MIT
