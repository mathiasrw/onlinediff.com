# onlinediff-com
Source of OnlineDiff.com

## How the diff is computed

Two web workers, kept separate on purpose:

1. `diff-worker.js` – the primary diff (chars / words / lines / patch, via jsdiff
   in `diff.js`). This is what must stay fast while typing; it is rendered as
   soon as it arrives.
2. `refine-worker.js` – round 2. Takes the finished coarse diff, pairs adjacent
   removed/added lines and diffs each pair one granularity finer than the
   primary diff (lines/patch → words, words → chars) so the exact changed parts
   get a stronger tint (`.chg`) on top of the `del`/`ins` background. Never
   changes the text or its length, so layout, scroll position and the minimap
   are untouched. If a newer coarse diff arrives while it is still busy the main
   thread simply `terminate()`s it and starts a fresh one.

No caching of round 2 results: pairs move around on every keystroke so a cache
would rarely hit and would just hold memory.

### Ideas for round 2, not done yet

- Similarity threshold: skip pairs where more than ~50–60% of the chars differ,
  so a fully rewritten line stays plain instead of confetti.
- Gap merging beyond whitespace: absorb 1–2 char equal runs between two changes
  into one changed span (diff-match-patch style "semantic cleanup"). Whitespace-
  only gaps between two changed words are already merged (`mergeSpaceGaps`), so
  a stretch of changed words paints as one block instead of stripes.
- Size cap: skip or chunk pairs above a few thousand chars per line; jsdiff's
  char diff is O(ND) and very dissimilar long lines get slow.
