import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContactPhone } from '../services/contactPhone.js';

test('Contact phone fields preserve the selected code, local number, and valid international number', () => {
  assert.deepEqual(validateContactPhone({
    phoneCountryCode: ' +1 ',
    phoneNumber: '415 555 2671',
    phone: ' +14155552671 '
  }), {
    phoneCountryCode: '+1',
    phoneNumber: '415 555 2671',
    phone: '+14155552671'
  });
});

test('Contact phone fields reject missing, malformed, or mismatched numbers', () => {
  assert.equal(validateContactPhone({}), null);
  assert.equal(validateContactPhone(null), null);
  assert.equal(validateContactPhone({
    phoneCountryCode: '+44',
    phoneNumber: '415 555 2671',
    phone: '+14155552671'
  }), null);
  assert.equal(validateContactPhone({
    phoneCountryCode: '+1',
    phoneNumber: '415 555 2671',
    phone: '4155552671'
  }), null);
});
