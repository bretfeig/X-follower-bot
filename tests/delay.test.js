// Minimal node test for the polite delay distribution.
// Run: node extension/tests/delay.test.js

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function politeDelay(baseMs = 3000) {
  const jitter = randInt(-Math.floor(baseMs * 0.5), Math.floor(baseMs * 0.5));
  const longTail = Math.random() < 0.07 ? randInt(5000, 12000) : 0;
  return baseMs + jitter + longTail;
}

// Basic checks
const samples = Array.from({ length: 2000 }, () => politeDelay(3000));
const min = Math.min(...samples);
const max = Math.max(...samples);
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

console.log(JSON.stringify({ n: samples.length, min, max, avg: Math.round(avg) }));

if (min < 1000 || max > 15000 || avg < 2500 || avg > 6000) {
  console.error('politeDelay distribution unexpected');
  process.exit(1);
}

