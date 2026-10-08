export function summarizeWorkflowResult(result) {
  const items = result.results || [];
  return {
    directory: result.directory || null,
    threadId: result.source?.threadId || null,
    threadTitle: result.source?.threadTitle || null,
    forum: result.source?.forum || null,
    section: result.source?.section || null,
    downloaded: items.filter((item) => item.status === 'downloaded').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
    actionRequired: items.filter((item) => item.status === 'action-required').length
  };
}

function messagesFor(result, status) {
  return (result.results || [])
    .filter((item) => item.status === status)
    .map((item) => item.error || item.message || item.reason)
    .filter(Boolean)
    .join('; ');
}

export async function runQueuedTasks({
  queue,
  workflow,
  context,
  tasks = queue.pending(),
  log = console.error,
  signal,
  onUpdate = async () => {}
}) {
  const processed = [];
  tasks = [...tasks];

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    log(`[resource-downloader] Task ${index + 1}/${tasks.length}: ${task.url}`);
    try {
      signal?.throwIfAborted();
      const result = await workflow.run(context, task.url, {
        signal,
        onProgress: async (stage, details) => {
          signal?.throwIfAborted();
          if (!details?.transfer) log(`[resource-downloader] Task stage: ${stage}`);
          await queue.markProgress(task.id, stage, details);
          await onUpdate();
        },
        shouldSkipResource: async (resource) =>
          [resource.url, ...(resource.aliasUrls || [])]
            .some((url) => queue.hasCompletedResource(url)),
        onResourceCompleted: async (resource) => queue.markResourceCompleted(task.id, resource)
      });
      signal?.throwIfAborted();
      const summary = summarizeWorkflowResult(result);
      if (summary.failed > 0) {
        const error = messagesFor(result, 'failed') || 'One or more resources failed';
        await queue.markFailed(task.id, error, summary);
        await onUpdate();
        processed.push({ id: task.id, url: task.url, status: 'failed', error, summary });
      } else if (summary.actionRequired > 0) {
        const error = messagesFor(result, 'action-required') || 'Official-page action is required';
        await queue.markActionRequired(task.id, error, summary);
        await onUpdate();
        processed.push({ id: task.id, url: task.url, status: 'action-required', error, summary });
      } else {
        await queue.markCompleted(task.id, summary);
        await onUpdate();
        processed.push({ id: task.id, url: task.url, status: 'completed', summary });
      }
    } catch (error) {
      const finished = signal?.aborted
        ? await queue.markCancelled(task.id)
        : await queue.markFailed(task.id, error.message);
      await onUpdate();
      processed.push({ id: task.id, url: task.url, status: finished.status, error: error.message });
    }
  }

  return processed;
}
