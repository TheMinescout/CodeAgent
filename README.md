# 🤖 CodeAgent

A serverless AI coding assistant that lives directly inside your Gmail inbox.

CodeAgent turns an email into a persistent coding job: it reads your instructions and attached source files, sends the work to the Groq API, processes the job through a durable state machine, generates a finished HTML artifact, and emails the result back with a live Web App preview.

> **Current release: v9** — durability hardening: failure notices always reach a real inbox, orphaned results recover, and delivered messages can never be queued twice.

## ✨ Features

- **📨 Gmail → AI → Gmail** — Send an email labeled `CodeAgent`; CodeAgent processes it and sends the finished result back to you.
- **💾 Persistent job queue** — Jobs are stored in Google Drive as JSON state files, so work can continue across multiple executions instead of depending on one long-running script execution.
- **🧩 Chunked processing** — Large source files can be split into smaller persisted parts and processed over multiple worker runs.
- **🛠️ Multi-stage state machine** — Jobs move through durable stages such as `SUMMARY`, `PROCESS`, `FINALIZE`, and `SEND_RESULT`.
- **🌐 Live HTML previews** — Completed HTML is saved to Drive and exposed through the Apps Script Web App deployment.
- **📎 Result attachments** — Completion emails include the generated HTML file as an attachment.
- **🔁 Automatic trigger recovery** — The project maintains two managed triggers and can recreate a missing polling or worker trigger when the agent is enabled.
- **🧯 Safe recovery tools** — Existing jobs can be recovered without deleting their generated artifacts.
- **✅ Output validation** — CodeAgent checks generated standalone HTML for required document structure and attempts a repair pass when the model truncates its output.
- **🧠 Safer prompting** — CodeAgent explicitly tells the model not to invent personal contact details, credentials, employers, hobbies, or other personal facts.
- **🔎 Queue diagnostics** — `inspectQueuedJobs()` exposes job state, retry timestamps, delivery attempts, result-lookup failures, and recorded errors.
- **📬 Reliable failure notices** — failures are emailed to the persisted recipient, then the sender of the original message, then the script owner, so a job never dies silently and never reaches an unrelated thread participant.
- **♻️ Orphan recovery** — a result file that cannot be read is retried, then reported instead of waiting forever; `recoverStuckJobs()` requeues it for another attempt.
- **🚫 No duplicate jobs** — delivered message IDs are remembered, so a failed `markRead()` cannot make the same email run twice.
- **⏳ Bounded queue lifetime** — jobs that stay unfinished for seven days are failed with a notice instead of occupying the queue.

## 🧠 How It Works

```text
Gmail
  │
  │ email labeled "CodeAgent"
  ▼
processCodeEmails
  │
  │ create persistent JSON job
  ▼
Google Drive job queue
  │
  ▼
resumeJobs
  │
  ├── SUMMARY
  ├── PROCESS
  ├── FINALIZE
  └── SEND_RESULT
          │
          ├── completed HTML → Drive
          └── result email → Gmail
```

The Gmail poller and worker are intentionally separated. The poller only finds and queues work. The worker processes persisted jobs independently. This makes the system much more resilient to execution limits, rate limits, and temporary failures.

## 🚀 Setup

### 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com/).
2. Create a new Apps Script project.
3. Copy `code.gs` from this repository into the Apps Script editor.

### 2. Deploy the preview Web App

1. In Apps Script, select **Deploy → New deployment**.
2. Choose **Web app**.
3. Configure access for the intended users.
4. Deploy it and copy the resulting Web App URL.

The Web App URL is used when CodeAgent creates the live preview link for completed HTML files.

### 3. Add Script Properties

Open **Project Settings → Script properties** and add:

| Property | Value |
|---|---|
| `GROQ_API_KEY` | Your Groq API key |
| `WEB_APP_URL` | Your deployed Apps Script Web App URL |

Do not commit your API key to GitHub.

CodeAgent manages one additional property on its own: `PROCESSED_MESSAGE_IDS` records recently delivered Gmail messages so the same email cannot be queued twice. It is safe to delete, and it is rebuilt automatically.

### 4. Set up Gmail

Create a Gmail label named exactly:

```text
CodeAgent
```

Create a Gmail filter that applies the `CodeAgent` label to the messages you want CodeAgent to process. A simple approach is to send requests to yourself and use a keyword such as `[CODE]` in the subject.

When a job is created, CodeAgent stores the source message/thread identifiers and the recipient address in the persistent job state.

### 5. Initialize and enable CodeAgent

Run these functions from the Apps Script editor in this order:

```javascript
initializeCodeAgent();
```

This safely removes old CodeAgent-managed triggers and leaves the agent disabled.

Then run:

```javascript
enableCodeAgent();
```

This enables the agent and creates the two managed triggers:

- `processCodeEmails` — Gmail intake every **5 minutes**.
- `resumeJobs` — persistent worker every **1 minute**.

You do **not** need to manually create these triggers when using `enableCodeAgent()`.

### 6. Grant Drive permissions

Run this once manually if Apps Script requests Drive authorization:

```javascript
forceDriveAuth();
```

CodeAgent uses Google Drive to persist job state and store generated HTML artifacts.

## 🛠️ Usage

Send yourself an email with the `CodeAgent` label applied.

Put your coding instructions in the email body and attach source files when needed. CodeAgent can work with pasted code and supported text-based attachments such as HTML, CSS, JavaScript, JSON, Markdown, SVG, Vue, and Svelte files.

A normal job looks like:

```text
Email received
    ↓
Job created
    ↓
SUMMARY (when source needs summarization)
    ↓
PROCESS
    ↓
FINALIZE
    ↓
SEND_RESULT
    ↓
Completion email + HTML attachment + live preview
```

A waiting job does not block unrelated jobs behind it. This is especially important when a transient Groq or Gmail retry timestamp is active.

## 🔧 Useful Admin Functions

### Check system status

```javascript
showCodeAgentStatus();
```

Reports the enabled state, integration configuration, Gmail pause state, queue size, and managed triggers.

### Inspect queued jobs

```javascript
inspectQueuedJobs();
```

Prints the current queue state, including job stage, retry time, chunk progress, recipient, delivery attempts, result-lookup failures, and recorded errors.

### Run one worker pass manually

```javascript
runWorkerOnce();
```

Useful for testing or immediately processing an existing queued job without waiting for the next scheduled worker execution.

### Recover stuck delivery jobs

```javascript
recoverStuckJobs();
```

Resets pending `SEND_RESULT` / failure-delivery jobs so the normal worker can inspect them again without deleting their generated artifacts. Orphaned results are requeued for another lookup attempt.

### Clear a temporary Gmail pause

```javascript
clearGmailPauseAndResume();
```

Use this when Gmail delivery has been paused because of a service/quota error and you intentionally want the worker to retry.

### Emergency stop

```javascript
emergencyStop();
```

Disables CodeAgent and removes the managed triggers while preserving existing Drive jobs.

## 🧪 v9 Reliability Changes

v9 keeps the v8 architecture and closes the durability gaps that v8 could still hit. The most important changes are:

- Failure notices resolve a recipient from the persisted job state, then the sender of the original message, then the script owner. The previous release could call an undefined helper and retry the notice forever; the thread's latest participant is never used, so a forwarded thread cannot leak a partial result.
- A missing result file is retried up to three times before a job is marked orphaned, and an orphaned job now notifies the user instead of waiting silently.
- `recoverStuckJobs()` requeues orphaned results so a transient Drive problem can still end in a delivery.
- Delivered message IDs are stored in the `PROCESSED_MESSAGE_IDS` script property, which prevents duplicate jobs when `markRead()` fails after a successful delivery.
- Jobs older than seven days that have not produced a result are failed with a notice, which keeps the queue bounded.
- Retry handling is stage-aware: an incomplete model response can no longer rewind the state machine from `SUMMARY` or `PROCESS` back to `FINALIZE`.
- The state machine is covered by a Node test suite with an Apps Script shim (`npm test`).

### v8 changes carried forward

- Completion delivery uses the persisted `recipientEmail` instead of requiring the original Gmail thread to remain available.
- A waiting job no longer prevents later jobs from being inspected.
- Generated standalone HTML must contain the expected document structure before it is accepted as a finished result.
- Truncated HTML receives a repair pass rather than being immediately treated as a successful artifact.
- The coding prompt explicitly prohibits fabricated personal information.
- Queue inspection is available through `inspectQueuedJobs()`.
- Gmail quota failures are recorded in persistent state and retried instead of deleting the generated result.

## 🧪 Tests

The state machine and the Gmail/Drive edge cases are covered by a dependency-free Node test suite:

```bash
npm test
```

`tests/gas-shim.js` loads `code.gs` into a `vm` context with in-memory implementations of the Apps Script services CodeAgent uses (`PropertiesService`, `DriveApp`, `GmailApp`, `UrlFetchApp`, `ScriptApp`, `LockService`, `Session`). The tests then drive real CodeAgent functions; nothing in `code.gs` is mocked or stubbed.

The suite covers chunk splitting, HTML extraction and validation, job creation and dedupe, the full `PROCESS → FINALIZE → SEND_RESULT` pipeline, failure-notice routing, Gmail quota pauses, orphaned-result recovery, job expiry, and queue diagnostics.

## ⚠️ Quotas & Limitations

CodeAgent is designed around persistence rather than trying to eliminate platform limits.

- Google Apps Script execution, Gmail, Drive, and trigger quotas still apply.
- Groq rate limits can delay processing; the worker uses persisted retry timestamps instead of sleeping inside an execution.
- Gmail quota errors can temporarily pause email operations while Drive/Groq work remains independent.
- Live previews depend on the Apps Script Web App deployment and its access configuration.
- The project is not a production-grade multi-user SaaS system; it is a lightweight serverless coding assistant built around a personal Gmail workflow.

## 📁 Repository

The main Apps Script implementation is:

```text
code.gs
```

The GitHub repository is:

[TheMinescout/CodeAgent](https://github.com/TheMinescout/CodeAgent)

## 📄 License

See [`LICENSE`](LICENSE).
