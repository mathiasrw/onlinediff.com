import Diff from './base.js';

// Based on https://en.wikipedia.org/wiki/Latin_script_in_Unicode
//
// Ranges and exceptions:
// Latin-1 Supplement, 0080–00FF
//  - U+00D7  × Multiplication sign
//  - U+00F7  ÷ Division sign
// Latin Extended-A, 0100–017F
// Latin Extended-B, 0180–024F
// IPA Extensions, 0250–02AF
// Spacing Modifier Letters, 02B0–02FF
//  - U+02C7  ˇ &#711;  Caron
//  - U+02D8  ˘ &#728;  Breve
//  - U+02D9  ˙ &#729;  Dot Above
//  - U+02DA  ˚ &#730;  Ring Above
//  - U+02DB  ˛ &#731;  Ogonek
//  - U+02DC  ˜ &#732;  Small Tilde
//  - U+02DD  ˝ &#733;  Double Acute Accent
// Latin Extended Additional, 1E00–1EFF
var extendedWordChars = "a-zA-Z0-9_\\u{C0}-\\u{FF}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";

var tokenizeIncludingWhitespace = new RegExp("[".concat(extendedWordChars, "]+|\\s+|[^").concat(extendedWordChars, "]"), 'ug');

var wordDiff = new Diff();
wordDiff.equals = function (left, right, options) {
  if (options.ignoreCase) {
    left = left.toLowerCase();
    right = right.toLowerCase();
  }
  return left.trim() === right.trim();
};
wordDiff.tokenize = function (value) {
  var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  var parts;
  if (options.intlSegmenter) {
    if (options.intlSegmenter.resolvedOptions().granularity != 'word') {
      throw new Error('The segmenter passed must have a granularity of "word"');
    }
    parts = Array.from(options.intlSegmenter.segment(value), function (segment) {
      return segment.segment;
    });
  } else {
    parts = value.match(tokenizeIncludingWhitespace) || [];
  }
  var tokens = [];
  var prevPart = null;
  parts.forEach(function (part) {
    if (/\s/.test(part)) {
      if (prevPart == null) {
        tokens.push(part);
      } else {
        tokens.push(tokens.pop() + part);
      }
    } else if (/\s/.test(prevPart)) {
      if (tokens[tokens.length - 1] == prevPart) {
        tokens.push(tokens.pop() + part);
      } else {
        tokens.push(prevPart + part);
      }
    } else {
      tokens.push(part);
    }
    prevPart = part;
  });
  return tokens;
};
wordDiff.join = function (tokens) {
  // Tokens being joined here will always have appeared consecutively in the
  // same text, so we can simply strip off the leading whitespace from all the
  // tokens except the first (and except any whitespace-only tokens - but such
  // a token will always be the first and only token anyway) and then join them
  // and the whitespace around words and punctuation will end up correct.
  return tokens.map(function (token, i) {
    if (i == 0) {
      return token;
    } else {
      return token.replace(/^\s+/, '');
    }
  }).join('');
};
wordDiff.postProcess = function (changes, options) {
  if (!changes || options.oneChangePerToken) {
    return changes;
  }
  var lastKeep = null;
  // Change objects representing any insertion or deletion since the last
  // "keep" change object. There can be at most one of each.
  var insertion = null;
  var deletion = null;
  changes.forEach(function (change) {
    if (change.added) {
      insertion = change;
    } else if (change.removed) {
      deletion = change;
    } else {
      if (insertion || deletion) {
        // May be false at start of text
        dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, change);
      }
      lastKeep = change;
      insertion = null;
      deletion = null;
    }
  });
  if (insertion || deletion) {
    dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, null);
  }
  return changes;
};

export function diffWords(oldStr, newStr, options) {
  // This option has never been documented and never will be (it's clearer to
  // just call `diffWordsWithSpace` directly if you need that behavior), but
  // has existed in jsdiff for a long time, so we retain support for it here
  // for the sake of backwards compatibility.
  if ((options === null || options === void 0 ? void 0 : options.ignoreWhitespace) != null && !options.ignoreWhitespace) {
    return diffWordsWithSpace(oldStr, newStr, options);
  }
  return wordDiff.diff(oldStr, newStr, options);
}

function dedupeWhitespaceInChangeObjects(startKeep, deletion, insertion, endKeep) {
  // Before returning, we tidy up the leading and trailing whitespace of the
  // change objects to eliminate cases where trailing whitespace in one object
  // is repeated as leading whitespace in the next.
  // Below are examples of the outcomes we want here to explain the code.
  // I=insert, K=keep, D=delete
  // 1. diffing 'foo bar baz' vs 'foo baz'
  //    Prior to cleanup, we have K:'foo ' D:' bar ' K:' baz'
  //    After cleanup, we want:   K:'foo ' D:'bar ' K:'baz'
  //
  // 2. Diffing 'foo bar baz' vs 'foo qux baz'
  //    Prior to cleanup, we have K:'foo ' D:' bar ' I:' qux ' K:' baz'
  //    After cleanup, we want K:'foo ' D:'bar' I:'qux' K:' baz'
  //
  // 3. Diffing 'foo\nbar baz' vs 'foo baz'
  //    Prior to cleanup, we have K:'foo ' D:'\nbar ' K:' baz'
  //    After cleanup, we want K'foo' D:'\nbar' K:' baz'
  //
  // 4. Diffing 'foo baz' vs 'foo\nbar baz'
  //    Prior to cleanup, we have K:'foo\n' I:'\nbar ' K:' baz'
  //    After cleanup, we ideally want K'foo' I:'\nbar' K:' baz'
  //    but don't actually manage this currently (the pre-cleanup change
  //    objects don't contain enough information to make it possible).
  //
  // 5. Diffing 'foo   bar baz' vs 'foo  baz'
  //    Prior to cleanup, we have K:'foo  ' D:'   bar ' K:'  baz'
  //    After cleanup, we want K:'foo  ' D:' bar ' K:'baz'
  //
  // Our handling is unavoidably imperfect in the case where there's a single
  // indel between keeps and the whitespace has changed. For instance, consider
  // diffing 'foo\tbar\nbaz' vs 'foo baz'. Unless we create an extra change
  // object to represent the insertion of the space character (which isn't even
  // a token), we have no way to avoid losing information about the texts'
  // original whitespace in the result we return. Still, we do our best to
  // output something that will look sensible if we e.g. print it with
  // insertions in green and deletions in red.

  // Between two "keep" change objects (or before the first or after the last
  // change object), we can have either:
  // * A "delete" followed by an "insert"
  // * Just an "insert"
  // * Just a "delete"
  // We handle the three cases separately.
  if (deletion && insertion) {
    var oldWsPrefix = deletion.value.match(/^\s*/)[0];
    var oldWsSuffix = deletion.value.match(/\s*$/)[0];
    var newWsPrefix = insertion.value.match(/^\s*/)[0];
    var newWsSuffix = insertion.value.match(/\s*$/)[0];
    if (startKeep) {
      var commonWsPrefix = longestCommonPrefix(oldWsPrefix, newWsPrefix);
      startKeep.value = replaceSuffix(startKeep.value, newWsPrefix, commonWsPrefix);
      deletion.value = removePrefix(deletion.value, commonWsPrefix);
      insertion.value = removePrefix(insertion.value, commonWsPrefix);
    }
    if (endKeep) {
      var commonWsSuffix = longestCommonSuffix(oldWsSuffix, newWsSuffix);
      endKeep.value = replacePrefix(endKeep.value, newWsSuffix, commonWsSuffix);
      deletion.value = removeSuffix(deletion.value, commonWsSuffix);
      insertion.value = removeSuffix(insertion.value, commonWsSuffix);
    }
  } else if (insertion) {
    // The whitespaces all reflect what was in the new text rather than
    // the old, so we essentially have no information about whitespace
    // insertion or deletion. We just want to dedupe the whitespace.
    // We do that by having each change object keep its trailing
    // whitespace and deleting duplicate leading whitespace where
    // present.
    if (startKeep) {
      insertion.value = insertion.value.replace(/^\s*/, '');
    }
    if (endKeep) {
      endKeep.value = endKeep.value.replace(/^\s*/, '');
    }
    // otherwise we've got a deletion and no insertion
  } else if (startKeep && endKeep) {
    var newWsFull = endKeep.value.match(/^\s*/)[0],
      delWsStart = deletion.value.match(/^\s*/)[0],
      delWsEnd = deletion.value.match(/\s*$/)[0];

    // Any whitespace that comes straight after startKeep in both the old and
    // new texts, assign to startKeep and remove from the deletion.
    var newWsStart = longestCommonPrefix(newWsFull, delWsStart);
    deletion.value = removePrefix(deletion.value, newWsStart);

    // Any whitespace that comes straight before endKeep in both the old and
    // new texts, and hasn't already been assigned to startKeep, assign to
    // endKeep and remove from the deletion.
    var newWsEnd = longestCommonSuffix(removePrefix(newWsFull, newWsStart), delWsEnd);
    deletion.value = removeSuffix(deletion.value, newWsEnd);
    endKeep.value = replacePrefix(endKeep.value, newWsFull, newWsEnd);

    // If there's any whitespace from the new text that HASN'T already been
    // assigned, assign it to the start:
    startKeep.value = replaceSuffix(startKeep.value, newWsFull, newWsFull.slice(0, newWsFull.length - newWsEnd.length));
  } else if (endKeep) {
    // We are at the start of the text. Preserve all the whitespace on
    // endKeep, and just remove whitespace from the end of deletion to the
    // extent that it overlaps with the start of endKeep.
    var endKeepWsPrefix = endKeep.value.match(/^\s*/)[0];
    var deletionWsSuffix = deletion.value.match(/\s*$/)[0];
    var overlap = maximumOverlap(deletionWsSuffix, endKeepWsPrefix);
    deletion.value = removeSuffix(deletion.value, overlap);
  } else if (startKeep) {
    // We are at the END of the text. Preserve all the whitespace on
    // startKeep, and just remove whitespace from the start of deletion to
    // the extent that it overlaps with the end of startKeep.
    var startKeepWsSuffix = startKeep.value.match(/\s*$/)[0];
    var deletionWsPrefix = deletion.value.match(/^\s*/)[0];
    var _overlap = maximumOverlap(startKeepWsSuffix, deletionWsPrefix);
    deletion.value = removePrefix(deletion.value, _overlap);
  }
}

var wordWithSpaceDiff = new Diff();
wordWithSpaceDiff.tokenize = function (value) {
  // Slightly different to the tokenizeIncludingWhitespace regex used above in
  // that this one treats each individual newline as a distinct tokens, rather
  // than merging them into other surrounding whitespace. This was requested
  // in https://github.com/kpdecker/jsdiff/issues/180 &
  //    https://github.com/kpdecker/jsdiff/issues/211
  var regex = new RegExp("(\\r?\\n)|[".concat(extendedWordChars, "]+|[^\\S\\n\\r]+|[^").concat(extendedWordChars, "]"), 'ug');
  return value.match(regex) || [];
};

export function diffWordsWithSpace(oldStr, newStr, options) {
  return wordWithSpaceDiff.diff(oldStr, newStr, options);
}

function longestCommonPrefix(str1, str2) {
  var i;
  for (i = 0; i < str1.length && i < str2.length; i++) {
    if (str1[i] != str2[i]) {
      return str1.slice(0, i);
    }
  }
  return str1.slice(0, i);
}
function longestCommonSuffix(str1, str2) {
  var i;

  // Unlike longestCommonPrefix, we need a special case to handle all scenarios
  // where we return the empty string since str1.slice(-0) will return the
  // entire string.
  if (!str1 || !str2 || str1[str1.length - 1] != str2[str2.length - 1]) {
    return '';
  }
  for (i = 0; i < str1.length && i < str2.length; i++) {
    if (str1[str1.length - (i + 1)] != str2[str2.length - (i + 1)]) {
      return str1.slice(-i);
    }
  }
  return str1.slice(-i);
}
function replacePrefix(string, oldPrefix, newPrefix) {
  if (string.slice(0, oldPrefix.length) != oldPrefix) {
    throw Error("string ".concat(JSON.stringify(string), " doesn't start with prefix ").concat(JSON.stringify(oldPrefix), "; this is a bug"));
  }
  return newPrefix + string.slice(oldPrefix.length);
}
function replaceSuffix(string, oldSuffix, newSuffix) {
  if (!oldSuffix) {
    return string + newSuffix;
  }
  if (string.slice(-oldSuffix.length) != oldSuffix) {
    throw Error("string ".concat(JSON.stringify(string), " doesn't end with suffix ").concat(JSON.stringify(oldSuffix), "; this is a bug"));
  }
  return string.slice(0, -oldSuffix.length) + newSuffix;
}
function removePrefix(string, oldPrefix) {
  return replacePrefix(string, oldPrefix, '');
}
function removeSuffix(string, oldSuffix) {
  return replaceSuffix(string, oldSuffix, '');
}
function maximumOverlap(string1, string2) {
  return string2.slice(0, overlapCount(string1, string2));
}

// Nicked from https://stackoverflow.com/a/60422853/1709587
function overlapCount(a, b) {
  // Deal with cases where the strings differ in length
  var startA = 0;
  if (a.length > b.length) {
    startA = a.length - b.length;
  }
  var endB = b.length;
  if (a.length < b.length) {
    endB = a.length;
  }
  // Create a back-reference for each index
  //   that should be followed in case of a mismatch.
  //   We only need B to make these references:
  var map = Array(endB);
  var k = 0; // Index that lags behind j
  map[0] = 0;
  for (var j = 1; j < endB; j++) {
    if (b[j] == b[k]) {
      map[j] = map[k]; // skip over the same character (optional optimisation)
    } else {
      map[j] = k;
    }
    while (k > 0 && b[j] != b[k]) {
      k = map[k];
    }
    if (b[j] == b[k]) {
      k++;
    }
  }
  // Phase 2: use these references while iterating over A
  k = 0;
  for (var i = startA; i < a.length; i++) {
    while (k > 0 && a[i] != b[k]) {
      k = map[k];
    }
    if (a[i] == b[k]) {
      k++;
    }
  }
  return k;
}
