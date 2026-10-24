// Synthetic demonstration using the actual countdown component; no model calls.
import { projectCountdown } from '../dist/ui/countdown.js';

const prediction = { remainingSeconds: 120, errorPercent: 25, observedActiveSeconds: 300 };
const samples = [
  ['Forecast received after 12 seconds', 312, 'running'],
  ['30 more active seconds', 342, 'running'],
  ['Tracking paused; active clock frozen', 342, 'paused'],
  ['Tracking resumed at the same active time', 342, 'running'],
  ['Estimate elapsed before completion', 421, 'running'],
  ['Explicit completion recorded', 421, 'completed'],
];

for (const [scenario, activeSeconds, state] of samples) {
  const view = projectCountdown({ prediction, activeSeconds, state });
  console.log(`${scenario}: ${view.timeText} | ${view.status} | ${view.uncertaintyText}`);
}
console.log('The uncertainty label is supplied input, not a calibrated confidence interval.');
