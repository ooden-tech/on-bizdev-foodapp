import OpenAI from 'https://deno.land/x/openai@v4.53.2/mod.ts'

export const createOpenAIClient = () => {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set')
  }

  return new OpenAI({
    apiKey,
    maxRetries: 3,
    timeout: 10 * 1000, // 10 seconds (Total with 3 retries = 40s, fitting within 60s Edge limit)
  })
}
