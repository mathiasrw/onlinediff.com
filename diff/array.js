import Diff from './base.js';

var arrayDiff = new Diff();
arrayDiff.tokenize = function (value) {
  return value.slice();
};
arrayDiff.join = arrayDiff.removeEmpty = function (value) {
  return value;
};
export function diffArrays(oldArr, newArr, callback) {
  return arrayDiff.diff(oldArr, newArr, callback);
}
