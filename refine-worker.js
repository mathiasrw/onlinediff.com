// Round 2: intra-change highlighting.
//
// diff-worker.js produces the coarse diff (words/lines/patch) and is kept
// deliberately separate so that it is never blocked by this work. This worker
// takes the finished coarse diff, finds adjacent removed/added pairs and diffs
// each pair one granularity finer than the primary diff (lines/patch -> words,
// words -> chars), so the parts that actually changed can be painted in a
// stronger tone on top of the existing del/ins background.
//
// The output never changes the text or its length - only how it is painted -
// so layout, scroll position and the minimap are unaffected.
//
// Preemption: the main thread terminate()s this worker when a newer coarse diff
// arrives while we are still busy, so there is no need for cooperative gen
// checks in here. Results are posted in batches so large diffs refine
// progressively from the top.
//
// What the two tones mean: inside a del/ins pair the lighter tone is what the
// old and the new text have in common, the stronger one is what was changed.
// That only says something when the two are versions of the same thing. Any
// two pieces of text share letters - "specialise" and "look at how work moves
// from idea to release" have s, e, i, a, l in the same order - and painting
// those as "in common" is noise. So matches that are there by accident are
// taken out (dropWeakLinks), and a pair left with too little in common is not
// shaded at all (MIN_KEPT): it stays one plain tint, which reads as "all of
// this was replaced".
//
// Idea for later, not done yet:
//  - Size cap: skip or chunk pairs above a few thousand chars per line, as
//    jsdiff's char diff is O(ND) and very dissimilar long lines get slow.

importScripts('diff.js');

var BATCH = 200;

// Unchanged text that is only blank lines (in a patch: a context line of
// nothing but its leading space)
var BLANK = /^[^\S\n]*\n\s*$/;

// Split "a\nb\nc" into ["a\n", "b\n", "c"], keeping the newlines attached.
function splitLines(s) {
	var out = [];
	var start = 0;
	for (var i = 0; i < s.length; i++) {
		if (s[i] === '\n') {
			out.push(s.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < s.length) out.push(s.slice(start));
	return out;
}

// A pair has to keep at least this share of its shorter side in common to be
// shaded. Of the shorter side, so that a line with a lot added to it still
// counts as the same line. Half is where "dogs" for "cats" (they share the s)
// and "collaboration" for "enhance document generation" (they share "ration")
// stop being shaded, while color/colour and process/processes still are.
var MIN_KEPT = 0.5;

// blocks: unchanged {eq} and changed {del, ins} stretches, taking turns.
// An unchanged stretch that is no longer than the changes on both sides of it
// is not holding anything together - one letter that happens to match in the
// middle of two different words. It is made part of the change around it. The
// change is bigger after that, so the stretch before it is looked at again.
// The rule is the "semantic cleanup" of diff-match-patch. A stretch at the very
// start or end has a change on one side only and is always kept: that is the
// "organisatio" of organisation -> organisatioxn.
function dropWeakLinks(blocks) {
	for (var i = 1; i < blocks.length - 1; i++) {
		var eq = blocks[i].eq;
		if (eq === undefined) continue;
		var before = blocks[i - 1], after = blocks[i + 1];
		if (eq.length <= Math.max(before.del.length, before.ins.length) &&
				eq.length <= Math.max(after.del.length, after.ins.length)) {
			before.del += eq + after.del;
			before.ins += eq + after.ins;
			blocks.splice(i, 2);
			i = Math.max(0, i - 3);
		}
	}
}

// Diff one removed line against one added line, one granularity finer than
// the primary diff: lines/patch refine per word, words refine per char.
// diffWordsWithSpace rather than diffWords: diffWords ignores whitespace-only
// differences, so its output would not reconstruct the original text exactly.
// Returns [partsForDel, partsForIns], each a list of [text, changed], or null
// when the two have too little in common to say what changed.
function diffPair(delText, insText, diffFn) {
	var d = diffFn(delText, insText);
	var blocks = [];
	var i, last;
	for (i = 0; i < d.length; i++) {
		var e = d[i];
		last = blocks[blocks.length - 1];
		if (e.removed || e.added) {
			if (!last || last.eq !== undefined) blocks.push(last = {del: '', ins: ''});
			if (e.removed) last.del += e.value; else last.ins += e.value;
		} else if (last && last.eq !== undefined) {
			last.eq += e.value;
		} else {
			blocks.push({eq: e.value});
		}
	}
	dropWeakLinks(blocks);

	var kept = 0;
	var delParts = [], insParts = [];
	for (i = 0; i < blocks.length; i++) {
		var b = blocks[i];
		if (b.eq !== undefined) {
			kept += b.eq.length;
			delParts.push([b.eq, false]);
			insParts.push([b.eq, false]);
		} else {
			if (b.del) delParts.push([b.del, true]);
			if (b.ins) insParts.push([b.ins, true]);
		}
	}
	if (kept < MIN_KEPT * Math.min(delText.length, insText.length)) return null;
	return [delParts, insParts];
}

// Word tokenisers give runs of whitespace their own token, so several changed
// words in a row come back as changed-word, unchanged-space, changed-word and
// paint as stripes with unmarked gaps - the eye reads that as several separate
// changes rather than one. Absorbing a gap that is only whitespace AND sits
// between two changed parts makes the run read as one continuous block.
// Newlines are deliberately not absorbed: a marked newline stretches its
// background to the end of the line, which looks like a change that is not
// there. Anything that is not pure whitespace (" in it" between two changed
// words) is left alone, because there the gap really is unchanged.
var SPACE_GAP = /^[^\S\r\n]+$/;

function mergeSpaceGaps(parts) {
	for (var i = 1; i < parts.length - 1; i++) {
		if (!parts[i][1] && parts[i - 1][1] && parts[i + 1][1] && SPACE_GAP.test(parts[i][0])) {
			parts[i - 1][0] += parts[i][0] + parts[i + 1][0];
			parts.splice(i, 2);
			i--;
		}
	}
	return parts;
}

// Refine one run of adjacent removed/added entries.
// dels / ins are lists of {i: indexInDiff, value}.
// For lines mode an entry holds many lines; for words/patch it holds one
// word-chunk / one line. Either way we split into lines and pair the nth line
// with the nth, not counting blank lines. Patch lines carry a leading +/- that
// must not take part in the diff.
function refineRun(dels, ins, isPatch, diffFn, byWords, out) {
	var delLines = [], insLines = [];
	var j, k, lines;
	for (j = 0; j < dels.length; j++) {
		lines = splitLines(dels[j].value);
		for (k = 0; k < lines.length; k++) delLines.push({i: dels[j].i, text: lines[k]});
	}
	for (j = 0; j < ins.length; j++) {
		lines = splitLines(ins[j].value);
		for (k = 0; k < lines.length; k++) insLines.push({i: ins[j].i, text: lines[k]});
	}

	var parts = {}; // diff index -> list of [text, changed]
	function add(i, list) {
		if (!parts[i]) parts[i] = [];
		var p = parts[i];
		for (var q = 0; q < list.length; q++) {
			var last = p[p.length - 1];
			if (last && last[1] === list[q][1]) {
				last[0] += list[q][0];
			} else {
				p.push([list[q][0], list[q][1]]);
			}
		}
	}

	// Blank lines are left out of the pairing: one added at the top of a
	// stretch ("1. Heading\n\n- What ...") would otherwise pair every line
	// with the one before its counterpart, and nothing gets shaded
	function body(line) {
		line.prefix = isPatch ? line.text.slice(0, 1) : '';
		line.body = line.text.slice(line.prefix.length);
		line.parts = [[line.body, false]];
		return /\S/.test(line.body);
	}
	var delFull = delLines.filter(body), insFull = insLines.filter(body);
	var n = Math.min(delFull.length, insFull.length);
	if (!n) return;

	for (j = 0; j < n; j++) {
		var r = diffPair(delFull[j].body, insFull[j].body, diffFn);
		if (r) {
			delFull[j].parts = r[0];
			insFull[j].parts = r[1];
		}
	}
	// Lines left without a partner stay as they are (whole-change tint only)
	[delLines, insLines].forEach(function(side) {
		side.forEach(function(line) {
			if (line.prefix) add(line.i, [[line.prefix, false]]);
			add(line.i, line.parts);
		});
	});

	for (var key in parts) {
		if (parts.hasOwnProperty(key)) {
			out.push({i: +key, p: byWords ? mergeSpaceGaps(parts[key]) : parts[key]});
		}
	}
}

self.onmessage = function(e) {
	var data = e.data;
	var diff = data.diff;
	var gen = data.gen;
	var isPatch = data.diffType === 'diffPatch';
	// One granularity finer than the primary diff: lines/patch -> words,
	// words -> chars. Only the word level needs the space-gap merge; at char
	// level every changed char is already adjacent to the next.
	var byWords = data.diffType !== 'diffWords';
	var diffFn = byWords ? Diff.diffWordsWithSpace : Diff.diffChars;
	var batch = [];

	function flush() {
		if (!batch.length) return;
		self.postMessage({gen: gen, refine: batch});
		batch = [];
	}

	var i = 0;
	while (i < diff.length) {
		if (!diff[i].added && !diff[i].removed) { i++; continue; }
		var dels = [], ins = [];
		// A blank line between two changes does not end the run: the line
		// diff often puts one between what was removed and what was added
		while (i < diff.length) {
			if (diff[i].added || diff[i].removed) {
				(diff[i].removed ? dels : ins).push({i: i, value: diff[i].value});
			} else if (!BLANK.test(diff[i].value) || !diff[i + 1] || !(diff[i + 1].added || diff[i + 1].removed)) {
				break;
			}
			i++;
		}
		if (dels.length && ins.length) {
			refineRun(dels, ins, isPatch, diffFn, byWords, batch);
			if (batch.length >= BATCH) flush();
		}
	}
	flush();
	self.postMessage({gen: gen, done: true});
};
