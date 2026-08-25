/**
 * =============================================================================
 * CodeAgent v8 — Google Apps Script
 * =============================================================================
 *
 * Gmail -> persistent Drive queue -> Groq coding agent -> HTML preview
 *
 * v8 focuses on reliability, output integrity, and diagnostics:
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
 *   - Incomplete HTML is detected and repaired before delivery.
 *   - Personal information is not invented by the coding prompt.
 *   - Stuck jobs can be manually recovered without deleting the generated file.
 *   - inspectQueuedJobs() provides detailed queue diagnostics.
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
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN',
  GITHUB_OWNER_PROPERTY: 'GITHUB_OWNER',
  GITHUB_REPO_PROPERTY: 'GITHUB_REPO',
  SLACK_WEBHOOK_PROPERTY: 'SLACK_WEBHOOK_URL',
  API_URL: 'https://api.groq.com/openai/v1/chat/completions',
  GROQ_MODEL: 'openai/gpt-oss-120b',
  TPM_LIMIT: 8000,
  CHARS_PER_TOKEN_ESTIMATE: 2.5,
  PROMPT_OVERHEAD_TOKENS: 650,
  OUTPUT_RESERVE_TOKENS: 1800,
  GROQ_BACKOFF_MS: 75 * 1000,
  MAX_RETRIES: 3,
  POLL_MINUTES: 5,
  WORKER_MINUTES: 1,
  GMAIL_QUOTA_PAUSE_MS: 12 * 60 * 60 * 1000,
  MAX_EXECUTION_TIME_MS: 4 * 60 * 1000,
  MAX_TOTAL_INPUT_CHARS: 400000,
  MAX_SOURCE_SUMMARY_CHARS: 2200,
  MIN_SPLIT_CHARS: 300,
  JOB_FOLDER_NAME: 'CodeAgent_Jobs',
  LOCK_WAIT_MS: 5000,
  MANAGED_TRIGGER_NAMES: ['processCodeEmails', 'resumeJobs']
});

function getScriptProperties_() { return PropertiesService.getScriptProperties(); }
function isCodeAgentEnabled_() { return getScriptProperties_().getProperty(CONFIG.ENABLE_PROPERTY) === 'true'; }
function getGroqApiKey_() { return getScriptProperties_().getProperty(CONFIG.GROQ_KEY_PROPERTY) || ''; }
function getWebAppUrl_() { return getScriptProperties_().getProperty(CONFIG.WEB_APP_URL_PROPERTY) || ''; }
function getChunkCharBudget_() {
  return Math.max(4000, Math.floor((CONFIG.TPM_LIMIT - CONFIG.PROMPT_OVERHEAD_TOKENS - CONFIG.OUTPUT_RESERVE_TOKENS) * CONFIG.CHARS_PER_TOKEN_ESTIMATE));
}

function disableCodeAgent() {
  const props = getScriptProperties_();
  props.setProperty(CONFIG.ENABLE_PROPERTY, 'false');
  deleteManagedTriggers_();
  console.log('CodeAgent DISABLED. Existing Drive jobs were preserved.');
}

function initializeCodeAgent() {
  const props = getScriptProperties_();
  if (!props.getProperty(CONFIG.ENABLE_PROPERTY)) props.setProperty(CONFIG.ENABLE_PROPERTY, 'false');
  deleteManagedTriggers_();
  console.log('Initialized safely. CodeAgent remains DISABLED. Existing jobs were preserved.');
}

function enableCodeAgent() {
  if (!getGroqApiKey_()) throw new Error('Missing GROQ_API_KEY. Add it under Project Settings > Script properties before enabling CodeAgent.');
  const props = getScriptProperties_();
  props.setProperty(CONFIG.ENABLE_PROPERTY, 'true');
  deleteManagedTriggers_();
  createManagedTriggers_();
  console.log(`CodeAgent ENABLED. Gmail polling: every ${CONFIG.POLL_MINUTES} min. Worker: every ${CONFIG.WORKER_MINUTES} min.`);
}

function emergencyStop() { disableCodeAgent(); }

function showCodeAgentStatus() {
  const props = getScriptProperties_();
  const triggers = ScriptApp.getProjectTriggers();
  const managed = triggers.filter(isManagedTrigger_).map(t => ({ handler: t.getHandlerFunction(), type: String(t.getTriggerSource()), event: String(t.getEventType()) }));
  console.log(JSON.stringify({
    enabled: isCodeAgentEnabled_(), hasGroqKey: !!getGroqApiKey_(), webAppConfigured: !!getWebAppUrl_(),
    gmailQuotaPausedUntil: props.getProperty('GMAIL_QUOTA_PAUSED_UNTIL') || null,
    lastGmailError: props.getProperty('LAST_GMAIL_ERROR') || null,
    queuedJobs: countQueuedJobs_(), managedTriggers: managed,
    expectedTriggers: { processCodeEmails: 1, resumeJobs: 1 }
  }, null, 2));
}

function runWorkerOnce() { resumeJobs(); }

function doGet(e) {
  const id = e && e.parameter ? e.parameter.id : null;
  if (!id) return HtmlService.createHtmlOutput('No preview ID provided.');
  try {
    const file = DriveApp.getFileById(id);
    const htmlContent = file.getBlob().getDataAsString();
    return HtmlService.createHtmlOutput(htmlContent).setTitle('Code Preview').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    console.error('doGet error:', err);
    return HtmlService.createHtmlOutput('Preview expired or not found.');
  }
}

function processCodeEmails() {
  if (!isCodeAgentEnabled_()) { console.log('CodeAgent disabled; processCodeEmails exiting before Gmail access.'); return; }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) { console.log('Another CodeAgent execution holds the lock. Gmail intake skipped.'); return; }
  try {
    ensureManagedTriggers_();
    if (gmailQuotaPauseActive_()) { console.log('Gmail quota pause active; skipping Gmail intake this cycle.'); return; }
    pollGmailForNewJobs_();
  } finally { lock.releaseLock(); }
}

function pollGmailForNewJobs_() {
  try {
    const threads = GmailApp.search('label:CodeAgent is:unread', 0, 5);
    console.log(`Gmail polling found ${threads.length} candidate thread(s).`);
    for (const thread of threads) if (initializeJobFromThread_(thread)) return;
  } catch (err) {
    if (isGmailQuotaError_(err)) { pauseGmailAfterQuotaError_(err); console.error('Gmail quota/service limit reached. Gmail intake paused.'); return; }
    console.error('Gmail polling failed:', err);
  }
}

function initializeJobFromThread_(thread) {
  let latestMessage;
  try {
    const messages = thread.getMessages();
    if (!messages || !messages.length) return false;
    latestMessage = messages[messages.length - 1];
    const existing = findJobByMessage_(thread.getId(), latestMessage.getId());
    if (existing) { markThreadReadSafely_(thread); console.log(`Existing job ${existing.jobId} found for message; skipping duplicate creation.`); return true; }
    const instruction = (latestMessage.getPlainBody() || '').trim();
    const sourceText = collectSourceText_(latestMessage);
    if (!sourceText && !instruction) {
      try { latestMessage.reply('🤖 No instructions or file content found to process.'); } catch (err) { if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err); }
      markThreadReadSafely_(thread); return true;
    }
    const chunks = splitIntoChunks_(sourceText);
    const state = {
      version: 8,
      jobId: `job_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      threadId: thread.getId(),
      messageId: latestMessage.getId(),
      recipientEmail: extractEmailAddress_(latestMessage.getFrom()),
      instruction, sourceText,
      fileSummary: sourceText ? 'Summary not generated yet.' : 'New file request.',
      chunks, processedParts: [], currentIndex: 0,
      stage: sourceText ? 'SUMMARY' : 'PROCESS', isChunked: chunks.length > 1,
      retryCount: 0, finalizeRetryCount: 0, deliveryAttempts: 0,
      nextAttemptAt: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const folder = getOrCreateJobFolder_();
    const file = folder.createFile(`${state.jobId}.json`, JSON.stringify(state), MimeType.PLAIN_TEXT);
    try {
      latestMessage.reply(state.isChunked ? `⚡ CodeAgent accepted your request as ${state.jobId} and queued it across ${chunks.length} persisted parts.` : `⚡ CodeAgent accepted your request as ${state.jobId} and queued it for processing.`);
    } catch (replyError) {
      if (isGmailQuotaError_(replyError)) pauseGmailAfterQuotaError_(replyError); else console.error('Acknowledgement email failed:', replyError);
    }
    markThreadReadSafely_(thread);
    console.log(`Created job ${state.jobId}: ${file.getId()}`);
    return true;
  } catch (err) {
    if (isGmailQuotaError_(err)) { pauseGmailAfterQuotaError_(err); return false; }
    console.error('Job initialization failed:', err); return false;
  }
}

function findJobByMessage_(threadId, messageId) {
  const files = getOrCreateJobFolder_().getFilesByType(MimeType.PLAIN_TEXT);
  while (files.hasNext()) {
    const file = files.next();
    try {
      const state = JSON.parse(file.getBlob().getDataAsString());
      if (state.threadId === threadId && state.messageId === messageId) return state;
    } catch (_) {}
  }
  return null;
}

function resumeJobs() {
  if (!isCodeAgentEnabled_()) { console.log('CodeAgent disabled; worker exiting.'); return; }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) { console.log('Another CodeAgent execution holds the lock. Worker skipped.'); return; }
  try { ensureManagedTriggers_(); processPendingJobs_(Date.now()); } finally { lock.releaseLock(); }
}

function processPendingJobs_(startTime) {
  const files = getOrCreateJobFolder_().getFilesByType(MimeType.PLAIN_TEXT);
  while (files.hasNext()) {
    if (hasTimedOut_(startTime)) return;
    const file = files.next();
    const result = processSingleJob_(file, startTime);
    if (result === 'DONE' || result === 'PROCESSED') return;
  }
}

function processSingleJob_(file, startTime) {
  let state;
  try { state = JSON.parse(file.getBlob().getDataAsString()); }
  catch (err) { console.error(`Corrupted job ${file.getName()}; moving it to trash.`, err); file.setTrashed(true); return 'DONE'; }
  if (state.nextAttemptAt && Date.now() < Number(state.nextAttemptAt)) return 'WAIT';

  if (state.stage === 'SUMMARY') {
    if (hasTimedOut_(startTime)) return 'WAIT';
    const result = summarizeFilePurpose_(state.sourceText || '');
    if (!result.ok) return handleModelFailure_(file, state, result, 'summary');
    state.fileSummary = (result.generatedText || '').trim() || 'No summary available.';
    state.stage = 'PROCESS'; state.retryCount = 0; state.nextAttemptAt = Date.now() + 10000; saveState_(file, state); return 'PROCESSED';
  }

  if (state.stage === 'PROCESS') {
    if (state.currentIndex >= state.chunks.length) { state.stage = 'FINALIZE'; state.nextAttemptAt = Date.now(); saveState_(file, state); return 'PROCESSED'; }
    if (hasTimedOut_(startTime)) return 'WAIT';
    const index = state.currentIndex;
    const result = processChunk_({ instruction: state.instruction, fileSummary: state.fileSummary, chunk: state.chunks[index], chunkIndex: index, totalChunks: state.chunks.length });
    if (!result.ok) return handleChunkFailure_(file, state, result, index);
    const generated = extractHtml_(result.generatedText || '').trim();
    if (!generated) return stageFailureForDelivery_(file, state, `The model returned an empty result for part ${index + 1}.`);
    state.processedParts.push(generated); state.currentIndex += 1; state.retryCount = 0;
    state.nextAttemptAt = Date.now() + (state.currentIndex < state.chunks.length ? CONFIG.GROQ_BACKOFF_MS : 10000);
    state.stage = state.currentIndex >= state.chunks.length ? 'FINALIZE' : 'PROCESS'; saveState_(file, state); return 'PROCESSED';
  }

  if (state.stage === 'FINALIZE') {
    if (hasTimedOut_(startTime)) return 'WAIT';
    const result = finalizeJob_(state);
    if (!result.ok) return handleModelFailure_(file, state, result, 'finalization');
    let htmlFile;
    try { htmlFile = DriveApp.createFile(`CodePreview_${Date.now()}.html`, result.html, MimeType.HTML); }
    catch (err) { state.stage = 'RETRY_DRIVE'; state.deliveryError = `Could not save result to Drive: ${err}`; state.nextAttemptAt = Date.now() + 60000; saveState_(file, state); return 'WAIT'; }
    const previewUrl = makePreviewUrl_(htmlFile);
    state.stage = 'SEND_RESULT'; state.resultFileId = htmlFile.getId(); state.resultFileName = htmlFile.getName(); state.previewUrl = previewUrl; state.nextAttemptAt = Date.now(); saveState_(file, state); return 'PROCESSED';
  }

  if (state.stage === 'RETRY_DRIVE') { state.stage = 'FINALIZE'; state.nextAttemptAt = Date.now(); saveState_(file, state); return 'PROCESSED'; }

  if (state.stage === 'SEND_RESULT') {
    if (gmailQuotaPauseActive_()) { console.warn(`Job ${state.jobId}: Gmail delivery paused until ${getScriptProperties_().getProperty('GMAIL_QUOTA_PAUSED_UNTIL')}.`); return 'WAIT'; }
    const recipient = String(state.recipientEmail || '').trim();
    if (!recipient) { state.deliveryAttempts = Number(state.deliveryAttempts || 0) + 1; state.deliveryError = 'No recipientEmail is stored for this job.'; state.nextAttemptAt = Date.now() + 10 * 60 * 1000; saveState_(file, state); console.error(`Job ${state.jobId}: ${state.deliveryError}`); return 'WAIT'; }
    let htmlFile;
    try { htmlFile = DriveApp.getFileById(state.resultFileId); }
    catch (err) { state.deliveryError = `Result file ${state.resultFileId} could not be found: ${err}`; state.stage = 'ORPHANED_RESULT'; saveState_(file, state); console.error(`Job ${state.jobId}: ${state.deliveryError}`); return 'WAIT'; }
    try {
      const finalHtml = htmlFile.getBlob().getDataAsString();
      const previewUrl = state.previewUrl || htmlFile.getUrl();
      const emailOptions = { htmlBody: buildEmailBody_(previewUrl, state.isChunked, state.chunks.length, state.jobId), attachments: [Utilities.newBlob(finalHtml, MimeType.HTML, state.resultFileName || 'CodeAgent_result.html')] };
      console.log(`Job ${state.jobId}: sending completion email directly to ${recipient}`);
      GmailApp.sendEmail(recipient, `CodeAgent result — ${state.jobId}`, `Your CodeAgent job ${state.jobId} is complete.\n\nOpen the live preview:\n${previewUrl}\n\nThe completed HTML file is attached.`, emailOptions);
      console.log(`Job ${state.jobId}: completion email successfully sent to ${recipient}`);
      file.setTrashed(true); return 'DONE';
    } catch (err) {
      state.deliveryAttempts = Number(state.deliveryAttempts || 0) + 1; state.deliveryError = String(err);
      if (isGmailQuotaError_(err)) { pauseGmailAfterQuotaError_(err); state.nextAttemptAt = Date.now() + CONFIG.GMAIL_QUOTA_PAUSE_MS; }
      else { state.nextAttemptAt = Date.now() + Math.min(60 * 60 * 1000, Math.max(60000, state.deliveryAttempts * 60000)); }
      saveState_(file, state); console.error(`Job ${state.jobId}: completion email failed:`, err); return 'WAIT';
    }
  }

  if (state.stage === 'FAILURE_PENDING') return processFailurePending_(file, state);
  if (state.stage === 'ORPHANED_RESULT') return 'WAIT';
  return stageFailureForDelivery_(file, state, `Unknown job stage: ${state.stage}`);
}

function handleChunkFailure_(file, state, result, index) {
  if (result.needsSplit && state.chunks[index].length > CONFIG.MIN_SPLIT_CHARS) {
    const text = state.chunks[index];
    const midpoint = Math.floor(text.length / 2);
    let splitIndex = text.lastIndexOf('\n', midpoint);
    if (splitIndex < text.length * 0.25 || splitIndex > text.length * 0.75) splitIndex = midpoint;
    const partA = text.substring(0, splitIndex).trim();
    const partB = text.substring(splitIndex).trim();
    if (partA && partB) {
      state.chunks.splice(index, 1, partA, partB);
      state.retryCount = 0;
      state.nextAttemptAt = Date.now() + CONFIG.GROQ_BACKOFF_MS;
      saveState_(file, state); return 'WAIT';
    }
  }
  return handleModelFailure_(file, state, result, `part ${index + 1}`);
}

function handleModelFailure_(file, state, result, stageName) {
  const errorMessage = result && result.errorMessage ? result.errorMessage : 'Unknown model error.';
  if (result && result.incomplete) {
    const retries = Number(state.finalizeRetryCount || 0);
    if (retries < 2) {
      state.finalizeRetryCount = retries + 1;
      state.stage = 'FINALIZE';
      state.nextAttemptAt = Date.now() + 10000;
      state.deliveryError = `Incomplete output during ${stageName}; retry ${state.finalizeRetryCount}/2.`;
      saveState_(file, state); console.warn(`Job ${state.jobId}: incomplete output; retrying ${stageName}.`); return 'WAIT';
    }
  }
  if (result && result.rateLimited && Number(state.retryCount || 0) < CONFIG.MAX_RETRIES) {
    state.retryCount = Number(state.retryCount || 0) + 1;
    state.nextAttemptAt = Date.now() + CONFIG.GROQ_BACKOFF_MS;
    state.deliveryError = errorMessage;
    saveState_(file, state); return 'WAIT';
  }
  return stageFailureForDelivery_(file, state, `CodeAgent stopped during ${stageName}: ${errorMessage}`);
}

function stageFailureForDelivery_(file, state, reason) {
  state.stage = 'FAILURE_PENDING';
  state.failureReason = reason;
  state.nextAttemptAt = Date.now();
  saveState_(file, state);
  return 'PROCESSED';
}

function stageFailureForDelivery(file, state, reason) { return stageFailureForDelivery_(file, state, reason); }

function processFailurePending_(file, state) {
  if (gmailQuotaPauseActive_()) return 'WAIT';
  const reason = state.failureReason || 'CodeAgent failed without a recorded reason.';
  const recipient = String(state.recipientEmail || '').trim();
  try {
    if (recipient) {
      const parts = state.processedParts || [];
      const options = parts.length ? { attachments: [Utilities.newBlob(parts.join('\n\n'), MimeType.HTML, 'partial_recovery.html')] } : {};
      GmailApp.sendEmail(recipient, `CodeAgent needs attention — ${state.jobId}`, `CodeAgent could not finish job ${state.jobId}.\n\n${reason}`, options);
    } else {
      const message = loadOriginalMessageForJob_(state);
      if (!message) { state.nextAttemptAt = Date.now() + 5 * 60 * 1000; saveState_(file, state); return 'WAIT'; }
      sendFailureReply_(message, state, reason);
    }
    file.setTrashed(true); console.log(`Job ${state.jobId}: failure notification delivered.`); return 'DONE';
  } catch (err) {
    if (isGmailQuotaError_(err)) { pauseGmailAfterQuotaError_(err); state.nextAttemptAt = Date.now() + CONFIG.GMAIL_QUOTA_PAUSE_MS; }
    else state.nextAttemptAt = Date.now() + 5 * 60 * 1000;
    state.deliveryError = String(err); saveState_(file, state); console.error(`Job ${state.jobId}: failure notification failed:`, err); return 'WAIT';
  }
}

function handleFailurePendingIfNeeded_(file, state) { if (state.stage !== 'FAILURE_PENDING') return null; return processFailurePending_(file, state); }

function collectSourceText_(msg) {
  let text = '';
  let attachments;
  try { attachments = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }); }
  catch (_) { attachments = msg.getAttachments(); }
  for (const att of attachments) {
    const name = att.getName() || 'attachment';
    const type = (att.getContentType() || '').toLowerCase();
    const textLike = type.indexOf('text/') === 0 || /\.(js|jsx|mjs|cjs|ts|tsx|html|htm|css|scss|json|md|txt|xml|svg|vue|svelte)$/i.test(name);
    if (!textLike) continue;
    text += `\n\n/* --- Attached File: ${name} --- */\n${att.getDataAsString()}`;
    if (text.length >= CONFIG.MAX_TOTAL_INPUT_CHARS) { text = text.substring(0, CONFIG.MAX_TOTAL_INPUT_CHARS) + '\n\n/* --- INPUT TRUNCATED: MAX_TOTAL_INPUT_CHARS reached --- */'; break; }
  }
  return text.trim();
}

function splitIntoChunks_(text) {
  if (!text) return [''];
  const budget = getChunkCharBudget_();
  if (text.length <= budget) return [text];
  const chunks = [];
  let remaining = text;
  const patterns = [/\n\s*\n/g, /<\/[a-zA-Z0-9:-]+>\s*\n/g, /}\s*\n/g, /;\s*\n/g, /\n/g];
  while (remaining.length > budget) {
    const window = remaining.substring(0, budget);
    let splitAt = -1;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      let lastMatchEnd = -1;
      while ((match = pattern.exec(window)) !== null) lastMatchEnd = match.index + match[0].length;
      if (lastMatchEnd >= budget * 0.55) { splitAt = lastMatchEnd; break; }
    }
    if (splitAt < 1) splitAt = budget;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

function summarizeFilePurpose_(text) {
  const preview = text.length > CONFIG.MAX_SOURCE_SUMMARY_CHARS ? text.substring(0, CONFIG.MAX_SOURCE_SUMMARY_CHARS) + '\n...[truncated]' : text;
  return callGroq_({ model: CONFIG.GROQ_MODEL, max_completion_tokens: 300, messages: [{ role: 'system', content: 'Summarize this source code architecture and purpose in 2-3 concise sentences. Focus on major components, data flow, important APIs, and naming conventions. Do not rewrite code.' }, { role: 'user', content: preview }] });
}

function estimateTokensV8_(text) { return Math.max(1, Math.ceil(String(text || '').length / CONFIG.CHARS_PER_TOKEN_ESTIMATE)); }
function getSafeCompletionBudgetV8_(promptText) { const promptTokens = estimateTokensV8_(promptText); const available = CONFIG.TPM_LIMIT - CONFIG.PROMPT_OVERHEAD_TOKENS - promptTokens; return Math.max(256, Math.min(3200, available)); }

function processChunk_({ instruction, fileSummary, chunk, chunkIndex, totalChunks }) {
  const positionNote = totalChunks > 1 ? `This is part ${chunkIndex + 1} of ${totalChunks} of a larger source file.\nGlobal context: ${fileSummary}\n\nApply the user's instruction to THIS SECTION. Preserve existing names, APIs, conventions, and working logic. Do not add document wrappers unless this section already has them.\n\n` : '';
  const outputInstruction = totalChunks === 1 ? 'Return ONLY a complete standalone HTML document inside one HTML code block. It MUST end with </html>. Keep the output concise enough to finish within the token limit. Do not add explanations.' : 'Return only the transformed source fragment inside one HTML code block. Do not add commentary.';
  const prompt = positionNote + `USER INSTRUCTION:\n${instruction || '(Repair the supplied code while preserving its intended behavior.)'}\n\n` + `SOURCE SECTION:\n${chunk}\n\n` + `PERSONAL-DATA RULE: Never invent an email address, phone number, social profile, employer, credential, hobby, project, biography detail, or other personal fact. Only use personal information supplied by the user. Otherwise use a neutral placeholder or omit it.\n\n` + outputInstruction;
  return callGroq_({ model: CONFIG.GROQ_MODEL, max_completion_tokens: getSafeCompletionBudgetV8_(prompt), messages: [{ role: 'system', content: 'You are an expert full-stack web developer and code repair agent. Preserve existing functionality, make targeted changes, and never invent personal information. For standalone HTML, always finish the complete document.' }, { role: 'user', content: prompt }] });
}

function callGroq_(payload) {
  const apiKey = getGroqApiKey_();
  if (!apiKey) return { ok: false, needsSplit: false, rateLimited: false, errorMessage: 'GROQ_API_KEY is missing.' };
  const options = { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: `Bearer ${apiKey}` }, payload: JSON.stringify(payload) };
  let response;
  try { response = UrlFetchApp.fetch(CONFIG.API_URL, options); }
  catch (err) { return { ok: false, needsSplit: false, rateLimited: false, errorMessage: `Network call failed: ${err}` }; }
  const code = response.getResponseCode();
  let data;
  try { data = JSON.parse(response.getContentText()); }
  catch (_) { return { ok: false, needsSplit: false, rateLimited: false, errorMessage: `Unparseable Groq response (HTTP ${code}).` }; }
  const rawError = data && data.error && data.error.message ? String(data.error.message) : '';
  const errorMessage = rawError.toLowerCase();
  if (code === 429) return { ok: false, needsSplit: false, rateLimited: true, errorMessage: rawError || 'Groq rate limit reached.' };
  if ((code === 400 || code === 413) && /(large|limit|token|context|length)/i.test(errorMessage)) return { ok: false, needsSplit: true, rateLimited: false, errorMessage: rawError || `Groq rejected the request as too large (HTTP ${code}).` };
  if (code >= 500 && code <= 599) return { ok: false, needsSplit: false, rateLimited: true, errorMessage: rawError || `Groq server error (HTTP ${code}).` };
  if (data && data.error) return { ok: false, needsSplit: false, rateLimited: false, errorMessage: rawError || `Groq API error (HTTP ${code}).` };
  if (code < 200 || code >= 300) return { ok: false, needsSplit: false, rateLimited: false, errorMessage: `Groq request failed with HTTP ${code}.` };
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string') return { ok: false, needsSplit: false, rateLimited: false, errorMessage: 'Groq returned no assistant content.' };
  return { ok: true, generatedText: content };
}

function isCompleteHtmlV8_(html) {
  const text = String(html || '').trim();
  return !!text && /<html(?:\s|>)/i.test(text) && /<head(?:\s|>)/i.test(text) && /<body(?:\s|>)/i.test(text) && /<\/body>/i.test(text) && /<\/html>/i.test(text);
}

function finalizeJob_(state) {
  const combined = (state.processedParts || []).join('\n\n');
  if (!state.isChunked) {
    const html = extractHtml_(state.processedParts[0] || combined).trim();
    if (!html) return { ok: false, incomplete: false, rateLimited: false, errorMessage: 'No generated HTML was returned.' };
    if (isCompleteHtmlV8_(html)) return { ok: true, html };
    const repairPrompt = `Repair this potentially truncated HTML document.\nPreserve its current design and behavior. Do not invent personal information.\nReturn ONLY the complete standalone HTML document inside one HTML code block.\nThe final output MUST contain </body> and </html>.\n\nCURRENT OUTPUT:\n${html}`;
    const repair = callGroq_({ model: CONFIG.GROQ_MODEL, max_completion_tokens: getSafeCompletionBudgetV8_(repairPrompt), messages: [{ role: 'system', content: 'Repair incomplete HTML. Return only a complete runnable document. Do not invent personal facts or contact details.' }, { role: 'user', content: repairPrompt }] });
    if (repair.ok) { const repaired = extractHtml_(repair.generatedText || '').trim(); if (isCompleteHtmlV8_(repaired)) return { ok: true, html: repaired }; }
    if (repair.rateLimited) return repair;
    return { ok: false, incomplete: true, rateLimited: false, errorMessage: 'Generated HTML was incomplete and the repair pass did not finish it.' };
  }
  const mergePrompt = `Original task: ${state.instruction}\nGlobal context: ${state.fileSummary}\nNever invent personal facts or contact information.\n\nMerge the fragments into one cohesive runnable HTML document. Preserve functionality, remove duplicate wrappers, repair obvious seams, and return a complete document ending with </html>.\n\nFRAGMENTS:\n${combined}`;
  const mergeTokens = estimateTokensV8_(mergePrompt);
  const canMerge = mergeTokens + CONFIG.PROMPT_OVERHEAD_TOKENS + 900 <= CONFIG.TPM_LIMIT;
  if (canMerge) {
    const result = callGroq_({ model: CONFIG.GROQ_MODEL, max_completion_tokens: getSafeCompletionBudgetV8_(mergePrompt), messages: [{ role: 'system', content: 'Merge transformed fragments into one complete runnable HTML document. Preserve functionality and do not invent personal information.' }, { role: 'user', content: mergePrompt }] });
    if (result.ok) { const html = extractHtml_(result.generatedText || '').trim(); if (isCompleteHtmlV8_(html)) return { ok: true, html }; }
    if (result.rateLimited) return result;
  }
  const fallback = /<html[\s>]/i.test(combined) ? combined : '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n' + combined + '\n</body>\n</html>';
  if (!isCompleteHtmlV8_(fallback)) return { ok: false, incomplete: true, rateLimited: false, errorMessage: 'Chunked output could not be assembled into a complete HTML document.' };
  return { ok: true, html: fallback };
}

function makePreviewUrl_(htmlFile) {
  const webAppUrl = getWebAppUrl_();
  try { htmlFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (err) { console.warn('Public Drive sharing unavailable; falling back to Drive URL.', err); }
  if (!webAppUrl) return htmlFile.getUrl();
  return `${webAppUrl}?id=${encodeURIComponent(htmlFile.getId())}`;
}

function extractHtml_(text) {
  if (!text) return '';
  const htmlMatch = String(text).match(/```html\s*([\s\S]*?)```/i);
  if (htmlMatch) return htmlMatch[1].trim();
  const genericMatch = String(text).match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  if (genericMatch) return genericMatch[1].trim();
  return String(text).replace(/^```[a-zA-Z0-9_-]*\s*/i, '').replace(/\s*```$/i, '').trim();
}

function buildEmailBody_(previewUrl, wasChunked, chunkCount, jobId) {
  const chunkNote = wasChunked ? `<p style="color:#6b7280;font-size:14px;margin-bottom:20px;">⚡ Processed across ${chunkCount} persisted parts.</p>` : '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding:24px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb;max-width:600px;"><h2 style="color:#111827;margin-top:0;font-size:20px;">🎉 Your Code is Ready!</h2><p style="color:#4b5563;font-size:15px;line-height:1.5;">CodeAgent finished job <strong>${escapeHtml_(jobId)}</strong>.</p>${chunkNote}<div style="margin:24px 0;"><a href="${escapeHtml_(previewUrl)}" target="_blank" rel="noopener noreferrer" style="background-color:#2563eb;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;">🚀 Open Live Preview</a></div><hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0;" /><p style="color:#9ca3af;font-size:13px;margin:0;">📎 The completed HTML file is attached.</p></div>`;
}

function sendFailureReply_(message, state, reason) {
  const parts = state.processedParts || [];
  const options = parts.length ? { attachments: [Utilities.newBlob(parts.join('\n\n'), MimeType.HTML, 'partial_recovery.html')] } : {};
  message.reply(`🤖 CodeAgent stopped safely.\n\n${reason}\n\n` + `Completed portions are attached when available. Job: ${state.jobId}`, options);
}

function escapeHtml_(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function resolveDeliveryTargetForJob_(state) {
  if (gmailQuotaPauseActive_()) return null;
  let thread = null;
  try { if (state.threadId) thread = GmailApp.getThreadById(state.threadId); }
  catch (err) { if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err); else console.error(`Job ${state.jobId}: Gmail thread lookup failed:`, err); }
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
    } catch (err) { if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err); else console.error(`Job ${state.jobId}: Gmail message lookup failed:`, err); }
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
  try { return GmailApp.getThreadById(threadId); }
  catch (err) { if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err); else console.error('getThreadSafely_ failed:', err); return null; }
}

function getMessageSafely_(thread, messageId) {
  try {
    const messages = thread.getMessages();
    return messages.find(m => m.getId() === messageId) || messages[messages.length - 1] || null;
  } catch (err) { if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err); else console.error('getMessageSafely_ failed:', err); return null; }
}

function markThreadReadSafely_(thread) {
  try { thread.markRead(); }
  catch (err) { if (isGmailQuotaError_(err)) pauseGmailAfterQuotaError_(err); else console.error('Could not mark thread read:', err); }
}

function isGmailQuotaError_(err) {
  const message = String(err && err.message ? err.message : err).toLowerCase();
  const quotaLike = /(service invoked too many times|too many times in a short time|daily limit|quota|rate limit)/i.test(message);
  const mailLike = /(email|gmail|mail|recipient|send|message)/i.test(message);
  return quotaLike && mailLike;
}

function gmailQuotaPauseActive_() {
  const value = getScriptProperties_().getProperty('GMAIL_QUOTA_PAUSED_UNTIL');
  if (!value) return false;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || Date.now() >= timestamp) {
    getScriptProperties_().deleteProperty('GMAIL_QUOTA_PAUSED_UNTIL');
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

function clearGmailPauseAndResume() {
  if (!isCodeAgentEnabled_()) throw new Error('CodeAgent is disabled. Run enableCodeAgent() first.');
  const props = getScriptProperties_();
  props.deleteProperty('GMAIL_QUOTA_PAUSED_UNTIL');
  props.deleteProperty('LAST_GMAIL_ERROR');
  console.log('Gmail local pause cleared. The stable worker will retry queued deliveries.');
}

function getOrCreateJobFolder_() {
  const folders = DriveApp.getFoldersByName(CONFIG.JOB_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(CONFIG.JOB_FOLDER_NAME);
}

function saveState_(file, state) { state.updatedAt = new Date().toISOString(); file.setContent(JSON.stringify(state)); }

function createManagedTriggers_() {
  ScriptApp.newTrigger('processCodeEmails').timeBased().everyMinutes(CONFIG.POLL_MINUTES).create();
  ScriptApp.newTrigger('resumeJobs').timeBased().everyMinutes(CONFIG.WORKER_MINUTES).create();
}

function ensureManagedTriggers_() {
  if (!isCodeAgentEnabled_()) return;
  const triggers = ScriptApp.getProjectTriggers();
  const hasPoller = triggers.some(t => t.getHandlerFunction() === 'processCodeEmails');
  const hasWorker = triggers.some(t => t.getHandlerFunction() === 'resumeJobs');
  if (!hasPoller) { ScriptApp.newTrigger('processCodeEmails').timeBased().everyMinutes(CONFIG.POLL_MINUTES).create(); console.log('Self-healed missing processCodeEmails trigger.'); }
  if (!hasWorker) { ScriptApp.newTrigger('resumeJobs').timeBased().everyMinutes(CONFIG.WORKER_MINUTES).create(); console.log('Self-healed missing resumeJobs trigger.'); }
}

function deleteManagedTriggers_() { for (const trigger of ScriptApp.getProjectTriggers()) if (isManagedTrigger_(trigger)) ScriptApp.deleteTrigger(trigger); }
function isManagedTrigger_(trigger) { return CONFIG.MANAGED_TRIGGER_NAMES.indexOf(trigger.getHandlerFunction()) !== -1; }
function countQueuedJobs_() {
  try {
    const files = getOrCreateJobFolder_().getFilesByType(MimeType.PLAIN_TEXT);
    let count = 0; while (files.hasNext()) { files.next(); count++; }
    return count;
  } catch (err) { console.error('countQueuedJobs_ failed:', err); return -1; }
}
function hasTimedOut_(startTime) { return Date.now() - startTime >= CONFIG.MAX_EXECUTION_TIME_MS; }
function forceDriveAuth() { DriveApp.getRootFolder(); }

function recoverStuckJobs() {
  if (!isCodeAgentEnabled_()) throw new Error('CodeAgent is disabled. Run enableCodeAgent() first.');
  ensureManagedTriggers_();
  const files = getOrCreateJobFolder_().getFilesByType(MimeType.PLAIN_TEXT);
  let recovered = 0;
  while (files.hasNext()) {
    const file = files.next();
    try {
      const state = JSON.parse(file.getBlob().getDataAsString());
      if (state.stage === 'SEND_RESULT' || state.stage === 'FAILURE_PENDING') {
        state.nextAttemptAt = Date.now();
        state.deliveryError = state.deliveryError || 'Manual recovery requested.';
        saveState_(file, state); recovered++;
      }
    } catch (err) { console.error(`Could not inspect ${file.getName()}:`, err); }
  }
  console.log(`Recovered ${recovered} pending delivery job(s). Stable worker will handle them.`);
}

function inspectQueuedJobs() {
  const files = getOrCreateJobFolder_().getFilesByType(MimeType.PLAIN_TEXT);
  const jobs = [];
  while (files.hasNext()) {
    const file = files.next();
    try {
      const state = JSON.parse(file.getBlob().getDataAsString());
      jobs.push({
        fileName: file.getName(), jobId: state.jobId || null, stage: state.stage || null,
        nextAttemptAt: state.nextAttemptAt || 0,
        nextAttemptIso: state.nextAttemptAt ? new Date(Number(state.nextAttemptAt)).toISOString() : null,
        currentIndex: Number(state.currentIndex || 0),
        totalChunks: Array.isArray(state.chunks) ? state.chunks.length : 0,
        finalizeRetryCount: Number(state.finalizeRetryCount || 0), deliveryAttempts: Number(state.deliveryAttempts || 0),
        recipientEmail: state.recipientEmail || null, deliveryError: state.deliveryError || null, failureReason: state.failureReason || null
      });
    } catch (err) { jobs.push({ fileName: file.getName(), error: String(err) }); }
  }
  console.log(JSON.stringify(jobs, null, 2));
  return jobs;
}

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
 *      Gmail ─┐
 *      Slack ─┼──> normalize -> persistent CodeAgent job -> worker -> result
 *      GitHub ┘
 *
 * This makes future GitHub commits/PRs and Slack commands additive. The queue,
 * retry logic, state machine, safety controls, and Groq integration remain one
 * shared core.
 */
