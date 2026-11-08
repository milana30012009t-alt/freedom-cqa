// Quotes inside a free-text rationale («…»). One extractor for the AI layer (which checks model
// explanations before they are stored) and for the Results JSON validator, so both agree on what a quote is.

const TIME_AFTER = /^ \(\+?\d{1,2}:\d{2}(?::\d{2})?\)/;

/** Minimum length of an untimed «…» fragment that is treated as a quote (shorter ones are button names, words). */
export const MIN_UNTIMED_QUOTE = 12;

/**
 * Top-level «…» fragments with nesting: «Откройте вкладку «Кабинет» — …» (01:10) is one quote.
 * Unbalanced guillemets end the scan of that fragment (nothing is guessed).
 * @returns {{text:string, start:number, end:number, timed:boolean}[]} end = index after the closing »
 */
export function extractQuotes(s) {
  const str = String(s ?? '');
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '«') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '»' && depth > 0) {
      const timed = TIME_AFTER.test(str.slice(i + 1));
      // «…» (01:10) always ends the outer quote, even if a shortened inner «… lost its closing mark
      depth = timed ? 0 : depth - 1;
      if (depth === 0) out.push({ text: str.slice(start + 1, i), start, end: i + 1, timed });
    }
  }
  return out;
}

/** Fragments that claim to be verbatim: followed by a message time, or long enough to be a sentence. */
export function quotesToCheck(s) {
  return extractQuotes(s).filter((q) => q.timed || q.text.length >= MIN_UNTIMED_QUOTE);
}

/** Comparison form: case, ё/е, ellipsis of a shortened quote and whitespace do not matter. */
export function normQuote(s) {
  return String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/…|\.\.\.$/g, '').replace(/\s+/g, ' ').trim();
}
