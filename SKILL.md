---
name: token-throttle
description: >
  Token rate-limit management for LLM API calls. Use BEFORE reading large files,
  fetching web pages, or sending any content to an LLM API that enforces
  tokens-per-minute (TPM) limits. Prevents HTTP 429 rate-limit errors by
  estimating token counts and throttling requests. Trigger when: (1) reading
  files or URLs that may be large, (2) processing multiple documents in
  sequence, (3) encountering or anticipating 429/rate_limit errors, (4) batch
  processing content through any LLM API.
---

# Token Throttle

Prevent 429 rate-limit errors by estimating and throttling token usage.

## Quick Estimation (No Library Needed)

Before reading any file or URL, estimate tokens first:

- **Files:** `file_size_bytes / 4` ≈ token count
- **URLs:** Send a HEAD request, use `Content-Length / 4`
- **Text already in memory:** `len(text) / 4`

If the estimate exceeds ~25K tokens, chunk before sending to the API.

## When to Throttle

- Single file/page > 20K estimated tokens → chunk it
- Multiple files in sequence → track cumulative usage per 60s window
- After any 429 error → wait 60s, then resume with smaller chunks

## Python

```python
from token_throttle import TokenThrottle

throttle = TokenThrottle(tokens_per_minute=30000)

# Read and process large content in throttled chunks
content = open("large_file.txt").read()
for chunk in throttle.consume(content):
    response = call_api(chunk)

# Or gate individual calls manually
throttle.wait_if_needed(throttle.estimate(some_text))
response = call_api(some_text)
```

Copy `python/token_throttle.py` into your project. Zero dependencies.

## Node.js

```javascript
const { TokenThrottle } = require("./token_throttle");
const throttle = new TokenThrottle({ tokensPerMinute: 30000 });

const content = fs.readFileSync("large_file.txt", "utf-8");
for await (const chunk of throttle.consume(content)) {
  const response = await callApi(chunk);
}
```

Copy `node/token_throttle.js` into your project. Zero dependencies.

## Pre-check Helpers

Estimate before fetching to decide whether to chunk:

```python
from token_throttle import estimate_file_tokens, estimate_url_tokens

tokens = estimate_file_tokens("report.pdf")  # uses file size
tokens = estimate_url_tokens("https://example.com/page")  # uses HEAD Content-Length

if tokens and tokens > 25000:
    # Use throttle.consume() to chunk
    ...
```

## Key Parameters

| Parameter | Default | Use |
|---|---|---|
| `tokens_per_minute` | 30000 | Match your API's TPM limit |
| `margin` | 0.85 | Lower (0.7) for concurrent requests |
| `chunk_size` | budget | Override max tokens per chunk |

## Rules

1. **Always estimate before reading** large or unknown-size content
2. **Use `consume()`** for anything over 20K estimated tokens
3. **Lower margin to 0.7** when making concurrent API calls
4. **Strip HTML/JS/CSS** from web pages before estimating — raw HTML inflates token count 2-5x
