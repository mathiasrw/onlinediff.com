importScripts('diff.js');

// Timings in the console, to see where the time goes when a diff is slow. Only
// for the diffs the page asks to have logged (those from a change of diff
// type), so that typing does not fill the console. Every step says what it is
// about to do before it does it, so one that never comes back can be told from
// the last line that did get printed.
var logging = false;

function log(gen, text) {
	if (logging) console.log('[diff ' + gen + '] ' + text);
}

function ms(since) {
	return Math.round(performance.now() - since) + ' ms';
}

// A plain char or word diff of two whole texts is slow. The time goes up with
// the square of how much differs, and with every char a token of its own a lot
// differs: 75 KB of code with one line in twenty edited took 2 s by chars.
// So work down from the cheap end, and only look closer where something has
// changed: lines first (13 ms for the same text), then words inside the lines
// that changed, then chars inside the words that changed. 7 ms all in.
//
// It marks all but the same chars. What is gone is matching up a char here
// with the same char in a line that has nothing to do with it, which a diff
// of the whole text does whenever that saves it an edit.
//
// The words step makes no difference to speed when few lines changed. It is
// there for when every line did (other line endings, new indentation, a text
// with no line breaks): the lines step then has nothing to hold on to and
// hands over the whole text, and words are 4-7 times quicker at that than
// chars. Still not fast on a big text - the page terminates this worker when
// it stops waiting for an answer, so at least nobody waits for one they do
// not want.

// Unchanged text that is only blank lines. Between two changes it is taken in
// as part of the change: a line diff happily matches the blank line after a
// heading in the new text with the one before the next heading in the old, and
// what was removed and what was added then end up on either side of it and are
// never compared. The finer diff finds the blank line again where it belongs.
var BLANK = /^[^\S\n]*\n\s*$/;

// Runs `fine` on every removed stretch of a diff that has an added one next to
// it, and puts what comes out in their place. gen and step are for the log.
function diffInside(coarse, fine, gen, step) {
	var diff = [];
	var started = performance.now();
	if (logging) {
		// What is about to be compared: how many pairs, and how big
		var pairs = 0, total = 0, most = 0, mostText = '';
		for (var k = 0; k + 1 < coarse.length; k++) {
			// Not counting pairs held apart by a blank line, close enough for a log
			if ((coarse[k].removed && coarse[k + 1].added) || (coarse[k].added && coarse[k + 1].removed)) {
				var size = coarse[k].value.length + coarse[k + 1].value.length;
				pairs++;
				total += size;
				if (size > most) {
					most = size;
					mostText = coarse[k].value.length + ' against ' + coarse[k + 1].value.length;
				}
				k++;
			}
		}
		log(gen, step + ': ' + pairs + ' changed pairs to go through, ' + total + ' chars in all' +
			(pairs ? ', the biggest ' + mostText + ' chars' : ''));
	}

	// One pair, timed. A big one is announced first, as it may be the one
	// that never finishes; a slow one is reported after.
	function pair(removed, added) {
		var size = removed.length + added.length;
		var t = performance.now();
		if (size > 20000) log(gen, step + ': starting on a pair of ' + removed.length + ' against ' + added.length + ' chars');
		var parts = fine(removed, added);
		if (performance.now() - t > 100) {
			log(gen, step + ': a pair of ' + removed.length + ' against ' + added.length + ' chars took ' + ms(t) +
				' and came out in ' + parts.length + ' parts');
		}
		return parts;
	}

	for (var i = 0; i < coarse.length; i++) {
		var parts = [coarse[i]];
		if (coarse[i].added || coarse[i].removed) {
			// The whole run of changes, with the blank lines between them
			var removed = '', added = '', end = i;
			for (; end < coarse.length; end++) {
				var c = coarse[end], after = coarse[end + 1];
				if (c.removed) {
					removed += c.value;
				} else if (c.added) {
					added += c.value;
				} else if (BLANK.test(c.value) && after && (after.added || after.removed)) {
					removed += c.value;
					added += c.value;
				} else {
					break;
				}
			}
			parts = removed && added && removed !== added ? pair(removed, added) : coarse.slice(i, end);
			i = end - 1;
		}
		for (var j = 0; j < parts.length; j++) {
			var part = parts[j], last = diff[diff.length - 1];
			// Unchanged text at the edge of a stretch is one piece with the
			// unchanged text next to it
			if (last && !last.added === !part.added && !last.removed === !part.removed) {
				last.value += part.value;
			} else {
				diff.push({value: part.value, added: !!part.added, removed: !!part.removed});
			}
		}
	}
	log(gen, step + ': done in ' + ms(started) + ', ' + diff.length + ' parts');
	return diff;
}

self.onmessage = function(e) {
	var data = e.data;
	var diff;
	var gen = data.gen;
	var started = performance.now(), t;
	logging = !!data.log;
	// "lines > words > chars" names this version of the worker: a log without
	// it comes from an older copy of this file that the browser held on to
	log(gen, data.diffType + ' of ' + data.textA.length + ' against ' + data.textB.length + ' chars (worker: lines > words > chars)');

	if (data.diffType === 'diffPatch') {
		var pastHunkHeader = false;
		diff = Diff.createTwoFilesPatch('a.txt', 'b.txt', data.textA, data.textB)
			.split('\n')
			.map(function(entry) {
				var r = {value: entry + '\n'};
				if (entry.startsWith('@@')) {
					r.chunkHeader = true;
					pastHunkHeader = true;
				} else if (pastHunkHeader) {
					if (entry.startsWith('-')) {
						r.removed = true;
					} else if (entry.startsWith('+')) {
						r.added = true;
					}
				}
				return r;
			});
		log(gen, 'patch: done in ' + ms(started) + ', ' + diff.length + ' lines');
	} else {
		t = performance.now();
		diff = Diff.diffLines(data.textA, data.textB);
		log(gen, 'lines: done in ' + ms(t) + ', ' + diff.length + ' parts');
		if (data.diffType === 'diffWords') {
			diff = diffInside(diff, Diff.diffWords, gen, 'words');
		} else if (data.diffType === 'diffChars') {
			// diffWordsWithSpace, as diffWords does not keep whitespace as it was
			diff = diffInside(diff, Diff.diffWordsWithSpace, gen, 'words');
			diff = diffInside(diff, Diff.diffChars, gen, 'chars');
		}
	}

	// Reorder: show additions before deletions
	for (var i = 0; i < diff.length; i++) {
		if (diff[i].removed && diff[i + 1] && diff[i + 1].added) {
			var swap = diff[i];
			diff[i] = diff[i + 1];
			diff[i + 1] = swap;
		}
	}

	log(gen, 'worker done in ' + ms(started) + ', sending ' + diff.length + ' parts to the page');
	self.postMessage({gen: data.gen, diff: diff});
};
