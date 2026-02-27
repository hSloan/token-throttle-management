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

---

## Concurrent Sub-Agent Budget Rule

**The 30K TPM limit is per API key — shared across the main session and ALL sub-agents.**

When running sub-agents alongside the main session, apply these rules:

- **Sub-agents must budget to ≤ 15,000–20,000 TPM effective** to leave headroom for the main session
- **Never run two read-heavy sub-agents concurrently** — they will race each other to the limit and both 429
- **Main session should idle** (stop making reads/writes) while a sub-agent is performing heavy file or web operations
- **Stagger spawns** — spawn one sub-agent, let it complete its heavy reads before spawning the next
- **On 429 in a sub-agent:** wait 60s before retrying; inform the main session if budget is critically low

### Sub-agent `sessions_spawn` task template addition

Every task passed to a sub-agent via `sessions_spawn` must include this block:

```
## Token Throttle (MANDATORY)
The 30K TPM limit is SHARED across ALL agents on this API key (main session + all sub-agents).
Sub-agents must budget for ~15K–20K TPM effective to leave headroom for the main session.

Before reading ANY file or fetching ANY URL:
1. Estimate tokens: file → file_size/4, URL → HEAD Content-Length/4, text → len(text)/4
2. If > 20K tokens → chunk using `TokenThrottle.consume()`
3. On 429 error → wait 60s, retry with smaller chunks
4. Track cumulative token usage across all reads in a 60s window
5. Never read multiple large files back-to-back without throttle checks
6. Default to conservative pacing — read one file, pause, read the next
```
