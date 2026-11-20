'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEnvironment, makeJob, COMPLETE_HTML } = require('./gas-shim');

function setup(options = {}) {
  return createEnvironment({
    properties: { CODE_AGENT_ENABLED: 'true', GROQ_API_KEY: 'test-key', ...(options.properties || {}) },
    fetch: options.fetch,
    ownerEmail: options.ownerEmail
  });
}

function runSteps(env, file, maxSteps = 10) {
  let lastResult = null;
  for (let step = 0; step < maxSteps; step++) {
    const state = env.readState(file);
    if (state.nextAttemptAt) env.writeState(file, { ...state, nextAttemptAt: 0 });
    lastResult = env.context.processSingleJob_(file, Date.now());
    if (lastResult === 'DONE' || lastResult === 'WAIT') return lastResult;
  }
  return lastResult;
}

test('splitIntoChunks_ keeps every character and respects the chunk budget', () => {
  const env = setup();
  const text = Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n');
  const chunks = env.context.splitIntoChunks_(text);

  assert.ok(chunks.length > 1, 'expected the text to be split');
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0);
  }
});

test('extractHtml_ unwraps fenced and raw responses', () => {
  const env = setup();

  assert.equal(env.context.extractHtml_('```html\n<p>hi</p>\n```'), '<p>hi</p>');
  assert.equal(env.context.extractHtml_('```\n<p>hi</p>\n```'), '<p>hi</p>');
  assert.equal(env.context.extractHtml_('<p>hi</p>'), '<p>hi</p>');
});

test('isCompleteHtml_ requires a full document', () => {
  const env = setup();

  assert.equal(env.context.isCompleteHtml_(COMPLETE_HTML), true);
  assert.equal(env.context.isCompleteHtml_('<html><body>cut'), false);
  assert.equal(env.context.isCompleteHtml_(''), false);
});

test('initializeJobFromThread_ creates a v9 job and marks the thread read', () => {
  const env = setup();
  const thread = env.addThread({
    id: 'thread_1',
    messages: [{
      id: 'message_1',
      from: 'The User <user@example.com>',
      plainBody: 'Make it better',
      attachments: [{ name: 'index.html', contentType: 'text/html', content: '<html><body>old</body></html>' }]
    }]
  });

  assert.equal(env.context.initializeJobFromThread_(thread), true);

  const states = env.jobStates();
  assert.equal(states.length, 1);
  assert.equal(states[0].version, 9);
  assert.equal(states[0].recipientEmail, 'user@example.com');
  assert.equal(states[0].stage, 'SUMMARY');
  assert.equal(thread.read, true);
  assert.equal(env.replies.length, 1);
});

test('initializeJobFromThread_ skips a message that was already delivered', () => {
  const env = setup();
  env.context.rememberProcessedMessage_('message_1');
  const thread = env.addThread({
    id: 'thread_2',
    messages: [{ id: 'message_1', from: 'The User <user@example.com>', plainBody: 'Do it again' }]
  });

  assert.equal(env.context.initializeJobFromThread_(thread), true);
  assert.equal(env.jobStates().length, 0);
});

test('initializeJobFromThread_ falls back to the script owner when the sender is unreadable', () => {
  const env = setup({ ownerEmail: 'owner@example.com' });
  const thread = env.addThread({
    id: 'thread_3',
    messages: [{ id: 'message_3', from: '', plainBody: 'Build a page' }]
  });

  env.context.initializeJobFromThread_(thread);

  assert.equal(env.jobStates()[0].recipientEmail, 'owner@example.com');
});

test('the worker drives a job from PROCESS to a delivered result', () => {
  const env = setup({ fetch: () => ({ code: 200, body: { choices: [{ message: { content: `\`\`\`html\n${COMPLETE_HTML}\n\`\`\`` } }] } }) });
  const { file } = env.createJob(makeJob({ chunks: ['<html><body>draft</body></html>'] }));

  assert.equal(runSteps(env, file), 'DONE');

  assert.equal(env.sentEmails.length, 1);
  assert.equal(env.sentEmails[0].recipient, 'user@example.com');
  assert.match(env.sentEmails[0].subject, /job_test_1/);
  assert.equal(env.sentEmails[0].options.attachments.length, 1);
  assert.equal(env.jobFiles().length, 0, 'the job file should be trashed after delivery');
  assert.deepEqual(JSON.parse(env.properties.get('PROCESSED_MESSAGE_IDS')), ['message_1']);
});

test('a rate-limited model call retries inside the same stage', () => {
  const env = setup();
  const { file } = env.createJob(makeJob({ stage: 'PROCESS' }));

  const result = env.context.handleModelFailure_(file, env.readState(file), { rateLimited: true, errorMessage: '429' }, 'part 1');
  const state = env.readState(file);

  assert.equal(result, 'WAIT');
  assert.equal(state.stage, 'PROCESS');
  assert.equal(state.retryCount, 1);
  assert.ok(state.nextAttemptAt > Date.now());
});

test('an incomplete result never rewinds a non-finalize stage', () => {
  const env = setup();
  const { file } = env.createJob(makeJob({ stage: 'PROCESS' }));

  const result = env.context.handleModelFailure_(file, env.readState(file), { incomplete: true, errorMessage: 'truncated' }, 'part 1');
  const state = env.readState(file);

  assert.equal(result, 'PROCESSED');
  assert.equal(state.stage, 'FAILURE_PENDING');
  assert.match(state.failureReason, /truncated/);
});

test('an incomplete finalize retries in place', () => {
  const env = setup();
  const { file } = env.createJob(makeJob({ stage: 'FINALIZE', processedParts: [COMPLETE_HTML] }));

  const result = env.context.handleModelFailure_(file, env.readState(file), { incomplete: true, errorMessage: 'truncated' }, 'finalization');
  const state = env.readState(file);

  assert.equal(result, 'WAIT');
  assert.equal(state.stage, 'FINALIZE');
  assert.equal(state.finalizeRetryCount, 1);
});

test('failure notices reach the thread sender when recipientEmail is missing', () => {
  const env = setup({ ownerEmail: '' });
  env.addThread({ id: 'thread_1', messages: [{ id: 'message_1', from: 'The User <user@example.com>', plainBody: 'hi' }] });
  const { file } = env.createJob(makeJob({ stage: 'FAILURE_PENDING', recipientEmail: '', failureReason: 'Groq exploded' }));

  assert.equal(env.context.processSingleJob_(file, Date.now()), 'DONE');
  assert.equal(env.sentEmails.length, 1);
  assert.equal(env.sentEmails[0].recipient, 'user@example.com');
  assert.match(env.sentEmails[0].body, /Groq exploded/);
});

test('failure notices fall back to the script owner', () => {
  const env = setup({ ownerEmail: 'owner@example.com' });
  const { file } = env.createJob(makeJob({ stage: 'FAILURE_PENDING', recipientEmail: '', threadId: 'gone', failureReason: 'boom' }));

  assert.equal(env.context.processSingleJob_(file, Date.now()), 'DONE');
  assert.equal(env.sentEmails[0].recipient, 'owner@example.com');
});

test('a failure notice is never routed to an unrelated thread participant', () => {
  const env = setup({ ownerEmail: 'owner@example.com' });
  env.addThread({
    id: 'thread_1',
    messages: [
      { id: 'message_original', from: 'The User <user@example.com>', plainBody: 'hi' },
      { id: 'message_forwarded', from: 'Someone Else <else@example.com>', plainBody: 'fwd' }
    ]
  });
  const { file } = env.createJob(makeJob({
    stage: 'FAILURE_PENDING',
    recipientEmail: '',
    messageId: 'message_missing',
    failureReason: 'boom'
  }));

  assert.equal(env.context.processSingleJob_(file, Date.now()), 'DONE');
  assert.equal(env.sentEmails[0].recipient, 'owner@example.com');
});

test('a failure notice with no reachable recipient is retried, not lost', () => {
  const env = setup({ ownerEmail: '' });
  const { file } = env.createJob(makeJob({ stage: 'FAILURE_PENDING', recipientEmail: '', threadId: 'gone', failureReason: 'boom' }));

  assert.equal(env.context.processSingleJob_(file, Date.now()), 'WAIT');

  const state = env.readState(file);
  assert.equal(state.stage, 'FAILURE_PENDING');
  assert.equal(state.failureAttempts, 1);
  assert.match(state.deliveryError, /No recipient/);
  assert.equal(env.jobFiles().length, 1, 'the job must stay queued for a later retry');
  assert.equal(env.sentEmails.length, 0);
});

test('a delivered failure also records the message so it cannot be re-queued', () => {
  const env = setup({ ownerEmail: 'owner@example.com' });
  const { file } = env.createJob(makeJob({ stage: 'FAILURE_PENDING', recipientEmail: '', threadId: 'gone', failureReason: 'boom' }));

  assert.equal(env.context.processSingleJob_(file, Date.now()), 'DONE');
  assert.deepEqual(JSON.parse(env.properties.get('PROCESSED_MESSAGE_IDS')), ['message_1']);
});

test('a Gmail quota error pauses delivery and keeps the job', () => {
  const env = setup();
  env.context.GmailApp.sendEmail = () => { throw new Error('Service invoked too many times for one day: email.'); };
  const resultFile = env.context.DriveApp.createFile('preview.html', COMPLETE_HTML, 'text/html');
  const { file } = env.createJob(makeJob({ stage: 'SEND_RESULT', resultFileId: resultFile.getId(), resultFileName: 'preview.html' }));

  assert.equal(env.context.processSingleJob_(file, Date.now()), 'WAIT');

  const state = env.readState(file);
  assert.equal(state.stage, 'SEND_RESULT');
  assert.equal(state.deliveryAttempts, 1);
  assert.ok(Number(env.properties.get('GMAIL_QUOTA_PAUSED_UNTIL')) > Date.now());
  assert.equal(env.jobFiles().length, 1);
});

test('missing result files are retried before a job is marked orphaned', () => {
  const env = setup({ ownerEmail: 'owner@example.com' });
  const { file } = env.createJob(makeJob({ stage: 'SEND_RESULT', resultFileId: 'missing_file', resultFileName: 'gone.html' }));

  assert.equal(env.context.processSingleJob_(file, Date.now()), 'WAIT');
  assert.equal(env.readState(file).resultLookupFailures, 1);

  env.writeState(file, { ...env.readState(file), nextAttemptAt: 0 });
  assert.equal(env.context.processSingleJob_(file, Date.now()), 'WAIT');
  assert.equal(env.readState(file).resultLookupFailures, 2);

  env.writeState(file, { ...env.readState(file), nextAttemptAt: 0 });
  assert.equal(env.context.processSingleJob_(file, Date.now()), 'PROCESSED');
  assert.equal(env.readState(file).stage, 'ORPHANED_RESULT');

  env.writeState(file, { ...env.readState(file), nextAttemptAt: 0 });
  assert.equal(env.context.processSingleJob_(file, Date.now()), 'PROCESSED');
  assert.equal(env.readState(file).stage, 'FAILURE_PENDING');

  assert.equal(runSteps(env, file), 'DONE');
  assert.equal(env.sentEmails.length, 1);
  assert.equal(env.sentEmails[0].recipient, 'user@example.com');
  assert.match(env.sentEmails[0].body, /could not be read/);
});

test('recoverStuckJobs requeues orphaned results for another lookup', () => {
  const env = setup();
  const { file } = env.createJob(makeJob({ stage: 'ORPHANED_RESULT', resultFileId: 'missing_file', resultLookupFailures: 3 }));

  env.context.recoverStuckJobs();

  const state = env.readState(file);
  assert.equal(state.stage, 'SEND_RESULT');
  assert.equal(state.resultLookupFailures, 0);
  assert.ok(state.nextAttemptAt > 0, 'the job must be runnable immediately');
});

test('an expired Gmail pause is cleared automatically', () => {
  const env = setup();
  env.properties.set('GMAIL_QUOTA_PAUSED_UNTIL', String(Date.now() - 1000));

  assert.equal(env.context.gmailQuotaPauseActive_(), false);
  assert.equal(env.properties.has('GMAIL_QUOTA_PAUSED_UNTIL'), false);
});

test('only unfinished stages expire', () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const env = setup();

  assert.equal(env.context.isJobExpired_(makeJob({ stage: 'PROCESS', createdAt: old })), true);
  assert.equal(env.context.isJobExpired_(makeJob({ stage: 'SUMMARY', createdAt: old })), true);
  assert.equal(env.context.isJobExpired_(makeJob({ stage: 'SEND_RESULT', createdAt: old })), false);
  assert.equal(env.context.isJobExpired_(makeJob({ stage: 'PROCESS', createdAt: new Date().toISOString() })), false);
});

test('an expired job becomes a delivered failure instead of staying queued', () => {
  const env = setup();
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const { file } = env.createJob(makeJob({ stage: 'PROCESS', createdAt: old }));

  assert.equal(env.context.processSingleJob_(file, Date.now()), 'PROCESSED');
  assert.equal(env.readState(file).stage, 'FAILURE_PENDING');
  assert.match(env.readState(file).failureReason, /queue lifetime/);
});

test('the processed message registry is capped', () => {
  const env = setup();
  for (let index = 0; index < 150; index++) env.context.rememberProcessedMessage_(`message_${index}`);

  const tracked = JSON.parse(env.properties.get('PROCESSED_MESSAGE_IDS'));
  assert.equal(tracked.length, env.eval('CONFIG.MAX_TRACKED_MESSAGES'));
  assert.equal(tracked[tracked.length - 1], 'message_149');
});

test('inspectQueuedJobs reports delivery diagnostics', () => {
  const env = setup();
  env.createJob(makeJob({ stage: 'SEND_RESULT', resultLookupFailures: 2, deliveryError: 'nope' }));

  const jobs = env.context.inspectQueuedJobs();

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, 'job_test_1');
  assert.equal(jobs[0].stage, 'SEND_RESULT');
  assert.equal(jobs[0].resultLookupFailures, 2);
  assert.equal(jobs[0].deliveryError, 'nope');
});
