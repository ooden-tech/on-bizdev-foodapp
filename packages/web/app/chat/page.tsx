'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { TypingIndicator } from '@/components/LoadingIndicators';
import FoodLogDetailModal from '@/components/FoodLogDetailModal';
import Link from 'next/link';
import ChatDashboardLayout from '@/components/ChatDashboardLayout';
import DashboardShell from '@/components/DashboardShell';
import DashboardSummaryTable from '@/components/DashboardSummaryTable';
import ChatMessageList from '@/components/ChatMessageList';
import { normalizeNutrientKey, MASTER_NUTRIENT_MAP, getStartAndEndOfDay } from 'shared';
import { useChatSessions } from '@/hooks/useChatSessions';

export const dynamic = 'force-dynamic';

interface ChatMessage {
  id: string | number;
  sender: 'user' | 'bot' | 'assistant' | 'error';
  text: string;
  metadata?: any;
  message_type?: string;
  flagged?: boolean;
}

interface UserGoal {
  nutrient: string;
  target_value: number;
  unit: string;
  goal_type?: string;
}

interface FoodLog {
  id: number;
  timestamp: string;
  food_name?: string | null;
  calories?: number | null;
  [key: string]: unknown;
}

interface DailyTotals {
  [nutrientKey: string]: number;
}

function ChatContent() {
  const router = useRouter();
  const { user, supabase, loading: authLoading, session } = useAuth();
  const { activeChatId, refreshChatSessions } = useChatSessions();

  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const skipFetchRef = React.useRef(false);

  // --- Dashboard State ---
  const [userGoals, setUserGoals] = useState<UserGoal[]>([]);
  const [dailyTotals, setDailyTotals] = useState<DailyTotals>({});
  const [recentLogs, setRecentLogs] = useState<FoodLog[]>([]);
  const [loadingDashboardData, setLoadingDashboardData] = useState(true);
  const [refreshingDashboard, setRefreshingDashboard] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);

  // --- Modal State ---
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);

  // Fetch initial messages when activeChatId changes
  useEffect(() => {
    const fetchInitialMessages = async () => {
      if (skipFetchRef.current) {
        skipFetchRef.current = false;
        return;
      }
      if (!activeChatId || !supabase) {
        setChatHistory([]);
        return;
      }

      try {
        const { data, error: dbError } = await supabase
          .from('chat_messages')
          .select('id, role, content, metadata, message_type, flagged, created_at')
          .eq('session_id', activeChatId)
          .order('created_at', { ascending: true });

        if (dbError) throw dbError;

        const formattedMessages: ChatMessage[] = data?.map((msg: any) => ({
          id: msg.id,
          sender: msg.role === 'assistant' ? 'bot' : msg.role,
          text: msg.content,
          metadata: msg.metadata,
          message_type: msg.message_type,
          flagged: msg.flagged || false
        })) || [];

        setChatHistory(formattedMessages);
      } catch (err: any) {
        console.error('Error fetching initial chat messages:', err);
        setChatHistory([]);
      }
    };

    fetchInitialMessages();
  }, [activeChatId, supabase]);

  // --- Fetch dashboard data ---
  const fetchDashboardData = useCallback(async (forceRefresh = false) => {
    if (!user || !supabase) {
      setLoadingDashboardData(false);
      setRefreshingDashboard(false);
      return;
    }
    if (!forceRefresh) setLoadingDashboardData(true);
    setRefreshingDashboard(true);
    setDashboardError(null);

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { start: startOfDay, end: endOfDay } = getStartAndEndOfDay(new Date(), timezone);

    try {
      const [goalsResponse, logsResponse] = await Promise.all([
        supabase
          .from('user_goals')
          .select('nutrient, target_value, unit, goal_type')
          .eq('user_id', user.id),
        supabase
          .from('food_log')
          .select('*')
          .eq('user_id', user.id)
          .gte('log_time', startOfDay)
          .lte('log_time', endOfDay)
          .order('log_time', { ascending: false })
      ]);

      if (goalsResponse.error) throw goalsResponse.error;
      if (logsResponse.error) throw logsResponse.error;

      const fetchedGoals = goalsResponse.data || [];
      const fetchedLogs = logsResponse.data || [];

      // Deduplicate goals by normalized key
      const uniqueGoalsMap = new Map<string, UserGoal>();
      fetchedGoals.forEach(g => {
        const normalized = normalizeNutrientKey(g.nutrient);
        const existing = uniqueGoalsMap.get(normalized);
        if (!existing || g.target_value > existing.target_value) {
          uniqueGoalsMap.set(normalized, { ...g, nutrient: normalized });
        }
      });
      const finalGoals = Array.from(uniqueGoalsMap.values());

      setUserGoals(finalGoals);
      setRecentLogs(fetchedLogs.slice(0, 5));

      const totals: DailyTotals = {};
      fetchedLogs.forEach(log => {
        Object.keys(log).forEach(key => {
          if (typeof log[key] === 'number') {
            const normalizedKey = normalizeNutrientKey(key);
            totals[normalizedKey] = (totals[normalizedKey] || 0) + (log[key] as number);
          }
        });
      });

      setDailyTotals(totals);

    } catch (err: unknown) {
      console.error("Error fetching dashboard data:", err);
      setDashboardError("Failed to load dashboard data");
    } finally {
      setLoadingDashboardData(false);
      setRefreshingDashboard(false);
    }
  }, [user, supabase]);

  useEffect(() => {
    if (user && supabase) {
      fetchDashboardData();
    }
  }, [user, supabase, fetchDashboardData]);

  const processBotReply = (responseData: any): ChatMessage => ({
    id: `bot-${Date.now()}`,
    sender: responseData.status === 'error' ? 'error' : 'bot',
    text: responseData.message || 'Sorry, I received an empty response.',
    metadata: responseData.data,
    message_type: responseData.response_type,
  });

  const handleSend = async (e?: React.FormEvent<HTMLFormElement>, actionPayload?: string, isHidden = false) => {
    if (e) e.preventDefault();
    const textToSend = actionPayload || message.trim();
    if (!textToSend || sending || authLoading || !supabase || !user) return;

    setSending(true);
    setCurrentStep('Communicating with NutriPal...');

    if (!isHidden) {
      const userMessage: ChatMessage = { id: Date.now(), sender: 'user', text: textToSend };
      setChatHistory(prev => [...prev, userMessage]);
    }
    setMessage('');

    // Auto-create a chat session if none is active
    let sessionId = activeChatId;
    if (!sessionId) {
      try {
        const now = new Date();
        const title = `Chat ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
        const { data, error: createError } = await supabase
          .from('chat_sessions')
          .insert([{ user_id: user.id, title }])
          .select('id')
          .single();
        if (createError || !data) throw createError || new Error('Failed to create chat');
        sessionId = data.id;
        skipFetchRef.current = true;
        router.push(`/chat?id=${sessionId}`);
        refreshChatSessions();
      } catch (err) {
        console.error('Error auto-creating chat session:', err);
        setChatHistory(prev => [...prev, { id: Date.now() + 1, sender: 'error', text: 'Failed to create chat session.' }]);
        setSending(false);
        setCurrentStep(null);
        return;
      }
    }

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/chat-handler`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
          'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
        },
        body: JSON.stringify({
          message: textToSend,
          session_id: sessionId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const json = JSON.parse(line.substring(6));

              if (json.step) {
                setCurrentStep(json.step);
              } else if (json.status) {
                const botMessage = processBotReply(json);
                setChatHistory(prev => [...prev, botMessage]);
                setCurrentStep(null);

                if (json.response_type === 'food_logged' ||
                  json.response_type === 'recipe_logged' ||
                  json.response_type === 'goal_updated' ||
                  json.response_type === 'goals_updated') {
                  fetchDashboardData(true);
                }
              }
            } catch (e) {
              console.error('Error parsing stream chunk:', e, line);
            }
          }
        }
      }

      // Flush any remaining buffer content after stream ends
      if (buffer.trim()) {
        const remainingLines = buffer.split('\n');
        for (const line of remainingLines) {
          if (line.startsWith('data: ')) {
            try {
              const json = JSON.parse(line.substring(6));
              if (json.status) {
                const botMessage = processBotReply(json);
                setChatHistory(prev => [...prev, botMessage]);
                setCurrentStep(null);
                if (json.response_type === 'food_logged' ||
                  json.response_type === 'recipe_logged' ||
                  json.response_type === 'goal_updated' ||
                  json.response_type === 'goals_updated') {
                  fetchDashboardData(true);
                }
              }
            } catch (e) {
              console.error('Error parsing remaining buffer:', e, line);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Error sending message:', error);
      setChatHistory(prev => [...prev, {
        id: Date.now() + 2,
        sender: 'error',
        text: `Error: ${error.message}`
      }]);
      setCurrentStep(null);
    } finally {
      setSending(false);
    }
  };

  const handleFlagMessage = async (messageId: number) => {
    console.log('[ChatPage] Flagging message:', messageId);
    // TODO: Implement flag message logic
  };

  const handleViewLogDetail = (logData: any) => {
    setSelectedLog(logData);
    setShowDetailModal(true);
  };

  const handleDeleteLogItem = async (logId: string | number) => {
    if (!supabase) return;
    try {
      const { error } = await supabase
        .from('food_log')
        .delete()
        .eq('id', logId);

      if (error) throw error;
      setShowDetailModal(false);
      fetchDashboardData(true);
    } catch (err) {
      console.error('Error deleting log item:', err);
      alert('Failed to delete log item');
    }
  };

  if (authLoading) return <div className="flex justify-center items-center h-screen"><TypingIndicator /></div>;

  if (!user || !session) {
    return (
      <div className="flex flex-col justify-center items-center h-screen bg-gray-100">
        <h1 className="text-2xl font-semibold mb-4">Welcome to NutriPal</h1>
        <p className="mb-6 text-gray-600">Please log in to access your chat and dashboard.</p>
        <Link href="/login" className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">
          Log In
        </Link>
      </div>
    );
  }

  const chatPanelContent = (
    <div className="flex-1 flex flex-col h-full bg-gray-100 overflow-hidden">
      <ChatMessageList
        activeChatId={activeChatId}
        messages={chatHistory}
        userGoals={userGoals}
        onFlagMessage={handleFlagMessage}
        onSendMessage={(text, isHidden) => handleSend(undefined, text, isHidden)}
        onViewLogDetail={handleViewLogDetail}
      />
      {sending && (
        <div className="px-4 py-2 flex flex-col items-start space-y-1">
          <TypingIndicator />
          {currentStep && (
            <span className="text-xs text-gray-500 font-medium animate-pulse ml-1">
              {currentStep}
            </span>
          )}
        </div>
      )}
      <div className="p-4 bg-white border-t border-gray-200 flex-shrink-0">
        <form onSubmit={handleSend} className="flex items-center space-x-3">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={sending ? "Waiting for response..." : "Type your message..."}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-full text-black placeholder-black focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !message.trim()}
            className="px-5 py-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 transition-colors duration-200"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );

  const dashboardPanelContent = (
    <div className="flex-1 p-4 bg-gray-50">
      <DashboardSummaryTable
        userGoals={userGoals}
        dailyTotals={dailyTotals}
        loading={loadingDashboardData}
        error={dashboardError}
        refreshing={refreshingDashboard}
        onRefresh={() => fetchDashboardData(true)}
      />
    </div>
  );

  return (
    <DashboardShell headerTitle="Chat & Dashboard">
      <ChatDashboardLayout
        chatPanel={chatPanelContent}
        dashboardPanel={dashboardPanelContent}
      />

      {showDetailModal && selectedLog && (
        <FoodLogDetailModal
          logData={selectedLog}
          onClose={() => setShowDetailModal(false)}
          userGoals={userGoals}
          onDelete={selectedLog.id ? () => handleDeleteLogItem(selectedLog.id) : undefined}
        />
      )}
    </DashboardShell>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="flex justify-center items-center h-screen"><TypingIndicator /></div>}>
      <ChatContent />
    </Suspense>
  );
}
