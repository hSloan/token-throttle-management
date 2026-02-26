# token-throttle-management

Simple, drop-in token rate-limit management for LLM API calls. Prevents HTTP 429 errors by estimating token counts and throttling requests to stay under your tokens-per-minute (TPM) budget.

Available in **Python** and **Node.js** — zero external dependencies.

## The Problem

LLM APIs enforce tokens-per-minute limits (e.g., 30K TPM). When agents read large files or web pages, they easily blow past this limit and get `429 Too Many Requests` errors. Retrying blindly just compounds the problem.

## The Solution

1. **Estimate tokens** before sending content (fast heuristic or precise counting)
2. **Track usage** within a rolling 60-second window
3. **Throttle automatically** — sleep when the budget is nearly exhausted
4. **Chunk oversized content** so no single request exceeds the budget

## Quick Start

### Python

```python
from token_throttle import TokenThrottle

throttle = TokenThrottle(tokens_per_minute=30000)

content = open("big_file.txt").read()

# Process content respecting rate limits
for chunk in throttle.consume(content):
    response = call_llm_api(chunk)
```

### Node.js

```javascript
const { TokenThrottle } = require("./token_throttle");

const throttle = new TokenThrottle({ tokensPerMinute: 30000 });

const content = fs.readFileSync("big_file.txt", "utf-8");

// Process content respecting rate limits
for await (const chunk of throttle.consume(content)) {
  const response = await callLlmApi(chunk);
}
```

## API

### `TokenThrottle(options)`

| Option | Default | Description |
|---|---|---|
| `tokens_per_minute` / `tokensPerMinute` | `30000` | Your TPM budget |
| `margin` | `0.85` | Safety margin (uses 85% of budget by default) |
| `chunk_size` / `chunkSize` | `null` | Max tokens per chunk (defaults to `budget * margin`) |
| `chars_per_token` / `charsPerToken` | `4` | Characters-per-token ratio for estimation |

### Methods

| Method | Description |
|---|---|
| `estimate(text)` | Returns estimated token count for a string |
| `consume(text)` | Generator/async-generator that yields throttled chunks |
| `wait_if_needed(tokens)` / `waitIfNeeded(tokens)` | Manually reserve tokens, sleeping if necessary |
| `reset()` | Reset the usage window |

## How It Works

- **Estimation:** Uses a configurable characters-per-token ratio (default 4:1, accurate for English). Swap in `tiktoken` or `js-tiktoken` for precise counts.
- **Windowing:** Tracks cumulative tokens in a rolling 60-second window. Resets automatically when the window expires.
- **Throttling:** When adding tokens would exceed the budget, sleeps until the window resets.
- **Chunking:** Content exceeding the per-chunk limit is split on paragraph → sentence → word boundaries to preserve readability.

## Tips

- Set `margin` to `0.7`–`0.8` if you're making multiple concurrent requests
- For web pages, strip HTML before passing to `consume()` — cuts tokens 50–80%
- Combine with a `HEAD` request to pre-check `Content-Length` before fetching

## License

MIT
