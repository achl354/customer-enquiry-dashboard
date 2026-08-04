const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  statusForFlag,
  statusForCategories,
  statusForReply,
  statusForMissingMessage,
  statusForFolderMove,
  statusForConfirmedSpam,
} = require('./repository');

// Pure-function tests for the "how does an enquiry get marked closed" logic
// — no DB needed for these three. Categories were added after checking real
// Sent Items showed the follow-up flag is rarely used in practice; these
// tests pin down the intended precedence and edge cases.

test('statusForFlag: complete always resolves', () => {
  assert.equal(statusForFlag('complete'), 'RESOLVED');
});

test('statusForFlag: flagged means in progress', () => {
  assert.equal(statusForFlag('flagged'), 'IN_PROGRESS');
});

test('statusForFlag: notFlagged/unknown/missing is not a signal', () => {
  assert.equal(statusForFlag('notFlagged'), null);
  assert.equal(statusForFlag(null), null);
  assert.equal(statusForFlag(undefined), null);
});

test('statusForCategories: Resolved category resolves', () => {
  assert.equal(statusForCategories(['Resolved']), 'RESOLVED');
});

test('statusForCategories: No Action Needed category ignores', () => {
  assert.equal(statusForCategories(['No Action Needed']), 'IGNORED');
});

test('statusForCategories: Resolved takes precedence if both are somehow applied', () => {
  assert.equal(statusForCategories(['No Action Needed', 'Resolved']), 'RESOLVED');
});

test('statusForCategories: matching is case-insensitive and trims whitespace', () => {
  assert.equal(statusForCategories(['RESOLVED']), 'RESOLVED');
  assert.equal(statusForCategories(['  Resolved  ']), 'RESOLVED');
  assert.equal(statusForCategories(['no action needed']), 'IGNORED');
});

test('statusForCategories: unrelated or empty categories are not a signal', () => {
  assert.equal(statusForCategories(['Blue Category']), null);
  assert.equal(statusForCategories([]), null);
  assert.equal(statusForCategories(null), null);
  assert.equal(statusForCategories(undefined), null);
});

test('statusForReply: customer-facing reply waits on customer', () => {
  assert.equal(statusForReply(true, 'NEW'), 'WAITING_ON_CUSTOMER');
});

test('statusForReply: internal-only reply is in progress', () => {
  assert.equal(statusForReply(false, 'NEW'), 'IN_PROGRESS');
});

test('statusForReply: never downgrades a more advanced status', () => {
  assert.equal(statusForReply(true, 'RESOLVED'), null);
  assert.equal(statusForReply(false, 'WAITING_ON_CUSTOMER'), null);
});

test('statusForMissingMessage: a confirmed-missing message resolves', () => {
  assert.equal(statusForMissingMessage(true), 'RESOLVED');
});

test('statusForMissingMessage: not confirmed missing is not a signal', () => {
  assert.equal(statusForMissingMessage(false), null);
  assert.equal(statusForMissingMessage(undefined), null);
});

test('statusForFolderMove: moved out of Inbox resolves', () => {
  assert.equal(statusForFolderMove(true), 'RESOLVED');
});

test('statusForFolderMove: still in Inbox is not a signal', () => {
  assert.equal(statusForFolderMove(false), null);
  assert.equal(statusForFolderMove(undefined), null);
});

test('statusForConfirmedSpam: non-spam categories are never a signal', () => {
  assert.equal(statusForConfirmedSpam('PRODUCT_ENQUIRY', 'ai', 0.99), null);
  assert.equal(statusForConfirmedSpam('INTERNAL', 'rules', 1), null);
});

test('statusForConfirmedSpam: rules/rules-fallback/manual are always trusted', () => {
  assert.equal(statusForConfirmedSpam('SPAM_NOTIFICATION', 'rules', 1), 'IGNORED');
  assert.equal(statusForConfirmedSpam('SPAM_NOTIFICATION', 'rules-fallback', null), 'IGNORED');
  assert.equal(statusForConfirmedSpam('SPAM_NOTIFICATION', 'manual', null), 'IGNORED');
});

test('statusForConfirmedSpam: AI spam is gated on confidence', () => {
  assert.equal(statusForConfirmedSpam('SPAM_NOTIFICATION', 'ai', 0.9), 'IGNORED');
  assert.equal(statusForConfirmedSpam('SPAM_NOTIFICATION', 'ai', 0.5), 'IGNORED');
});

test('statusForConfirmedSpam: low-confidence AI spam stays a signal-free NEW for review', () => {
  assert.equal(statusForConfirmedSpam('SPAM_NOTIFICATION', 'ai', 0.49), null);
  assert.equal(statusForConfirmedSpam('SPAM_NOTIFICATION', 'ai', null), null);
});
