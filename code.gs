/**
 * --------------------------------------------------------------
 *  Google Apps Script – Code-Agent + Live Preview (State Machine)
 * --------------------------------------------------------------
 *  1) doGet(e)            – Serves the preview HTML file.
 *  2) processCodeEmails() – (Main Trigger) Finds unread emails, creates Job files.
 *  3) resumeJobs()        – (Auto Trigger) Resumes paused jobs.
 * --------------------------------------------------------------
 */

const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();
const API_KEY = SCRIPT_PROPERTIES.getProperty('GROQ_API_KEY');
const WEB_APP_URL = SCRIPT_PROPERTIES.getProperty('WEB_APP_URL');
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';

// ---- Rate-limit & Execution Budget ---------------------------------------
const TPM_LIMIT = 8000;
const CHARS_PER_TOKEN_ESTIMATE = 3.2; 
const PROMPT_OVERHEAD_TOKENS = 500;   
const OUTPUT_RESERVE_TOKENS = 3000;   
const CHUNK_INPUT_TOKEN_BUDGET = TPM_LIMIT - PROMPT_OVERHEAD_TOKENS - OUTPUT_RESERVE_TOKENS; 
const CHUNK_CHAR_BUDGET = Math.floor(CHUNK_INPUT_TOKEN_BUDGET * CHARS_PER_TOKEN_ESTIMATE);

const DELAY_BETWEEN_CALLS_MS = 65 * 1000; 
const MAX_RETRIES = 4;
const GMAIL_SEARCH_QUERY = 'label:CodeAgent is:unread';
const MAX_TOTAL_INPUT_CHARS = 400000; 

// ---- State Machine Budget ------------------------------------------------
// Google kills scripts at 6.0 minutes. We stop cleanly at 4.5 minutes to save state.
const MAX_EXECUTION_TIME_MS = 4.5 * 60 * 1000; 
const JOB_FOLDER_NAME = 'CodeAgent_Jobs';

// -------------------------------------------------------------------
// 1) Live-preview endpoint (Web-App)
// -------------------------------------------------------------------
function doGet(e) {
  const id = e?.parameter?.id;
  if (!id) return HtmlService.createHtmlOutput('No preview ID provided.');

  try {
    const file = DriveApp.getFileById(id);
    const html = file.getBlob().getDataAsString();
    return HtmlService
      .createHtmlOutput(html)
      .setTitle('Code Preview')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    Logger.log('doGet error: ' + err);
    return HtmlService.createHtmlOutput('Preview expired or not found.');
  }
}

// -------------------------------------------------------------------
// 2) Orchestrators: Email Reader & Job Resumer
// -------------------------------------------------------------------
function processCodeEmails() {
  if (!API_KEY) {
    Logger.log('GROQ_API_KEY script property is missing.');
    return;
  }
  
  const startTime = Date.now();
  
  // 1. Process any pending jobs first
  processPendingJobs_(startTime);
  if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) return;

  // 2. Look for new emails to create new jobs
  const threads = GmailApp.search(GMAIL_SEARCH_QUERY);
  Logger.log(`Found ${threads.length} unread thread(s) to process.`);

  for (const thread of threads) {
    if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
      scheduleResume_();
      return;
    }

    try {
      initializeJobFromThread_(thread);
    } catch (err) {
      Logger.log(`Error initializing thread ${thread.getId()}: ${err}`);
    } finally {
      thread.markRead(); // Mark read immediately so we don't duplicate jobs
    }
  }

  // 3. Process the newly created jobs
  processPendingJobs_(startTime);
}

// Auto-Trigger entry point for paused jobs
function resumeJobs() {
  const startTime = Date.now();
  cleanUpTriggers_(); // Remove the one-time trigger that fired this
  processPendingJobs_(startTime);
}

// -------------------------------------------------------------------
// 3) State Machine Logic (Job Management)
// -------------------------------------------------------------------
function processPendingJobs_(startTime) {
  const folder = getOrCreateJobFolder_();
  const files = folder.getFilesByType(MimeType.PLAIN_TEXT);

  while (files.hasNext()) {
    if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
      scheduleResume_();
      return;
    }
    const file = files.next();
    processSingleJob_(file, startTime);
  }
}

function initializeJobFromThread_(thread) {
  const messages = thread.getMessages();
  const latestMessage = messages[messages.length - 1];

  const instruction = latestMessage.getPlainBody().trim();
  const sourceText = collectSourceText_(latestMessage);

  if (!sourceText.trim()) {
    latestMessage.reply(
      '🤖 I didn\'t find any file content to work with — attach the file ' +
      '(or paste it in the email body) along with your instructions.'
    );
    return;
  }

  const chunks = splitIntoChunks_(sourceText);
  const isChunked = chunks.length > 1;

  latestMessage.reply(
    isChunked
      ? `⚡ Your file is large, so I'm processing it in ${chunks.length} parts to stay ` +
        `under the free API's rate limit. This will take a few minutes — I'll email you ` +
        `the finished result when it's done.`
      : '⚡ Writing your code and generating a live preview environment…'
  );

  const fileSummary = summarizeFilePurpose_(sourceText);

  // Define Job State
  const state = {
    jobId: `job_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    threadId: thread.getId(),
    messageId: latestMessage.getId(),
    instruction: instruction,
    fileSummary: fileSummary,
    chunks: chunks,
    processedParts: [],
    currentIndex: 0,
    isChunked: isChunked
  };

  const folder = getOrCreateJobFolder_();
  folder.createFile(`${state.jobId}.json`, JSON.stringify(state), MimeType.PLAIN_TEXT);
}

function processSingleJob_(file, startTime) {
  const state = JSON.parse(file.getBlob().getDataAsString());
  
  const thread = GmailApp.getThreadById(state.threadId);
  if (!thread) {
    file.setTrashed(true); // Thread deleted, trash job
    return;
  }
  
  const messages = thread.getMessages();
  const message = messages.find(m => m.getId() === state.messageId) || messages[messages.length - 1];

  while (state.currentIndex < state.chunks.length) {
    // Check if we are running out of Google execution time
    if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
      file.setContent(JSON.stringify(state)); // Save progress
      scheduleResume_();
      return; 
    }

    const i = state.currentIndex;
    Logger.log(`Job ${state.jobId}: Processing chunk ${i + 1}/${state.chunks.length}...`);

    const chunkResult = processChunk_({
      instruction: state.instruction,
      fileSummary: state.fileSummary,
      chunk: state.chunks[i],
      chunkIndex: i,
      totalChunks: state.chunks.length
    });

    if (!chunkResult.ok) {
      message.reply(
        `🤖 Failed while processing part ${i + 1} of ${state.chunks.length}: ${chunkResult.errorMessage}\n\n` +
        `Parts completed before the failure are attached so you don't lose that work.`,
        state.processedParts.length > 0
          ? { attachments: [Utilities.newBlob(state.processedParts.join('\n\n'), MimeType.HTML, 'partial_result.html')] }
          : {}
      );
      file.setTrashed(true);
      return;
    }

    state.processedParts.push(chunkResult.generatedText);
    state.currentIndex++;
    file.setContent(JSON.stringify(state)); // Incrementally save

    // Respect TPM: wait before the next call unless this was the last chunk.
    if (state.currentIndex < state.chunks.length) {
      Utilities.sleep(DELAY_BETWEEN_CALLS_MS);
    }
  }

  // ---- Reassemble Phase ----
  let finalHtml;
  if (state.isChunked) {
    finalHtml = reassembleChunks_(state.processedParts, state.instruction, state.fileSummary);
  } else {
    finalHtml = extractHtml_(state.processedParts[0]);
  }

  if (!finalHtml || !finalHtml.trim()) {
    message.reply('🤖 The AI finished, but I couldn\'t extract usable code from the result.');
    file.setTrashed(true);
    return;
  }

  const fileName = `CodePreview_${Date.now()}.html`;
  const htmlFile = DriveApp.createFile(fileName, finalHtml, MimeType.HTML);
  htmlFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const previewUrl = WEB_APP_URL
    ? `${WEB_APP_URL}?id=${htmlFile.getId()}`
    : htmlFile.getUrl();

  const emailHtml = buildEmailBody_(previewUrl, state.isChunked, state.chunks.length);
  const attachmentBlob = Utilities.newBlob(finalHtml, MimeType.HTML, fileName);

  message.reply('', {
    htmlBody: emailHtml,
    attachments: [attachmentBlob]
  });

  file.setTrashed(true); // Job complete, cleanup file
}

// ---- Job & Trigger Helpers ----
function getOrCreateJobFolder_() {
  const folders = DriveApp.getFoldersByName(JOB_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(JOB_FOLDER_NAME);
}

function scheduleResume_() {
  cleanUpTriggers_(); // Prevent duplicate triggers
  ScriptApp.newTrigger('resumeJobs')
    .timeBased()
    .after(60 * 1000) // Run again in ~1 minute
    .create();
  Logger.log("Execution time limit approaching. Scheduled resume trigger.");
}

function cleanUpTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'resumeJobs') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

// -------------------------------------------------------------------
// 4) Core AI & Text Parsing Logic (Unchanged)
// -------------------------------------------------------------------
function collectSourceText_(latestMessage) {
  let text = '';
  const attachments = latestMessage.getAttachments();
  for (const att of attachments) {
    const name = att.getName();
    const type = att.getContentType();
    const isTextLike = type.includes('text') || name.endsWith('.js') || name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.json') || name.endsWith('.md');
    if (!isTextLike) continue;
    const txt = att.getDataAsString();
    text += `\n\n/* --- Attached File: ${name} --- */\n${txt}`;
  }
  if (text.length > MAX_TOTAL_INPUT_CHARS) {
    text = text.substring(0, MAX_TOTAL_INPUT_CHARS) + '\n...[truncated: file exceeded hard size limit]';
  }
  return text;
}

function splitIntoChunks_(sourceText) {
  if (sourceText.length <= CHUNK_CHAR_BUDGET) return [sourceText];
  const chunks = [];
  let remaining = sourceText;
  const breakPatterns = [ /\n\s*\n/g, /<\/[a-zA-Z]+>\s*\n/g, /}\s*\n/g, /\n/g ];

  while (remaining.length > CHUNK_CHAR_BUDGET) {
    const window = remaining.substring(0, CHUNK_CHAR_BUDGET);
    let splitAt = -1;
    for (const pattern of breakPatterns) {
      pattern.lastIndex = 0;
      let match;
      let lastMatchEnd = -1;
      while ((match = pattern.exec(window)) !== null) {
        lastMatchEnd = match.index + match[0].length;
      }
      if (lastMatchEnd > CHUNK_CHAR_BUDGET * 0.5) { 
        splitAt = lastMatchEnd;
        break;
      }
    }
    if (splitAt === -1) splitAt = CHUNK_CHAR_BUDGET; 
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function summarizeFilePurpose_(sourceText) {
  const previewChars = Math.floor(CHUNK_CHAR_BUDGET * 0.6);
  const preview = sourceText.length > previewChars ? sourceText.substring(0, previewChars) + '\n...[rest of file omitted for this summary]' : sourceText;
  const payload = {
    model: GROQ_MODEL,
    max_completion_tokens: 300,
    messages: [
      { role: 'system', content: 'Summarize the purpose and structure of code/files in 2-3 sentences. Be concise.' },
      { role: 'user', content: `Summarize what this file is and how it's structured:\n\n${preview}` }
    ]
  };
  const result = callGroqWithRetry_(payload);
  if (!result.ok) {
    Logger.log('Summary call failed: ' + result.errorMessage);
    return '(No summary available.)';
  }
  return result.generatedText.trim();
}

function processChunk_({ instruction, fileSummary, chunk, chunkIndex, totalChunks }) {
  const positionNote = totalChunks > 1
    ? `This is part ${chunkIndex + 1} of ${totalChunks} of a larger file that was split due to size. Overall file summary: ${fileSummary}\n\nApply the instruction below to THIS PART ONLY. Keep your output consistent in style with the rest of the file (same conventions, naming, structure) since the parts will be reassembled in order afterward. Do not add a full HTML document wrapper (<html>, <head>, <body>) to this part unless this part itself contains those tags in the original — a final assembly pass will handle the overall document structure.\n\n`
    : '';

  const prompt = `${positionNote}User's instruction (apply to the content below):\n${instruction}\n\nContent to work on:\n${chunk}` +
    (totalChunks === 1
      ? `\n\nYou are an expert web developer. Output your final solution as a completely standalone, runnable HTML file inside a single \`\`\`html codeblock. If you write React, import React, ReactDOM, and Babel via unpkg CDNs so it runs without build tools. Make it look beautiful.`
      : `\n\nOutput only the transformed content for this part inside a single \`\`\`html codeblock (or \`\`\`\` if not HTML), with no extra commentary.`);

  const payload = {
    model: GROQ_MODEL,
    max_completion_tokens: OUTPUT_RESERVE_TOKENS,
    messages: [
      { role: 'system', content: 'You are a helpful expert coding assistant.' },
      { role: 'user', content: prompt }
    ]
  };
  const result = callGroqWithRetry_(payload);
  if (!result.ok) return result;
  return { ok: true, generatedText: extractHtml_(result.generatedText) };
}

function reassembleChunks_(processedParts, instruction, fileSummary) {
  const combined = processedParts.join('\n\n');
  if (combined.length <= CHUNK_CHAR_BUDGET) {
    const prompt = `The following content was produced by processing a large file in ${processedParts.length} parts and concatenating the results. The original instruction was: "${instruction}"\nFile summary: ${fileSummary}\n\nClean up the seams between parts (remove duplicate HTML wrappers, fix any mismatched or incomplete tags, ensure it is valid) WITHOUT changing the actual content or logic. Output the final, complete, standalone HTML file inside a single \`\`\`html codeblock.\n\nContent:\n${combined}`;
    const payload = {
      model: GROQ_MODEL,
      max_completion_tokens: OUTPUT_RESERVE_TOKENS,
      messages: [
        { role: 'system', content: 'You are a helpful expert coding assistant specializing in merging code fragments cleanly.' },
        { role: 'user', content: prompt }
      ]
    };
    const result = callGroqWithRetry_(payload);
    if (result.ok) return extractHtml_(result.generatedText);
    Logger.log('Final cleanup pass failed: ' + result.errorMessage);
  }
  if (/<html[\s>]/i.test(combined)) return combined;
  return `<!DOCTYPE html>\n<html>\n<head><meta charset="UTF-8"></head>\n<body>\n${combined}\n</body>\n</html>`;
}

function callGroqWithRetry_(payload) {
  const options = {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${API_KEY}` }, payload: JSON.stringify(payload)
  };
  let retries = 0;
  while (retries <= MAX_RETRIES) {
    let response;
    try { response = UrlFetchApp.fetch(API_URL, options); } 
    catch (err) { return { ok: false, errorMessage: 'Network error calling Groq: ' + err.toString() }; }

    const responseCode = response.getResponseCode();
    if (responseCode === 429) {
      const backoff = Math.pow(2, retries) * 3000 + 2000;
      Utilities.sleep(backoff);
      retries++;
      continue;
    }
    
    let data;
    try { data = JSON.parse(response.getContentText()); } 
    catch (err) { return { ok: false, errorMessage: `Unreadable response (HTTP ${responseCode}).` }; }
    if (data.error) return { ok: false, errorMessage: 'Error from AI: ' + data.error.message };
    if (responseCode !== 200) return { ok: false, errorMessage: `AI request failed with HTTP ${responseCode}.` };
    
    const generatedText = data.choices?.[0]?.message?.content ?? '';
    if (!generatedText) return { ok: false, errorMessage: 'The AI returned an empty response.' };
    return { ok: true, generatedText };
  }
  return { ok: false, errorMessage: 'Gave up after repeated rate-limit (429) responses.' };
}

function extractHtml_(generatedText) {
  const htmlMatch = generatedText.match(/```html\s*([\s\S]*?)```/i) || generatedText.match(/```\s*([\s\S]*?)```/);
  return htmlMatch ? htmlMatch[1] : generatedText;
}

function buildEmailBody_(previewUrl, wasChunked, chunkCount) {
  const chunkNote = wasChunked ? `<p style="color:#6b7280;font-size:14px;">Processed in ${chunkCount} parts and reassembled due to file size.</p>` : '';
  return `
<div style="font-family:Arial,sans-serif;padding:20px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb;max-width:600px;">
  <h2 style="color:#111827;margin-top:0;">🎉 Your Code is Ready!</h2>
  <p style="color:#4b5563;font-size:16px;">I generated the requested code and set up a live preview for you.</p>
  ${chunkNote}
  <div style="margin:25px 0;">
    <a href="${previewUrl}" target="_blank"
       style="background:#3b82f6;color:white;padding:14px 24px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:16px;display:inline-block;">
      🚀 Open Preview
    </a>
  </div>
  <p style="color:#6b7280;font-size:14px;"><em>* The raw HTML file is attached to this email.</em></p>
</div>`;
}

function escapeHtml_(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function forceDriveAuth() { DriveApp.getRootFolder(); }
