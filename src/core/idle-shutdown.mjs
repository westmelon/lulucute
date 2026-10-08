function hasActiveTasks(state) {
  return state.running || state.pluginOperation || state.browser?.loginStatus || state.tasks.some((task) => (
    task.status === 'pending' || task.status === 'running'
  ));
}

export function waitForShutdown({ worker, idleShutdownMs, signalEmitter = process }) {
  return new Promise((resolve) => {
    let idleTimer;
    let stopping = false;

    const cleanup = () => {
      clearTimeout(idleTimer);
      unsubscribe();
      signalEmitter.removeListener('SIGINT', onSigint);
      signalEmitter.removeListener('SIGTERM', onSigterm);
    };
    const stop = (reason) => {
      if (stopping) return;
      stopping = true;
      cleanup();
      resolve(reason);
    };
    const onSigint = () => stop('SIGINT');
    const onSigterm = () => stop('SIGTERM');
    const schedule = (state) => {
      clearTimeout(idleTimer);
      if (!idleShutdownMs || hasActiveTasks(state)) return;
      idleTimer = setTimeout(() => {
        const latest = worker.state();
        if (hasActiveTasks(latest)) schedule(latest);
        else stop('idle');
      }, idleShutdownMs);
    };

    const unsubscribe = worker.subscribe(schedule);
    signalEmitter.on('SIGINT', onSigint);
    signalEmitter.on('SIGTERM', onSigterm);
    schedule(worker.state());
  });
}
