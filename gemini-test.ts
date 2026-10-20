// Quick Gemini connection test. Run from the project folder:  bun gemini-test.ts
// Bun reads your .env automatically. Prints how long Google takes to answer.
const key = process.env.GEMINI_API_KEY?.trim().replace(/^['"]|['"]$/g, "");
const model = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
if (!key) {
  console.log("No GEMINI_API_KEY found. Is this file in the same folder as .env?");
  process.exit(1);
}
console.log(`Key found (starts with ${key.slice(0, 6)}...). Asking "${model}"...`);

async function attempt(label: string, url: string, init: RequestInit) {
  const start = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    const body = await res.text();
    console.log(`\n[${label}] status ${res.status} after ${((Date.now() - start) / 1000).toFixed(1)} s`);
    console.log(body.slice(0, 400));
  } catch (e) {
    console.log(`\n[${label}] FAILED after ${((Date.now() - start) / 1000).toFixed(1)} s:`, (e as Error).message);
  }
}

await attempt(
  "Test 1 - Google's normal address",
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ text: "Say hi in 3 words." }] }] }),
  },
);

await attempt(
  "Test 2 - the address the app uses",
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Say hi in 3 words." }] }),
  },
);
