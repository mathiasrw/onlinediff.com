# Online Diff

The source of [onlinediff.com](https://onlinediff.com). Paste two texts and see
what changed. No ads, no tracking, no sign-up, no watermarks.

The page is three lanes. The old text is on the left, the new text on the right
and the difference between them in the middle, updated as you type. Everything
happens in your browser. The texts never leave it; they are kept in its local
storage so they are still there next time.

## What it does

- Diff by chars, words or lines, or as a patch. Changed lines get a second,
  stronger tone on the exact part that changed.
- Select text in any lane and the same text is marked in the other two, and
  the lanes line up on it.
- Compare mode marks the line the cursor is on in all three lanes as you move.
- Scroll sync keeps the three lanes together, line breaks can be turned off,
  and either side can be made narrow to give the other more room.
- A minimap down the middle shows where the changes are.
- Line editing as in VS Code. Alt+Up/Down moves lines, Cmd/Ctrl+X with nothing
  selected cuts the whole line.
- Keys 1-9 for everything in the bottom bar and the narrow sides (Esc to leave
  a text box first).

It is a static site made of `index.html`, `style.css` and two web workers. No build
step, no dependencies beyond the bundled jsdiff in `diff.js`.

## Contributing

This repo does not accept pull requests. It is a personal tool, shaped by one
person's taste, and kept that way on purpose. Pull requests will be closed
without review.

Ideas and bug reports are welcome as issues. You are also welcome to fork it
and make it your own.

# How it works

## How the diff is computed

Two web workers, kept separate on purpose.

1. `diff-worker.js` - the primary diff (chars / words / lines / patch, via jsdiff
   in `diff.js`). This is what must stay fast while typing; it is rendered as
   soon as it arrives. Chars and words are not run on the whole text, as the time
   a diff takes goes up with the square of how much differs, and by chars that
   is a lot (75 KB of code with one line in twenty edited takes 2 s). So it works
   down from the cheap end and only looks closer where something changed
   (`diffInside`). Lines first, then words inside the changed lines, then - for
   chars - chars inside the changed words. The same text now takes 7 ms. It marks all but
   the same chars; it just no longer matches a char with the same char in an
   unrelated line. The words step is for when every line changed (other line
   endings, new indentation, no line breaks at all) and the lines step has
   nothing to hold on to. Words are 4-7 times quicker at a whole text than
   chars are.
2. `refine-worker.js` - round 2. Takes the finished coarse diff, pairs adjacent
   removed/added lines and diffs each pair one granularity finer than the
   primary diff (lines/patch → words, words → chars) so the exact changed parts
   get a stronger tint (`.chg`) on top of the `del`/`ins` background. Never
   changes the text or its length, so layout, scroll position and the minimap
   are untouched.

Neither worker can be interrupted, only thrown away. So as soon as the text or
the diff type changes, a worker that is still busy is `terminate()`d and
replaced. Nothing is worked out that nobody is waiting for, and the diff that
is wanted never waits in line behind one that is not.

### Seeing where the time goes

Changing the diff type logs the timings of that one diff to the console, from
both the page and `diff-worker.js`, one line per step, all starting with
`[diff N]` where N counts the diffs asked for. Diffs from typing are not
logged. The worker says what it is about to compare before it starts, so a step
that never comes back can be told from the last line that was printed.

The worker's first line ends in `(worker: lines > words > chars)`. If it does
not, the browser is running an older `diff-worker.js`.

No caching of round 2 results. Pairs move around on every keystroke so a cache
would rarely hit and would just hold memory.

### What the two tones in round 2 mean

Inside a removed/added pair the lighter tone is what the old and the new text
have in common, the stronger tone is what was changed. That only says something
when the two are versions of the same thing, so

- Matches that are there by accident are taken out (`dropWeakLinks`, the
  "semantic cleanup" rule of diff-match-patch). An unchanged stretch no longer
  than the changes on both sides of it becomes part of the change. Any two
  texts share letters in the same order; one matching letter between two
  different words is not something they have in common.
- A pair that is then left with less than half of its shorter side in common
  (`MIN_KEPT`) is not shaded at all. One plain tint reads as "all of this was
  replaced", which is what happened.
- Whitespace-only gaps between two changed words are merged (`mergeSpaceGaps`),
  so a stretch of changed words paints as one block instead of stripes.

Not done yet is a size cap. jsdiff's char diff is O(ND), and a pair of very
different lines of a few thousand chars each gets slow.

## Marking text

Select text in any of the three lanes and the same text is marked in the other
two. It is a lookup, not a text search. The diff already knows which piece of A
is which piece of B and where both sit in the result, so selecting one "the"
marks that "the" and not every "the" on the page.

- `buildLaneMap` (in `index.html`) turns the diff on screen into a list of
  segments with their char offsets in each lane. It is built on the first
  selection after a diff, so it costs nothing until you mark something.
- Every segment is checked against the real text while building. If anything
  does not line up the map is dropped and nothing is marked - a mark is either
  on exactly the right chars or not there.
- Words mode ignores whitespace when comparing, so there the map is exact for
  everything but whitespace. `a (b)` and `a(b)` are matched char for char and
  the space is allowed to be missing on one side.
- Patch mode leaves unchanged lines out of the result. They are still mapped
  between A and B, using the line numbers in the `@@` headers.
- Painted with the CSS Custom Highlight API (`::highlight(mark)` in
  `style.css`), so nothing is inserted into the editable lanes. Browsers
  without it (Firefox before 140, Safari before 17.2) get no marks.

### Lining the lanes up on a mark

Marking text also scrolls the other two lanes so that their first mark is at
the same height as the text it belongs to in the lane you marked in. That lane
never moves. Only with scroll sync on.

- Scroll sync is proportional (top meets top, bottom meets bottom), which
  cannot keep any one piece of text level, as the result is longer than A and B by
  everything that was added or removed. So `alignMarks` stores where each lane
  was when it lined them up (`scrollAnchor`), and `syncScroll` bends its curve
  through that point. 1:1 for up to a screen either way, so what was lined up
  stays lined up for as long as you can see it, and proportional over what is
  left beyond that, so the ends still meet. It is the same curve whichever lane
  you scroll, so nothing jumps when you scroll another one.
- A lane already at its top or bottom goes as far as it can and no further, so
  on the first and last screen of a text the marks do not always line up.
- The anchor belongs to one layout. A new diff, a resize or toggling line
  breaks drops it, and a selection that is still there lines things up again.
- A selection whose start is scrolled out of view (select all) moves nothing.

### Scrolling the lanes together

- The wheel is handled by the page (`onWheel`), not the browser, and moves all
  three lanes in the same step. Left to the browser, the lane under the pointer
  scrolls at once and the others only follow from its scroll event a frame
  later, so lanes that are locked 1:1 wobble against each other.
- Scrolling that is not the wheel (scrollbar, keyboard, dragging a selection
  past the edge) still goes through scroll events, a frame behind.
- A lane that the page moved fires a scroll event too. `scrollPut` remembers
  where each lane was put so those are ignored; otherwise the lanes that were
  moved pull the one being scrolled back to where it was a frame ago.
- With scroll sync off the lanes are left to the browser.

## Busy state

While a newer diff is on its way the result is faded and gets a spinner
(`.busy` on the result cell). Switching diff type shows it at once and starts
the diff without the 100 ms typing delay; while typing it only shows if the
diff is not back 150 ms after it was started.
