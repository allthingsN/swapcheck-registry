# swapcheck-registry

The open, signed registry behind [Swapcheck](https://github.com/allthingsN/swapcheck). It records when a hosted LLM model is retiring, being rerouted, repriced or losing request parameters, on each platform that serves it, and publishes the result as a signed JSON snapshot.

Published at `https://allthingsn.github.io/swapcheck-registry/`:

| File | What it is |
| --- | --- |
| `snapshot.json` | `RegistrySnapshot` (`version`, `generated_at`, `events`, `models`), the contract in `src/types.ts` |
| `snapshot.json.sig` | Detached Ed25519 signature, base64, over the exact bytes of `snapshot.json` |
| `feed.xml` | RSS 2.0, newest events first |
| `calendar.json` | Upcoming dated events, soonest first |

`registry-public.pem` is the verification key. Swapcheck pins the same key and refuses remote data whose signature does not verify.

## How a fact gets in

1. `scripts/update.ts` fetches each source in `parsers/`, one deterministic parser per source.
2. Parsers return candidate events and, for model catalogs, model rows. They read pages as data only: values are matched by pattern and validated (model IDs, dates, https URLs). No page text is followed as an instruction, and free page prose is not copied into the registry.
3. Candidates are consolidated, merged with `events/`, and the snapshot is validated, checked against the removal guard, written and signed.

No language model takes part in any step. A test fails the build if pipeline code calls an LLM API.

## Confidence

| Level | Rule |
| --- | --- |
| `high` | Stated on the provider's own page or API (for the `openrouter` route, OpenRouter's own API) |
| `medium` | Two independent secondary sources agree on the date, with no inferred successor |
| `low` | One secondary source, secondary sources that disagree, or an inferred successor or mapping |

A provider-page event is never decorated with a successor taken from a secondary source. Date disagreements between a provider page and a secondary source are listed in `out/run-report.json` under `cross_check`. A secondary-only date in the past is not published.

## Dates

`date_precision` is `exact`, `earliest_possible` or `estimated`:

- Google AI Studio says listed shutdown dates are the earliest possible, so table dates are `earliest_possible`. Rows already in a "Deprecated models" table happened, so they are `exact`. A re-route stated as "Effective December 1, 2026, all API requests ... will automatically route" is `exact`.
- Vertex AI's 12-month table "won't be moved to an earlier date", so it is `earliest_possible`; the short-availability and retired tables are `exact`.
- Azure dates for GA and Preview models are plans that Microsoft says are subject to change, so they are `estimated`. Deprecated, Legacy and Retired rows are `exact`.
- Secondary sources are `estimated`.
- "Not sooner than" (Anthropic) and "or later" (Vertex) on an active model are guaranteed floors, not announced retirements. They produce no event.

A model's status becomes `retired` only after an `exact`, high-confidence retirement date has passed. A passed floor date leaves it `deprecated`.

## Routes

The same model on another platform is a separate route with its own events.

`anthropic-api`, `openai-api`, `google-ai-studio`, `google-vertex`, `aws-bedrock`, `azure-foundry`, `mistral-api`, `xai-api`, `cohere-api`, `groq-api`, `deepseek-api`, `together-api`, `openrouter`.

`provider` is the company that makes the model; `route` is where it is served.

## Events

`events/<provider>/<id>.json` is the source of truth, one file per event. The ID is `<route>.<type>.<model>[.<variant>]`, with `/` written as `__`, `:` as `..` and `@` as `_at_`.

- Events are never deleted. When a working parser stops listing an event, the file gets `not_listed_since` and stays.
- When a fact changes, the earlier values move into `history` with the date of the change.
- `origin`, `history` and `not_listed_since` stay in the event file and are left out of the snapshot.

Event types: `retirement`, `reroute`, `alias_move`, `price_change`, `parameter_change`, `capability_change`, `new_model`.

Conventions worth knowing:

- Anthropic's removal of `temperature`, `top_p` and `top_k` in API version `2026-10-21` is one `parameter_change` per model that was not retired, so a lookup by model finds it.
- Bedrock publishes dates per base model ID. Inference-profile IDs (`us.`, `eu.`, `global.` and so on) get a copy at `low` confidence, because the mapping is inferred.
- Bedrock's "public extended access" start dates are `price_change` events with `billing: "unknown"`, because AWS says to expect higher pricing but does not publish the amount there.
- `price_change` and `capability_change` events also come from comparing model rows between runs.

## Sources

| Source | Parser | Kind |
| --- | --- | --- |
| Anthropic model deprecations | `anthropic` | primary |
| Google AI Studio (Gemini API) deprecations | `gemini` | primary |
| OpenAI deprecations | `openai` | primary |
| Amazon Bedrock model lifecycle | `bedrock` | primary |
| Vertex AI model versions | `vertex` | primary |
| Microsoft Foundry retirement schedule | `azure` | primary |
| Mistral models | `mistral` | primary |
| xAI migration guides | `xai` | primary |
| Cohere deprecations | `cohere` | primary |
| Groq deprecations | `groq` | primary |
| DeepSeek change log and pricing | `deepseek` | primary |
| Together AI deprecations | `together` | primary |
| OpenRouter models API | `openrouter` | primary for the `openrouter` route |
| [models.dev](https://models.dev) (MIT) | `models-dev` | secondary; capabilities, limits, prices and release dates |
| LiteLLM `model_prices_and_context_window.json` | `litellm` | secondary; successors are treated as inferred |
| [deprecations.info](https://deprecations.info) | `deprecations-info` | secondary cross-check |

Models come from models.dev for first-party, Bedrock and Vertex routes, and from OpenRouter for the `openrouter` route. Rows without a price or context limit are left out rather than guessed.

## Safety rails

- A parser that stops matching its page throws `ParseMismatchError`. The run continues, nothing from that source is removed, its models are carried forward from the previous snapshot, and the workflow opens one issue per broken parser.
- A run that would remove more than 20% of models or events from the previous snapshot fails without writing.
- The snapshot is validated against the contract before it is signed.
- Response bodies are capped at 20 MB, and each fetch times out after 45 seconds.

## Running it

Node 24 or newer runs the TypeScript directly. There are no dependencies.

```sh
npm test                                      # node:test, no network
node scripts/update.ts --offline --dry-run    # parse recorded fixtures, write nothing
node scripts/update.ts --dry-run              # fetch live, write nothing
REGISTRY_SIGNING_KEY_PEM="$(cat path/to/key.pem)" node scripts/update.ts
node scripts/verify.ts                        # check dist/ against registry-public.pem
node scripts/record-fixtures.ts gemini        # re-record one source's fixture
```

`out/run-report.json` (not committed) lists every source's outcome, added and amended event IDs, cross-checks and the removal check.

## Automation

- `update.yml` runs every 6 hours. It runs the tests, then the update, opens issues for broken parsers, and opens a pull request. That pull request is merged automatically only when every changed event is high confidence and no model rows changed. Anything else waits for review.
- `pages.yml` verifies the signature, then publishes `dist/` to GitHub Pages.

Repository setup:

- Add a secret `REGISTRY_SIGNING_KEY_PEM` holding the Ed25519 private key in PKCS#8 PEM.
- Set Pages to deploy from GitHub Actions.
- Allow GitHub Actions to create pull requests.

Actions are pinned by commit SHA.

## Licenses

Data (`events/`, `dist/`) is licensed CC BY 4.0, see `LICENSE-DATA`. Code (parsers, scripts) is licensed Apache-2.0, see `LICENSE`. Fixtures are copies of public pages, kept for testing, and remain their publishers' content. models.dev data is MIT-licensed.
