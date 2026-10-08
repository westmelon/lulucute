import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';

const ACTIVE_STATUSES = new Set(['running']);
const BULK_RETRYABLE_STATUSES = new Set(['failed', 'action-required']);
const RETRYABLE_STATUSES = new Set([...BULK_RETRYABLE_STATUSES, 'cancelled']);
const TASK_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'action-required', 'cancelled']);

function now() {
  return new Date().toISOString();
}

function resourceKey(resourceUrl, forums) {
  return createHash('sha256').update(normalizeTaskUrl(resourceUrl, forums)).digest('hex');
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

export function normalizeTaskUrl(value, forums = []) {
  const url = new URL(String(value).trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Unsupported task URL: ${value}`);
  if (url.username || url.password) throw new Error('Task URLs must not contain credentials');

  for (const forum of forums) {
    const normalized = forum.normalizeUrl?.(url.toString());
    if (normalized) return normalizeTaskUrl(normalized);
  }

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.searchParams.sort();
  return url.toString();
}

export class TaskQueue {
  constructor(filePath, { forums = [] } = {}) {
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.data = { version: 1, tasks: [], resources: [] };
    this.locked = false;
    this.pendingCancelSaves = new Map();
    this.forums = forums;
  }

  async open() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.acquireLock();
    try {
      this.data = await this.readData();
      const recovered = this.recoverInterrupted();
      if (recovered > 0) await this.save();
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async acquireLock() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`);
        } finally {
          await handle.close();
        }
        this.locked = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try {
          owner = JSON.parse(await readFile(this.lockPath, 'utf8'));
        } catch {
          throw new Error(`Task queue is locked and its owner cannot be read: ${this.lockPath}`);
        }
        if (processIsRunning(owner.pid)) {
          throw new Error(`Another resource-downloader process is using the task queue (pid ${owner.pid})`);
        }
        await unlink(this.lockPath);
      }
    }
    throw new Error(`Unable to acquire task queue lock: ${this.lockPath}`);
  }

  async close() {
    if (!this.locked) return;
    this.locked = false;
    let owner;
    try {
      owner = JSON.parse(await readFile(this.lockPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (owner.pid !== process.pid) throw new Error('Task queue lock ownership changed unexpectedly');
    await unlink(this.lockPath);
  }

  async readData() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, tasks: [], resources: [] };
      throw new Error(`Unable to read task queue ${this.filePath}: ${error.message}`);
    }
    if (raw?.version !== 1 || !Array.isArray(raw.tasks)) {
      throw new Error(`Unsupported or invalid task queue: ${this.filePath}`);
    }
    for (const task of raw.tasks) {
      if (!task?.id || !task.url || !TASK_STATUSES.has(task.status)) {
        throw new Error(`Unsupported or invalid task queue: ${this.filePath}`);
      }
      task.attempts = Number.isInteger(task.attempts) ? task.attempts : 0;
    }
    raw.resources = Array.isArray(raw.resources) ? raw.resources : [];
    return raw;
  }

  recoverInterrupted() {
    let recovered = 0;
    for (const task of this.data.tasks) {
      if (!ACTIVE_STATUSES.has(task.status)) continue;
      if (task.cancelRequestedAt) {
        if (task.cancelRequestedFromStage === 'replying') {
          task.status = 'action-required';
          task.stage = 'reply-status-unknown';
          task.lastError = 'Cancellation interrupted a public reply; inspect the thread before retrying';
        } else {
          task.status = 'cancelled';
          task.stage = 'cancelled';
          delete task.lastError;
        }
        delete task.progress;
        delete task.cancelRequestedAt;
        delete task.cancelRequestedFromStage;
      } else if (task.stage === 'replying') {
        task.status = 'action-required';
        task.stage = 'reply-status-unknown';
        task.lastError = 'The process stopped while submitting a public reply; inspect the thread before retrying';
      } else {
        task.status = 'pending';
        task.stage = 'recovered';
      }
      task.updatedAt = now();
      recovered += 1;
    }
    return recovered;
  }

  async save() {
    const temporary = `${this.filePath}.part-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }

  async enqueue(urls) {
    const added = [];
    const existing = [];
    const refreshed = [];
    for (const value of urls) {
      const url = normalizeTaskUrl(value, this.forums);
      const duplicate = this.data.tasks.find((task) => task.url === url);
      if (duplicate) {
        if (duplicate.status === 'completed'
          && this.forums.some((forum) => forum.match(url) && forum.shouldRefresh?.(url))) {
          duplicate.status = 'pending';
          duplicate.stage = 'sync-queued';
          duplicate.updatedAt = now();
          delete duplicate.progress;
          delete duplicate.summary;
          refreshed.push(duplicate);
          continue;
        }
        existing.push(duplicate);
        continue;
      }
      const timestamp = now();
      const task = {
        id: randomUUID(),
        url,
        status: 'pending',
        stage: 'queued',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.data.tasks.push(task);
      added.push(task);
    }
    if (added.length > 0 || refreshed.length > 0) await this.save();
    return { added, existing, refreshed };
  }

  async retryFailed() {
    const retried = [];
    for (const task of this.data.tasks) {
      if (!BULK_RETRYABLE_STATUSES.has(task.status)) continue;
      task.status = 'pending';
      task.stage = 'retry-queued';
      delete task.lastError;
      task.updatedAt = now();
      delete task.summary;
      retried.push(task);
    }
    if (retried.length > 0) await this.save();
    return retried;
  }

  async retry(id) {
    const task = this.requireTask(id);
    if (!RETRYABLE_STATUSES.has(task.status)) {
      throw new Error(`Task is not retryable: ${id}`);
    }
    task.status = 'pending';
    task.stage = 'retry-queued';
    task.updatedAt = now();
    delete task.lastError;
    delete task.summary;
    await this.save();
    return task;
  }

  async markCancelRequested(id) {
    const task = this.requireTask(id);
    if (task.status !== 'pending' && task.status !== 'running') {
      throw new Error(`Task is not running: ${id}`);
    }
    task.cancelRequestedFromStage = task.stage;
    task.cancelRequestedAt = now();
    task.status = 'running';
    task.stage = 'cancelling';
    task.updatedAt = now();
    const saving = this.save();
    this.pendingCancelSaves.set(id, saving);
    try {
      await saving;
      return task;
    } finally {
      if (this.pendingCancelSaves.get(id) === saving) this.pendingCancelSaves.delete(id);
    }
  }

  async markCancelled(id) {
    const pendingSave = this.pendingCancelSaves.get(id);
    if (pendingSave) await pendingSave;
    const task = this.requireTask(id);
    if (task.cancelRequestedFromStage === 'replying') {
      return this.finish(id, 'action-required', 'reply-status-unknown', {
        lastError: 'Cancellation interrupted a public reply; inspect the thread before retrying'
      });
    }
    return this.finish(id, 'cancelled', 'cancelled', {});
  }

  async remove(id) {
    const index = this.data.tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new Error(`Task was not found: ${id}`);
    const [task] = this.data.tasks.splice(index, 1);
    if (ACTIVE_STATUSES.has(task.status)) {
      this.data.tasks.splice(index, 0, task);
      throw new Error(`Running task cannot be deleted: ${id}`);
    }
    this.data.resources = this.data.resources.filter(
      (resource) => resource.taskId !== id || resource.preserveCompletion
    );
    await this.save();
    return task;
  }

  pending() {
    return this.data.tasks.filter((task) => task.status === 'pending');
  }

  tasks() {
    return structuredClone(this.data.tasks);
  }

  hasCompletedResource(resourceUrl) {
    const key = resourceKey(resourceUrl, this.forums);
    return this.data.resources.some((resource) => resource.key === key);
  }

  async markResourceCompleted(taskId, resource) {
    let changed = false;
    for (const url of [resource.url, ...(resource.aliasUrls || [])]) {
      const key = resourceKey(url, this.forums);
      if (this.data.resources.some((item) => item.key === key)) continue;
      this.data.resources.push({
        key,
        provider: resource.provider,
        taskId,
        preserveCompletion: resource.preserveCompletion === true,
        completedAt: now()
      });
      changed = true;
    }
    if (changed) await this.save();
  }

  async markProgress(id, stage, details = {}) {
    const task = this.requireTask(id);
    task.status = 'running';
    task.stage = stage;
    task.updatedAt = now();
    task.progress = details;
    if (stage === 'inspecting') task.attempts += 1;
    await this.save();
    return task;
  }

  async markCompleted(id, summary) {
    return this.finish(id, 'completed', 'completed', { summary });
  }

  async markActionRequired(id, error, summary) {
    return this.finish(id, 'action-required', 'action-required', {
      lastError: error,
      summary
    });
  }

  async markFailed(id, error, summary) {
    return this.finish(id, 'failed', 'failed', { lastError: error, summary });
  }

  async finish(id, status, stage, values) {
    const task = this.requireTask(id);
    Object.assign(task, values, { status, stage, updatedAt: now() });
    delete task.progress;
    delete task.cancelRequestedAt;
    delete task.cancelRequestedFromStage;
    await this.save();
    return task;
  }

  requireTask(id) {
    const task = this.data.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`Task was not found: ${id}`);
    return task;
  }
}
