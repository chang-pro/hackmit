const CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 30_000;

export async function cerebrasStructuredCompletion({
  model,
  messages,
  schema,
  schemaName,
  maxCompletionTokens = 1200,
  fetchImpl = fetch,
}) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error("CEREBRAS_API_KEY is not set");

  const response = await fetchImpl(CEREBRAS_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_completion_tokens: maxCompletionTokens,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Cerebras API request failed (${response.status} ${response.statusText}): ${body.slice(0, 400)}`
    );
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Cerebras returned no message content");
  return {
    data: JSON.parse(content),
    meta: {
      model,
      request_id: payload.id ?? null,
      usage: payload.usage ?? null,
    },
  };
}
