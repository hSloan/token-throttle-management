"""
token_throttle - Simple token rate-limit management for LLM API calls.

Zero dependencies. Drop into any project.

Usage:
    from token_throttle import TokenThrottle

    throttle = TokenThrottle(tokens_per_minute=30000)

    # Auto-chunk and throttle large content
    for chunk in throttle.consume(large_text):
        response = call_your_api(chunk)

    # Or manually gate individual calls
    throttle.wait_if_needed(estimated_tokens)
    response = call_your_api(content)
"""

import time
import re
from typing import Iterator, Optional


class TokenThrottle:
    """Track token usage within a rolling minute window and throttle to stay under budget."""

    def __init__(
        self,
        tokens_per_minute: int = 30_000,
        margin: float = 0.85,
        chunk_size: Optional[int] = None,
        chars_per_token: float = 4.0,
    ):
        """
        Args:
            tokens_per_minute: Your TPM limit.
            margin: Safety factor (0-1). Effective budget = tpm * margin.
            chunk_size: Max tokens per yielded chunk. Defaults to effective budget.
            chars_per_token: Characters-per-token ratio for estimation (4 ≈ English).
        """
        self.tpm = tokens_per_minute
        self.margin = margin
        self.budget = int(tokens_per_minute * margin)
        self.chunk_size = chunk_size or self.budget
        self.chars_per_token = chars_per_token

        self._tokens_used = 0
        self._window_start = time.monotonic()

    # ── Estimation ──────────────────────────────────────────────

    def estimate(self, text: str) -> int:
        """Estimate token count from text length."""
        return max(1, int(len(text) / self.chars_per_token))

    # ── Window management ───────────────────────────────────────

    def _maybe_reset_window(self) -> None:
        elapsed = time.monotonic() - self._window_start
        if elapsed >= 60.0:
            self._tokens_used = 0
            self._window_start = time.monotonic()

    def reset(self) -> None:
        """Manually reset the usage window."""
        self._tokens_used = 0
        self._window_start = time.monotonic()

    # ── Throttling ──────────────────────────────────────────────

    def wait_if_needed(self, tokens: int) -> float:
        """
        Reserve `tokens` from the budget, sleeping if necessary.

        Returns seconds slept (0 if no wait was needed).
        """
        self._maybe_reset_window()

        if self._tokens_used + tokens <= self.budget:
            self._tokens_used += tokens
            return 0.0

        # Need to wait for window reset
        elapsed = time.monotonic() - self._window_start
        sleep_time = max(0.0, 60.0 - elapsed + 0.5)  # +0.5s buffer
        if sleep_time > 0:
            time.sleep(sleep_time)

        # Reset after sleeping
        self._tokens_used = tokens
        self._window_start = time.monotonic()
        return sleep_time

    # ── Chunking ────────────────────────────────────────────────

    def _split_text(self, text: str, max_chars: int) -> list[str]:
        """Split text into chunks of roughly max_chars, breaking on paragraph/sentence/word boundaries."""
        if len(text) <= max_chars:
            return [text]

        chunks = []
        remaining = text

        while remaining:
            if len(remaining) <= max_chars:
                chunks.append(remaining)
                break

            # Try to break at paragraph boundary
            slice_ = remaining[:max_chars]
            break_pos = slice_.rfind("\n\n")

            # Fall back to sentence boundary
            if break_pos < max_chars // 4:
                match = None
                for m in re.finditer(r"[.!?]\s+", slice_):
                    match = m
                break_pos = match.end() if match and match.end() > max_chars // 4 else -1

            # Fall back to word boundary
            if break_pos < max_chars // 4:
                break_pos = slice_.rfind(" ")

            # Last resort: hard cut
            if break_pos < max_chars // 4:
                break_pos = max_chars

            chunks.append(remaining[:break_pos].rstrip())
            remaining = remaining[break_pos:].lstrip()

        return chunks

    # ── Main interface ──────────────────────────────────────────

    def consume(self, text: str) -> Iterator[str]:
        """
        Yield throttled chunks of text that fit within the token budget.

        Each chunk is guaranteed to be under `chunk_size` tokens.
        Automatically sleeps between chunks when the budget is exhausted.
        """
        max_chars = int(self.chunk_size * self.chars_per_token)
        chunks = self._split_text(text, max_chars)

        for chunk in chunks:
            tokens = self.estimate(chunk)
            self.wait_if_needed(tokens)
            yield chunk

    # ── Utilities ───────────────────────────────────────────────

    @property
    def remaining_tokens(self) -> int:
        """Tokens remaining in the current window."""
        self._maybe_reset_window()
        return max(0, self.budget - self._tokens_used)

    @property
    def seconds_until_reset(self) -> float:
        """Seconds until the current window resets."""
        elapsed = time.monotonic() - self._window_start
        return max(0.0, 60.0 - elapsed)

    def __repr__(self) -> str:
        return (
            f"TokenThrottle(tpm={self.tpm}, budget={self.budget}, "
            f"used={self._tokens_used}, remaining={self.remaining_tokens})"
        )


# ── Convenience for quick scripts ──────────────────────────────

def estimate_file_tokens(path: str, chars_per_token: float = 4.0) -> int:
    """Estimate tokens in a file without reading it fully (uses file size)."""
    import os
    size = os.path.getsize(path)
    return max(1, int(size / chars_per_token))


def estimate_url_tokens(url: str, chars_per_token: float = 4.0, timeout: int = 10) -> Optional[int]:
    """Estimate tokens from a URL via HEAD request Content-Length. Returns None if unavailable."""
    import urllib.request
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            length = resp.headers.get("Content-Length")
            if length:
                return max(1, int(int(length) / chars_per_token))
    except Exception:
        pass
    return None
