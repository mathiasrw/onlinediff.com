importScripts('diff.js');

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
		diff = Diff[data.diffType](data.textA, data.textB);
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
