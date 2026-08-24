# 🤖 CodeAgent

A 100% free, serverless AI coding assistant that lives directly inside your Gmail inbox. 

CodeAgent reads unread emails labeled `CodeAgent`, extracts text attachments or pasted code, processes instructions using the Groq API (bypassing context and execution limits via a custom state machine), and emails you back the finished code along with a live Web App preview link.

## ✨ Features
* **Inbox to Live Preview:** Emails you a styled HTML response with a direct link to run the generated code in a new tab.
* **Massive File Support:** Uses a persistent state machine to chunk large files and bypass Google Apps Script's strict 6-minute execution limit.
* **100% Free Infrastructure:** Built on Google Apps Script (free tier) and the Groq API (free tier).

## 🚀 Setup Instructions

1. **Create the Apps Script Project**
   * Go to [script.google.com](https://script.google.com) and create a new project.
   * Copy the contents of `Code.js` from this repository and paste it into the editor.

2. **Deploy the Preview Server**
   * Click **Deploy** -> **New deployment**.
   * Choose **Web app**, set access to **Anyone**, and click Deploy.
   * Copy the resulting Web App URL.

3. **Set Script Properties**
   * In your Apps Script Project Settings (gear icon), add two Script Properties:
     * `GROQ_API_KEY`: Your free API key from console.groq.com.
     * `WEB_APP_URL`: The URL you copied in Step 2.

4. **Set Up Gmail**
   * Create a label in Gmail called exactly `CodeAgent`.
   * Create a filter to automatically apply this label to emails you send to yourself with a specific keyword (e.g., `[CODE]`).

5. **Create the Trigger**
   * In Apps Script, go to Triggers (clock icon) -> Add Trigger.
   * Set `processCodeEmails` to run on a **Time-driven** -> **Minutes timer** -> **Every minute**.
   * Run the `forceDriveAuth()` function once manually in the editor to grant Google Drive permissions for the state machine.

## 🛠️ Usage
Send an email to yourself with the `CodeAgent` label applied. Write your instructions in the email body, and attach any `.html`, `.css`, or `.js` files you want the AI to read. Within a minute or two, the agent will reply with your finished code!
