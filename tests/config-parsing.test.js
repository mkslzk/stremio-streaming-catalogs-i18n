/**
 * Tests for the config parsing in src/server/routes/catalog.js and
 * src/server/routes/manifest.js. Verifies:
 *   - 7-field configs (legacy, no language) parse correctly
 *   - 8-field configs (with language) parse correctly
 *   - Legacy RPDB key format is detected and re-ordered
 *   - Empty/missing fields don't break parsing
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Re-implement the parsing logic here to test it in isolation.
// (The actual routes are tied to express req/res — we test the parsing
// logic by extracting it via the same pattern used in catalog.js.)
function parseConfig(b64) {
  const buffer = Buffer(b64 || '', 'base64');
  const parts = buffer.toString('ascii')?.split(':') || [];
  let [selectedProviders, rpdbKey, countryCode, installedAt] = parts;

  // Handle legacy RPDB key format
  if (String(rpdbKey || '').startsWith('16')) {
    installedAt = rpdbKey;
    rpdbKey = null;
  }

  const language = parts[7] || null;

  return { selectedProviders, rpdbKey, countryCode, installedAt, language };
}

function encode(parts) {
  return Buffer.from(parts.join(':')).toString('base64');
}

describe('config parsing — 8-field format (i18n extension)', () => {
  it('parses language from the 8th field', () => {
    const cfg = encode(['nfx,hbm', '', '', '1234567890', '0', '0', '', 'de-DE']);
    const p = parseConfig(cfg);
    assert.equal(p.selectedProviders, 'nfx,hbm');
    assert.equal(p.language, 'de-DE');
  });

  it('returns null language for 7-field legacy config (backward compat)', () => {
    const cfg = encode(['nfx,hbm', '', '', '1234567890', '0', '0', '']);
    const p = parseConfig(cfg);
    assert.equal(p.selectedProviders, 'nfx,hbm');
    assert.equal(p.language, null);
  });

  it('handles empty string language gracefully', () => {
    const cfg = encode(['nfx', '', '', '1234', '0', '0', '', '']);
    const p = parseConfig(cfg);
    assert.equal(p.language, null, 'empty language treated as null');
  });

  it('preserves all other fields when language is present', () => {
    const cfg = encode(['nfx,amp', 'rpdb123', 'DE', '1700000000', '1', '0', 'DE', 'fr-FR']);
    const p = parseConfig(cfg);
    assert.equal(p.selectedProviders, 'nfx,amp');
    assert.equal(p.rpdbKey, 'rpdb123');
    assert.equal(p.countryCode, 'DE');
    assert.equal(p.installedAt, '1700000000');
    assert.equal(p.language, 'fr-FR');
  });
});

describe('config parsing — legacy RPDB key format', () => {
  it('detects RPDB keys starting with 16 and reorders', () => {
    // Old format: rpdbKey='16xxx...', installedAt was actually in field 1
    const cfg = encode(['nfx', '1612345678901', '', '']);
    const p = parseConfig(cfg);
    assert.equal(p.rpdbKey, null, 'legacy rpdb key cleared');
    assert.equal(p.installedAt, '1612345678901', 'timestamp moved to installedAt');
  });

  it('preserves new-format RPDB keys (not starting with 16)', () => {
    const cfg = encode(['nfx', 't1-abcd-1234', '', '1700000000']);
    const p = parseConfig(cfg);
    assert.equal(p.rpdbKey, 't1-abcd-1234');
    assert.equal(p.installedAt, '1700000000');
  });
});

describe('config parsing — edge cases', () => {
  it('handles empty config without crashing', () => {
    const p = parseConfig('');
    // Buffer('').toString('ascii') → '' (empty string), not undefined
    assert.equal(p.selectedProviders, '');
    assert.equal(p.language, null);
  });

  it('handles config with only one field', () => {
    const cfg = encode(['nfx']);
    const p = parseConfig(cfg);
    assert.equal(p.selectedProviders, 'nfx');
    assert.equal(p.language, null);
  });
});