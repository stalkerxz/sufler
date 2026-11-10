import test from 'node:test';
import assert from 'node:assert/strict';
import { readingLayout } from '../src/reader-layout.js';

test('reading height follows the selected percentage and grows monotonically', () => {
  const upper = readingLayout({height:800, position:10});
  const middle = readingLayout({height:800, position:50});
  const lower = readingLayout({height:800, position:80});
  assert.equal(upper.guideY,80); assert.equal(middle.guideY,400); assert.equal(lower.guideY,640);
  assert.ok(upper.paddingTop < middle.paddingTop && middle.paddingTop < lower.paddingTop);
});
test('the first and last words can reach the chosen height', () => {
  for (const position of [10,38,50,80]) {
    const height=800,line=44*1.65;
    const layout=readingLayout({height,position});
    assert.equal(layout.paddingTop + line/2, layout.guideY);
    assert.ok(layout.paddingBottom >= height - layout.guideY + line/2);
    assert.ok(layout.fadeTop <= layout.guideY - line/2);
    assert.ok(layout.fadeBottom >= layout.guideY + line/2);
  }
});
test('large type and a short viewport keep the reading point within bounds', () => {
  for (const height of [0,60,180,600]) for (const position of [10,80]) {
    const result=readingLayout({height,position,fontSize:80,lineHeight:2});
    assert.ok(result.guideY>=0 && result.guideY<=height);
    assert.ok(result.paddingTop>=0 && result.paddingBottom>=0);
    assert.ok(result.fadeTop>=0 && result.fadeBottom<=height);
  }
});
test('missing, malformed and out-of-range percentages have safe defaults', () => {
  assert.equal(readingLayout({height:1000}).guideY,380);
  assert.equal(readingLayout({height:1000,position:NaN}).guideY,380);
  assert.equal(readingLayout({height:1000,position:-100}).guideY,100);
  assert.equal(readingLayout({height:1000,position:1000}).guideY,800);
});
