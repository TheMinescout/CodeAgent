/**
 * =============================================================================
 * CodeAgent v7 — Google Apps Script
 * =============================================================================
 *
 * Gmail -> persistent Drive queue -> Groq coding agent -> HTML preview
 *
 * v5 focuses on reliability:
 *   - SAFE BY DEFAULT: disabled until enableCodeAgent() is run.
 *   - Exactly TWO stable managed triggers when enabled:
 *       1) processCodeEmails — Gmail intake every 5 minutes.
 *       2) resumeJobs       — queue worker every 1 minute.
 *   - No one-shot worker triggers. This removes the "job exists but worker
 *     trigger disappeared" failure seen in v4.
 *   - Gmail and worker responsibilities are completely separated.
 *   - Gmail quota errors pause Gmail work without stopping Drive/Groq work.
 *   - Jobs are deduplicated by thread/message ID, even if a Gmail message stays
 *     unread because Gmail quota prevented markRead().
 *   - Job state is persisted before every state transition.
 *   - One meaningful job step is processed per worker execution.
 *   - Groq rate limiting is handled through persistent nextAttemptAt timestamps;
 *     the script never sleeps for 60+ seconds inside an execution.
 *   - Completed HTML artifacts are preserved until Gmail delivery succeeds.
 *   - Stuck jobs can be manually recovered without deleting the generated file.
 *   - GitHub and Slack remain thin adapters over the same normalized job queue.
 *
 * IMPORTANT
 *   Replace your current CodeAgent code with this file. Run initializeCodeAgent()
 *   first, then enableCodeAgent(). Existing Drive jobs are preserved.
 * =============================================================================
 */

const CONFIG = Object.freeze({
  ENABLE_PROPERTY: 'CODE_AGENT_ENABLED',
  GROQ_KEY_PROPERTY: 'GROQ_API_KEY',
  WEB_APP_URL_PROPERTY: 'WEB_APP_URL',

  // Future integration properties.
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN',
  GITHUB_OWNER_PROPERTY: 'GITHUB_OWNER',
  GITHUB_REPO_PROPERTY: 'GITHUB_REPO',
  SLACK_WEBHOOK_PROPERTY: 'SLACK_WEBHOOK_URL',

  API_URL: 'https://api.groq.com/openai/v1/chat/completions',
  GROQ_MODEL: 'openai/gpt-oss-120b',

  // Conservative 8k TPM budgeting.
  TPM_LIMIT: 8000,
  CHARS_PER_TOKEN_ESTIMATE: 2.5,
  PROMPT_OVERHEAD_TOKENS: 650,
  OUTPUT_RESERVE_TOKENS: 1800,

  // The worker never sleeps; these become persistent timestamps instead.
  GROQ_BACKOFF_MS: 75 * 1000,
  MAX_RETRIES: 3,

  // Stable trigger cadence.
  POLL_MINUTES: 5,
  WORKER_MINUTES: 1,

  // Gmail daily/service quota failures can last for many hours.
  GMAIL_QUOTA_PAUSE_MS: 12 * 60 * 60 * 1000,

  // Execution guard. One queue step per execution normally finishes far below this.
  MAX_EXECUTION_TIME_MS: 4 * 60 * 1000,

  MAX_TOTAL_INPUT_CHARS: 400000,
  MAX_SOURCE_SUMMARY_CHARS: 2200,
  MIN_SPLIT_CHARS: 300,
  JOB_FOLDER_NAME: 'CodeAgent_Jobs',
  LOCK_WAIT_MS: 5000,
  MANAGED_TRIGGER_NAMES: ['processCodeEmails', 'resumeJobs']
});

// -----------------------------------------------------------------------------
// 1. Properties / configuration
// -----------------------------------------------------------------------------

function getScriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function isCodeAgentEnabled_() {
  return getScriptProperties_().getProperty(CONFIG.ENABLE_PROPERTY) === 'true';
}

function getGroqApiKey_() {
  return getScriptProperties_().getProperty(CONFIG.GROQ_KEY_PROPERTY) || '';
}

function getWebAppUrl_() {
  return getScriptProperties_().getProperty(CONFIG.WEB_APP_URL_PROPERTY) || '';
}

function getChunkCharBudget_() {
  return Math.max(
    4000,
    Math.floor(
      (CONFIG.TPM_LIMIT - CONFIG.PROMPT_OVERHEAD_TOKENS - CONFIG.OUTPUT_RESERVE_TOKENS) *
      CONFIG.CHARS_PER_TOKEN_ESTIMATE
    )
  );
}

// -----------------------------------------------------------------------------
// 2. Master controls
// -----------------------------------------------------------------------------

/**
 * Leaves the agent safely disabled and removes both managed triggers.
 * Existing Drive jobs are NOT deleted.
 */
function disableCodeAgent() {
  const props = getScriptProperties_();
  props.setProperty(CONFIG.ENABLE_PROPERTY, 'false');
  deleteManagedTriggers_();
  console.log('CodeAgent DISABLED. Existing Drive jobs were preserved.');
}

/**
 * Safely initializes the project without enabling it.
 */
function initializeCodeAgent() {
  const props = getScriptProperties_();
  if (!props.getProperty(CONFIG.ENABLE_PROPERTY)) {
    props.setProperty(CONFIG.ENABLE_PROPERTY, 'false');
  }
  deleteManagedTriggers_();
  console.log('Initialized safely. CodeAgent remains DISABLED. Existing jobs were preserved.');
}

/**
 * Enables CodeAgent and creates exactly one Gmail trigger and one worker trigger.
 */
function enableCodeAgent() {
  if (!getGroqApiKey_()) {
    throw new Error(
      'Missing GROQ_API_KEY. Add it under Project Settings > Script properties before enabling CodeAgent.'
    );
  }

  const props = getScriptProperties_();
  props.setProperty(CONFIG.ENABLE_PROPERTY, 'true');

  // Do not clear a real Gmail pause automatically. If the user intentionally
  // wants to test/retry Gmail, use clearGmailPauseAndResume().
  deleteManagedTriggers_();
  createManagedTriggers_();

  console.log(
    `CodeAgent ENABLED. Gmail polling: every ${CONFIG.POLL_MINUTES} min. ` +
    `Worker: every ${CONFIG.WORKER_MINUTES} min.`
  );
}

function emergencyStop() {
  disableCodeAgent();
}

/**
 * Prints current status, including stable trigger counts and queued job count.
 */
function showCodeAgentStatus() {
  const props = getScriptProperties_();
  const triggers = ScriptApp.getProjectTriggers();
  const managed = triggers.filter(isManagedTrigger_).map(t => ({
    handler: t.getHandlerFunction(),
    type: String(t.getTriggerSource()),
    event: String(t.getEventType())
  }));

  console.log(JSON.stringify({
    enabled: isCodeAgentEnabled_(),
    hasGroqKey: !!getGroqApiKey_(),
    webAppConfigured: !!getWebAppUrl_(),
    gmailQuotaPausedUntil: props.getProperty('GMAIL_QUOTA_PAUSED_UNTIL') || null,
    lastGmailError: props.getProperty('LAST_GMAIL_ERROR') || null,
    queuedJobs: countQueuedJobs_(),
    managedTriggers: managed,
    expectedTriggers: {
      processCodeEmails: 1,
      resumeJobs: 1
    }
  }, null, 2));
}

/**
 * Optional manual helper for a single worker pass from the editor.
 * It does not create or delete triggers.
 */
function runWorkerOnce() {
  resumeJobs();
}

// -----------------------------------------------------------------------------
// 3. Web app preview endpoint
// -----------------------------------------------------------------------------

function doGet(e) {
  const id = e && e.parameter ? e.parameter.id : null;

  if (!id) {
    return HtmlService.createHtmlOutput('No preview ID provided.');
  }

  try {
    const file = DriveApp.getFileById(id);
    const htmlContent = file.getBlob().getDataAsString();

    return HtmlService
      .createHtmlOutput(htmlContent)
      .setTitle('Code Preview')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    console.error('doGet error:', err);
    return HtmlService.createHtmlOutput('Preview expired or not found.');
  }
}

// -----------------------------------------------------------------------------
// 4. Stable Gmail intake trigger
// -----------------------------------------------------------------------------

function processCodeEmails() {
  if (!isCodeAgentEnabled_()) {
    console.log('CodeAgent disabled; processCodeEmails exiting before Gmail access.');
    return;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    console.log('Another CodeAgent execution holds the lock. Gmail intake skipped.');
    return;
  }

  try {
    // Self-heal the trigger pair without ever processing jobs here.
    ensureManagedTriggers_();

    // A previous daily/service Gmail quota error should prevent Gmail calls.
    if (gmailQuotaPauseActive_()) {
      console.log('Gmail quota pause active; skipping Gmail intake this cycle.');
      return;
    }

    pollGmailForNewJobs_();
  } finally {
    lock.releaseLock();
  }
}

function pollGmailForNewJobs_() {
  try {
    const threads = GmailApp.search('label:CodeAgent is:unread', 0, 5);
    console.log(`Gmail polling found ${threads.length} candidate thread(s).`);

    // One new job per poll keeps Gmail usage controlled.
    for (const thread of threads) {
      if (initializeJobFromThread_(thread)) {
        return;
      }
    }
  } catch (err) {
    if (isGmailQuotaError_(err)) {
      pauseGmailAfterQuotaError_(err);
      console.error('Gmail quota/service limit reached. Gmail intake paused.');
      return;
    }

    console.error('Gmail polling failed:', err);
  }
}

// -----------------------------------------------------------------------------
// 5. Job creation + deduplication
// -----------------------------------------------------------------------------

function initializeJobFromThread_(thread) {
  let latestMessage;

  try {
    const messages = thread.getMessages();
    if (!messages || !messages.length) {
      return false;
    }

    latestMessage = messages[messages.length - 1];

    // IMPORTANT: if quota prevented markRead on a prior run, this prevents
    // duplicate job creation from the same Gmail message.
    const existing = findJobByMessage_(thread.getId(), latestMessage.getId());
    if (existing) {
      markThreadReadSafely_(thread);
      console.log(`Existing job ${existing.jobId} found for message; skipping duplicate creation.`);
      return true;
    }

    const instruction = (latestMessage.getPlainBody() || '').trim();
    const sourceText = collectSourceText_(latestMessage);

    if (!sourceText && !instruction) {
      try {
        latestMessage.reply('🤖 No instructions or file content found to process.');
      } catch (err) {
        if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err);
      }
      markThreadReadSafely_(thread);
      return true;
    }

    const chunks = splitIntoChunks_(sourceText);
    const state = {
      version: 5,
      jobId: `job_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      threadId: thread.getId(),
      messageId: latestMessage.getId(),
      recipientEmail: extractEmailAddress_(latestMessage.getFrom()),
      instruction,
      sourceText,
      fileSummary: sourceText ? 'Summary not generated yet.' : 'New file request.',
      chunks,
      processedParts: [],
      currentIndex: 0,
      stage: sourceText ? 'SUMMARY' : 'PROCESS',
      isChunked: chunks.length > 1,
      retryCount: 0,
      nextAttemptAt: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const folder = getOrCreateJobFolder_();
    const file = folder.createFile(
      `${state.jobId}.json`,
      JSON.stringify(state),
      MimeType.PLAIN_TEXT
    );

    // Acknowledge only after durable job creation.
    try {
      latestMessage.reply(
        state.isChunked
          ? `⚡ CodeAgent accepted your request as ${state.jobId} and queued it across ${chunks.length} persisted parts.`
          : `⚡ CodeAgent accepted your request as ${state.jobId} and queued it for processing.`
      );
    } catch (replyError) {
      if (isGmailQuotaError_(replyError)) {
        pauseGmailAfterQuotaError_(replyError);
      } else {
        console.error('Acknowledgement email failed:', replyError);
      }
    }

    // Best effort; dedupe protects us if quota prevents this operation.
    markThreadReadSafely_(thread);

    console.log(`Created job ${state.jobId}: ${file.getId()}`);
    return true;
  } catch (err) {
    if (isGmailQuotaError_(err)) {
      pauseGmailAfterQuotaError_(err);
      return false;
    }

    console.error('Job initialization failed:', err);
    return false;
  }
}

function findJobByMessage_(threadId, messageId) {
  const folder = getOrCreateJobFolder_();
  const files = folder.getFilesByType(MimeType.PLAIN_TEXT);

  while (files.hasNext()) {
    const file = files.next();
    try {
      const state = JSON.parse(file.getBlob().getDataAsString());
      if (state.threadId === threadId && state.messageId === messageId) {
        return state;
      }
    } catch (_) {
      // Ignore unreadable job files here; the worker will report/clean them.
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// 6. Stable worker trigger
// -----------------------------------------------------------------------------

/**
 * Stable worker: every minute, one job step at a time.
 * This replaces the fragile one-shot trigger architecture from v3/v4.
 */
function resumeJobs() {
  if (!isCodeAgentEnabled_()) {
    console.log('CodeAgent disabled; worker exiting.');
    return;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    console.log('Another CodeAgent execution holds the lock. Worker skipped.');
    return;
  }

  try {
    // Worker is allowed to self-heal the trigger pair.
    ensureManagedTriggers_();

    const startTime = Date.now();
    processPendingJobs_(startTime);
  } finally {
    lock.releaseLock();
  }
}

function processPendingJobs_(startTime) {
  const folder = getOrCreateJobFolder_();
  const files = folder.getFilesByType(MimeType.PLAIN_TEXT);

  // Process at most ONE meaningful job step per worker execution.
  // If the first job is waiting on a future retry/delivery, keep scanning so
  // one blocked job cannot starve every other queued job behind it.
  while (files.hasNext()) {
    if (hasTimedOut_(startTime)) {
      return;
    }

    const file = files.next();
    const result = processSingleJob_(file, startTime);

    if (result === 'DONE') {
      return;
    }

    // WAIT / PROCESSED means this particular job should not consume another
    // step during this execution. Continue scanning for another ready job.
  }
}

function processSingleJob_(file, startTime) {
  let state;

  try {
    state = JSON.parse(file.getBlob().getDataAsString());
  } catch (err) {
    console.error(`Corrupted job ${file.getName()}; moving it to trash.`, err);
    file.setTrashed(true);
    return 'DONE';
  }

  if (state.nextAttemptAt && Date.now() < Number(state.nextAttemptAt)) {
    return 'WAIT';
  }

  // ----------------------------- SUMMARY -----------------------------
  if (state.stage === 'SUMMARY') {
    if (hasTimedOut_(startTime)) return 'WAIT';

    const result = summarizeFilePurpose_(state.sourceText || '');
    if (!result.ok) {
      return handleModelFailure_(file, state, result, 'summary');
    }

    state.fileSummary = (result.generatedText || '').trim() || 'No summary available.';
    state.stage = 'PROCESS';
    state.retryCount = 0;
    state.nextAttemptAt = Date.now() + 10000;
    saveState_(file, state);
    return 'PROCESSED';
  }

  // ----------------------------- PROCESS -----------------------------
  if (state.stage === 'PROCESS') {
    if (state.currentIndex >= state.chunks.length) {
      state.stage = 'FINALIZE';
      state.nextAttemptAt = Date.now();
      saveState_(file, state);
      return 'PROCESSED';
    }

    if (hasTimedOut_(startTime)) return 'WAIT';

    const index = state.currentIndex;
    const result = processChunk_({
      instruction: state.instruction,
      fileSummary: state.fileSummary,
      chunk: state.chunks[index],
      chunkIndex: index,
      totalChunks: state.chunks.length
    });

    if (!result.ok) {
      return handleChunkFailure_(file, state, result, index);
    }

    const generated = extractHtml_(result.generatedText || '').trim();
    if (!generated) {
      return stageFailureForDelivery_(file, state, `The model returned an empty result for part ${index + 1}.`);
    }

    state.processedParts.push(generated);
    state.currentIndex += 1;
    state.retryCount = 0;
    state.nextAttemptAt = Date.now() + (state.currentIndex < state.chunks.length ? CONFIG.GROQ_BACKOFF_MS : 10000);
    state.stage = state.currentIndex >= state.chunks.length ? 'FINALIZE' : 'PROCESS';
    saveState_(file, state);
    return 'PROCESSED';
  }

  // ----------------------------- FINALIZE -----------------------------
  if (state.stage === 'FINALIZE') {
    if (hasTimedOut_(startTime)) return 'WAIT';

    const result = finalizeJob_(state);

    if (!result.ok) {
      return handleModelFailure_(file, state, result, 'finalization');
    }

    let htmlFile;
    try {
      htmlFile = DriveApp.createFile(
        `CodePreview_${Date.now()}.html`,
        result.html,
        MimeType.HTML
      );
    } catch (err) {
      state.stage = 'RETRY_DRIVE';
      state.deliveryError = `Could not save result to Drive: ${err}`;
      state.nextAttemptAt = Date.now() + 60000;
      saveState_(file, state);
      return 'WAIT';
    }

    const previewUrl = makePreviewUrl_(htmlFile);

    state.stage = 'SEND_RESULT';
    state.resultFileId = htmlFile.getId();
    state.resultFileName = htmlFile.getName();
    state.previewUrl = previewUrl;
    state.nextAttemptAt = Date.now();
    state.deliveryAttempts = Number(state.deliveryAttempts || 0);
    saveState_(file, state);
    return 'PROCESSED';
  }

  // ----------------------------- RETRY_DRIVE -----------------------------
  if (state.stage === 'RETRY_DRIVE') {
    state.stage = 'FINALIZE';
    state.nextAttemptAt = Date.now();
    saveState_(file, state);
    return 'PROCESSED';
  }

  // ----------------------------- SEND_RESULT -----------------------------
  if (state.stage === 'SEND_RESULT') {
    if (gmailQuotaPauseActive_()) {
      const pausedUntil = getScriptProperties_().getProperty('GMAIL_QUOTA_PAUSED_UNTIL');
      console.warn(
        `Job ${state.jobId}: Gmail delivery paused until ${pausedUntil}.`
      );
      return 'WAIT';
    }

    // The recipient is captured when the job is created. Prefer a direct
    // recipient send for completion delivery rather than depending on the
    // original Gmail thread/message still being retrievable.
    const recipient = String(state.recipientEmail || '').trim();

    if (!recipient) {
      state.deliveryAttempts = Number(state.deliveryAttempts || 0) + 1;
      state.deliveryError = 'No recipientEmail is stored for this job.';
      state.nextAttemptAt = Date.now() + 10 * 60 * 1000;
      saveState_(file, state);
      console.error(`Job ${state.jobId}: ${state.deliveryError}`);
      return 'WAIT';
    }

    let htmlFile;
    try {
      htmlFile = DriveApp.getFileById(state.resultFileId);
    } catch (err) {
      state.deliveryError =
        `Result file ${state.resultFileId} could not be found: ${err}`;
      state.stage = 'ORPHANED_RESULT';
      saveState_(file, state);
      console.error(`Job ${state.jobId}: ${state.deliveryError}`);
      return 'WAIT';
    }

    try {
      const finalHtml = htmlFile.getBlob().getDataAsString();
      const previewUrl = state.previewUrl || htmlFile.getUrl();

      const emailSubject = `CodeAgent result — ${state.jobId}`;

      const plainBody =
        `Your CodeAgent job ${state.jobId} is complete.\n\n` +
        `Open the live preview:\n${previewUrl}\n\n` +
        `The completed HTML file is attached.`;

      const emailOptions = {
        htmlBody: buildEmailBody_(
          previewUrl,
          state.isChunked,
          state.chunks.length,
          state.jobId
        ),
        attachments: [
          Utilities.newBlob(
            finalHtml,
            MimeType.HTML,
            state.resultFileName || 'CodeAgent_result.html'
          )
        ]
      };

      console.log(
        `Job ${state.jobId}: sending completion email directly to ${recipient}`
      );

      GmailApp.sendEmail(
        recipient,
        emailSubject,
        plainBody,
        emailOptions
      );

      console.log(
        `Job ${state.jobId}: completion email successfully sent to ${recipient}`
      );

      file.setTrashed(true);
      return 'DONE';

    } catch (err) {
      state.deliveryAttempts = Number(state.deliveryAttempts || 0) + 1;
      state.deliveryError = String(err);

      if (isGmailQuotaError_(err)) {
        pauseGmailAfterQuotaError_(err);
        state.nextAttemptAt =
          Date.now() + CONFIG.GMAIL_QUOTA_PAUSE_MS;
      } else {
        state.nextAttemptAt =
          Date.now() +
          Math.min(
            60 * 60 * 1000,
            Math.max(60000, state.deliveryAttempts * 60000)
          );
      }

      saveState_(file, state);

      console.error(
        `Job ${state.jobId}: completion email failed:`,
        err
      );

      return 'WAIT';
    }
  }

  // ----------------------------- FAILURE_PENDING -----------------------------
  if (state.stage === 'FAILURE_PENDING') {
    return processFailurePending_(file, state);
  }

  // ----------------------------- ORPHANED_RESULT -----------------------------
  if (state.stage === 'ORPHANED_RESULT') {
    // Preserve the job and artifact. Manual recovery can inspect it.
    return 'WAIT';
  }

  // Unknown stage.
  return stageFailureForDelivery_(
    file,
    state,
    `Unknown job stage: ${state.stage}`
  );
}

// -----------------------------------------------------------------------------
// 7. Failure / retry handling
// -----------------------------------------------------------------------------

function handleChunkFailure_(file, state, result, index) {
  if (result.needsSplit && state.chunks[index].length > CONFIG.MIN_SPLIT_CHARS) {
    const text = state.chunks[index];
    const midpoint = Math.floor(text.length / 2);
    let splitIndex = text.lastIndexOf('\n', midpoint);

    if (splitIndex < text.length * 0.25 || splitIndex > text.length * 0.75) {
      splitIndex = midpoint;
    }

    const partA = text.substring(0, splitIndex).trim();
    const partB = text.substring(splitIndex).trim();

    if (partA && partB) {
      state.chunks.splice(index, 1, partA, partB);
      state.retryCount = 0;
      state.nextAttemptAt = Date.now() + CONFIG.GROQ_BACKOFF_MS;
      saveState_(file, state);
      return 'WAIT';
    }
  }

  return handleModelFailure_(file, state, result, `part ${index + 1}`);
}

function handleModelFailure_(file, state, result, stageName) {
  if (result.rateLimited && Number(state.retryCount || 0) < CONFIG.MAX_RETRIES) {
    state.retryCount = Number(state.retryCount || 0) + 1;
    state.nextAttemptAt = Date.now() + CONFIG.GROQ_BACKOFF_MS;
    state.deliveryError = result.errorMessage;
    saveState_(file, state);
    return 'WAIT';
  }

  return stageFailureForDelivery(
    file,
    state,
    `CodeAgent stopped during ${stageName}: ${result.errorMessage}`
  );
}

function stageFailureForDelivery_(file, state, reason) {
  state.stage = 'FAILURE_PENDING';
  state.failureReason = reason;
  state.nextAttemptAt = Date.now();
  saveState_(file, state);
  return 'PROCESSED';
}

// Backward-compatible alias for any old manually saved job code or debugging.
function stageFailureForDelivery(file, state, reason) {
  return stageFailureForDelivery_(file, state, reason);
}

// ----------------------------- FAILURE_PENDING -----------------------------

function processFailurePending_(file, state) {
  if (gmailQuotaPauseActive_()) return 'WAIT';

  const message = loadOriginalMessageForJob_(state);
  if (!message) {
    state.nextAttemptAt = Date.now() + 5 * 60 * 1000;
    saveState_(file, state);
    return 'WAIT';
  }

  try {
    sendFailureReply_(message, state, state.failureReason || 'CodeAgent failed without a recorded reason.');
    file.setTrashed(true);
    return 'DONE';
  } catch (err) {
    if (isGmailQuotaError_(err)) {
      pauseGmailAfterQuotaError_(err);
    }
    state.nextAttemptAt = Date.now() + CONFIG.GMAIL_QUOTA_PAUSE_MS;
    saveState_(file, state);
    return 'WAIT';
  }
}

// Patch handler for FAILURE_PENDING without adding Gmail work to other stages.
// Kept as a separate function so the state machine stays readable.
function handleFailurePendingIfNeeded_(file, state) {
  if (state.stage !== 'FAILURE_PENDING') return null;
  return processFailurePending_(file, state);
}

// -----------------------------------------------------------------------------
// 8. Source parsing / chunking
// -----------------------------------------------------------------------------

function collectSourceText_(msg) {
  let text = '';
  let attachments;

  try {
    attachments = msg.getAttachments({
      includeInlineImages: false,
      includeAttachments: true
    });
  } catch (_) {
    attachments = msg.getAttachments();
  }

  for (const att of attachments) {
    const name = att.getName() || 'attachment';
    const type = (att.getContentType() || '').toLowerCase();
    const textLike =
      type.indexOf('text/') === 0 ||
      /\.(js|jsx|mjs|cjs|ts|tsx|html|htm|css|scss|json|md|txt|xml|svg|vue|svelte)$/i.test(name);

    if (!textLike) continue;

    text += `\n\n/* --- Attached File: ${name} --- */\n${att.getDataAsString()}`;

    if (text.length >= CONFIG.MAX_TOTAL_INPUT_CHARS) {
      text = text.substring(0, CONFIG.MAX_TOTAL_INPUT_CHARS) +
        '\n\n/* --- INPUT TRUNCATED: MAX_TOTAL_INPUT_CHARS reached --- */';
      break;
    }
  }

  return text.trim();
}

function splitIntoChunks_(text) {
  if (!text) return [''];

  const budget = getChunkCharBudget_();
  if (text.length <= budget) return [text];

  const chunks = [];
  let remaining = text;
  const patterns = [
    /\n\s*\n/g,
    /<\/[a-zA-Z0-9:-]+>\s*\n/g,
    /}\s*\n/g,
    /;\s*\n/g,
    /\n/g
  ];

  while (remaining.length > budget) {
    const window = remaining.substring(0, budget);
    let splitAt = -1;

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      let lastMatchEnd = -1;
      while ((match = pattern.exec(window)) !== null) {
        lastMatchEnd = match.index + match[0].length;
      }
      if (lastMatchEnd >= budget * 0.55) {
        splitAt = lastMatchEnd;
        break;
      }
    }

    if (splitAt < 1) splitAt = budget;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }

  if (remaining.length) chunks.push(remaining);
  return chunks;
}

// -----------------------------------------------------------------------------
// 9. Groq API
// -----------------------------------------------------------------------------

function summarizeFilePurpose_(text) {
  const preview = text.length > CONFIG.MAX_SOURCE_SUMMARY_CHARS
    ? text.substring(0, CONFIG.MAX_SOURCE_SUMMARY_CHARS) + '\n...[truncated]'
    : text;

  return callGroq_({
    model: CONFIG.GROQ_MODEL,
    max_completion_tokens: 300,
    messages: [
      {
        role: 'system',
        content:
          'Summarize this source code architecture and purpose in 2-3 concise sentences. ' +
          'Focus on major components, data flow, important APIs, and naming conventions. Do not rewrite code.'
      },
      { role: 'user', content: preview }
    ]
  });
}

function processChunk_({ instruction, fileSummary, chunk, chunkIndex, totalChunks }) {
  const positionNote = totalChunks > 1
    ? `This is part ${chunkIndex + 1} of ${totalChunks} of a larger source file.\n` +
      `Global context: ${fileSummary}\n\n` +
      `Apply the user's instruction to THIS SECTION. Preserve existing names, APIs, ` +
      `conventions, and working logic. Do not add document wrappers unless this section already has them.\n\n`
    : '';

  const outputInstruction = totalChunks === 1
    ? 'Return the complete corrected solution inside one ```html code block. Make it a runnable standalone HTML file. If React is needed, use browser CDN imports.'
    : 'Return only the transformed source fragment for this section inside one ```html code block. Do not add commentary.';

  const prompt =
    `${positionNote}` +
    `USER INSTRUCTION:\n${instruction || '(Repair the supplied code while preserving its intended behavior.)'}\n\n` +
    `SOURCE SECTION:\n${chunk}\n\n` +
    outputInstruction;

  return callGroq_({
    model: CONFIG.GROQ_MODEL,
    max_completion_tokens: CONFIG.OUTPUT_RESERVE_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          'You are an expert full-stack web developer and code repair agent. ' +
          'Preserve working functionality. Make targeted corrections. Do not remove features for convenience.'
      },
      { role: 'user', content: prompt }
    ]
  });
}

function callGroq_(payload) {
  const apiKey = getGroqApiKey_();
  if (!apiKey) {
    return {
      ok: false,
      needsSplit: false,
      rateLimited: false,
      errorMessage: 'GROQ_API_KEY is missing.'
    };
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify(payload)
  };

  let response;
  try {
    response = UrlFetchApp.fetch(CONFIG.API_URL, options);
  } catch (err) {
    return {
      ok: false,
      needsSplit: false,
      rateLimited: false,
      errorMessage: `Network call failed: ${err}`
    };
  }

  const code = response.getResponseCode();
  let data;

  try {
    data = JSON.parse(response.getContentText());
  } catch (_) {
    return {
      ok: false,
      needsSplit: false,
      rateLimited: false,
      errorMessage: `Unparseable Groq response (HTTP ${code}).`
    };
  }

  const rawError = data && data.error && data.error.message
    ? String(data.error.message)
    : '';
  const errorMessage = rawError.toLowerCase();

  if (code === 429) {
    return {
      ok: false,
      needsSplit: false,
      rateLimited: true,
      errorMessage: rawError || 'Groq rate limit reached.'
    };
  }

  if (
    (code === 400 || code === 413) &&
    /(large|limit|token|context|length)/i.test(errorMessage)
  ) {
    return {
      ok: false,
      needsSplit: true,
      rateLimited: false,
      errorMessage: rawError || `Groq rejected the request as too large (HTTP ${code}).`
    };
  }

  if (code >= 500 && code <= 599) {
    return {
      ok: false,
      needsSplit: false,
      rateLimited: true,
      errorMessage: rawError || `Groq server error (HTTP ${code}).`
    };
  }

  if (data && data.error) {
    return {
      ok: false,
      needsSplit: false,
      rateLimited: false,
      errorMessage: rawError || `Groq API error (HTTP ${code}).`
    };
  }

  if (code < 200 || code >= 300) {
    return {
      ok: false,
      needsSplit: false,
      rateLimited: false,
      errorMessage: `Groq request failed with HTTP ${code}.`
    };
  }

  const content = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;

  if (typeof content !== 'string') {
    return {
      ok: false,
      needsSplit: false,
      rateLimited: false,
      errorMessage: 'Groq returned no assistant content.'
    };
  }

  return { ok: true, generatedText: content };
}

// -----------------------------------------------------------------------------
// 10. Finalization
// -----------------------------------------------------------------------------

function finalizeJob_(state) {
  const combined = (state.processedParts || []).join('\n\n');

  if (!state.isChunked) {
    const html = extractHtml_(state.processedParts[0] || combined);
    return html
      ? { ok: true, html }
      : { ok: false, rateLimited: false, errorMessage: 'No valid generated HTML was returned.' };
  }

  const estimatedTokens = Math.ceil(combined.length / CONFIG.CHARS_PER_TOKEN_ESTIMATE);
  const canAffordMerge =
    estimatedTokens + CONFIG.PROMPT_OVERHEAD_TOKENS + CONFIG.OUTPUT_RESERVE_TOKENS <= CONFIG.TPM_LIMIT;

  if (canAffordMerge) {
    const result = callGroq_({
      model: CONFIG.GROQ_MODEL,
      max_completion_tokens: CONFIG.OUTPUT_RESERVE_TOKENS,
      messages: [
        {
          role: 'system',
          content:
            'Merge these transformed fragments into one cohesive runnable HTML file. ' +
            'Remove duplicate wrappers and repair obvious seams without removing functionality.'
        },
        {
          role: 'user',
          content:
            `Original task: ${state.instruction}\n` +
            `Global context: ${state.fileSummary}\n\n` +
            `FRAGMENTS:\n${combined}`
        }
      ]
    });

    if (result.ok) {
      const html = extractHtml_(result.generatedText || '');
      if (html) return { ok: true, html };
    }

    if (result.rateLimited) return result;
  }

  const html = /<html[\s>]/i.test(combined)
    ? combined
    : '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '</head>\n<body>\n' + combined + '\n</body>\n</html>';

  return { ok: true, html };
}

function makePreviewUrl_(htmlFile) {
  const webAppUrl = getWebAppUrl_();

  try {
    htmlFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    console.warn('Public Drive sharing unavailable; falling back to Drive URL.', err);
  }

  if (!webAppUrl) return htmlFile.getUrl();
  return `${webAppUrl}?id=${encodeURIComponent(htmlFile.getId())}`;
}

// -----------------------------------------------------------------------------
// 11. Email / output helpers
// -----------------------------------------------------------------------------

function extractHtml_(text) {
  if (!text) return '';

  const htmlMatch = String(text).match(/```html\s*([\s\S]*?)```/i);
  if (htmlMatch) return htmlMatch[1].trim();

  const genericMatch = String(text).match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  if (genericMatch) return genericMatch[1].trim();

  return String(text)
    .replace(/^```[a-zA-Z0-9_-]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function buildEmailBody_(previewUrl, wasChunked, chunkCount, jobId) {
  const chunkNote = wasChunked
    ? `<p style="color:#6b7280;font-size:14px;margin-bottom:20px;">⚡ Processed across ${chunkCount} persisted parts.</p>`
    : '';

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding:24px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb;max-width:600px;">
  <h2 style="color:#111827;margin-top:0;font-size:20px;">🎉 Your Code is Ready!</h2>
  <p style="color:#4b5563;font-size:15px;line-height:1.5;">CodeAgent finished job <strong>${escapeHtml_(jobId)}</strong>.</p>
  ${chunkNote}
  <div style="margin:24px 0;">
    <a href="${escapeHtml_(previewUrl)}" target="_blank" rel="noopener noreferrer"
       style="background-color:#2563eb;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;">
      🚀 Open Live Preview
    </a>
  </div>
  <hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0;" />
  <p style="color:#9ca3af;font-size:13px;margin:0;">📎 The completed HTML file is attached.</p>
</div>`;
}

function sendFailureReply_(message, state, reason) {
  const parts = state.processedParts || [];
  const options = parts.length
    ? {
        attachments: [
          Utilities.newBlob(parts.join('\n\n'), MimeType.HTML, 'partial_recovery.html')
        ]
      }
    : {};

  message.reply(
    `🤖 CodeAgent stopped safely.\n\n${reason}\n\n` +
    `Completed portions are attached when available. Job: ${state.jobId}`,
    options
  );
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -----------------------------------------------------------------------------
// 12. Gmail helpers / quota handling
// -----------------------------------------------------------------------------

function resolveDeliveryTargetForJob_(state) {
  if (gmailQuotaPauseActive_()) return null;

  let thread = null;
  try {
    if (state.threadId) thread = GmailApp.getThreadById(state.threadId);
  } catch (err) {
    if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err);
    else console.error(`Job ${state.jobId}: Gmail thread lookup failed:`, err);
  }

  if (thread) {
    try {
      const messages = thread.getMessages();
      if (messages && messages.length) {
        const exact = state.messageId ? messages.find(m => m.getId() === state.messageId) : null;
        const message = exact || messages[messages.length - 1];
        if (message) {
          let recipient = '';
          try { recipient = extractEmailAddress_(message.getFrom()); } catch (_) {}
          return { message, recipient };
        }
      }
    } catch (err) {
      if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err);
      else console.error(`Job ${state.jobId}: Gmail message lookup failed:`, err);
    }
  }

  if (state.recipientEmail) return { message: null, recipient: state.recipientEmail };
  return null;
}

function extractEmailAddress_(fromField) {
  const text = String(fromField || '').trim();
  const angle = text.match(/<([^>]+)>/);
  return (angle ? angle[1] : text).trim();
}

function getThreadSafely_(threadId) {
  try {
    return GmailApp.getThreadById(threadId);
  } catch (err) {
    if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err);
    else console.error('getThreadSafely_ failed:', err);
    return null;
  }
}

function getMessageSafely_(thread, messageId) {
  try {
    const messages = thread.getMessages();
    return messages.find(m => m.getId() === messageId) || messages[messages.length - 1] || null;
  } catch (err) {
    if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err);
    else console.error('getMessageSafely_ failed:', err);
    return null;
  }
}

function markThreadReadSafely_(thread) {
  try {
    thread.markRead();
  } catch (err) {
    if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err);
    else console.error('Could not mark thread read:', err);
  }
}

function isGmailQuotaError_(err) {
  const message = String(err && err.message ? err.message : err).toLowerCase();
  return message.indexOf('service invoked too many times') !== -1 &&
    message.indexOf('email') !== -1;
}

function gmailQuotaPauseActive_() {
  const value = getScriptProperties_().getProperty('GMAIL_QUOTA_PAUSED_UNTIL');
  if (!value) return false;

  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || Date.now() >= timestamp) {
    const props = getScriptProperties_();
    props.deleteProperty('GMAIL_QUOTA_PAUSED_UNTIL');
    return false;
  }

  return true;
}

function pauseGmailAfterQuotaError_(err) {
  const until = Date.now() + CONFIG.GMAIL_QUOTA_PAUSE_MS;
  const props = getScriptProperties_();
  props.setProperty('GMAIL_QUOTA_PAUSED_UNTIL', String(until));
  props.setProperty('LAST_GMAIL_ERROR', String(err));
}

/**
 * Manual recovery for Gmail delivery after you believe quota is available again.
 * This does NOT create duplicate triggers; it simply clears the local pause.
 */
function clearGmailPauseAndResume() {
  if (!isCodeAgentEnabled_()) {
    throw new Error('CodeAgent is disabled. Run enableCodeAgent() first.');
  }

  const props = getScriptProperties_();
  props.deleteProperty('GMAIL_QUOTA_PAUSED_UNTIL');
  props.deleteProperty('LAST_GMAIL_ERROR');

  console.log('Gmail local pause cleared. The stable worker will retry queued deliveries.');
}

// -----------------------------------------------------------------------------
// 13. Drive / trigger / queue helpers
// -----------------------------------------------------------------------------

function getOrCreateJobFolder_() {
  const folders = DriveApp.getFoldersByName(CONFIG.JOB_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(CONFIG.JOB_FOLDER_NAME);
}

function saveState_(file, state) {
  state.updatedAt = new Date().toISOString();
  file.setContent(JSON.stringify(state));
}

function createManagedTriggers_() {
  ScriptApp.newTrigger('processCodeEmails')
    .timeBased()
    .everyMinutes(CONFIG.POLL_MINUTES)
    .create();

  ScriptApp.newTrigger('resumeJobs')
    .timeBased()
    .everyMinutes(CONFIG.WORKER_MINUTES)
    .create();
}

function ensureManagedTriggers_() {
  if (!isCodeAgentEnabled_()) return;

  const triggers = ScriptApp.getProjectTriggers();
  const hasPoller = triggers.some(t => t.getHandlerFunction() === 'processCodeEmails');
  const hasWorker = triggers.some(t => t.getHandlerFunction() === 'resumeJobs');

  if (!hasPoller) {
    ScriptApp.newTrigger('processCodeEmails')
      .timeBased()
      .everyMinutes(CONFIG.POLL_MINUTES)
      .create();
    console.log('Self-healed missing processCodeEmails trigger.');
  }

  if (!hasWorker) {
    ScriptApp.newTrigger('resumeJobs')
      .timeBased()
      .everyMinutes(CONFIG.WORKER_MINUTES)
      .create();
    console.log('Self-healed missing resumeJobs trigger.');
  }
}

function deleteManagedTriggers_() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (isManagedTrigger_(trigger)) {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

function isManagedTrigger_(trigger) {
  return CONFIG.MANAGED_TRIGGER_NAMES.indexOf(trigger.getHandlerFunction()) !== -1;
}

function countQueuedJobs_() {
  try {
    const folder = getOrCreateJobFolder_();
    const files = folder.getFilesByType(MimeType.PLAIN_TEXT);
    let count = 0;
    while (files.hasNext()) {
      files.next();
      count++;
    }
    return count;
  } catch (err) {
    console.error('countQueuedJobs_ failed:', err);
    return -1;
  }
}

function hasTimedOut_(startTime) {
  return Date.now() - startTime >= CONFIG.MAX_EXECUTION_TIME_MS;
}

function forceDriveAuth() {
  DriveApp.getRootFolder();
}

/**
 * One-time helper for the exact scenario we just encountered.
 * It does not delete or recreate the generated result. It only:
 *   - ensures the stable trigger pair exists;
 *   - clears a stale nextAttemptAt timestamp on pending jobs so the worker can
 *     inspect them on its next normal pass.
 *
 * Gmail quota remains respected: SEND_RESULT will still wait if Gmail is paused.
 */
function recoverStuckJobs() {
  if (!isCodeAgentEnabled_()) {
    throw new Error('CodeAgent is disabled. Run enableCodeAgent() first.');
  }

  ensureManagedTriggers_();

  const folder = getOrCreateJobFolder_();
  const files = folder.getFilesByType(MimeType.PLAIN_TEXT);
  let recovered = 0;

  while (files.hasNext()) {
    const file = files.next();
    try {
      const state = JSON.parse(file.getBlob().getDataAsString());
      if (state.stage === 'SEND_RESULT' || state.stage === 'FAILURE_PENDING') {
        state.nextAttemptAt = Date.now();
        state.deliveryError = state.deliveryError || 'Manual recovery requested.';
        saveState_(file, state);
        recovered++;
      }
    } catch (err) {
      console.error(`Could not inspect ${file.getName()}:`, err);
    }
  }

  console.log(`Recovered ${recovered} pending delivery job(s). Stable worker will handle them.`);
}

// -----------------------------------------------------------------------------
// 14. Future GitHub + Slack integration
// -----------------------------------------------------------------------------

/*
 * GITHUB ROADMAP
 * --------------
 * GitHub should be a thin adapter into the same job engine, not a second AI
 * system. Future work will:
 *   1. Authenticate to GitHub using a token stored in Script Properties or a
 *      safer secret store for production deployments.
 *   2. Accept repository owner/repo/branch/path plus task text.
 *   3. Read source files and commit SHAs through GitHub's REST API.
 *   4. Normalize the request into the existing persistent CodeAgent job schema.
 *   5. Reuse SUMMARY -> PROCESS -> FINALIZE -> RESULT stages.
 *   6. Write changed files to a new branch and optionally open a pull request.
 *   7. Persist branch name, commit SHA, PR URL, and repository metadata in the
 *      job JSON so interrupted work can resume safely.
 *   8. Later, use GitHub webhooks for issues/PRs instead of polling.
 *
 * SLACK ROADMAP
 * ------------
 * Slack will also be a thin adapter:
 *   1. Authenticate Slack events/commands.
 *   2. Convert the message into the same normalized job schema.
 *   3. Store channel/thread metadata in the job for reply routing.
 *   4. Reuse the exact same worker and Groq logic.
 *   5. Post acknowledgement, progress, completion, and failure messages back to
 *      the originating Slack thread.
 *
 * TARGET ARCHITECTURE
 * -------------------
 *
 *      Gmail ─┐
 *      Slack ─┼──> normalize -> persistent CodeAgent job -> worker -> result
 *      GitHub ┘
 *
 * This makes future GitHub commits/PRs and Slack commands additive. The queue,
 * retry logic, state machine, safety controls, and Groq integration remain one
 * shared core.
 */
