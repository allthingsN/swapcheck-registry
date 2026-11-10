#### Migration Guides

# grok-imagine-image-quality Retirement on November 2, 2026

`grok-imagine-image-2.0` now covers everything `grok-imagine-image-quality` was used for, at a lower price. **Effective November 2, 2026**, the `grok-imagine-image-quality` model slug is retired from the xAI API. Its 60-day notice period began on September 2, 2026.

> [!CAUTION]
>
> After **November 2, 2026**, requests to `grok-imagine-image-quality` are served by `grok-imagine-image-2.0` with `quality` set to `low`. The slug continues to resolve, so you do not need to change your code to avoid breakage. `grok-imagine-image-2.0` is [priced differently](#pricing-impact) than the model it replaces.

`grok-imagine-image` (1.0) is not affected by this change.

### How the redirect works

Starting **November 2, 2026**:

* Requests to `grok-imagine-image-quality` on `/v1/images/generations` and `/v1/images/edits` are served by **`grok-imagine-image-2.0` with `quality: "low"`**.
* The request and response shapes are unchanged. Every parameter accepted today is accepted after the switch, and `grok-imagine-image-2.0` additionally accepts `quality`, up to five source images for editing, and the `21:9` and `5:2` aspect ratios.
* To confirm the switch, check [`usage.cost_in_usd_ticks`](/developers/cost-tracking) on responses. It reflects the `grok-imagine-image-2.0` low price: $0.04 per 1K image and $0.06 per 2K image, plus $0.01 per input image on edits. gRPC responses (xAI SDK) also report `model` as `grok-imagine-image-2.0-low`.
* Requests to `grok-imagine-image-pro`, which [already redirect](/developers/migration/may-15-retirement) to `grok-imagine-image-quality`, follow it to `grok-imagine-image-2.0` at `low`.

## Pricing impact

`grok-imagine-image-2.0` at `low` quality is $0.01 per image cheaper than `grok-imagine-image-quality` at every resolution. If you keep sending requests to the retired slug after November 2, you are billed at the `grok-imagine-image-2.0` `low` rate. See [Pricing](/developers/pricing) for current per-image rates.

## Recommended replacement

We recommend switching to `grok-imagine-image-2.0` explicitly before November 2. Doing so lets you choose the quality you pay for, rather than accepting the `low` default applied by the redirect.

| Model being retired | Redirect target after November 2 |
|---|---|
| `grok-imagine-image-quality` | `grok-imagine-image-2.0` with `quality: "low"` |

Migrating is a one-line change to the `model` field. `grok-imagine-image-2.0` also accepts an optional [`quality`](/developers/model-capabilities/images/generation#quality) parameter:

* `low` is what the redirect uses. It ranks #2 on the [Arena](https://arena.ai) Image Edit leaderboard and #3 on Text-to-Image, and is the closest match in cost to `grok-imagine-image-quality`.
* `medium` spends more compute on each image for finer detail; choose it where output quality matters more than cost.
* `auto` (the default when `quality` is omitted) currently serves `low` for generation and `medium` for editing, and you are billed at the quality served.

```python customLanguage="pythonOpenAISDK"
from openai import OpenAI

client = OpenAI(
    base_url="https://api.x.ai/v1",
    api_key="YOUR_API_KEY",
)

response = client.images.generate(
    model="grok-imagine-image-2.0",
    prompt="A watercolor painting of a lighthouse at dawn",
    extra_body={"quality": "low"},
)

print(response.data[0].url)
```

```javascript customLanguage="javascriptOpenAISDK"
import OpenAI from "openai";

const client = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: "https://api.x.ai/v1",
});

const response = await client.images.generate({
    model: "grok-imagine-image-2.0",
    prompt: "A watercolor painting of a lighthouse at dawn",
    quality: "low",
});

console.log(response.data[0].url);
```

```bash
curl -X POST https://api.x.ai/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-imagine-image-2.0",
    "prompt": "A watercolor painting of a lighthouse at dawn",
    "quality": "low"
  }'
```

```python customLanguage="pythonXAI"
import xai_sdk

client = xai_sdk.Client()

response = client.image.sample(
    prompt="A watercolor painting of a lighthouse at dawn",
    model="grok-imagine-image-2.0",
    quality="low",
)

print(response.url)
```

The same `model` change applies to [image editing](/developers/model-capabilities/images/editing) requests on `/v1/images/edits`.

## Need help?

If you have questions or need assistance with this migration, reach out to [support@x.ai](mailto:support@x.ai).
