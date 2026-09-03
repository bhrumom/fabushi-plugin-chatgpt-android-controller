import assert from 'node:assert/strict';
import test from 'node:test';
import { findSemanticNode, parseUiNodes } from '../runtime/controller.ts';

test('parseUiNodes decodes Android hierarchy attributes and bounds', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <hierarchy rotation="0">
    <node index="0" text="允许一次" resource-id="com.openai.chatgpt:id/allow" class="android.widget.Button" package="com.openai.chatgpt" content-desc="" clickable="true" enabled="true" bounds="[100,200][300,280]" />
    <node index="1" text="" resource-id="composer" class="android.widget.EditText" package="com.openai.chatgpt" content-desc="Message ChatGPT" clickable="true" enabled="true" bounds="[20,900][900,1050]" />
  </hierarchy>`;

  const nodes = parseUiNodes(xml);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].text, '允许一次');
  assert.deepEqual(nodes[0].bounds, [100, 200, 300, 280]);
  assert.equal(nodes[1].editable, true);
  assert.equal(nodes[1].description, 'Message ChatGPT');
});

test('findSemanticNode matches localized text and accessibility description', () => {
  const nodes = parseUiNodes(`
    <hierarchy>
      <node text="" resource-id="" class="android.widget.Button" package="com.openai.chatgpt" content-desc="Send message" clickable="true" enabled="true" bounds="[800,900][900,1000]" />
      <node text="允許一次" resource-id="" class="android.widget.Button" package="com.openai.chatgpt" content-desc="" clickable="true" enabled="true" bounds="[100,300][400,380]" />
    </hierarchy>`);

  assert.equal(findSemanticNode(nodes, ['Send', 'Send message'])?.description, 'Send message');
  assert.equal(findSemanticNode(nodes, ['Allow once', '允许一次', '允許一次'])?.text, '允許一次');
});

test('disabled or unbounded nodes are never selected for an action', () => {
  const nodes = parseUiNodes(`
    <hierarchy>
      <node text="Allow once" class="android.widget.Button" package="com.openai.chatgpt" clickable="true" enabled="false" bounds="[1,1][2,2]" />
      <node text="Allow once" class="android.widget.Button" package="com.openai.chatgpt" clickable="true" enabled="true" bounds="" />
    </hierarchy>`);

  assert.equal(findSemanticNode(nodes, ['Allow once']), undefined);
});
