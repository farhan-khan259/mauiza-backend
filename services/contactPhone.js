export function validateContactPhone(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const phoneCountryCode = typeof input.phoneCountryCode === 'string' ? input.phoneCountryCode.trim() : '';
  const phoneNumber = typeof input.phoneNumber === 'string' ? input.phoneNumber.trim() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';

  if (!/^\+[1-9]\d{0,2}$/.test(phoneCountryCode) ||
      !/^\+[1-9]\d{0,14}$/.test(phone) ||
      !phone.startsWith(phoneCountryCode) ||
      !phoneNumber) {
    return null;
  }

  return { phoneCountryCode, phoneNumber, phone };
}
