importScripts('diff.js');

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

// Runs `fine` on every removed stretch of a diff that has an added one next to
// it, and puts what comes out in their place.
function diffInside(coarse, fine) {
	var diff = [];
	for (var i = 0; i < coarse.length; i++) {
		var cur = coarse[i], next = coarse[i + 1];
		var parts = [cur];
		if (next && cur.removed && next.added) {
			parts = fine(cur.value, next.value);
			i++;
		} else if (next && cur.added && next.removed) {
			parts = fine(next.value, cur.value);
			i++;
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
	return diff;
}

self.onmessage = function(e) {
	var data = e.data;
	var diff;

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
	} else {
		diff = Diff.diffLines(data.textA, data.textB);
		if (data.diffType === 'diffWords') {
			diff = diffInside(diff, Diff.diffWords);
		} else if (data.diffType === 'diffChars') {
			// diffWordsWithSpace, as diffWords does not keep whitespace as it was
			diff = diffInside(diffInside(diff, Diff.diffWordsWithSpace), Diff.diffChars);
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

	self.postMessage({gen: data.gen, diff: diff});
};
