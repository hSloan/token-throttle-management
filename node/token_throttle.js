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
 *
 * Sub-agent usage (enforces shared budget automatically):
 *   const { SubAgentThrottle } = require('./token_throttle');
 *   const throttle = new SubAgentThrottle(); // caps to 15K TPM by default
 *
 * Strict mode (throws BudgetExceeded instead of waiting):
 *   const { TokenThrottle, BudgetExceeded } = require('./token_throttle');
 *   const throttle = new TokenThrottle({ budget: 15000, strict: true });
 *   try {
 *     await throttle.waitIfNeeded(25000);
 *   } catch (e) {
 *     if (e instanceof BudgetExceeded) { ... }
 *   }
 */

class TokenThrottle {
  /**
   * @param {Object} options
   * @param {number} [options.tokensPerMinute=30000] - Your TPM limit.
   * @param {number} [options.margin=0.85] - Safety factor (0-1).
   * @param {number|null} [options.budget=null] - Hard cap on effective TPM. Ceiling =
   *   min(budget, tpm * margin). Useful for sub-agents sharing an API key.
   * @param {number} [options.chunkSize] - Max tokens per chunk. Defaults to budget.
   * @param {number} [options.charsPerToken=4] - Characters-per-token ratio.
   * @param {boolean} [options.strict=false] - Throw BudgetExceeded instead of waiting
   *   when a single request exceeds the budget.
   */
  constructor({
    tokensPerMinute = 30000,
    margin = 0.85,
    budget = null,
    chunkSize = null,
    charsPerToken = 4,
    strict = false,
  } = {}) {
    this.tpm = tokensPerMinute;
    this.margin = margin;
    this.strict = strict;
    const effective = Math.floor(tokensPerMinute * margin);
    this.budget = budget !== null ? Math.min(budget, effective) : effective;
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
   * @throws {BudgetExceeded} If strict=true and tokens exceeds the budget.
   */
  async waitIfNeeded(tokens) {
    if (this.strict && tokens > this.budget) {
      throw new BudgetExceeded(
        `Request of ${tokens} tokens exceeds budget of ${this.budget} TPM. ` +
        "Reduce the request size or disable strict mode."
      );
    }

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
    return `TokenThrottle(tpm=${this.tpm}, budget=${this.budget}, used=${this._tokensUsed}, remaining=${this.remainingTokens}, strict=${this.strict})`;
  }
}

// ── Exceptions ────────────────────────────────────────────────

/**
 * Thrown in strict mode when a single request exceeds the per-window budget.
 * Catch this to handle oversized requests explicitly rather than silently waiting.
 */
class BudgetExceeded extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

// ── Sub-agent convenience ─────────────────────────────────────

/**
 * Pre-configured TokenThrottle for sub-agent use.
 *
 * Enforces a conservative shared-budget ceiling automatically so sub-agents
 * don't accidentally consume the full API key TPM and starve the main session.
 *
 * Default: caps effective TPM to 50% of the total limit (15K on a 30K key).
 *
 * @example
 *   const throttle = new SubAgentThrottle();            // 15K TPM ceiling
 *   const throttle = new SubAgentThrottle({ budgetFraction: 0.4 }); // 12K TPM
 */
class SubAgentThrottle extends TokenThrottle {
  /**
   * @param {Object} options
   * @param {number} [options.totalTpm=30000] - Full API key TPM limit (shared across all agents).
   * @param {number} [options.budgetFraction=0.5] - Fraction of totalTpm this sub-agent may use.
   * @param {...*} rest - Passed through to TokenThrottle (e.g. strict, chunkSize).
   */
  constructor({ totalTpm = 30000, budgetFraction = 0.5, ...rest } = {}) {
    super({
      tokensPerMinute: totalTpm,
      margin: budgetFraction,
      ...rest,
    });
  }

  toString() {
    return `SubAgentThrottle(tpm=${this.tpm}, budget=${this.budget}, used=${this._tokensUsed}, remaining=${this.remainingTokens}, strict=${this.strict})`;
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

module.exports = { TokenThrottle, SubAgentThrottle, BudgetExceeded, estimateFileTokens, estimateUrlTokens };
