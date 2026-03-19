import { diffLines } from './line.js';

function unixToWin(patch) {
  if (Array.isArray(patch)) {
    return patch.map(unixToWin);
  }
  return {
    ...patch,
    hunks: patch.hunks.map(function (hunk) {
      return {
        ...hunk,
        lines: hunk.lines.map(function (line, i) {
          var _hunk$lines;
          return line.startsWith('\\') || line.endsWith('\r') || (_hunk$lines = hunk.lines[i + 1]) !== null && _hunk$lines !== void 0 && _hunk$lines.startsWith('\\') ? line : line + '\r';
        })
      };
    })
  };
}
function winToUnix(patch) {
  if (Array.isArray(patch)) {
    return patch.map(winToUnix);
  }
  return {
    ...patch,
    hunks: patch.hunks.map(function (hunk) {
      return {
        ...hunk,
        lines: hunk.lines.map(function (line) {
          return line.endsWith('\r') ? line.substring(0, line.length - 1) : line;
        })
      };
    })
  };
}

/**
 * Returns true if the patch consistently uses Unix line endings (or only involves one line and has
 * no line endings).
 */
function isUnix(patch) {
  if (!Array.isArray(patch)) {
    patch = [patch];
  }
  return !patch.some(function (index) {
    return index.hunks.some(function (hunk) {
      return hunk.lines.some(function (line) {
        return !line.startsWith('\\') && line.endsWith('\r');
      });
    });
  });
}

/**
 * Returns true if the patch uses Windows line endings and only Windows line endings.
 */
function isWin(patch) {
  if (!Array.isArray(patch)) {
    patch = [patch];
  }
  return patch.some(function (index) {
    return index.hunks.some(function (hunk) {
      return hunk.lines.some(function (line) {
        return line.endsWith('\r');
      });
    });
  }) && patch.every(function (index) {
    return index.hunks.every(function (hunk) {
      return hunk.lines.every(function (line, i) {
        var _hunk$lines2;
        return line.startsWith('\\') || line.endsWith('\r') || ((_hunk$lines2 = hunk.lines[i + 1]) === null || _hunk$lines2 === void 0 ? void 0 : _hunk$lines2.startsWith('\\'));
      });
    });
  });
}

export function parsePatch(uniDiff) {
  var diffstr = uniDiff.split(/\n/),
    list = [],
    i = 0;
  function parseIndex() {
    var index = {};
    list.push(index);

    // Parse diff metadata
    while (i < diffstr.length) {
      var line = diffstr[i];

      // File header found, end parsing diff metadata
      if (/^(\-\-\-|\+\+\+|@@)\s/.test(line)) {
        break;
      }

      // Diff index
      var header = /^(?:Index:|diff(?: -r \w+)+)\s+(.+?)\s*$/.exec(line);
      if (header) {
        index.index = header[1];
      }
      i++;
    }

    // Parse file headers if they are defined. Unified diff requires them, but
    // there's no technical issues to have an isolated hunk without file header
    parseFileHeader(index);
    parseFileHeader(index);

    // Parse hunks
    index.hunks = [];
    while (i < diffstr.length) {
      var _line = diffstr[i];
      if (/^(Index:\s|diff\s|\-\-\-\s|\+\+\+\s|===================================================================)/.test(_line)) {
        break;
      } else if (/^@@/.test(_line)) {
        index.hunks.push(parseHunk());
      } else if (_line) {
        throw new Error('Unknown line ' + (i + 1) + ' ' + JSON.stringify(_line));
      } else {
        i++;
      }
    }
  }

  // Parses the --- and +++ headers, if none are found, no lines
  // are consumed.
  function parseFileHeader(index) {
    var fileHeader = /^(---|\+\+\+)\s+(.*)\r?$/.exec(diffstr[i]);
    if (fileHeader) {
      var keyPrefix = fileHeader[1] === '---' ? 'old' : 'new';
      var data = fileHeader[2].split('\t', 2);
      var fileName = data[0].replace(/\\\\/g, '\\');
      if (/^".*"$/.test(fileName)) {
        fileName = fileName.substr(1, fileName.length - 2);
      }
      index[keyPrefix + 'FileName'] = fileName;
      index[keyPrefix + 'Header'] = (data[1] || '').trim();
      i++;
    }
  }

  // Parses a hunk
  // This assumes that we are at the start of a hunk.
  function parseHunk() {
    var chunkHeaderIndex = i,
      chunkHeaderLine = diffstr[i++],
      chunkHeader = chunkHeaderLine.split(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    var hunk = {
      oldStart: +chunkHeader[1],
      oldLines: typeof chunkHeader[2] === 'undefined' ? 1 : +chunkHeader[2],
      newStart: +chunkHeader[3],
      newLines: typeof chunkHeader[4] === 'undefined' ? 1 : +chunkHeader[4],
      lines: []
    };

    // Unified Diff Format quirk: If the chunk size is 0,
    // the first number is one lower than one would expect.
    // https://www.artima.com/weblogs/viewpost.jsp?thread=164293
    if (hunk.oldLines === 0) {
      hunk.oldStart += 1;
    }
    if (hunk.newLines === 0) {
      hunk.newStart += 1;
    }
    var addCount = 0,
      removeCount = 0;
    for (; i < diffstr.length && (removeCount < hunk.oldLines || addCount < hunk.newLines || (_diffstr$i = diffstr[i]) !== null && _diffstr$i !== void 0 && _diffstr$i.startsWith('\\')); i++) {
      var _diffstr$i;
      var operation = diffstr[i].length == 0 && i != diffstr.length - 1 ? ' ' : diffstr[i][0];
      if (operation === '+' || operation === '-' || operation === ' ' || operation === '\\') {
        hunk.lines.push(diffstr[i]);
        if (operation === '+') {
          addCount++;
        } else if (operation === '-') {
          removeCount++;
        } else if (operation === ' ') {
          addCount++;
          removeCount++;
        }
      } else {
        throw new Error("Hunk at line ".concat(chunkHeaderIndex + 1, " contained invalid line ").concat(diffstr[i]));
      }
    }

    // Handle the empty block count case
    if (!addCount && hunk.newLines === 1) {
      hunk.newLines = 0;
    }
    if (!removeCount && hunk.oldLines === 1) {
      hunk.oldLines = 0;
    }

    // Perform sanity checking
    if (addCount !== hunk.newLines) {
      throw new Error('Added line count did not match for hunk at line ' + (chunkHeaderIndex + 1));
    }
    if (removeCount !== hunk.oldLines) {
      throw new Error('Removed line count did not match for hunk at line ' + (chunkHeaderIndex + 1));
    }
    return hunk;
  }
  while (i < diffstr.length) {
    parseIndex();
  }
  return list;
}

// Iterator that traverses in the range of [min, max], stepping
// by distance from a given start position. I.e. for [0, 4], with
// start of 2, this will iterate 2, 3, 1, 4, 0.
function distanceIterator (start, minLine, maxLine) {
  var wantForward = true,
    backwardExhausted = false,
    forwardExhausted = false,
    localOffset = 1;
  return function iterator() {
    if (wantForward && !forwardExhausted) {
      if (backwardExhausted) {
        localOffset++;
      } else {
        wantForward = false;
      }

      // Check if trying to fit beyond text length, and if not, check it fits
      // after offset location (or desired location on first iteration)
      if (start + localOffset <= maxLine) {
        return start + localOffset;
      }
      forwardExhausted = true;
    }
    if (!backwardExhausted) {
      if (!forwardExhausted) {
        wantForward = true;
      }

      // Check if trying to fit before text beginning, and if not, check it fits
      // before offset location
      if (minLine <= start - localOffset) {
        return start - localOffset++;
      }
      backwardExhausted = true;
      return iterator();
    }

    // We tried to fit hunk before text beginning and beyond text length, then
    // hunk can't fit on the text. Return undefined
  };
}

export function applyPatch(source, uniDiff) {
  var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  if (typeof uniDiff === 'string') {
    uniDiff = parsePatch(uniDiff);
  }
  if (Array.isArray(uniDiff)) {
    if (uniDiff.length > 1) {
      throw new Error('applyPatch only works with a single input.');
    }
    uniDiff = uniDiff[0];
  }
  if (options.autoConvertLineEndings || options.autoConvertLineEndings == null) {
    if (hasOnlyWinLineEndings(source) && isUnix(uniDiff)) {
      uniDiff = unixToWin(uniDiff);
    } else if (hasOnlyUnixLineEndings(source) && isWin(uniDiff)) {
      uniDiff = winToUnix(uniDiff);
    }
  }

  // Apply the diff to the input
  var lines = source.split('\n'),
    hunks = uniDiff.hunks,
    compareLine = options.compareLine || function (lineNumber, line, operation, patchContent) {
      return line === patchContent;
    },
    fuzzFactor = options.fuzzFactor || 0,
    minLine = 0;
  if (fuzzFactor < 0 || !Number.isInteger(fuzzFactor)) {
    throw new Error('fuzzFactor must be a non-negative integer');
  }

  // Special case for empty patch.
  if (!hunks.length) {
    return source;
  }

  // Before anything else, handle EOFNL insertion/removal. If the patch tells us to make a change
  // to the EOFNL that is redundant/impossible - i.e. to remove a newline that's not there, or add a
  // newline that already exists - then we either return false and fail to apply the patch (if
  // fuzzFactor is 0) or simply ignore the problem and do nothing (if fuzzFactor is >0).
  // If we do need to remove/add a newline at EOF, this will always be in the final hunk:
  var prevLine = '',
    removeEOFNL = false,
    addEOFNL = false;
  for (var i = 0; i < hunks[hunks.length - 1].lines.length; i++) {
    var line = hunks[hunks.length - 1].lines[i];
    if (line[0] == '\\') {
      if (prevLine[0] == '+') {
        removeEOFNL = true;
      } else if (prevLine[0] == '-') {
        addEOFNL = true;
      }
    }
    prevLine = line;
  }
  if (removeEOFNL) {
    if (addEOFNL) {
      // This means the final line gets changed but doesn't have a trailing newline in either the
      // original or patched version. In that case, we do nothing if fuzzFactor > 0, and if
      // fuzzFactor is 0, we simply validate that the source file has no trailing newline.
      if (!fuzzFactor && lines[lines.length - 1] == '') {
        return false;
      }
    } else if (lines[lines.length - 1] == '') {
      lines.pop();
    } else if (!fuzzFactor) {
      return false;
    }
  } else if (addEOFNL) {
    if (lines[lines.length - 1] != '') {
      lines.push('');
    } else if (!fuzzFactor) {
      return false;
    }
  }

  /**
   * Checks if the hunk can be made to fit at the provided location with at most `maxErrors`
   * insertions, substitutions, or deletions, while ensuring also that:
   * - lines deleted in the hunk match exactly, and
   * - wherever an insertion operation or block of insertion operations appears in the hunk, the
   *   immediately preceding and following lines of context match exactly
   *
   * `toPos` should be set such that lines[toPos] is meant to match hunkLines[0].
   *
   * If the hunk can be applied, returns an object with properties `oldLineLastI` and
   * `replacementLines`. Otherwise, returns null.
   */
  function applyHunk(hunkLines, toPos, maxErrors) {
    var hunkLinesI = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : 0;
    var lastContextLineMatched = arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : true;
    var patchedLines = arguments.length > 5 && arguments[5] !== undefined ? arguments[5] : [];
    var patchedLinesLength = arguments.length > 6 && arguments[6] !== undefined ? arguments[6] : 0;
    var nConsecutiveOldContextLines = 0;
    var nextContextLineMustMatch = false;
    for (; hunkLinesI < hunkLines.length; hunkLinesI++) {
      var hunkLine = hunkLines[hunkLinesI],
        operation = hunkLine.length > 0 ? hunkLine[0] : ' ',
        content = hunkLine.length > 0 ? hunkLine.substr(1) : hunkLine;
      if (operation === '-') {
        if (compareLine(toPos + 1, lines[toPos], operation, content)) {
          toPos++;
          nConsecutiveOldContextLines = 0;
        } else {
          if (!maxErrors || lines[toPos] == null) {
            return null;
          }
          patchedLines[patchedLinesLength] = lines[toPos];
          return applyHunk(hunkLines, toPos + 1, maxErrors - 1, hunkLinesI, false, patchedLines, patchedLinesLength + 1);
        }
      }
      if (operation === '+') {
        if (!lastContextLineMatched) {
          return null;
        }
        patchedLines[patchedLinesLength] = content;
        patchedLinesLength++;
        nConsecutiveOldContextLines = 0;
        nextContextLineMustMatch = true;
      }
      if (operation === ' ') {
        nConsecutiveOldContextLines++;
        patchedLines[patchedLinesLength] = lines[toPos];
        if (compareLine(toPos + 1, lines[toPos], operation, content)) {
          patchedLinesLength++;
          lastContextLineMatched = true;
          nextContextLineMustMatch = false;
          toPos++;
        } else {
          if (nextContextLineMustMatch || !maxErrors) {
            return null;
          }

          // Consider 3 possibilities in sequence:
          // 1. lines contains a *substitution* not included in the patch context, or
          // 2. lines contains an *insertion* not included in the patch context, or
          // 3. lines contains a *deletion* not included in the patch context
          // The first two options are of course only possible if the line from lines is non-null -
          // i.e. only option 3 is possible if we've overrun the end of the old file.
          return lines[toPos] && (applyHunk(hunkLines, toPos + 1, maxErrors - 1, hunkLinesI + 1, false, patchedLines, patchedLinesLength + 1) || applyHunk(hunkLines, toPos + 1, maxErrors - 1, hunkLinesI, false, patchedLines, patchedLinesLength + 1)) || applyHunk(hunkLines, toPos, maxErrors - 1, hunkLinesI + 1, false, patchedLines, patchedLinesLength);
        }
      }
    }

    // Before returning, trim any unmodified context lines off the end of patchedLines and reduce
    // toPos (and thus oldLineLastI) accordingly. This allows later hunks to be applied to a region
    // that starts in this hunk's trailing context.
    patchedLinesLength -= nConsecutiveOldContextLines;
    toPos -= nConsecutiveOldContextLines;
    patchedLines.length = patchedLinesLength;
    return {
      patchedLines: patchedLines,
      oldLineLastI: toPos - 1
    };
  }
  var resultLines = [];

  // Search best fit offsets for each hunk based on the previous ones
  var prevHunkOffset = 0;
  for (var _i = 0; _i < hunks.length; _i++) {
    var hunk = hunks[_i];
    var hunkResult = void 0;
    var maxLine = lines.length - hunk.oldLines + fuzzFactor;
    var toPos = void 0;
    for (var maxErrors = 0; maxErrors <= fuzzFactor; maxErrors++) {
      toPos = hunk.oldStart + prevHunkOffset - 1;
      var iterator = distanceIterator(toPos, minLine, maxLine);
      for (; toPos !== undefined; toPos = iterator()) {
        hunkResult = applyHunk(hunk.lines, toPos, maxErrors);
        if (hunkResult) {
          break;
        }
      }
      if (hunkResult) {
        break;
      }
    }
    if (!hunkResult) {
      return false;
    }

    // Copy everything from the end of where we applied the last hunk to the start of this hunk
    for (var _i2 = minLine; _i2 < toPos; _i2++) {
      resultLines.push(lines[_i2]);
    }

    // Add the lines produced by applying the hunk:
    for (var _i3 = 0; _i3 < hunkResult.patchedLines.length; _i3++) {
      var _line = hunkResult.patchedLines[_i3];
      resultLines.push(_line);
    }

    // Set lower text limit to end of the current hunk, so next ones don't try
    // to fit over already patched text
    minLine = hunkResult.oldLineLastI + 1;

    // Note the offset between where the patch said the hunk should've applied and where we
    // applied it, so we can adjust future hunks accordingly:
    prevHunkOffset = toPos + 1 - hunk.oldStart;
  }

  // Copy over the rest of the lines from the old text
  for (var _i4 = minLine; _i4 < lines.length; _i4++) {
    resultLines.push(lines[_i4]);
  }
  return resultLines.join('\n');
}

// Wrapper that supports multiple file patches via callbacks.
export function applyPatches(uniDiff, options) {
  if (typeof uniDiff === 'string') {
    uniDiff = parsePatch(uniDiff);
  }
  var currentIndex = 0;
  function processIndex() {
    var index = uniDiff[currentIndex++];
    if (!index) {
      return options.complete();
    }
    options.loadFile(index, function (err, data) {
      if (err) {
        return options.complete(err);
      }
      var updatedContent = applyPatch(data, index, options);
      options.patched(index, updatedContent, function (err) {
        if (err) {
          return options.complete(err);
        }
        processIndex();
      });
    });
  }
  processIndex();
}

export function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  if (!options) {
    options = {};
  }
  if (typeof options === 'function') {
    options = {
      callback: options
    };
  }
  if (typeof options.context === 'undefined') {
    options.context = 4;
  }
  if (options.newlineIsToken) {
    throw new Error('newlineIsToken may not be used with patch-generation functions, only with diffing functions');
  }
  if (!options.callback) {
    return diffLinesResultToPatch(diffLines(oldStr, newStr, options));
  } else {
    var _options = options,
      _callback = _options.callback;
    diffLines(oldStr, newStr, {
      ...options,
      callback: function callback(diff) {
        var patch = diffLinesResultToPatch(diff);
        _callback(patch);
      }
    });
  }
  function diffLinesResultToPatch(diff) {
    // STEP 1: Build up the patch with no "\ No newline at end of file" lines and with the arrays
    //         of lines containing trailing newline characters. We'll tidy up later...

    if (!diff) {
      return;
    }
    diff.push({
      value: '',
      lines: []
    }); // Append an empty value to make cleanup easier

    function contextLines(lines) {
      return lines.map(function (entry) {
        return ' ' + entry;
      });
    }
    var hunks = [];
    var oldRangeStart = 0,
      newRangeStart = 0,
      curRange = [],
      oldLine = 1,
      newLine = 1;
    var _loop = function _loop() {
      var current = diff[i],
        lines = current.lines || splitLines(current.value);
      current.lines = lines;
      if (current.added || current.removed) {
        var _curRange;
        // If we have previous context, start with that
        if (!oldRangeStart) {
          var prev = diff[i - 1];
          oldRangeStart = oldLine;
          newRangeStart = newLine;
          if (prev) {
            curRange = options.context > 0 ? contextLines(prev.lines.slice(-options.context)) : [];
            oldRangeStart -= curRange.length;
            newRangeStart -= curRange.length;
          }
        }

        // Output our changes
        (_curRange = curRange).push.apply(_curRange, _toConsumableArray(lines.map(function (entry) {
          return (current.added ? '+' : '-') + entry;
        })));

        // Track the updated file position
        if (current.added) {
          newLine += lines.length;
        } else {
          oldLine += lines.length;
        }
      } else {
        // Identical context lines. Track line changes
        if (oldRangeStart) {
          // Close out any changes that have been output (or join overlapping)
          if (lines.length <= options.context * 2 && i < diff.length - 2) {
            var _curRange2;
            // Overlapping
            (_curRange2 = curRange).push.apply(_curRange2, _toConsumableArray(contextLines(lines)));
          } else {
            var _curRange3;
            // end the range and output
            var contextSize = Math.min(lines.length, options.context);
            (_curRange3 = curRange).push.apply(_curRange3, _toConsumableArray(contextLines(lines.slice(0, contextSize))));
            var _hunk = {
              oldStart: oldRangeStart,
              oldLines: oldLine - oldRangeStart + contextSize,
              newStart: newRangeStart,
              newLines: newLine - newRangeStart + contextSize,
              lines: curRange
            };
            hunks.push(_hunk);
            oldRangeStart = 0;
            newRangeStart = 0;
            curRange = [];
          }
        }
        oldLine += lines.length;
        newLine += lines.length;
      }
    };
    for (var i = 0; i < diff.length; i++) {
      _loop();
    }

    // Step 2: eliminate the trailing `\n` from each line of each hunk, and, where needed, add
    //         "\ No newline at end of file".
    for (var _i = 0, _hunks = hunks; _i < _hunks.length; _i++) {
      var hunk = _hunks[_i];
      for (var _i2 = 0; _i2 < hunk.lines.length; _i2++) {
        if (hunk.lines[_i2].endsWith('\n')) {
          hunk.lines[_i2] = hunk.lines[_i2].slice(0, -1);
        } else {
          hunk.lines.splice(_i2 + 1, 0, '\\ No newline at end of file');
          _i2++; // Skip the line we just added, then continue iterating
        }
      }
    }
    return {
      oldFileName: oldFileName,
      newFileName: newFileName,
      oldHeader: oldHeader,
      newHeader: newHeader,
      hunks: hunks
    };
  }
}

export function formatPatch(diff) {
  if (Array.isArray(diff)) {
    return diff.map(formatPatch).join('\n');
  }
  var ret = [];
  if (diff.oldFileName == diff.newFileName) {
    ret.push('Index: ' + diff.oldFileName);
  }
  ret.push('===================================================================');
  ret.push('--- ' + diff.oldFileName + (typeof diff.oldHeader === 'undefined' ? '' : '\t' + diff.oldHeader));
  ret.push('+++ ' + diff.newFileName + (typeof diff.newHeader === 'undefined' ? '' : '\t' + diff.newHeader));
  for (var i = 0; i < diff.hunks.length; i++) {
    var hunk = diff.hunks[i];
    // Unified Diff Format quirk: If the chunk size is 0,
    // the first number is one lower than one would expect.
    // https://www.artima.com/weblogs/viewpost.jsp?thread=164293
    if (hunk.oldLines === 0) {
      hunk.oldStart -= 1;
    }
    if (hunk.newLines === 0) {
      hunk.newStart -= 1;
    }
    ret.push('@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@');
    ret.push.apply(ret, hunk.lines);
  }
  return ret.join('\n') + '\n';
}

export function createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  var _options2;
  if (typeof options === 'function') {
    options = {
      callback: options
    };
  }
  if (!((_options2 = options) !== null && _options2 !== void 0 && _options2.callback)) {
    var patchObj = structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options);
    if (!patchObj) {
      return;
    }
    return formatPatch(patchObj);
  } else {
    var _options3 = options,
      _callback2 = _options3.callback;
    structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, {
      ...options,
      callback: function callback(patchObj) {
        if (!patchObj) {
          _callback2();
        } else {
          _callback2(formatPatch(patchObj));
        }
      }
    });
  }
}

export function createPatch(fileName, oldStr, newStr, oldHeader, newHeader, options) {
  return createTwoFilesPatch(fileName, fileName, oldStr, newStr, oldHeader, newHeader, options);
}

/**
 * Split `text` into an array of lines, including the trailing newline character (where present)
 */
function splitLines(text) {
  var hasTrailingNl = text.endsWith('\n');
  var result = text.split('\n').map(function (line) {
    return line + '\n';
  });
  if (hasTrailingNl) {
    result.pop();
  } else {
    result.push(result.pop().slice(0, -1));
  }
  return result;
}

/**
 * Returns true if the string consistently uses Windows line endings.
 */
function hasOnlyWinLineEndings(string) {
  return string.includes('\r\n') && !string.startsWith('\n') && !string.match(/[^\r]\n/);
}

/**
 * Returns true if the string consistently uses Unix line endings.
 */
function hasOnlyUnixLineEndings(string) {
  return !string.includes('\r\n') && string.includes('\n');
}

function _toConsumableArray(arr) {
  return _arrayWithoutHoles(arr) || _iterableToArray(arr) || _unsupportedIterableToArray(arr) || _nonIterableSpread();
}
function _arrayWithoutHoles(arr) {
  if (Array.isArray(arr)) return _arrayLikeToArray(arr);
}
function _iterableToArray(iter) {
  if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
}
function _unsupportedIterableToArray(o, minLen) {
  if (!o) return;
  if (typeof o === "string") return _arrayLikeToArray(o, minLen);
  var n = Object.prototype.toString.call(o).slice(8, -1);
  if (n === "Object" && o.constructor) n = o.constructor.name;
  if (n === "Map" || n === "Set") return Array.from(o);
  if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _arrayLikeToArray(o, minLen);
}
function _arrayLikeToArray(arr, len) {
  if (len == null || len > arr.length) len = arr.length;
  for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
  return arr2;
}
function _nonIterableSpread() {
  throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
