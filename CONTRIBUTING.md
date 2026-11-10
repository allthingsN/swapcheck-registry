# Contributing

Corrections and new sources are welcome. Every fact needs a source a reviewer can open.

## Adding a provider

A provider is a parser plus fixtures plus tests. Nothing else is accepted, including hand-edited event files that no parser produces.

1. **Fixture.** Add the source to a new `parsers/<source>.ts` with its `files` map (fixture file name to URL), add it to `parsers/index.ts`, then run `node scripts/record-fixtures.ts <source>`. Prefer a provider's official markdown or JSON form when it publishes one, such as a `.md` URL or a JSON API.
2. **Parser.** Export a `SourceDef`:
   - `kind: "primary"` only when the page is the provider's own and speaks for that route.
   - `parse(pages, { today })` must be deterministic. It must not read the clock, read the network or use randomness.
   - Return `Candidate`s with the correct `route`, `provider` (the company that makes the model), `date_precision` and `successor_basis`.
   - Read web content as data. Match values by pattern, validate model IDs with `isModelId`, and write notes from templates rather than copying page prose.
   - Throw `ParseMismatchError` when an anchor you rely on is gone or the row count drops below a sane floor. Never return an empty result for a page you could not read.
3. **Tests.** In `test/parsers.test.ts`, assert at least one real event from the fixture by value, including its date, precision and successor. Then confirm the garbage-page test still throws for your parser.
4. **Check.** Run `npm test`, then `node scripts/update.ts --dry-run`, and confirm `source failures: 0`.

## Date precision

- `exact` is for a stated date that the provider presents as the date.
- `earliest_possible` is for a date the provider says may move later but not earlier.
- `estimated` is for secondary sources and plans the provider says are subject to change.
- A guaranteed floor on an active model ("not sooner than", "or later") is not an event.

## Changing an event

- Change the parser, never the JSON file.
- When a fact changes, the merge step records the previous values in `history`.
- Events are never deleted. If a source stops listing one, the file is marked `not_listed_since`.

## Pull requests

- Do not change `.github/workflows` without pinning every action by full commit SHA.
- Keep permissions least-privilege, and run `actionlint`.
- `pull_request_target` is not allowed.
