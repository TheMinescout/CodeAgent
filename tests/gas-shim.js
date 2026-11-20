'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE_PATH = path.join(__dirname, '..', 'code.gs');

function iterator(items) {
  let index = 0;
  return {
    hasNext: () => index < items.length,
    next: () => items[index++]
  };
}

function makeFile({ id, name, content, mimeType }) {
  const file = {
    id,
    name,
    content,
    mimeType,
    trashed: false,
    getId: () => file.id,
    getName: () => file.name,
    getBlob: () => ({ getDataAsString: () => file.content }),
    setContent: next => { file.content = next; },
    setTrashed: value => { file.trashed = value !== false; },
    getUrl: () => `https://drive.example/${file.id}`,
    setSharing: () => {}
  };
  return file;
}

function createEnvironment(options = {}) {
  const properties = new Map(Object.entries(options.properties || {}));
  const folders = new Map();
  const files = new Map();
  const threads = new Map();
  const sentEmails = [];
  const replies = [];
  const logs = [];
  const triggers = [];
  let fileSequence = 0;

  const ownerEmail = options.ownerEmail === undefined ? 'owner@example.com' : options.ownerEmail;
  const fetchHandler = options.fetch || (() => ({
    code: 200,
    body: { choices: [{ message: { content: '```html\n<!DOCTYPE html><html><head></head><body>ok</body></html>\n```' } }] }
  }));

  function createFileRecord(name, content, mimeType) {
    const file = makeFile({ id: `file_${++fileSequence}`, name, content, mimeType });
    files.set(file.id, file);
    return file;
  }

  function makeFolder(name) {
    const folder = {
      name,
      contents: [],
      createFile(fileName, content, mimeType) {
        const file = createFileRecord(fileName, content, mimeType);
        folder.contents.push(file);
        return file;
      },
      getFilesByType(mimeType) {
        const matching = folder.contents.filter(file => !file.trashed && (!mimeType || file.mimeType === mimeType));
        return iterator(matching);
      }
    };
    return folder;
  }

  function makeMessage({ id, from, plainBody = '', attachments = [] }) {
    return {
      getId: () => id,
      getFrom: () => from,
      getPlainBody: () => plainBody,
      getAttachments: () => attachments.map(attachment => ({
        getName: () => attachment.name,
        getContentType: () => attachment.contentType || 'text/plain',
        getDataAsString: () => attachment.content || ''
      })),
      reply: (body, replyOptions) => { replies.push({ messageId: id, body, options: replyOptions }); }
    };
  }

  function makeThread({ id, messages }) {
    const thread = {
      id,
      messages,
      read: false,
      getId: () => id,
      getMessages: () => thread.messages,
      markRead: () => { thread.read = true; }
    };
    return thread;
  }

  const DriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
    getFoldersByName(name) {
      return iterator(folders.has(name) ? [folders.get(name)] : []);
    },
    createFolder(name) {
      const folder = makeFolder(name);
      folders.set(name, folder);
      return folder;
    },
    createFile(name, content, mimeType) {
      return createFileRecord(name, content, mimeType);
    },
    getFileById(id) {
      const file = files.get(id);
      if (!file || file.trashed) throw new Error(`No item with the given ID could be found: ${id}`);
      return file;
    },
    getRootFolder() {
      return { getId: () => 'root' };
    }
  };

  const GmailApp = {
    search() {
      return Array.from(threads.values()).filter(thread => !thread.read);
    },
    getThreadById(id) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Invalid thread id: ${id}`);
      return thread;
    },
    sendEmail(recipient, subject, body, sendOptions) {
      sentEmails.push({ recipient, subject, body, options: sendOptions });
    }
  };

  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    newTrigger(handler) {
      return {
        timeBased() {
          return {
            everyMinutes(minutes) {
              return {
                create() {
                  const trigger = {
                    handler,
                    minutes,
                    getHandlerFunction: () => handler,
                    getTriggerSource: () => 'CLOCK',
                    getEventType: () => 'CLOCK'
                  };
                  triggers.push(trigger);
                  return trigger;
                }
              };
            }
          };
        }
      };
    },
    deleteTrigger(trigger) {
      const index = triggers.indexOf(trigger);
      if (index !== -1) triggers.splice(index, 1);
    }
  };

  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => (properties.has(key) ? properties.get(key) : null),
        setProperty: (key, value) => { properties.set(key, String(value)); },
        deleteProperty: key => { properties.delete(key); }
      })
    },
    DriveApp,
    GmailApp,
    ScriptApp,
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },
    UrlFetchApp: {
      fetch(url, fetchOptions) {
        const payload = JSON.parse(fetchOptions.payload);
        const response = fetchHandler(payload, url);
        return {
          getResponseCode: () => response.code,
          getContentText: () => JSON.stringify(response.body)
        };
      }
    },
    Utilities: {
      newBlob: (data, mimeType, name) => ({
        data,
        mimeType,
        name,
        getDataAsString: () => String(data)
      })
    },
    HtmlService: {
      createHtmlOutput: html => {
        const output = {
          html,
          setTitle() { return output; },
          addMetaTag() { return output; }
        };
        return output;
      }
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => ownerEmail })
    },
    MimeType: { PLAIN_TEXT: 'text/plain', HTML: 'text/html' },
    console: {
      log: (...args) => logs.push({ level: 'log', args }),
      warn: (...args) => logs.push({ level: 'warn', args }),
      error: (...args) => logs.push({ level: 'error', args })
    }
  };

  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context, { filename: 'code.gs' });

  return {
    context,
    properties,
    threads,
    sentEmails,
    replies,
    logs,
    triggers,
    ownerEmail,
    eval: expression => vm.runInContext(expression, context),
    addThread({ id, messages }) {
      const thread = makeThread({ id, messages: messages.map(message => makeMessage(message)) });
      threads.set(id, thread);
      return thread;
    },
    addMessage(threadId, message) {
      const thread = threads.get(threadId);
      thread.messages.push(makeMessage(message));
      return thread;
    },
    jobFiles() {
      const folder = folders.get('CodeAgent_Jobs');
      if (!folder) return [];
      return folder.contents.filter(file => !file.trashed);
    },
    jobStates() {
      const folder = folders.get('CodeAgent_Jobs');
      if (!folder) return [];
      return folder.contents.filter(file => !file.trashed).map(file => JSON.parse(file.content));
    },
    createJob(state) {
      const folder = folders.get('CodeAgent_Jobs') || DriveApp.createFolder('CodeAgent_Jobs');
      const file = folder.createFile(`${state.jobId}.json`, JSON.stringify(state), 'text/plain');
      return { file, state };
    },
    readState(file) {
      return JSON.parse(file.content);
    },
    writeState(file, state) {
      file.content = JSON.stringify(state);
      return state;
    },
    allFiles: () => Array.from(files.values())
  };
}

function makeJob(overrides = {}) {
  return {
    version: 9,
    jobId: overrides.jobId || 'job_test_1',
    threadId: overrides.threadId || 'thread_1',
    messageId: overrides.messageId || 'message_1',
    recipientEmail: overrides.recipientEmail === undefined ? 'user@example.com' : overrides.recipientEmail,
    instruction: 'Build a page',
    sourceText: '',
    fileSummary: 'A page',
    chunks: [''],
    processedParts: [],
    currentIndex: 0,
    stage: 'PROCESS',
    isChunked: false,
    retryCount: 0,
    finalizeRetryCount: 0,
    deliveryAttempts: 0,
    resultLookupFailures: 0,
    nextAttemptAt: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

const COMPLETE_HTML = '<!DOCTYPE html>\n<html>\n<head><title>t</title></head>\n<body>hello</body>\n</html>';

module.exports = { createEnvironment, makeJob, COMPLETE_HTML };
