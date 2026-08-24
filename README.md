# 🤖 CodeAgent

A serverless AI coding assistant that lives directly inside your Gmail inbox.

CodeAgent turns an email into a persistent coding job: it reads your instructions and attached source files, sends the work to the Groq API, processes the job through a durable state machine, generates a finished HTML artifact, and emails the result back with a live Web App preview.

> **Status:** Experimental / personal project. CodeAgent is designed to stay lightweight and inexpensive, but Google Apps Script and Groq quotas still apply.

## ✨ Features

- **📨 Gmail → AI → Gmail** — Send an email labeled `CodeAgent`; CodeAgent processes it and sends the finished result back to you.
- **💾 Persistent job queue** — Jobs are stored in Google Drive as JSON state files, so work can continue across multiple executions instead of depending on one long-running script execution.
- **🧩 Chunked processing** — Large source files can be split into smaller persisted parts and processed over multiple worker runs.
- **🛠️ Multi-stage state machine** — Jobs move through durable stages such as `SUMMARY`, `PROCESS`, `FINALIZE`, and `SEND_RESULT`.
- **🌐 Live HTML previews** — Completed HTML is saved to Drive and exposed through the Apps Script Web App deployment.
- **📎 Result attachments** — Completion emails include the generated HTML file as an attachment.
- **🔁 Automatic trigger recovery** — The project maintains two managed triggers and can recreate a missing polling or worker trigger when the agent is enabled.
- **🧯 Safe recovery tools** — Existing jobs can be recovered without deleting their generated artifacts.
- **🔌 Future integration ready** — The queue architecture is designed so additional front ends can eventually feed the same worker pipeline.

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

The important design choice is that Gmail intake and AI processing are separate. The Gmail poller only finds and queues work. The worker processes persisted jobs independently. This makes the system much more resilient to execution limits, rate limits, and temporary failures.

## 🚀 Setup

### 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com/).
2. Create a new Apps Script project.
3. Copy `code.gs` from this repository into the Apps Script editor.

### 2. Deploy the preview Web App

1. In Apps Script, select **Deploy → New deployment**.
2. Choose **Web app**.
3. Configure the deployment so the intended users can access the preview.
4. Deploy it and copy the resulting Web App URL.

The Web App URL is used when CodeAgent creates the live preview link for completed HTML files.

### 3. Add Script Properties

Open **Project Settings → Script properties** and add:

| Property | Value |
|---|---|
| `GROQ_API_KEY` | Your Groq API key |
| `WEB_APP_URL` | Your deployed Apps Script Web App URL |

Do not commit your API key to GitHub.

### 4. Set up Gmail

Create a Gmail label named exactly:

```text
CodeAgent
```

Then create a Gmail filter that applies the `CodeAgent` label to the messages you want CodeAgent to process. A simple approach is to send requests to yourself and use a keyword such as `[CODE]` in the subject.

The worker records the original message/thread information when a job is created so the final result can be routed back after processing.

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

You do **not** need to manually create a separate `processCodeEmails` trigger when using `enableCodeAgent()`.

### 6. Grant Drive permissions

Run this once manually if Apps Script requests Drive authorization:

```javascript
forceDriveAuth();
```

CodeAgent uses Google Drive to persist job state and store generated HTML artifacts.

## 🛠️ Usage

Send yourself an email with the `CodeAgent` label applied.

Put your coding instructions in the email body and attach source files when needed. CodeAgent can work with pasted code and supported text-based attachments such as HTML, CSS, and JavaScript.

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

Processing may take multiple worker executions for larger jobs. That is intentional: the job state is persisted between executions rather than relying on one long-running Apps Script invocation.

## 🔧 Useful Admin Functions

### Check system status

```javascript
showCodeAgentStatus();
```

Reports the current enabled state, integration configuration, Gmail pause state, queue size, and managed triggers.

### Run one worker pass manually

```javascript
runWorkerOnce();
```

Useful for testing or immediately processing an existing queued job without waiting for the next scheduled worker execution.

### Recover stuck delivery jobs

```javascript
recoverStuckJobs();
```

Resets pending `SEND_RESULT` / failure-delivery jobs so the normal worker can inspect them again without deleting the generated artifact.

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

## ⚠️ Quotas & Limitations

CodeAgent is designed around persistence rather than trying to eliminate platform limits.

- Google Apps Script execution, Gmail, Drive, and trigger quotas still apply.
- Groq rate limits can delay processing; the worker uses persisted retry timestamps instead of sleeping inside an execution.
- Gmail quota errors can temporarily pause email operations while Drive/Groq work remains independent.
- Live previews depend on the Apps Script Web App deployment and its access configuration.
- The project is not a production-grade multi-user SaaS system; it is a lightweight serverless coding assistant built around a personal Gmail workflow.

## 📁 Repository

The repository currently contains the Apps Script implementation in:

```text
code.gs
```

The GitHub repository is:

[TheMinescout/CodeAgent](https://github.com/TheMinescout/CodeAgent)

## 📄 License

See [`LICENSE`](LICENSE).
