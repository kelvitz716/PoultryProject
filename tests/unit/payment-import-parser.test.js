const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PARSER_VERSION,
    normalizeSms,
    parseMpesaSms
} = require('../../services/payment-import-parser');

function stringFields(value) {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringFields);
    if (value && typeof value === 'object') return Object.values(value).flatMap(stringFields);
    return [];
}

function assertNoSensitiveLeak(parsed, rawPhone) {
    const output = stringFields(parsed).join('\n');
    assert.doesNotMatch(output, new RegExp(rawPhone.replace(/[+]/g, '\\+').replace(/[\s-]/g, '[\\s-]?')));
    assert.doesNotMatch(output, /9,999|FULIZA|M-?PESA\s+BALANCE/i);
}

test('parses both supported incoming receipt wordings with EAT timestamp and redacted evidence', () => {
    const canonical = parseMpesaSms('QWE123ABC Confirmed. You have received Ksh1,250.50 from JANE DOE 0712345678 on 6/9/26 at 10:30 AM. New M-PESA balance is Ksh9,999. Fuliza M-PESA limit is Ksh1,000.');
    const direct = parseMpesaSms('DIR1234XYZ Confirmed. Ksh10 received from ALEX MULE +254712345678 on 6/9/26 at 10:31 AM.');

    assert.equal(canonical.parser_version, PARSER_VERSION);
    assert.deepEqual([canonical.receipt_code, canonical.amount_minor, canonical.direction, canonical.event_kind, canonical.status], ['QWE123ABC', 125050, 'received', 'customer_receipt', 'received']);
    assert.equal(canonical.transaction_at_ms, Date.UTC(2026, 8, 6, 7, 30));
    assert.deepEqual([canonical.counterparty_name, canonical.counterparty_phone_masked], ['JANE DOE', '••••5678']);
    assert.deepEqual([direct.counterparty_name, direct.counterparty_phone_masked], ['ALEX MULE', '••••5678']);
    assert.equal(canonical.is_postable, false);
    assertNoSensitiveLeak(canonical, '0712345678');
    assertNoSensitiveLeak(direct, '+254712345678');
});

test('supports Kenyan 07/+2547 and 01/+2541 phone families without leaking any full number', () => {
    const samples = [
        ['LOC1234XYZ Confirmed. Ksh20 received from LOCAL SEVEN 0712345678 on 6/9/26 at 9:00 AM.', 'LOCAL SEVEN', '0712345678'],
        ['INT1234XYZ Confirmed. Ksh20 received from INTERNATIONAL SEVEN +254712345678 on 6/9/26 at 9:00 AM.', 'INTERNATIONAL SEVEN', '+254712345678'],
        ['ONE1234XYZ Confirmed. Ksh20 received from LOCAL ONE 0112345678 on 6/9/26 at 9:00 AM.', 'LOCAL ONE', '0112345678'],
        ['MOB1234XYZ Confirmed. Ksh20 received from INTERNATIONAL ONE +254112345678 on 6/9/26 at 9:00 AM.', 'INTERNATIONAL ONE', '+254112345678']
    ];

    for (const [sms, expectedName, phone] of samples) {
        const parsed = parseMpesaSms(sms);
        assert.equal(parsed.counterparty_name, expectedName);
        assert.equal(parsed.counterparty_phone_masked, '••••5678');
        assertNoSensitiveLeak(parsed, phone);
    }
});

test('distinguishes send-to-person, paybill, and buy-goods with evidenced counterparties', () => {
    const sent = parseMpesaSms('SEN1234XYZ Confirmed. KES 300.00 sent to JOHN KIMANI 0712345678 on 6/9/26 at 11:05 AM.');
    const paybill = parseMpesaSms('PAY1234XYZ Confirmed. Ksh850.00 sent to KPLC PREPAID for account 123456 on 6/9/26 at 11:10 AM.');
    const buyGoods = parseMpesaSms('BUY1234XYZ Confirmed. Ksh75.25 Buy Goods at GREEN MART Till Number 554433 on 6/9/26 at 11:15 AM.');

    assert.deepEqual([sent.direction, sent.event_kind, sent.counterparty_name], ['sent', 'send_to_person', 'JOHN KIMANI']);
    assert.deepEqual([paybill.direction, paybill.event_kind, paybill.counterparty_name, paybill.reference_masked], ['paid', 'paybill_payment', 'KPLC PREPAID', '••••3456']);
    assert.deepEqual([buyGoods.direction, buyGoods.event_kind, buyGoods.counterparty_name, buyGoods.reference_masked, buyGoods.amount_minor], ['paid', 'buy_goods_payment', 'GREEN MART', '••••4433', 7525]);
    assert.equal(sent.status, 'needs_review');
    assert.equal(paybill.is_postable, false);
    assert.deepEqual(buyGoods.parse_warnings, []);
});

test('recognizes reversals and correctly converts EAT AM/PM times while rejecting invalid dates', () => {
    const reversal = parseMpesaSms('REV1234XYZ Confirmed. Ksh1,000.00 reversal of transaction on 6/9/26 at 12:00 PM.');
    const midnight = parseMpesaSms('MID1234XYZ Confirmed. Ksh10 received from NIGHT OWL 0712345678 on 6/9/26 at 12:05 AM.');
    const invalidDate = parseMpesaSms('BAD1234XYZ Confirmed. Ksh10 received from DATE TEST 0712345678 on 31/2/26 at 10:30 AM.');

    assert.deepEqual([reversal.direction, reversal.event_kind, reversal.status, reversal.amount_minor], ['reversed', 'reversal', 'reversed', 100000]);
    assert.equal(reversal.is_postable, false);
    assert.ok(reversal.parse_warnings.includes('missing_counterparty'));
    assert.equal(Object.hasOwn(reversal, 'reversal_of_id'), false);
    assert.equal(midnight.transaction_at_ms, Date.UTC(2026, 8, 5, 21, 5));
    assert.equal(invalidDate.transaction_at_ms, null);
    assert.ok(invalidDate.parse_warnings.includes('invalid_transaction_time'));
    assert.equal(invalidDate.status, 'needs_review');
});

test('missing, malformed, ambiguous, and non-canonical receipt tokens remain non-postable and need review', () => {
    const missingReceipt = parseMpesaSms('Confirmed. Ksh50 received from TEST BUYER on 6/9/26 at 1:00 PM.');
    const missingAmount = parseMpesaSms('MIS1234XYZ Confirmed. received from TEST BUYER on 6/9/26 at 1:00 PM.');
    const ambiguous = parseMpesaSms('AMB1234XYZ Confirmed. Ksh20 received from A and sent to B on 6/9/26 at 1:00 PM.');
    const falsePositive = parseMpesaSms('Your ACCOUNT123 Confirmed. Ksh20 received from A on 6/9/26 at 1:00 PM.');
    const malformed = parseMpesaSms('this is not a payment message');
    const empty = parseMpesaSms(null);

    assert.deepEqual(missingReceipt.parse_warnings, ['missing_receipt_code']);
    assert.deepEqual(missingAmount.parse_warnings, ['missing_amount']);
    assert.ok(ambiguous.parse_warnings.includes('ambiguous_direction'));
    assert.equal(falsePositive.receipt_code, null);
    assert.ok(falsePositive.parse_warnings.includes('missing_receipt_code'));
    assert.deepEqual(malformed.parse_warnings, ['missing_receipt_code', 'missing_amount', 'missing_direction']);
    assert.deepEqual(empty.parse_warnings, ['empty_message', 'missing_receipt_code', 'missing_amount', 'missing_direction']);
    for (const parsed of [missingReceipt, missingAmount, ambiguous, falsePositive, malformed, empty]) {
        assert.equal(parsed.status, 'needs_review');
        assert.equal(parsed.is_postable, false);
    }
});

test('zero amount remains observed but is invalid payment evidence requiring review', () => {
    const parsed = parseMpesaSms('ZER1234XYZ Confirmed. You have received Ksh0.00 from ZERO TEST 0712345678 on 6/9/26 at 10:30 AM.');

    assert.equal(parsed.amount_minor, 0);
    assert.equal(parsed.status, 'needs_review');
    assert.equal(parsed.is_postable, false);
    assert.ok(parsed.parse_warnings.includes('non_positive_amount'));
});

test('normalization makes fingerprints stable without exposing normalized full text in parser output', () => {
    const first = parseMpesaSms(' QWE123ABC confirmed. Ksh 1,250.50 received from Jane Doe ');
    const second = parseMpesaSms('qwe123abc CONFIRMED. KSH1,250.50   received from jane doe');

    assert.equal(normalizeSms(' Ksh 1,250 '), 'KSH1,250');
    assert.equal(first.message_fingerprint, second.message_fingerprint);
    assert.equal(Object.hasOwn(first, 'normalized_text'), false);
});
