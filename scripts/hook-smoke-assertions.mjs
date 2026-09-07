export function assertHookProcess(result, name) {
  if (result.error || result.status !== 0) throw new Error(`packaged ${name} process failed`);
  // A fail-open Hook deliberately exits successfully. Delivery diagnostics are
  // therefore a smoke failure, not proof the task received the event.
  if (result.stderr?.trim()) throw new Error(`packaged ${name} delivery was not clean`);
  const acknowledgement = JSON.parse(result.stdout);
  if (JSON.stringify(acknowledgement) !== JSON.stringify(name === 'Interrupt' ? {} : {continue: true})) {
    throw new Error('packaged Hook emitted unexpected model-facing output');
  }
}

export function assertStoppedTurn(snapshot, taskId) {
  if (snapshot.tasks?.find(task => task.id === taskId)?.status !== 'quiescent') {
    throw new Error('packaged Stop did not quiesce the target turn');
  }
}
