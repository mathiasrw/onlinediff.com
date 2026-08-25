// Round 2: intra-change highlighting.
//
// diff-worker.js produces the coarse diff (words/lines/patch) and is kept
// deliberately separate so that it is never blocked by this work. This worker
// takes the finished coarse diff, finds adjacent removed/added pairs and runs a
// char diff on each, so the characters that actually changed can be painted in
// a stronger tone on top of the existing del/ins background.
//
// The output never changes the text or its length - only how it is painted -
// so layout, scroll position and the minimap are unaffected.
//
// Preemption: the main thread terminate()s this worker when a newer coarse diff
// arrives while we are still busy, so there is no need for cooperative gen
// checks in here. Results are posted in batches so large diffs refine
// progressively from the top.
//
// Ideas for later (intentionally not done yet, keep round 2 simple first):
//  - Similarity threshold: skip pairs where more than ~50-60% of the chars
//    differ, so a fully rewritten line stays plain instead of confetti.
//  - Gap merging: absorb 1-2 char equal runs between two changes into one
//    changed span (diff-match-patch style "semantic cleanup").
//  - Size cap: skip or chunk pairs above a few thousand chars per line, as
//    jsdiff's char diff is O(ND) and very dissimilar long lines get slow.

importScripts('diff.js');

var BATCH = 200;

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

// Char diff of one removed line against one added line.
// Returns [partsForDel, partsForIns], each a list of [text, changed].
function diffPair(delText, insText) {
	var d = Diff.diffChars(delText, insText);
	var delParts = [], insParts = [];
	for (var i = 0; i < d.length; i++) {
		var e = d[i];
		if (e.removed) {
			delParts.push([e.value, true]);
		} else if (e.added) {
			insParts.push([e.value, true]);
		} else {
			delParts.push([e.value, false]);
			insParts.push([e.value, false]);
		}
	}
	return [delParts, insParts];
}

// Refine one run of adjacent removed/added entries.
// dels / ins are lists of {i: indexInDiff, value}.
// For lines mode an entry holds many lines; for words/patch it holds one
// word-chunk / one line. Either way we split into lines and pair line n with
// line n. Patch lines carry a leading +/- that must not take part in the diff.
function refineRun(dels, ins, isPatch, out) {
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

	var n = Math.min(delLines.length, insLines.length);
	if (!n) return;

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

	for (j = 0; j < n; j++) {
		var dl = delLines[j], il = insLines[j];
		var dText = dl.text, iText = il.text;
		var dPrefix = '', iPrefix = '';
		if (isPatch) {
			dPrefix = dText.slice(0, 1); dText = dText.slice(1);
			iPrefix = iText.slice(0, 1); iText = iText.slice(1);
		}
		var r = diffPair(dText, iText);
		if (dPrefix) add(dl.i, [[dPrefix, false]]);
		add(dl.i, r[0]);
		if (iPrefix) add(il.i, [[iPrefix, false]]);
		add(il.i, r[1]);
	}
	// Unpaired trailing lines stay as they are (whole-change tint only)
	for (j = n; j < delLines.length; j++) add(delLines[j].i, [[delLines[j].text, false]]);
	for (j = n; j < insLines.length; j++) add(insLines[j].i, [[insLines[j].text, false]]);

	for (var key in parts) {
		if (parts.hasOwnProperty(key)) out.push({i: +key, p: parts[key]});
	}
}

self.onmessage = function(e) {
	var data = e.data;
	var diff = data.diff;
	var gen = data.gen;
	var isPatch = data.diffType === 'diffPatch';
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
		while (i < diff.length && (diff[i].added || diff[i].removed)) {
			(diff[i].removed ? dels : ins).push({i: i, value: diff[i].value});
			i++;
		}
		if (dels.length && ins.length) {
			refineRun(dels, ins, isPatch, batch);
			if (batch.length >= BATCH) flush();
		}
	}
	flush();
	self.postMessage({gen: gen, done: true});
};
