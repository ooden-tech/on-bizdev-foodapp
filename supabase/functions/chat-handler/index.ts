import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { handleError } from "../_shared/error-handler.ts";
import { createSupabaseClient } from "../_shared/supabase-client.ts";
// V3: Hybrid Multi-Agent Architecture (IntentAgent → ReasoningAgent → ChatAgent)
import { orchestrateV3 as orchestrate } from "./orchestrator_v3.ts";
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    console.log('[Chat-Handler] Request received (v3.0.0 - Hybrid Multi-Agent)');
    const supabaseClient = createSupabaseClient(req);
    const authHeader = req.headers.get('Authorization');
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      console.error('[Chat-Handler] Auth Error:', userError);
      return new Response(JSON.stringify({
        error: 'Unauthorized',
        message: 'Unauthorized',
        details: userError?.message
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const body = await req.json();
    let { message, session_id, timezone } = body;

    // Validate session_id is a valid UUID to prevent Postgres syntax errors
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (session_id && !uuidRegex.test(session_id)) {
      console.warn(`[Chat-Handler] Invalid session_id received and stripped: ${session_id}`);
      session_id = undefined;
    }

    console.log('[Chat-Handler] User:', user.id, 'Session:', session_id, 'Message:', message);
    if (!message) {
      return new Response(JSON.stringify({
        error: 'Message is required'
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Fetch conversation history if session_id is provided
    let history = [];
    if (session_id) {
      const { data: historyData } = await supabaseClient.from('chat_messages').select('role, content').eq('session_id', session_id).order('created_at', {
        ascending: false
      }).limit(10);
      if (historyData) {
        history = historyData.reverse();
      }
    }
    // Stream thinking steps + final response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Callback to send steps to client
        const onStep = (step) => {
          console.log(`[Chat-Handler] Streaming step: ${step}`);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            step
          })}\n\n`));
        };
        try {
          const result = await orchestrate(user.id, message, session_id, history, timezone, onStep);
          // Save message to history - wrapped in safety
          try {
            if (session_id) {
              await supabaseClient.from('chat_messages').insert([
                {
                  session_id,
                  user_id: user.id,
                  role: 'user',
                  content: message
                },
                {
                  session_id,
                  user_id: user.id,
                  role: 'assistant',
                  content: result.message || 'Success!',
                  metadata: result.data || {},
                  message_type: result.response_type || 'standard'
                }
              ]);
            }
          } catch (insertError) {
            console.error('[Chat-Handler] History Insert Error:', insertError);
          }
          // Send final result
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(result)}\n\n`));
          controller.close();
        } catch (error) {
          console.error('[Chat-Handler] Stream Error:', error);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            status: 'error',
            message: error.message
          })}\n\n`));
          controller.close();
        }
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  } catch (error) {
    return handleError(error);
  }
});
