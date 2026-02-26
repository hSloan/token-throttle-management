/**
 * token_throttle - Simple token rate-limit management for LLM API calls.
 *
 * Zero dependencies. Drop into any project.
 *
 * Usage:
 *   const { TokenThrottle } = require('./token_throttle');
 *   const throttle = new TokenThrottle({ tokensPerMinute: 30000 });
 *
 *   for await (const chunk of throttle.consume(largeText)) {
 *     const response = await callYourApi(chunk);
 *   }
 */

class TokenThrottle {
  /**
   * @param {Object} options
   * @param {number} [options.tokensPerMinute=30000] - Your TPM limit.
   * @param {number} [options.margin=0.85] - Safety factor (0-1).
   * @param {number} [options.chunkSize] - Max tokens per chunk. Defaults to budget.
   * @param {number} [options.charsPerToken=4] - Characters-per-token ratio.
   */
  constructor({
    tokensPerMinute = 30000,
    margin = 0.85,
    chunkSize = null,
    charsPerToken = 4,
  } = {}) {
    this.tpm = tokensPerMinute;
    this.margin = margin;
    this.budget = Math.floor(tokensPerMinute * margin);
    this.chunkSize = chunkSize || this.budget;
    this.charsPerToken = charsPerToken;

    this._tokensUsed = 0;
    this._windowStart = Date.now();
  }

  // ── Estimation ──────────────────────────────────────────────

  /**
   * Estimate token count from text length.
   * @param {string} text
   * @returns {number}
   */
  estimate(text) {
    return Math.max(1, Math.floor(text.length / this.charsPerToken));
  }

  // ── Window management ───────────────────────────────────────

  _maybeResetWindow() {
    const elapsed = Date.now() - this._windowStart;
    if (elapsed >= 25000) {
      this._tokensUsed = 0;
      this._windowStart = Date.now();
    }
  }

  reset() {
    this._tokensUsed = 0;
    this._windowStart = Date.now();
  }

  // ── Throttling ──────────────────────────────────────────────

  /**
   * Reserve tokens from the budget, sleeping if necessary.
   * @param {number} tokens
   * @returns {Promise<number>} Milliseconds slept.
   */
  async waitIfNeeded(tokens) {
    this._maybeResetWindow();

    if (this._tokensUsed + tokens <= this.budget) {
      this._tokensUsed += tokens;
      return 0;
    }

    const elapsed = Date.now() - this._windowStart;
    const sleepMs = Math.max(0, 25000 - elapsed + 500); // +500ms buffer

    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }

    this._tokensUsed = tokens;
    this._windowStart = Date.now();
    return sleepMs;
  }

  // ── Chunking ────────────────────────────────────────────────

  /**
   * Split text into chunks of roughly maxChars, respecting boundaries.
   * @param {string} text
   * @param {number} maxChars
   * @returns {string[]}
   */
  _splitText(text, maxChars) {
    if (text.length <= maxChars) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxChars) {
        chunks.push(remaining);
        break;
      }

      const slice = remaining.slice(0, maxChars);
      let breakPos;

      // Try paragraph boundary
      breakPos = slice.lastIndexOf("\n\n");

      // Fall back to sentence boundary
      if (breakPos < maxChars / 4) {
        const sentenceMatch = [...slice.matchAll(/[.!?]\s+/g)];
        const last = sentenceMatch[sentenceMatch.length - 1];
        breakPos =
          last && last.index + last[0].length > maxChars / 4
            ? last.index + last[0].length
            : -1;
      }

      // Fall back to word boundary
      if (breakPos < maxChars / 4) {
        breakPos = slice.lastIndexOf(" ");
      }

      // Hard cut
      if (breakPos < maxChars / 4) {
        breakPos = maxChars;
      }

      chunks.push(remaining.slice(0, breakPos).trimEnd());
      remaining = remaining.slice(breakPos).trimStart();
    }

    return chunks;
  }

  // ── Main interface ──────────────────────────────────────────

  /**
   * Async generator that yields throttled chunks of text.
   * @param {string} text
   * @yields {string}
   */
  async *consume(text) {
    const maxChars = Math.floor(this.chunkSize * this.charsPerToken);
    const chunks = this._splitText(text, maxChars);

    for (const chunk of chunks) {
      const tokens = this.estimate(chunk);
      await this.waitIfNeeded(tokens);
      yield chunk;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  get remainingTokens() {
    this._maybeResetWindow();
    return Math.max(0, this.budget - this._tokensUsed);
  }

  get secondsUntilReset() {
    const elapsed = Date.now() - this._windowStart;
    return Math.max(0, (25000 - elapsed) / 1000);
  }

  toString() {
    return `TokenThrottle(tpm=${this.tpm}, budget=${this.budget}, used=${this._tokensUsed}, remaining=${this.remainingTokens})`;
  }
}

// ── Convenience functions ─────────────────────────────────────

const fs = require("fs");
const https = require("https");
const http = require("http");

/**
 * Estimate tokens in a file without reading it (uses file size).
 * @param {string} filePath
 * @param {number} [charsPerToken=4]
 * @returns {number}
 */
function estimateFileTokens(filePath, charsPerToken = 4) {
  const stat = fs.statSync(filePath);
  return Math.max(1, Math.floor(stat.size / charsPerToken));
}

/**
 * Estimate tokens from a URL via HEAD request Content-Length.
 * @param {string} url
 * @param {number} [charsPerToken=4]
 * @returns {Promise<number|null>}
 */
function estimateUrlTokens(url, charsPerToken = 4) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url, { method: "HEAD", timeout: 10000 }, (res) => {
      const length = res.headers["content-length"];
      resolve(length ? Math.max(1, Math.floor(parseInt(length) / charsPerToken)) : null);
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

module.exports = { TokenThrottle, estimateFileTokens, estimateUrlTokens };
