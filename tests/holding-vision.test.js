import assert from 'node:assert/strict';
import test from 'node:test';
import { holdingVisionRequest, holdingVisionRows, isHoldingJpeg } from '../backend/holding-vision.mjs';

function candidate(rows) {
  return { candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }, { text: JSON.stringify({ rows }) }] } }] };
}

test('sends a single inline image and requests a bounded structured response', () => {
  const image = Buffer.from([255, 216, 255, 224, 255, 217]).toString('base64');
  assert.equal(isHoldingJpeg(image), true);
  assert.equal(isHoldingJpeg('UklGRg=='), false);
  const request = JSON.parse(holdingVisionRequest('gemini', image));
  assert.deepEqual(request.contents[0].parts[1], { inlineData: { mimeType: 'image/jpeg', data: image } });
  assert.equal(request.generationConfig.responseJsonSchema.properties.rows.maxItems, 50);
});

test('requests high-detail OpenAI image input and a strict schema without storing the response', () => {
  const image = Buffer.from([255, 216, 255, 224, 255, 217]).toString('base64');
  const request = JSON.parse(holdingVisionRequest('openai', image));
  assert.equal(request.model, 'gpt-6.1-terra');
  assert.equal(request.store, false);
  assert.deepEqual(request.input[0].content[1], { type: 'input_image', image_url: 'data:image/jpeg;base64,' + image, detail: 'high' });
  assert.equal(request.text.format.strict, true);
  const schema = request.text.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.rows.items.additionalProperties, false);
  assert.equal(schema.properties.rows.maxItems, 50);
});

test('preserves leading zeros and converts explicit lots without guessing missing amounts', () => {
  const rows = holdingVisionRows('gemini', candidate([
    { code: '００５０', name: '元大台灣50', quantity: '2.501', quantityUnit: 'lots', averageCost: 'NT$ 157.30', lastPrice: '168.00' },
    { code: '2330', name: '台積電', quantity: '500', quantityUnit: 'unknown', averageCost: '', lastPrice: '0' },
    { code: '00679B', name: '', quantity: '1,000', quantityUnit: 'shares' }
  ]));
  assert.deepEqual(rows, [
    { code: '0050', name: '元大台灣50', shares: '2501', cost: '157.3', price: '168' },
    { code: '2330', name: '台積電', shares: '', cost: '', price: '' }
  ]);
});

test('handles an empty model result and reports invalid model output', () => {
  assert.deepEqual(holdingVisionRows('gemini', candidate([])), []);
  assert.throws(() => holdingVisionRows('gemini', { candidates: [] }), { status: 502 });
});

test('reads completed OpenAI message output and rejects incomplete or refused responses', () => {
  const content = [{ type: 'output_text', text: JSON.stringify({ rows: [
    { code: '0050', name: '元大台灣50', quantity: '2.5', quantityUnit: 'lots', averageCost: '', lastPrice: '168' }
  ] }) }];
  const output = [{ type: 'reasoning' }, { type: 'message', content }];
  assert.deepEqual(holdingVisionRows('openai', { status: 'completed', output }), [
    { code: '0050', name: '元大台灣50', shares: '2500', cost: '', price: '168' }
  ]);
  assert.throws(() => holdingVisionRows('openai', { status: 'incomplete', output }), { status: 502 });
  assert.throws(() => holdingVisionRows('openai', { status: 'completed', output: [
    { type: 'message', content: [{ type: 'refusal', refusal: 'Refused' }] }
  ] }), { status: 502 });
});
