import Diff from './base.js';
import { diffChars } from './character.js';
import { diffWords, diffWordsWithSpace } from './word.js';
import { diffLines, diffTrimmedLines } from './line.js';
import { diffSentences } from './sentence.js';
import { diffCss } from './css.js';
import { diffJson } from './json.js';
import { diffArrays } from './array.js';
import { structuredPatch, createTwoFilesPatch, createPatch, applyPatch, applyPatches, parsePatch, formatPatch } from './patch.js';

export {
  Diff,
  diffChars,
  diffWords,
  diffWordsWithSpace,
  diffLines,
  diffTrimmedLines,
  diffSentences,
  diffCss,
  diffJson,
  diffArrays,
  structuredPatch,
  createTwoFilesPatch,
  createPatch,
  applyPatch,
  applyPatches,
  parsePatch,
  formatPatch
};
